import { Router } from 'express';
import dns from 'node:dns/promises';
import net from 'node:net';
import { z } from 'zod';
import { tdb } from '../lib/tenant.js';
import { audit } from '../lib/audit.js';
import { randomHex, sha256 } from '../lib/crypto.js';
import { HttpError, badRequest, notFound, wrap } from '../lib/errors.js';
import { isProd } from '../config.js';
import { ctx, requireAuth, requireRole } from '../middleware/auth.js';
import { WEBHOOK_EVENTS, enqueueWebhook } from '../services/webhooks.js';

export const developerRouter = Router();
developerRouter.use(requireAuth, requireRole('admin'));

export const SCOPES = ['sms:send', 'sms:read', 'calls:write', 'calls:read'] as const;

// ------------------------------------------------------------------ API keys
developerRouter.get('/api-keys', wrap(async (req, res) => {
  const a = ctx(req);
  res.json(await tdb(a.companyId).rows('SELECT id, name, prefix, scopes, rate_limit_per_min, last_used_at, revoked_at, created_at FROM api_keys WHERE company_id=? ORDER BY revoked_at IS NOT NULL, id DESC', [a.companyId]));
}));

developerRouter.post('/api-keys', wrap(async (req, res) => {
  const a = ctx(req);
  const b = z.object({ name: z.string().min(2).max(80), scopes: z.array(z.enum(SCOPES)).min(1), rate_limit_per_min: z.number().int().min(1).max(1000).default(60) }).parse(req.body);
  const key = `swk_live_${randomHex(4)}_${randomHex(16)}`;
  const r = await tdb(a.companyId).exec('INSERT INTO api_keys (company_id, name, prefix, key_hash, scopes, rate_limit_per_min) VALUES (?,?,?,?,?,?)', [a.companyId, b.name, key.slice(0, 18), sha256(key), JSON.stringify(b.scopes), b.rate_limit_per_min]);
  await audit(a.companyId, a.email, 'api_key.created', b.name);
  res.status(201).json({ id: r.insertId, key, note: 'Copy this key now — only its hash is stored and it cannot be shown again.' });
}));

developerRouter.delete('/api-keys/:id', wrap(async (req, res) => {
  const a = ctx(req); const id = Number(req.params.id);
  const r = await tdb(a.companyId).exec('UPDATE api_keys SET revoked_at=NOW(3) WHERE company_id=? AND id=? AND revoked_at IS NULL', [a.companyId, id]);
  if (!r.affectedRows) throw notFound('API key');
  await audit(a.companyId, a.email, 'api_key.revoked', `key:${id}`);
  res.json({ ok: true });
}));

developerRouter.get('/usage', wrap(async (req, res) => {
  const a = ctx(req); const db = tdb(a.companyId);
  const sms = await db.rows('SELECT DATE(created_at) day, COUNT(*) messages, SUM(segments) segments, SUM(status=\'failed\') failed FROM sms_messages WHERE company_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY day ORDER BY day', [a.companyId]);
  res.json({ sms });
}));

// ------------------------------------------------------------------ webhooks
function isPrivateIp(ip: string) {
  if (net.isIPv6(ip)) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** SSRF guard: in production only public https targets are allowed (hostname is resolved and every address checked). */
async function assertSafeUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('Only http(s) URLs are allowed');
  if (!isProd) return;
  if (u.protocol !== 'https:') throw badRequest('Webhook URLs must use https');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((x) => isPrivateIp(x.address))) throw badRequest('Webhook URL resolves to a private or unknown address');
}

developerRouter.get('/webhooks', wrap(async (req, res) => {
  const a = ctx(req); const db = tdb(a.companyId);
  const hooks = await db.rows<any>('SELECT id, url, events, active, created_at, CONCAT(LEFT(secret, 10), \'…\') secret_hint FROM webhooks WHERE company_id=? ORDER BY id DESC', [a.companyId]);
  const stats = await db.rows<{ webhook_id: number; status: string; n: number }>('SELECT webhook_id, status, COUNT(*) n FROM webhook_deliveries WHERE company_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY webhook_id, status', [a.companyId]);
  res.json({ events: WEBHOOK_EVENTS, hooks: hooks.map((h) => ({ ...h, deliveries: Object.fromEntries(stats.filter((s) => s.webhook_id === h.id).map((s) => [s.status, s.n])) })) });
}));

const hookSchema = z.object({ url: z.string().url().max(400), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1), active: z.boolean().default(true) });

