import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { config } from '../config.js';
import { pool } from '../db/mysql.js';
import { mcol } from '../db/mongo.js';
import { tdb } from '../lib/tenant.js';
import { audit } from '../lib/audit.js';
import { csvRow } from '../lib/csv.js';
import { randomHex, secureEqualHex, sha256 } from '../lib/crypto.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { runtime } from '../engine/runtime.js';
import { enqueueWebhook } from './webhooks.js';

const CHUNK = 5000;

export interface PrivacySettings {
  retention_recordings_days: number; retention_calls_days: number; retention_sms_days: number;
  consent_prompt_text: string; allow_pause_resume: number;
}

export async function getSettings(companyId: number) {
  const row = await tdb(companyId).one<PrivacySettings>('SELECT * FROM privacy_settings WHERE company_id=?', [companyId]);
  if (row) return row;
  await tdb(companyId).exec('INSERT INTO privacy_settings (company_id) VALUES (?)', [companyId]);
  return (await tdb(companyId).one<PrivacySettings>('SELECT * FROM privacy_settings WHERE company_id=?', [companyId]))!;
}

// ------------------------------------------------------------------ recording pause / resume (hard tokens)
/**
 * "Hard" pause: pausing issues a one-time resume token that is returned ONCE (e.g. to a PCI payment flow).
 * Recording cannot be resumed by anyone without that token — not the agent UI, not a timer.
 * Supervisors can force-resume, which is separately logged as `pause_override`.
 */
export async function pauseRecording(companyId: number, callId: number, actor: string) {
  const db = tdb(companyId);
  const s = await getSettings(companyId);
  if (!s.allow_pause_resume) throw new HttpError(403, 'Recording pause/resume is disabled for this company', 'forbidden');
  const call = await db.one<{ recording_state: string; status: string }>('SELECT recording_state, status FROM calls WHERE company_id=? AND id=?', [companyId, callId]);
  if (!call) throw notFound('Call');
  if (call.status !== 'in_progress') throw new HttpError(409, 'Call is not in progress', 'conflict');
  if (call.recording_state !== 'recording') throw new HttpError(409, `Recording is "${call.recording_state}", nothing to pause`, 'conflict');
  const token = `rpt_${randomHex(12)}`;
  await db.exec('INSERT INTO recording_pause_tokens (company_id, call_id, token_hash, issued_to) VALUES (?,?,?,?)', [companyId, callId, sha256(token), actor]);
  await db.exec("UPDATE calls SET recording_state='paused' WHERE company_id=? AND id=?", [companyId, callId]);
  await db.exec("INSERT INTO consent_events (company_id, call_id, type, actor) VALUES (?,?,'recording_paused',?)", [companyId, callId, actor]);
  runtime.get(companyId).setRecording(callId, 'paused');
  void enqueueWebhook(companyId, 'recording.paused', { call_id: callId }).catch(() => {});
  return { token, note: 'Store this token now. It is shown once and is required to resume recording.' };
}

export async function resumeRecording(companyId: number, callId: number, token: string, actor: string) {
  const db = tdb(companyId);
  const row = await db.one<{ id: number; token_hash: string }>('SELECT id, token_hash FROM recording_pause_tokens WHERE company_id=? AND call_id=? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1', [companyId, callId]);
  if (!row) throw new HttpError(409, 'No active pause for this call', 'conflict');
  if (!secureEqualHex(row.token_hash, sha256(token))) {
    await audit(companyId, actor, 'recording.resume_denied', `call:${callId}`);
    throw new HttpError(403, 'Invalid resume token', 'forbidden');
  }
  await finishResume(companyId, callId, row.id, 'recording_resumed', actor);
}

export async function overrideResume(companyId: number, callId: number, actor: string) {
  const db = tdb(companyId);
  const row = await db.one<{ id: number }>('SELECT id FROM recording_pause_tokens WHERE company_id=? AND call_id=? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1', [companyId, callId]);
  if (!row) throw new HttpError(409, 'No active pause for this call', 'conflict');
  await finishResume(companyId, callId, row.id, 'pause_override', actor);
  await audit(companyId, actor, 'recording.pause_override', `call:${callId}`);
}

