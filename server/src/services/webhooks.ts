import { pool } from '../db/mysql.js';
import { tdb } from '../lib/tenant.js';
import { hmacSignature } from '../lib/crypto.js';

export const WEBHOOK_EVENTS = ['call.completed', 'call.abandoned', 'sms.delivered', 'sms.failed', 'recording.paused', 'recording.resumed', 'webhook.test'] as const;

/** Backoff schedule (seconds) after failed attempt N. 5 attempts total. */
const BACKOFF = [5, 30, 120, 600, 3600];
const MAX_ATTEMPTS = BACKOFF.length;

export async function enqueueWebhook(companyId: number, event: string, data: Record<string, unknown>, onlyWebhookId?: number) {
  const db = tdb(companyId);
  const hooks = await db.rows<{ id: number }>(
    `SELECT id FROM webhooks WHERE company_id = ? AND active = 1 AND JSON_CONTAINS(events, JSON_QUOTE(?))${onlyWebhookId ? ' AND id = ?' : ''}`,
    onlyWebhookId ? [companyId, event, onlyWebhookId] : [companyId, event],
  );
  const payload = JSON.stringify({ id: `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, type: event, created: new Date().toISOString(), data });
  for (const h of hooks) {
    await db.exec(
      'INSERT INTO webhook_deliveries (company_id, webhook_id, event, payload, next_attempt_at) VALUES (?, ?, ?, ?, NOW(3))',
      [companyId, h.id, event, payload],
    );
  }
  return hooks.length;
}

interface DueRow {
  id: number;
  company_id: number;
  webhook_id: number;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
}

/**
 * Cross-tenant background worker: the single place (besides retention) that scans all tenants.
 * Every row it touches is processed strictly with the row's own company_id.
 */
async function deliverDue() {
  const [rows] = await pool.query(
    `SELECT d.id, d.company_id, d.webhook_id, d.payload, d.attempts, w.url, w.secret
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id AND w.company_id = d.company_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= NOW(3) ORDER BY d.next_attempt_at LIMIT 25`,
  );
  await Promise.all((rows as DueRow[]).map(deliverOne));
}

async function deliverOne(d: DueRow) {
  const body = typeof d.payload === 'string' ? d.payload : JSON.stringify(d.payload);
  const t = Math.floor(Date.now() / 1000);
  let code: number | null = null;
  let err: string | null = null;
  try {
    const res = await fetch(d.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Swadesh-Webhooks/1.0', 'x-swadesh-signature': `t=${t},v1=${hmacSignature(d.secret, t, body)}` },
      body,
      signal: AbortSignal.timeout(5000),
    });
    code = res.status;
    if (!res.ok) err = `HTTP ${res.status}`;
  } catch (e) {
    err = (e as Error).message.slice(0, 180);
  }
  const attempts = d.attempts + 1;
  const db = tdb(d.company_id);
  if (!err) {
    await db.exec("UPDATE webhook_deliveries SET status='success', attempts=?, response_code=?, last_error=NULL, next_attempt_at=NULL WHERE company_id=? AND id=?", [attempts, code, d.company_id, d.id]);
  } else if (attempts >= MAX_ATTEMPTS) {
    await db.exec("UPDATE webhook_deliveries SET status='failed', attempts=?, response_code=?, last_error=?, next_attempt_at=NULL WHERE company_id=? AND id=?", [attempts, code, err, d.company_id, d.id]);
  } else {
    await db.exec('UPDATE webhook_deliveries SET attempts=?, response_code=?, last_error=?, next_attempt_at=DATE_ADD(NOW(3), INTERVAL ? SECOND) WHERE company_id=? AND id=?', [attempts, code, err, BACKOFF[attempts - 1], d.company_id, d.id]);
  }
}

let timer: NodeJS.Timeout | undefined;
let running = false;
export function startWebhookWorker() {
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await deliverDue();
    } catch (e) {
      console.error('[webhooks] worker error', e);
    } finally {
      running = false;
    }
  }, 2000);
  timer.unref();
}
export const stopWebhookWorker = () => timer && clearInterval(timer);
