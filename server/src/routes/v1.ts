import { Router } from 'express';
import { z } from 'zod';
import { tdb } from '../lib/tenant.js';
import { HttpError, notFound, wrap } from '../lib/errors.js';
import { apiKeyAuth, keyLimit, requireScope } from '../middleware/apiKeyAuth.js';
import { apiKeyRateLimit } from '../middleware/rateLimit.js';
import { E164, sendSms } from '../services/sms.js';
import { runtime } from '../engine/runtime.js';

/**
 * Public developer API.  Auth: Bearer API key → per-key sliding-window rate limit → scope check.
 * Every response is JSON; errors are { error: { code, message } }.
 */
export const v1Router = Router();
v1Router.use(apiKeyAuth, apiKeyRateLimit(keyLimit));

// Idempotency-Key support for POSTs (24h, per key). In-memory for single-node; use Redis when scaling out.
const idem = new Map<string, { at: number; status: number; body: unknown }>();
setInterval(() => { const cut = Date.now() - 86_400_000; for (const [k, v] of idem) if (v.at < cut) idem.delete(k); }, 3600_000).unref();

function withIdempotency(handler: (req: import('express').Request) => Promise<{ status: number; body: unknown }>) {
  return wrap(async (req, res) => {
    const k = req.header('idempotency-key');
    const key = k ? `${req.apiKey!.id}:${req.method}:${req.path}:${k.slice(0, 80)}` : null;
    if (key && idem.has(key)) { res.setHeader('Idempotent-Replay', 'true'); const h = idem.get(key)!; return res.status(h.status).json(h.body); }
    const out = await handler(req);
    if (key) idem.set(key, { at: Date.now(), ...out });
    res.status(out.status).json(out.body);
  });
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

v1Router.get('/account', wrap(async (req, res) => {
  res.json({ api_key: { id: req.apiKey!.id, name: req.apiKey!.name, scopes: req.apiKey!.scopes, rate_limit_per_min: keyLimit(req) }, company_id: req.apiKey!.companyId });
}));

// ---------------------------------------------------------------- SMS
const smsSchema = z.object({ to: z.string().regex(E164, 'to must be E.164, e.g. +919876543210'), body: z.string().min(1).max(1600), from: z.string().regex(E164).optional() });

v1Router.post('/sms', requireScope('sms:send'), withIdempotency(async (req) => {
  const b = smsSchema.parse(req.body); const cid = req.apiKey!.companyId;
  const dnc = await tdb(cid).one('SELECT phone FROM dnc_numbers WHERE company_id=? AND phone=?', [cid, b.to]);
  if (dnc) throw new HttpError(422, 'Recipient is on the do-not-contact list', 'recipient_blocked');
  const m = await sendSms(cid, req.apiKey!.id, b);
  return { status: 202, body: { id: m.id, object: 'sms', to: m.to, from: m.from, status: m.status, segments: m.segments, encoding: m.encoding } };
}));

const smsRow = (r: any) => ({ id: r.id, object: 'sms', direction: r.direction, to: r.to_number, from: r.from_number, body: r.body, status: r.status, segments: r.segments, error: r.error, created_at: iso(r.created_at) });

v1Router.get('/sms', requireScope('sms:read'), wrap(async (req, res) => {
  const cid = req.apiKey!.companyId; const { limit, starting_after, status } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), starting_after: z.coerce.number().int().positive().optional(), status: z.enum(['queued', 'sent', 'delivered', 'failed']).optional() }).parse(req.query);
  let where = 'company_id=?'; const p: (number | string)[] = [cid];
  if (starting_after) { where += ' AND id < ?'; p.push(starting_after); }
  if (status) { where += ' AND status=?'; p.push(status); }
  const rows = await tdb(cid).rows<any>(`SELECT * FROM sms_messages WHERE ${where} ORDER BY id DESC LIMIT ${limit + 1}`, p);
  res.json({ object: 'list', data: rows.slice(0, limit).map(smsRow), has_more: rows.length > limit });
}));

v1Router.get('/sms/:id', requireScope('sms:read'), wrap(async (req, res) => {
  const cid = req.apiKey!.companyId;
  const r = await tdb(cid).one<any>('SELECT * FROM sms_messages WHERE company_id=? AND id=?', [cid, Number(req.params.id)]);
  if (!r) throw notFound('SMS');
  res.json(smsRow(r));
}));

// ---------------------------------------------------------------- Voice
const callRow = (r: any) => ({ id: r.id, object: 'call', direction: r.direction, from: r.from_number, to: r.to_number, status: r.status, disposition: r.disposition, started_at: iso(r.started_at), answered_at: iso(r.answered_at), ended_at: iso(r.ended_at), duration_secs: r.talk_secs, agent_id: r.agent_id });

v1Router.post('/calls', requireScope('calls:write'), withIdempotency(async (req) => {
  const b = z.object({ to: z.string().regex(E164), agent_id: z.number().int().positive().optional() }).parse(req.body); const cid = req.apiKey!.companyId;
  if (await tdb(cid).one('SELECT phone FROM dnc_numbers WHERE company_id=? AND phone=?', [cid, b.to])) throw new HttpError(422, 'Recipient is on the do-not-contact list', 'recipient_blocked');
  const call = await runtime.get(cid).originate(b.to, b.agent_id);
  return { status: 202, body: { id: call.id, object: 'call', direction: 'outbound', to: call.to, from: call.from, status: 'ringing' } };
}));

v1Router.get('/calls', requireScope('calls:read'), wrap(async (req, res) => {
  const cid = req.apiKey!.companyId; const { limit, starting_after, status } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), starting_after: z.coerce.number().int().positive().optional(), status: z.string().max(20).optional() }).parse(req.query);
  let where = 'company_id=?'; const p: (number | string)[] = [cid];
  if (starting_after) { where += ' AND id < ?'; p.push(starting_after); }
  if (status) { where += ' AND status=?'; p.push(status); }
  const rows = await tdb(cid).rows<any>(`SELECT * FROM calls WHERE ${where} ORDER BY id DESC LIMIT ${limit + 1}`, p);
  res.json({ object: 'list', data: rows.slice(0, limit).map(callRow), has_more: rows.length > limit });
}));

v1Router.get('/calls/:id', requireScope('calls:read'), wrap(async (req, res) => {
  const cid = req.apiKey!.companyId;
  const r = await tdb(cid).one<any>('SELECT * FROM calls WHERE company_id=? AND id=?', [cid, Number(req.params.id)]);
  if (!r) throw notFound('Call');
  res.json(callRow(r));
}));
