import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { tdb } from '../lib/tenant.js';
import { audit } from '../lib/audit.js';
import { mcol } from '../db/mongo.js';
import { HttpError, badRequest, notFound, wrap } from '../lib/errors.js';
import { ctx, requireAuth, requireRole } from '../middleware/auth.js';
import { runtime } from '../engine/runtime.js';
import { E164 } from '../services/sms.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin', 'supervisor'));
const adminOnly = requireRole('admin');

const intParam = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id');
  return n;
};

/** Build "col=?, col=?" from a validated partial object, restricted to a whitelist. */
function setClause(data: Record<string, unknown>, allowed: string[]) {
  const cols = Object.keys(data).filter((k) => allowed.includes(k) && data[k] !== undefined);
  if (!cols.length) throw badRequest('Nothing to update');
  return { sql: cols.map((c) => `${c}=?`).join(', '), params: cols.map((c) => (typeof data[c] === 'object' && data[c] !== null ? JSON.stringify(data[c]) : data[c]) as never) };
}

// ------------------------------------------------------------------ users
adminRouter.get('/users', wrap(async (req, res) => {
  const a = ctx(req);
  res.json(await tdb(a.companyId).rows("SELECT id, name, email, role, status, extension, skills, is_bot FROM users WHERE company_id=? ORDER BY FIELD(role,'admin','supervisor','agent'), name", [a.companyId]));
}));

const userCreate = z.object({
  name: z.string().min(2).max(120), email: z.string().email().max(160), role: z.enum(['supervisor', 'agent']).default('agent'),
  extension: z.string().regex(/^\d{3,8}$/).optional(), skills: z.array(z.string().max(40)).max(10).default([]), password: z.string().min(10).max(100),
});
adminRouter.post('/users', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const b = userCreate.parse(req.body); const db = tdb(a.companyId);
  const exists = await tdb(a.companyId).one('SELECT id FROM users WHERE company_id=? AND email=?', [a.companyId, b.email.toLowerCase()]);
  if (exists) throw new HttpError(409, 'A user with this email already exists', 'conflict');
  const r = await db.exec('INSERT INTO users (company_id, email, name, password_hash, role, extension, skills) VALUES (?,?,?,?,?,?,?)', [a.companyId, b.email.toLowerCase(), b.name, await bcrypt.hash(b.password, 10), b.role, b.extension ?? null, JSON.stringify(b.skills)]);
  await audit(a.companyId, a.email, 'user.created', b.email);
  await runtime.reload(a.companyId);
  res.status(201).json({ id: r.insertId });
}));

