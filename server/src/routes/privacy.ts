import { Router } from 'express';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import { tdb } from '../lib/tenant.js';
import { audit } from '../lib/audit.js';
import { HttpError, notFound, wrap } from '../lib/errors.js';
import { ctx, requireAuth, requireRole } from '../middleware/auth.js';
import { createExport, deletionPreview, executeDeletion, getSettings, retentionPreview, runRetention } from '../services/privacy.js';

export const privacyRouter = Router();
privacyRouter.use(requireAuth, requireRole('admin', 'supervisor'));
const adminOnly = requireRole('admin');

privacyRouter.get('/settings', wrap(async (req, res) => res.json(await getSettings(ctx(req).companyId))));

privacyRouter.put('/settings', adminOnly, wrap(async (req, res) => {
  const a = ctx(req);
  const b = z.object({
    retention_recordings_days: z.number().int().min(1).max(3650), retention_calls_days: z.number().int().min(7).max(3650), retention_sms_days: z.number().int().min(1).max(3650),
    consent_prompt_text: z.string().min(10).max(400), allow_pause_resume: z.boolean(),
  }).parse(req.body);
  if (b.retention_recordings_days > b.retention_calls_days) throw new HttpError(422, 'Recording retention cannot exceed call-record retention', 'validation_failed');
  await getSettings(a.companyId);
  await tdb(a.companyId).exec('UPDATE privacy_settings SET retention_recordings_days=?, retention_calls_days=?, retention_sms_days=?, consent_prompt_text=?, allow_pause_resume=? WHERE company_id=?',
    [b.retention_recordings_days, b.retention_calls_days, b.retention_sms_days, b.consent_prompt_text, b.allow_pause_resume ? 1 : 0, a.companyId]);
  await audit(a.companyId, a.email, 'privacy.settings_updated', undefined, b);
  res.json({ ok: true });
}));

privacyRouter.get('/consent-events', wrap(async (req, res) => {
  const a = ctx(req); const page = Math.max(1, Number(req.query.page) || 1); const db = tdb(a.companyId);
  let where = 'company_id=?'; const p: (string | number)[] = [a.companyId];
  if (req.query.type) { where += ' AND type=?'; p.push(String(req.query.type)); }
  if (req.query.callId) { where += ' AND call_id=?'; p.push(Number(req.query.callId)); }
  const [{ n }] = await db.rows<{ n: number }>(`SELECT COUNT(*) n FROM consent_events WHERE ${where}`, p);
  const rows = await db.rows(`SELECT id, call_id, subject_phone, type, actor, created_at FROM consent_events WHERE ${where} ORDER BY id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`, p);
  const summary = await db.rows('SELECT type, COUNT(*) n FROM consent_events WHERE company_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) GROUP BY type', [a.companyId]);
  res.json({ total: n, page, pageSize: 25, rows, summary });
}));

privacyRouter.get('/retention/preview', wrap(async (req, res) => res.json(await retentionPreview(ctx(req).companyId))));
privacyRouter.post('/retention/run', adminOnly, wrap(async (req, res) => {
  const a = ctx(req);
  res.json(await runRetention(a.companyId, a.email));
}));

privacyRouter.get('/exports', wrap(async (req, res) => {
  const a = ctx(req);
  res.json(await tdb(a.companyId).rows('SELECT e.id, e.type, e.params, e.status, e.row_count, e.error, e.created_at, e.completed_at, u.name requested_by FROM data_exports e LEFT JOIN users u ON u.id=e.requested_by AND u.company_id=e.company_id WHERE e.company_id=? ORDER BY e.id DESC LIMIT 30', [a.companyId]));
}));

privacyRouter.post('/exports', adminOnly, wrap(async (req, res) => {
  const a = ctx(req);
  const b = z.object({ type: z.enum(['calls', 'sms', 'consent', 'subject']), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), phone: z.string().optional() }).parse(req.body);
  const id = await createExport(a.companyId, a.userId, a.email, b.type, { from: b.from, to: b.to, phone: b.phone });
  res.status(202).json({ id, status: 'queued' });
}));

privacyRouter.get('/exports/:id/download', adminOnly, wrap(async (req, res) => {
  const a = ctx(req);
  const e = await tdb(a.companyId).one<{ status: string; file_path: string | null }>('SELECT status, file_path FROM data_exports WHERE company_id=? AND id=?', [a.companyId, Number(req.params.id)]);
  if (!e) throw notFound('Export');
  if (e.status !== 'ready' || !e.file_path) throw new HttpError(409, `Export is ${e.status}`, 'conflict');
  await access(e.file_path).catch(() => { throw new HttpError(410, 'Export file has expired', 'gone'); });
  await audit(a.companyId, a.email, 'export.downloaded', `export:${req.params.id}`);
  res.download(e.file_path, `export-${req.params.id}.csv`);
}));

privacyRouter.post('/deletions/preview', adminOnly, wrap(async (req, res) => {
  const { phone } = z.object({ phone: z.string() }).parse(req.body);
  res.json(await deletionPreview(ctx(req).companyId, phone));
}));
privacyRouter.post('/deletions', adminOnly, wrap(async (req, res) => {
  const a = ctx(req); const b = z.object({ phone: z.string(), confirm: z.literal(true) }).parse(req.body);
  res.status(201).json(await executeDeletion(a.companyId, b.phone, a.userId, a.email));
}));
privacyRouter.get('/deletions', wrap(async (req, res) => {
  const a = ctx(req);
  res.json(await tdb(a.companyId).rows('SELECT id, subject_phone, summary, created_at FROM deletion_requests WHERE company_id=? ORDER BY id DESC LIMIT 30', [a.companyId]));
}));
