import { Router } from 'express';
import { z } from 'zod';
import { tdb } from '../lib/tenant.js';
import { HttpError, wrap } from '../lib/errors.js';
import { ctx, requireAuth, requireRole } from '../middleware/auth.js';
import { runtime } from '../engine/runtime.js';
import { pauseRecording, resumeRecording, getSettings } from '../services/privacy.js';

export const agentRouter = Router();
agentRouter.use(requireAuth, requireRole('agent'));

const callId = z.coerce.number().int().positive();

agentRouter.get('/me', wrap(async (req, res) => {
  const a = ctx(req); const db = tdb(a.companyId);
  const settings = await getSettings(a.companyId);
  res.json({
    ...runtime.get(a.companyId).me(a.userId),
    dispositions: await db.rows('SELECT code, label, category FROM dispositions WHERE company_id=? ORDER BY category DESC, label', [a.companyId]),
    consentPrompt: settings.consent_prompt_text, pauseResumeEnabled: !!settings.allow_pause_resume,
  });
}));

agentRouter.get('/history', wrap(async (req, res) => {
  const a = ctx(req);
  res.json(await tdb(a.companyId).rows(
    `SELECT c.id, c.direction, c.status, c.disposition, IF(c.direction='inbound', c.from_number, c.to_number) customer, c.started_at, c.talk_secs, qu.name queue_name
       FROM calls c LEFT JOIN queues qu ON qu.id=c.queue_id AND qu.company_id=c.company_id
      WHERE c.company_id=? AND c.agent_id=? ORDER BY c.started_at DESC LIMIT 15`, [a.companyId, a.userId]));
}));

agentRouter.post('/state', wrap(async (req, res) => {
  const a = ctx(req); const b = z.object({ state: z.enum(['available', 'break', 'offline']), reason: z.string().max(40).optional() }).parse(req.body);
  await runtime.get(a.companyId).agentSetState(a.userId, b.state, b.reason);
  res.json({ ok: true });
}));

agentRouter.post('/calls/:id/answer', wrap(async (req, res) => { const a = ctx(req); await runtime.get(a.companyId).agentAnswer(a.userId, callId.parse(req.params.id)); res.json({ ok: true }); }));
agentRouter.post('/calls/:id/end', wrap(async (req, res) => { const a = ctx(req); await runtime.get(a.companyId).agentEnd(a.userId, callId.parse(req.params.id)); res.json({ ok: true }); }));
agentRouter.post('/calls/:id/disposition', wrap(async (req, res) => {
  const a = ctx(req); const b = z.object({ code: z.string().min(2).max(30), notes: z.string().max(500).optional() }).parse(req.body);
  await runtime.get(a.companyId).agentDisposition(a.userId, callId.parse(req.params.id), b.code, b.notes);
  res.json({ ok: true });
}));

function ownActiveCall(companyId: number, userId: number, id: number) {
  const c = runtime.get(companyId).getCall(id);
  if (!c || c.agentId !== userId || c.state !== 'in_progress') throw new HttpError(409, 'Not your active call', 'conflict');
}
agentRouter.post('/calls/:id/recording/pause', wrap(async (req, res) => {
  const a = ctx(req); const id = callId.parse(req.params.id); ownActiveCall(a.companyId, a.userId, id);
  res.json(await pauseRecording(a.companyId, id, a.email));
}));
agentRouter.post('/calls/:id/recording/resume', wrap(async (req, res) => {
  const a = ctx(req); const id = callId.parse(req.params.id); ownActiveCall(a.companyId, a.userId, id);
  const { token } = z.object({ token: z.string().min(8).max(64) }).parse(req.body);
  await resumeRecording(a.companyId, id, token, a.email);
  res.json({ ok: true });
}));

agentRouter.post('/demo-call', wrap(async (req, res) => { const a = ctx(req); await runtime.get(a.companyId).agentDemoCall(a.userId); res.json({ ok: true }); }));
agentRouter.post('/preview/next', wrap(async (req, res) => { const a = ctx(req); await runtime.get(a.companyId).agentPreviewNext(a.userId); res.json({ ok: true }); }));
agentRouter.post('/preview/dial', wrap(async (req, res) => { const a = ctx(req); await runtime.get(a.companyId).agentPreviewDial(a.userId); res.json({ ok: true }); }));
agentRouter.post('/preview/skip', wrap(async (req, res) => { const a = ctx(req); await runtime.get(a.companyId).agentPreviewSkip(a.userId); res.json({ ok: true }); }));