adminRouter.patch('/users/:id', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const id = intParam(req.params.id);
  const b = z.object({ name: z.string().min(2).max(120), status: z.enum(['active', 'disabled']), skills: z.array(z.string().max(40)).max(10), extension: z.string().regex(/^\d{3,8}$/) }).partial().parse(req.body);
  if (id === a.userId && b.status === 'disabled') throw new HttpError(409, 'You cannot disable your own account', 'conflict');
  const s = setClause(b, ['name', 'status', 'skills', 'extension']);
  const r = await tdb(a.companyId).exec(`UPDATE users SET ${s.sql} WHERE company_id=? AND id=?`, [...s.params, a.companyId, id]);
  if (!r.affectedRows) throw notFound('User');
  await audit(a.companyId, a.email, 'user.updated', `user:${id}`, b);
  await runtime.reload(a.companyId);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ dispositions / dnc
adminRouter.get('/dispositions', wrap(async (req, res) => {
  const a = ctx(req);
  res.json(await tdb(a.companyId).rows('SELECT code, label, category FROM dispositions WHERE company_id=? ORDER BY category, label', [a.companyId]));
}));

adminRouter.get('/dnc', wrap(async (req, res) => {
  const a = ctx(req); const page = Math.max(1, Number(req.query.page) || 1);
  const db = tdb(a.companyId);
  const [{ n }] = await db.rows<{ n: number }>('SELECT COUNT(*) n FROM dnc_numbers WHERE company_id=?', [a.companyId]);
  res.json({ total: n, rows: await db.rows('SELECT phone, reason, created_at FROM dnc_numbers WHERE company_id=? ORDER BY created_at DESC LIMIT 50 OFFSET ?', [a.companyId, (page - 1) * 50]) });
}));
adminRouter.post('/dnc', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const b = z.object({ phone: z.string().regex(E164), reason: z.string().max(120).default('Added manually') }).parse(req.body);
  const db = tdb(a.companyId);
  await db.exec('INSERT IGNORE INTO dnc_numbers (company_id, phone, reason) VALUES (?,?,?)', [a.companyId, b.phone, b.reason]);
  await db.exec("UPDATE leads SET status='dnc' WHERE company_id=? AND phone=? AND status IN ('new','callback')", [a.companyId, b.phone]);
  await audit(a.companyId, a.email, 'dnc.added', `${b.phone.slice(0, 5)}••••${b.phone.slice(-3)}`);
  res.status(201).json({ ok: true });
}));
adminRouter.delete('/dnc/:phone', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const phone = String(req.params.phone);
  const r = await tdb(a.companyId).exec('DELETE FROM dnc_numbers WHERE company_id=? AND phone=?', [a.companyId, phone]);
  if (!r.affectedRows) throw notFound('Number');
  await audit(a.companyId, a.email, 'dnc.removed', `${phone.slice(0, 5)}••••${phone.slice(-3)}`);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ queues
adminRouter.get('/queues', wrap(async (req, res) => {
  const a = ctx(req); const db = tdb(a.companyId);
  const qs = await db.rows<any>('SELECT * FROM queues WHERE company_id=? ORDER BY name', [a.companyId]);
  const members = await db.rows<{ queue_id: number; user_id: number }>('SELECT queue_id, user_id FROM queue_members WHERE company_id=?', [a.companyId]);
  res.json(qs.map((q) => ({ ...q, members: members.filter((m) => m.queue_id === q.id).map((m) => m.user_id) })));
}));

const queueSchema = z.object({
  name: z.string().min(2).max(80), strategy: z.enum(['round_robin', 'longest_idle', 'least_calls', 'skills_based', 'ring_all']),
  sla_seconds: z.number().int().min(5).max(600), max_wait_seconds: z.number().int().min(15).max(1800), wrap_up_seconds: z.number().int().min(0).max(600),
  required_skill: z.string().max(40).nullable(), recording_consent_mode: z.enum(['none', 'announce', 'opt_in']), active: z.boolean(),
  members: z.array(z.number().int().positive()).max(500),
});

async function setMembers(companyId: number, queueId: number, userIds: number[]) {
  const db = tdb(companyId);
  if (userIds.length) {
    const ok = await db.rows<{ id: number }>(`SELECT id FROM users WHERE company_id=? AND role='agent' AND id IN (${userIds.map(() => '?').join(',')})`, [companyId, ...userIds]);
    if (ok.length !== new Set(userIds).size) throw badRequest('One or more members are not agents in your company');
  }
  await db.tx(async (t) => {
    await t.exec('DELETE FROM queue_members WHERE company_id=? AND queue_id=?', [companyId, queueId]);
    for (const u of new Set(userIds)) await t.exec('INSERT INTO queue_members (company_id, queue_id, user_id) VALUES (?,?,?)', [companyId, queueId, u]);
  });
}

adminRouter.post('/queues', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const b = queueSchema.partial({ strategy: true, sla_seconds: true, max_wait_seconds: true, wrap_up_seconds: true, required_skill: true, recording_consent_mode: true, active: true, members: true }).parse(req.body);
  const db = tdb(a.companyId);
  if (await db.one('SELECT id FROM queues WHERE company_id=? AND name=?', [a.companyId, b.name])) throw new HttpError(409, 'A queue with that name exists', 'conflict');
  const r = await db.exec('INSERT INTO queues (company_id, name, strategy, sla_seconds, max_wait_seconds, wrap_up_seconds, required_skill, recording_consent_mode) VALUES (?,?,?,?,?,?,?,?)',
    [a.companyId, b.name, b.strategy ?? 'longest_idle', b.sla_seconds ?? 20, b.max_wait_seconds ?? 90, b.wrap_up_seconds ?? 20, b.required_skill ?? null, b.recording_consent_mode ?? 'announce']);
  if (b.members) await setMembers(a.companyId, r.insertId, b.members);
  await audit(a.companyId, a.email, 'queue.created', b.name);
  await runtime.reload(a.companyId);
  res.status(201).json({ id: r.insertId });
}));