async function finishResume(companyId: number, callId: number, tokenId: number, type: 'recording_resumed' | 'pause_override', actor: string) {
  const db = tdb(companyId);
  await db.exec('UPDATE recording_pause_tokens SET consumed_at=NOW(3) WHERE company_id=? AND id=?', [companyId, tokenId]);
  await db.exec("UPDATE calls SET recording_state='recording' WHERE company_id=? AND id=? AND recording_state='paused'", [companyId, callId]);
  await db.exec('INSERT INTO consent_events (company_id, call_id, type, actor) VALUES (?,?,?,?)', [companyId, callId, type, actor]);
  runtime.get(companyId).setRecording(callId, 'recording');
  void enqueueWebhook(companyId, 'recording.resumed', { call_id: callId, override: type === 'pause_override' }).catch(() => {});
}

// ------------------------------------------------------------------ retention
const days = (d: number) => new Date(Date.now() - d * 86_400_000);

export async function retentionPreview(companyId: number) {
  const db = tdb(companyId); const s = await getSettings(companyId);
  const [rec] = await db.rows<{ n: number }>("SELECT COUNT(*) n FROM calls WHERE company_id=? AND recording_state IN ('stopped','paused') AND started_at < ?", [companyId, days(s.retention_recordings_days)]);
  const [calls] = await db.rows<{ n: number }>('SELECT COUNT(*) n FROM calls WHERE company_id=? AND started_at < ?', [companyId, days(s.retention_calls_days)]);
  const [sms] = await db.rows<{ n: number }>('SELECT COUNT(*) n FROM sms_messages WHERE company_id=? AND created_at < ?', [companyId, days(s.retention_sms_days)]);
  return { recordings: Number(rec.n), calls: Number(calls.n), sms: Number(sms.n), settings: s };
}

/** Chunked deletes (LIMIT 5000) so purging a large tenant never holds long locks. */
export async function runRetention(companyId: number, actor = 'system:retention') {
  const db = tdb(companyId); const s = await getSettings(companyId);
  const out = { recordingsPurged: 0, callsDeleted: 0, smsDeleted: 0 };
  for (;;) {
    const r = await db.exec("UPDATE calls SET recording_state='purged', recording_key=NULL WHERE company_id=? AND recording_state IN ('stopped','paused') AND started_at < ? LIMIT ?", [companyId, days(s.retention_recordings_days), CHUNK]);
    out.recordingsPurged += r.affectedRows; if (r.affectedRows < CHUNK) break;
  }
  for (;;) {
    const ids = (await db.rows<{ id: number }>('SELECT id FROM calls WHERE company_id=? AND started_at < ? LIMIT ?', [companyId, days(s.retention_calls_days), CHUNK])).map((r) => r.id);
    if (!ids.length) break;
    await purgeCallIds(companyId, ids); out.callsDeleted += ids.length;
    if (ids.length < CHUNK) break;
  }
  for (;;) {
    const r = await db.exec('DELETE FROM sms_messages WHERE company_id=? AND created_at < ? LIMIT ?', [companyId, days(s.retention_sms_days), CHUNK]);
    out.smsDeleted += r.affectedRows; if (r.affectedRows < CHUNK) break;
  }
  await audit(companyId, actor, 'retention.run', undefined, out);
  return out;
}

async function purgeCallIds(companyId: number, ids: number[]) {
  const db = tdb(companyId);
  const ph = ids.map(() => '?').join(',');
  await mcol('call_events', companyId).deleteMany({ call_id: { $in: ids } });
  await db.exec(`DELETE FROM recording_pause_tokens WHERE company_id=? AND call_id IN (${ph})`, [companyId, ...ids]);
  await db.exec(`DELETE FROM consent_events WHERE company_id=? AND call_id IN (${ph})`, [companyId, ...ids]);
  await db.exec(`DELETE FROM calls WHERE company_id=? AND id IN (${ph})`, [companyId, ...ids]);
}