developerRouter.post('/webhooks', wrap(async (req, res) => {
  const a = ctx(req); const b = hookSchema.parse(req.body); await assertSafeUrl(b.url);
  const secret = `whsec_${randomHex(16)}`;
  const r = await tdb(a.companyId).exec('INSERT INTO webhooks (company_id, url, secret, events, active) VALUES (?,?,?,?,?)', [a.companyId, b.url, secret, JSON.stringify(b.events), b.active ? 1 : 0]);
  await audit(a.companyId, a.email, 'webhook.created', b.url);
  res.status(201).json({ id: r.insertId, secret, note: 'Signing secret shown once. Verify the X-Swadesh-Signature header with it.' });
}));

developerRouter.patch('/webhooks/:id', wrap(async (req, res) => {
  const a = ctx(req); const id = Number(req.params.id); const b = hookSchema.partial().parse(req.body);
  if (b.url) await assertSafeUrl(b.url);
  const sets: string[] = []; const p: (string | number)[] = [];
  if (b.url) { sets.push('url=?'); p.push(b.url); }
  if (b.events) { sets.push('events=?'); p.push(JSON.stringify(b.events)); }
  if (b.active !== undefined) { sets.push('active=?'); p.push(b.active ? 1 : 0); }
  if (!sets.length) throw badRequest('Nothing to update');
  const r = await tdb(a.companyId).exec(`UPDATE webhooks SET ${sets.join(', ')} WHERE company_id=? AND id=?`, [...p, a.companyId, id]);
  if (!r.affectedRows) throw notFound('Webhook');
  res.json({ ok: true });
}));

developerRouter.delete('/webhooks/:id', wrap(async (req, res) => {
  const a = ctx(req); const id = Number(req.params.id); const db = tdb(a.companyId);
  await db.exec('DELETE FROM webhook_deliveries WHERE company_id=? AND webhook_id=?', [a.companyId, id]);
  const r = await db.exec('DELETE FROM webhooks WHERE company_id=? AND id=?', [a.companyId, id]);
  if (!r.affectedRows) throw notFound('Webhook');
  await audit(a.companyId, a.email, 'webhook.deleted', `webhook:${id}`);
  res.json({ ok: true });
}));

developerRouter.post('/webhooks/:id/test', wrap(async (req, res) => {
  const a = ctx(req); const id = Number(req.params.id);
  if (!(await tdb(a.companyId).one('SELECT id FROM webhooks WHERE company_id=? AND id=?', [a.companyId, id]))) throw notFound('Webhook');
  // test events bypass the subscription filter by sending only to this endpoint
  await tdb(a.companyId).exec("UPDATE webhooks SET events = JSON_ARRAY_APPEND(events, '$', 'webhook.test') WHERE company_id=? AND id=? AND NOT JSON_CONTAINS(events, JSON_QUOTE('webhook.test'))", [a.companyId, id]);
  const n = await enqueueWebhook(a.companyId, 'webhook.test', { message: 'Test event from Swadesh console' }, id);
  if (!n) throw new HttpError(409, 'Webhook is inactive', 'conflict');
  res.json({ queued: true });
}));

developerRouter.get('/deliveries', wrap(async (req, res) => {
  const a = ctx(req); const page = Math.max(1, Number(req.query.page) || 1);
  let where = 'd.company_id=?'; const p: (string | number)[] = [a.companyId];
  if (req.query.status) { where += ' AND d.status=?'; p.push(String(req.query.status)); }
  if (req.query.webhookId) { where += ' AND d.webhook_id=?'; p.push(Number(req.query.webhookId)); }
  const db = tdb(a.companyId);
  const [{ n }] = await db.rows<{ n: number }>(`SELECT COUNT(*) n FROM webhook_deliveries d WHERE ${where}`, p);
  const rows = await db.rows(`SELECT d.id, d.webhook_id, w.url, d.event, d.status, d.attempts, d.response_code, d.last_error, d.next_attempt_at, d.created_at FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id AND w.company_id=d.company_id WHERE ${where} ORDER BY d.id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`, p);
  res.json({ total: n, page, pageSize: 25, rows });
}));

developerRouter.post('/deliveries/:id/retry', wrap(async (req, res) => {
  const a = ctx(req); const id = Number(req.params.id);
  const r = await tdb(a.companyId).exec("UPDATE webhook_deliveries SET status='pending', attempts=0, next_attempt_at=NOW(3) WHERE company_id=? AND id=? AND status='failed'", [a.companyId, id]);
  if (!r.affectedRows) throw new HttpError(409, 'Only failed deliveries can be retried', 'conflict');
  res.json({ ok: true });
}));