adminRouter.patch('/queues/:id', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const id = intParam(req.params.id); const b = queueSchema.partial().parse(req.body);
  const db = tdb(a.companyId);
  if (!(await db.one('SELECT id FROM queues WHERE company_id=? AND id=?', [a.companyId, id]))) throw notFound('Queue');
  const { members, ...rest } = b;
  if (Object.keys(rest).length) { const s = setClause(rest, ['name', 'strategy', 'sla_seconds', 'max_wait_seconds', 'wrap_up_seconds', 'required_skill', 'recording_consent_mode', 'active']); await db.exec(`UPDATE queues SET ${s.sql} WHERE company_id=? AND id=?`, [...s.params, a.companyId, id]); }
  if (members) await setMembers(a.companyId, id, members);
  await audit(a.companyId, a.email, 'queue.updated', `queue:${id}`, b);
  await runtime.reload(a.companyId);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ campaigns
adminRouter.get('/campaigns', wrap(async (req, res) => {
  const a = ctx(req); const db = tdb(a.companyId);
  const rows = await db.rows<any>('SELECT c.*, q.name queue_name FROM campaigns c JOIN queues q ON q.id=c.queue_id AND q.company_id=c.company_id WHERE c.company_id=? ORDER BY FIELD(c.status,\'running\',\'paused\',\'draft\',\'completed\'), c.id DESC', [a.companyId]);
  const leads = await db.rows<{ campaign_id: number; status: string; n: number }>('SELECT campaign_id, status, COUNT(*) n FROM leads WHERE company_id=? GROUP BY campaign_id, status', [a.companyId]);
  res.json(rows.map((c) => ({ ...c, leads: Object.fromEntries(leads.filter((l) => l.campaign_id === c.id).map((l) => [l.status, l.n])) })));
}));

adminRouter.get('/campaigns/:id', wrap(async (req, res) => {
  const a = ctx(req); const id = intParam(req.params.id); const db = tdb(a.companyId);
  const c = await db.one<any>('SELECT c.*, q.name queue_name FROM campaigns c JOIN queues q ON q.id=c.queue_id AND q.company_id=c.company_id WHERE c.company_id=? AND c.id=?', [a.companyId, id]);
  if (!c) throw notFound('Campaign');
  const rules = await db.rows('SELECT id, priority, outcome, action, action_param FROM dialer_rules WHERE company_id=? AND campaign_id=? ORDER BY priority', [a.companyId, id]);
  const leads = await db.rows<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM leads WHERE company_id=? AND campaign_id=? GROUP BY status', [a.companyId, id]);
  res.json({ ...c, rules, leads: Object.fromEntries(leads.map((l) => [l.status, l.n])), live: runtime.get(a.companyId).snapshot().campaigns.find((x) => x.id === id) ?? null });
}));

const campaignSchema = z.object({
  name: z.string().min(2).max(120), queue_id: z.number().int().positive(), mode: z.enum(['preview', 'progressive', 'predictive']),
  pacing_ratio: z.number().min(1).max(3), max_abandon_pct: z.number().min(0.5).max(5), max_attempts: z.number().int().min(1).max(10),
  retry_delay_minutes: z.number().int().min(1).max(1440), caller_id: z.string().regex(E164), ring_timeout_secs: z.number().int().min(10).max(60),
  call_window_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/), call_window_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/), dnc_check: z.boolean(),
});