let retentionTimer: NodeJS.Timeout | undefined;
export function startRetentionWorker() {
  retentionTimer = setInterval(async () => {
    try {
      const [rows] = await pool.query('SELECT id FROM companies');
      for (const c of rows as { id: number }[]) await runRetention(c.id);
    } catch (e) { console.error('[retention]', e); }
  }, 6 * 3600_000);
  retentionTimer.unref();
}

// ------------------------------------------------------------------ data-subject deletion
function normalisePhone(p: string) {
  const v = p.replace(/[\s-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(v)) throw badRequest('Phone must be E.164, e.g. +919876543210');
  return v;
}

export async function deletionPreview(companyId: number, phoneRaw: string) {
  const phone = normalisePhone(phoneRaw); const db = tdb(companyId);
  const one = async (sql: string, p: (string | number)[]) => Number((await db.rows<{ n: number }>(sql, p))[0].n);
  return {
    phone,
    calls: await one('SELECT COUNT(*) n FROM calls WHERE company_id=? AND (from_number=? OR to_number=?)', [companyId, phone, phone]),
    recordings: await one("SELECT COUNT(*) n FROM calls WHERE company_id=? AND (from_number=? OR to_number=?) AND recording_state <> 'none' AND recording_state <> 'purged'", [companyId, phone, phone]),
    sms: await one('SELECT COUNT(*) n FROM sms_messages WHERE company_id=? AND to_number=?', [companyId, phone]),
    leads: await one('SELECT COUNT(*) n FROM leads WHERE company_id=? AND phone=?', [companyId, phone]),
  };
}

/**
 * Erase a data subject. Call rows are ANONYMISED (numbers nulled, recording dropped, notes cleared) rather than deleted so
 * aggregate reporting stays intact; SMS bodies, leads and event timelines are deleted. The number is added to DNC so they
 * are never re-imported and dialled. A deletion record (counts only, no PII) is kept as evidence.
 */
export async function executeDeletion(companyId: number, phoneRaw: string, userId: number, actor: string) {
  const phone = normalisePhone(phoneRaw); const db = tdb(companyId);
  const before = await deletionPreview(companyId, phone);
  const callIds = (await db.rows<{ id: number }>('SELECT id FROM calls WHERE company_id=? AND (from_number=? OR to_number=?)', [companyId, phone, phone])).map((r) => r.id);
  for (let i = 0; i < callIds.length; i += CHUNK) {
    const ids = callIds.slice(i, i + CHUNK); const ph = ids.map(() => '?').join(',');
    await mcol('call_events', companyId).deleteMany({ call_id: { $in: ids } });
    await db.exec(`UPDATE calls SET from_number=NULL, to_number=NULL, notes=NULL, recording_state=IF(recording_state='none','none','purged'), recording_key=NULL WHERE company_id=? AND id IN (${ph})`, [companyId, ...ids]);
    await db.exec(`UPDATE consent_events SET subject_phone=NULL WHERE company_id=? AND call_id IN (${ph})`, [companyId, ...ids]);
  }
  await db.exec('DELETE FROM sms_messages WHERE company_id=? AND to_number=?', [companyId, phone]);
  await db.exec('DELETE FROM leads WHERE company_id=? AND phone=?', [companyId, phone]);
  await db.exec("INSERT IGNORE INTO dnc_numbers (company_id, phone, reason) VALUES (?,?,'Erasure request')", [companyId, phone]);
  const masked = `${phone.slice(0, 5)}••••${phone.slice(-3)}`;
  await db.exec('INSERT INTO deletion_requests (company_id, subject_phone, requested_by, summary) VALUES (?,?,?,?)', [companyId, masked, userId, JSON.stringify(before)]);
  await audit(companyId, actor, 'privacy.subject_erased', masked, before);
  return before;
}

// ------------------------------------------------------------------ structured exports
const EXPORTS = {
  calls: { table: 'calls', cols: ['id', 'direction', 'campaign_id', 'queue_id', 'agent_id', 'from_number', 'to_number', 'status', 'disposition', 'started_at', 'answered_at', 'ended_at', 'wait_secs', 'talk_secs', 'wrap_secs', 'recording_consent', 'recording_state'], dateCol: 'started_at' },
  sms: { table: 'sms_messages', cols: ['id', 'direction', 'from_number', 'to_number', 'body', 'segments', 'status', 'error', 'created_at'], dateCol: 'created_at' },
  consent: { table: 'consent_events', cols: ['id', 'call_id', 'subject_phone', 'type', 'actor', 'created_at'], dateCol: 'created_at' },
} as const;
export type ExportType = keyof typeof EXPORTS | 'subject';

export async function createExport(companyId: number, userId: number, actor: string, type: ExportType, params: { from?: string; to?: string; phone?: string }) {
  if (type === 'subject') params.phone = normalisePhone(params.phone ?? '');
  const res = await tdb(companyId).exec('INSERT INTO data_exports (company_id, requested_by, type, params) VALUES (?,?,?,?)', [companyId, userId, type, JSON.stringify(params)]);
  await audit(companyId, actor, 'export.requested', `${type}#${res.insertId}`, { ...params, phone: params.phone ? '[redacted]' : undefined });
  setImmediate(() => void processExport(companyId, res.insertId));
  return res.insertId;
}

async function processExport(companyId: number, id: number) {
  const db = tdb(companyId);
  try {
    const job = await db.one<{ type: ExportType; params: { from?: string; to?: string; phone?: string } }>('SELECT type, params FROM data_exports WHERE company_id=? AND id=?', [companyId, id]);
    if (!job) return;
    await db.exec("UPDATE data_exports SET status='running' WHERE company_id=? AND id=?", [companyId, id]);
    const dir = path.resolve(config.exportDir, String(companyId));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `export-${id}.csv`);
    const out = createWriteStream(file);
    let count = 0;
    const write = async (s: string) => { if (!out.write(s)) await once(out, 'drain'); };

    const types: (keyof typeof EXPORTS)[] = job.type === 'subject' ? ['calls', 'sms', 'consent'] : [job.type];
    for (const t of types) {
      const def = EXPORTS[t];
      if (job.type === 'subject') await write(`# ${t}\r\n`);
      await write(csvRow([...def.cols]));
      let last = 0;
      for (;;) {
        let sql = `SELECT ${def.cols.join(',')} FROM ${def.table} WHERE company_id=? AND id > ?`; const p: (string | number | Date)[] = [companyId, last];
        if (job.type === 'subject') {
          if (t === 'calls') { sql += ' AND (from_number=? OR to_number=?)'; p.push(job.params.phone!, job.params.phone!); }
          else if (t === 'sms') { sql += ' AND to_number=?'; p.push(job.params.phone!); }
          else { sql += ' AND subject_phone=?'; p.push(job.params.phone!); }
        } else {
          if (job.params.from) { sql += ` AND ${def.dateCol} >= ?`; p.push(new Date(`${job.params.from}T00:00:00Z`)); }
          if (job.params.to) { sql += ` AND ${def.dateCol} < ?`; p.push(new Date(Date.parse(`${job.params.to}T00:00:00Z`) + 86_400_000)); }
        }
        sql += ` ORDER BY id LIMIT ${CHUNK}`; // keyset pagination: constant cost per page regardless of table size
        const rows = await db.rows<Record<string, unknown>>(sql, p);
        for (const r of rows) await write(csvRow(def.cols.map((c) => r[c])));
        count += rows.length;
        if (rows.length < CHUNK) break;
        last = rows[rows.length - 1].id as number;
      }
    }
    out.end(); await once(out, 'finish');
    await db.exec("UPDATE data_exports SET status='ready', row_count=?, file_path=?, completed_at=NOW(3) WHERE company_id=? AND id=?", [count, file, companyId, id]);
  } catch (e) {
    console.error('[export]', e);
    await db.exec("UPDATE data_exports SET status='failed', error=? WHERE company_id=? AND id=?", [(e as Error).message.slice(0, 180), companyId, id]);
  }
}
