import { Router } from 'express';
import { z } from 'zod';
import { tdb } from '../lib/tenant.js';
import { mcol } from '../db/mongo.js';
import { badRequest, notFound, wrap } from '../lib/errors.js';
import { ctx, requireAuth, requireRole } from '../middleware/auth.js';
import { overrideResume } from '../services/privacy.js';

export const callsRouter = Router();
callsRouter.use(requireAuth, requireRole('admin', 'supervisor'));

const q = z.object({
  page: z.coerce.number().int().min(1).max(5000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
  status: z.enum(['queued', 'ringing', 'in_progress', 'completed', 'abandoned', 'no_answer', 'busy', 'voicemail', 'failed']).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  queueId: z.coerce.number().int().positive().optional(),
  agentId: z.coerce.number().int().positive().optional(),
  campaignId: z.coerce.number().int().positive().optional(),
  disposition: z.string().max(30).optional(),
  phone: z.string().regex(/^\+?\d{4,15}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function filters(companyId: number, f: z.infer<typeof q>) {
  let where = 'c.company_id = ?'; const p: (string | number | Date)[] = [companyId];
  const add = (cond: string, ...v: (string | number | Date)[]) => { where += ` AND ${cond}`; p.push(...v); };
  if (f.status) add('c.status = ?', f.status);
  if (f.direction) add('c.direction = ?', f.direction);
  if (f.queueId) add('c.queue_id = ?', f.queueId);
  if (f.agentId) add('c.agent_id = ?', f.agentId);
  if (f.campaignId) add('c.campaign_id = ?', f.campaignId);
  if (f.disposition) add('c.disposition = ?', f.disposition);
  if (f.phone) add('(c.from_number = ? OR c.to_number = ?)', f.phone.startsWith('+') ? f.phone : `+${f.phone}`, f.phone.startsWith('+') ? f.phone : `+${f.phone}`);
  if (f.from) add('c.started_at >= ?', new Date(`${f.from}T00:00:00Z`));
  if (f.to) add('c.started_at < ?', new Date(Date.parse(`${f.to}T00:00:00Z`) + 86_400_000));
  return { where, p };
}

/** Server-side pagination; the default sort rides idx_calls_started so deep tenants stay fast. */
callsRouter.get('/', wrap(async (req, res) => {
  const a = ctx(req); const f = q.parse(req.query); const db = tdb(a.companyId);
  const { where, p } = filters(a.companyId, f);
  const [{ n }] = await db.rows<{ n: number }>(`SELECT COUNT(*) n FROM calls c WHERE ${where}`, p);
  const rows = await db.rows(
    `SELECT c.id, c.direction, c.status, c.disposition, c.from_number, c.to_number, c.started_at, c.wait_secs, c.talk_secs, c.wrap_secs,
            c.recording_consent, c.recording_state, c.queue_id, qu.name queue_name, c.agent_id, u.name agent_name, c.campaign_id
       FROM (SELECT c.id FROM calls c WHERE ${where} ORDER BY c.started_at DESC, c.id DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}) pg
       JOIN calls c ON c.id = pg.id AND c.company_id = ?
       LEFT JOIN queues qu ON qu.id=c.queue_id AND qu.company_id=c.company_id
       LEFT JOIN users u ON u.id=c.agent_id AND u.company_id=c.company_id
      ORDER BY c.started_at DESC, c.id DESC`, [...p, a.companyId]);
  res.json({ total: n, page: f.page, pageSize: f.pageSize, rows });
}));

callsRouter.get('/:id', wrap(async (req, res) => {
  const a = ctx(req); const id = Number(req.params.id); if (!Number.isInteger(id)) throw badRequest('Invalid id'); const db = tdb(a.companyId);
  const call = await db.one<any>(
    `SELECT c.*, qu.name queue_name, u.name agent_name, cp.name campaign_name FROM calls c
       LEFT JOIN queues qu ON qu.id=c.queue_id AND qu.company_id=c.company_id LEFT JOIN users u ON u.id=c.agent_id AND u.company_id=c.company_id
       LEFT JOIN campaigns cp ON cp.id=c.campaign_id AND cp.company_id=c.company_id WHERE c.company_id=? AND c.id=?`, [a.companyId, id]);
  if (!call) throw notFound('Call');
  const events = await mcol('call_events', a.companyId).find({ call_id: id }).sort({ ts: 1 }).project({ _id: 0, company_id: 0 }).toArray();
  const consent = await db.rows('SELECT type, actor, created_at FROM consent_events WHERE company_id=? AND call_id=? ORDER BY id', [a.companyId, id]);
  res.json({ ...call, events, consent });
}));

callsRouter.post('/:id/recording/override-resume', wrap(async (req, res) => {
  const a = ctx(req); const id = Number(req.params.id);
  if (!(await tdb(a.companyId).one('SELECT id FROM calls WHERE company_id=? AND id=?', [a.companyId, id]))) throw notFound('Call');
  await overrideResume(a.companyId, id, a.email);
  res.json({ ok: true });
}));