adminRouter.post('/campaigns', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const b = campaignSchema.partial({ mode: true, pacing_ratio: true, max_abandon_pct: true, max_attempts: true, retry_delay_minutes: true, ring_timeout_secs: true, call_window_start: true, call_window_end: true, dnc_check: true }).parse(req.body);
  const db = tdb(a.companyId);
  if (!(await db.one('SELECT id FROM queues WHERE company_id=? AND id=?', [a.companyId, b.queue_id]))) throw badRequest('Unknown queue');
  const r = await db.exec('INSERT INTO campaigns (company_id, name, queue_id, mode, pacing_ratio, max_abandon_pct, max_attempts, retry_delay_minutes, caller_id, ring_timeout_secs, call_window_start, call_window_end, dnc_check) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [a.companyId, b.name, b.queue_id, b.mode ?? 'progressive', b.pacing_ratio ?? 1.5, b.max_abandon_pct ?? 3, b.max_attempts ?? 3, b.retry_delay_minutes ?? 30, b.caller_id, b.ring_timeout_secs ?? 25, b.call_window_start ?? '09:00', b.call_window_end ?? '20:00', b.dnc_check === false ? 0 : 1]);
  await audit(a.companyId, a.email, 'campaign.created', b.name);
  await runtime.reload(a.companyId);
  res.status(201).json({ id: r.insertId });
}));

adminRouter.patch('/campaigns/:id', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const id = intParam(req.params.id); const b = campaignSchema.partial().parse(req.body); const db = tdb(a.companyId);
  if (b.queue_id && !(await db.one('SELECT id FROM queues WHERE company_id=? AND id=?', [a.companyId, b.queue_id]))) throw badRequest('Unknown queue');
  const s = setClause(b, Object.keys(campaignSchema.shape));
  const r = await db.exec(`UPDATE campaigns SET ${s.sql} WHERE company_id=? AND id=?`, [...s.params, a.companyId, id]);
  if (!r.affectedRows) throw notFound('Campaign');
  await audit(a.companyId, a.email, 'campaign.updated', `campaign:${id}`, b);
  await runtime.reload(a.companyId);
  res.json({ ok: true });
}));

const TRANSITIONS: Record<string, string[]> = { draft: ['running'], running: ['paused', 'completed'], paused: ['running', 'completed'], completed: [] };
adminRouter.post('/campaigns/:id/status', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const id = intParam(req.params.id); const { status } = z.object({ status: z.enum(['running', 'paused', 'completed']) }).parse(req.body); const db = tdb(a.companyId);
  const c = await db.one<{ status: string; queue_id: number }>('SELECT status, queue_id FROM campaigns WHERE company_id=? AND id=?', [a.companyId, id]);
  if (!c) throw notFound('Campaign');
  if (!TRANSITIONS[c.status].includes(status)) throw new HttpError(409, `Cannot go from "${c.status}" to "${status}"`, 'conflict');
  if (status === 'running') {
    const [{ n }] = await db.rows<{ n: number }>("SELECT COUNT(*) n FROM leads WHERE company_id=? AND campaign_id=? AND status IN ('new','callback')", [a.companyId, id]);
    if (!n) throw new HttpError(409, 'Cannot start: this campaign has no dialable leads. Import leads first.', 'no_leads');
    const [{ m }] = await db.rows<{ m: number }>('SELECT COUNT(*) m FROM queue_members WHERE company_id=? AND queue_id=?', [a.companyId, c.queue_id]);
    if (!m) throw new HttpError(409, 'Cannot start: the campaign queue has no agents assigned.', 'no_agents');
  }
  await db.exec('UPDATE campaigns SET status=? WHERE company_id=? AND id=?', [status, a.companyId, id]);
  await audit(a.companyId, a.email, `campaign.${status}`, `campaign:${id}`);
  await runtime.reload(a.companyId);
  res.json({ ok: true, status });
}));

adminRouter.put('/campaigns/:id/rules', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const id = intParam(req.params.id); const db = tdb(a.companyId);
  const rules = z.array(z.object({ outcome: z.string().min(2).max(30), action: z.enum(['retry_after', 'mark_done', 'schedule_callback', 'add_to_dnc']), action_param: z.number().int().min(1).max(10080).nullable() })).max(30).parse(req.body);
  for (const r of rules) if ((r.action === 'retry_after' || r.action === 'schedule_callback') && !r.action_param) throw badRequest(`Rule "${r.outcome}" needs a minutes value`);
  if (!(await db.one('SELECT id FROM campaigns WHERE company_id=? AND id=?', [a.companyId, id]))) throw notFound('Campaign');
  await db.tx(async (t) => {
    await t.exec('DELETE FROM dialer_rules WHERE company_id=? AND campaign_id=?', [a.companyId, id]);
    let p = 1;
    for (const r of rules) await t.exec('INSERT INTO dialer_rules (company_id, campaign_id, priority, outcome, action, action_param) VALUES (?,?,?,?,?,?)', [a.companyId, id, p++, r.outcome, r.action, r.action_param]);
  });
  await audit(a.companyId, a.email, 'campaign.rules_updated', `campaign:${id}`);
  await runtime.reload(a.companyId);
  res.json({ ok: true });
}));

adminRouter.get('/campaigns/:id/leads', wrap(async (req, res) => {
  const a = ctx(req); const id = intParam(req.params.id); const db = tdb(a.companyId);
  const page = Math.max(1, Number(req.query.page) || 1); const size = 25;
  let where = 'company_id=? AND campaign_id=?'; const p: (string | number)[] = [a.companyId, id];
  if (req.query.status) { where += ' AND status=?'; p.push(String(req.query.status)); }
  if (req.query.q) { where += ' AND (phone LIKE ? OR first_name LIKE ?)'; p.push(`${String(req.query.q).replace(/[%_]/g, '')}%`, `${String(req.query.q).replace(/[%_]/g, '')}%`); }
  const [{ n }] = await db.rows<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE ${where}`, p);
  const rows = await db.rows(`SELECT id, first_name, last_name, phone, status, attempts, last_outcome, last_attempt_at, next_attempt_at FROM leads WHERE ${where} ORDER BY id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, p);
  res.json({ total: n, page, pageSize: size, rows });
}));

/** CSV text body: first_name,last_name,phone,email (header required). Max 5000 rows per import. */
adminRouter.post('/campaigns/:id/leads/import', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const id = intParam(req.params.id); const db = tdb(a.companyId);
  const { csv } = z.object({ csv: z.string().min(10).max(2_000_000) }).parse(req.body);
  if (!(await db.one('SELECT id FROM campaigns WHERE company_id=? AND id=?', [a.companyId, id]))) throw notFound('Campaign');
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.shift()!.toLowerCase().split(',').map((h) => h.trim());
  const idx = (k: string) => header.indexOf(k);
  if (idx('phone') < 0 || idx('first_name') < 0) throw badRequest('CSV header must include first_name and phone (optional: last_name, email)');
  if (lines.length > 5000) throw badRequest('Maximum 5000 rows per import');
  const dnc = new Set((await db.rows<{ phone: string }>('SELECT phone FROM dnc_numbers WHERE company_id=?', [a.companyId])).map((r) => r.phone));
  const result = { imported: 0, duplicates: 0, invalid: [] as { row: number; reason: string }[], dnc: 0 };
  const rows: unknown[][] = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const c = line.split(',').map((x) => x.trim());
    const phone = (c[idx('phone')] ?? '').replace(/[\s-]/g, '');
    if (!c[idx('first_name')]) return result.invalid.push({ row: i + 2, reason: 'first_name missing' });
    if (!E164.test(phone)) return result.invalid.push({ row: i + 2, reason: 'phone must be E.164 (+91…)' });
    if (dnc.has(phone)) { result.dnc++; return; }
    if (seen.has(phone)) { result.duplicates++; return; }
    seen.add(phone);
    rows.push([a.companyId, id, c[idx('first_name')].slice(0, 60), (c[idx('last_name')] ?? '').slice(0, 60) || null, phone, (c[idx('email')] ?? '').slice(0, 160) || null]);
  });
  for (const r of rows) {
    const x = await db.exec('INSERT IGNORE INTO leads (company_id, campaign_id, first_name, last_name, phone, email) VALUES (?,?,?,?,?,?)', r as never);
    if (x.affectedRows) result.imported++; else result.duplicates++;
  }
  await audit(a.companyId, a.email, 'leads.imported', `campaign:${id}`, { imported: result.imported });
  res.json({ ...result, invalid: result.invalid.slice(0, 20), invalidCount: result.invalid.length });
}));

// ------------------------------------------------------------------ audit
adminRouter.get('/audit', adminOnly, wrap(async (req, res) => {
  const a = ctx(req);
  const rows = await mcol('audit_log', a.companyId).find().sort({ ts: -1 }).limit(100).project({ _id: 0, company_id: 0 }).toArray();
  res.json(rows);
}));
