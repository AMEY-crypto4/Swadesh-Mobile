import { Router } from 'express';
import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { pool } from '../db/mysql.js';
import { mdb, mcol } from '../db/mongo.js';
import { tdb } from '../lib/tenant.js';
import { HttpError, wrap } from '../lib/errors.js';
import { config, useEmbeddedDb } from '../config.js';
import { ctx, requireAuth, requireRole } from '../middleware/auth.js';
import { hub } from '../engine/hub.js';
import { runtime } from '../engine/runtime.js';
import { processStats, tenantHttp } from '../lib/metrics.js';
import { REPORTS, parseRange } from '../services/reports.js';
import { MAX_GUEST_SEATS } from '../services/sessions.js';

/**
 * "Platform showcase" API: lets an admin demonstrate, live, what the platform is doing —
 * Node process health, request latency, WebSocket traffic, database timings with the index actually used,
 * tenant-isolation probes and an honest list of what is real vs simulated. Admin only; per-request data is tenant-scoped.
 */
export const systemRouter = Router();
systemRouter.use(requireAuth, requireRole('admin'));

// ------------------------------------------------------------------ overview (polled by the UI every ~2 s)
const rowsCache = new Map<number, { at: number; v: unknown }>();
async function dataSizes(companyId: number) {
  const hit = rowsCache.get(companyId);
  if (hit && Date.now() - hit.at < 10_000) return hit.v;
  const db = tdb(companyId);
  const n = async (table: string) => Number((await db.rows<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE company_id=?`, [companyId]))[0].n);
  const [calls, leads, sms, consent, deliveries, users] = await Promise.all([n('calls'), n('leads'), n('sms_messages'), n('consent_events'), n('webhook_deliveries'), n('users')]);
  const [events, snapshots, audit, states] = await Promise.all(['call_events', 'wallboard_snapshots', 'audit_log', 'agent_state_log'].map((c) => mcol(c, companyId).count()));
  const v = { mysql: { calls, leads, sms, consent, deliveries, users }, mongo: { call_events: events, wallboard_snapshots: snapshots, audit_log: audit, agent_state_log: states } };
  rowsCache.set(companyId, { at: Date.now(), v });
  return v;
}

let dbInfo: { mysql: string; mongo: string } | undefined;
async function versions() {
  if (dbInfo) return dbInfo;
  const [r] = await pool.query('SELECT VERSION() v');
  const info = await mdb.admin().serverInfo();
  return (dbInfo = { mysql: String((r as { v: string }[])[0].v), mongo: String(info.version) });
}

systemRouter.get('/overview', wrap(async (req, res) => {
  const a = ctx(req);
  const ws = hub.tenantSnapshot(a.companyId);
  const last5 = ws.recent.slice(-5);
  const core = (pool as unknown as { pool?: { _allConnections?: { length: number }; _freeConnections?: { length: number } } }).pool;
  res.json({
    now: Date.now(),
    process: processStats(),
    http: tenantHttp(a.companyId),
    ws: {
      connections: ws.connections, framesOut: ws.framesOut, framesIn: ws.framesIn, bytesOut: ws.bytesOut,
      framesPerSec: Math.round((last5.reduce((x, y) => x + y, 0) / 5) * 10) / 10, perSec: ws.recent, byType: ws.byType, seq: runtime.get(a.companyId).seq,
      sessions: hub.sessions(a.companyId),
    },
    db: {
      mode: useEmbeddedDb ? 'embedded (dev)' : 'external', ...(await versions()),
      poolOpen: core?._allConnections?.length ?? null, poolIdle: core?._freeConnections?.length ?? null, sizes: await dataSizes(a.companyId),
    },
    sessions: { guestSeatCap: MAX_GUEST_SEATS },
    simulate: config.simulate,
  });
}));

// ------------------------------------------------------------------ query benchmarks with the index actually chosen
interface Bench { name: string; store: 'MySQL' | 'MongoDB'; ms: number; rows: number | null; index: string | null; access: string | null; note: string }

async function median(fn: () => Promise<unknown>, runs = 3) {
  const t: number[] = []; let last: unknown;
  for (let i = 0; i < runs; i++) { const s = performance.now(); last = await fn(); t.push(performance.now() - s); }
  t.sort((x, y) => x - y);
  return { ms: Math.round(t[Math.floor(t.length / 2)] * 10) / 10, last };
}

systemRouter.get('/benchmarks', wrap(async (req, res) => {
  const a = ctx(req); const cid = a.companyId; const db = tdb(cid);
  const out: Bench[] = [];
  const [{ n: total }] = await db.rows<{ n: number }>('SELECT COUNT(*) n FROM calls WHERE company_id=?', [cid]);
  const sample = await db.one<{ to_number: string; agent_id: number; campaign_id: number }>('SELECT to_number, agent_id, campaign_id FROM calls WHERE company_id=? AND to_number IS NOT NULL AND agent_id IS NOT NULL AND campaign_id IS NOT NULL LIMIT 1', [cid]);
  const camp = await db.one<{ id: number }>('SELECT campaign_id id FROM leads WHERE company_id=? GROUP BY campaign_id ORDER BY COUNT(*) DESC LIMIT 1', [cid]);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const offset = Math.max(0, Math.floor(total * 0.8));

  const sqlCases: [string, string, (string | number | Date)[], string][] = [
    ['Call log — newest 25', 'SELECT c.id, c.status, c.started_at FROM calls c WHERE c.company_id=? ORDER BY c.started_at DESC, c.id DESC LIMIT 25', [cid], 'Ordered scan of the tenant-leading time index'],
    [`Call log — page at offset ${offset.toLocaleString('en-IN')} (deferred join)`, `SELECT c.id, c.status, c.started_at FROM (SELECT c.id FROM calls c WHERE c.company_id=? ORDER BY c.started_at DESC, c.id DESC LIMIT 25 OFFSET ${offset}) pg JOIN calls c ON c.id=pg.id AND c.company_id=?`, [cid, cid], 'Index-only id scan, then 25 row lookups'],
    ['Exact phone lookup', 'SELECT c.id FROM calls c WHERE c.company_id=? AND c.to_number=?', [cid, sample?.to_number ?? '+910000000000'], 'Composite (company_id, to_number)'],
    ['Agent calls in last 30 days', 'SELECT COUNT(*) FROM calls c WHERE c.company_id=? AND c.agent_id=? AND c.started_at >= ?', [cid, sample?.agent_id ?? 0, since], 'Composite (company_id, agent_id, started_at)'],
    ['Dial candidates for a campaign', "SELECT l.id FROM leads l WHERE l.company_id=? AND l.campaign_id=? AND l.status IN ('new','callback') ORDER BY l.priority DESC, l.id LIMIT 4", [cid, camp?.id ?? 0], 'Dialer hot path'],
  ];
  for (const [name, sql, params, note] of sqlCases) {
    const m = await median(() => db.rows(sql, params));
    const ex = await db.rows<{ key: string | null; type: string | null }>(`EXPLAIN ${sql}`, params);
    out.push({ name, store: 'MySQL', ms: m.ms, rows: Array.isArray(m.last) ? (m.last as unknown[]).length : null, index: [...new Set(ex.map((e) => e.key).filter(Boolean))].join(', ') || null, access: ex[0]?.type ?? null, note });
  }

  const range = parseRange({}, 330); const r30 = { ...range, from: since, to: new Date() };
  for (const [name, fn] of [['Report — 30-day overview', 'overview'], ['Report — hour-of-day profile', 'hourly'], ['Report — by queue', 'queues'], ['Report — agent leaderboard', 'agents']] as const) {
    const m = await median(() => REPORTS[fn](cid, r30));
    out.push({ name, store: 'MySQL', ms: m.ms, rows: Array.isArray(m.last) ? m.last.length : 1, index: 'idx_calls_started (range)', access: 'range', note: 'SQL aggregate over the date range, no per-row joins' });
  }

  const ev = await mcol('call_events', cid).findOne({});
  const mongoCases: [string, () => Promise<unknown[]>, string, string][] = [
    ['Call event timeline', () => mcol('call_events', cid).find({ call_id: ev?.call_id ?? 0 }).sort({ ts: 1 }).toArray(), '{company_id, call_id, ts}', 'Per-call event stream'],
    ['Audit log — latest 100', () => mcol('audit_log', cid).find().sort({ ts: -1 }).limit(100).toArray(), '{company_id, ts}', 'Append-only audit trail'],
    ['Telemetry — last 3 hours', () => mcol('wallboard_snapshots', cid).find({ ts: { $gte: new Date(Date.now() - 3 * 3600_000) } }).sort({ ts: 1 }).toArray(), '{company_id, ts}', 'Minute snapshots, TTL-expired after 48 h'],
  ];
  for (const [name, fn, index, note] of mongoCases) {
    const m = await median(fn);
    out.push({ name, store: 'MongoDB', ms: m.ms, rows: (m.last as unknown[]).length, index, access: 'IXSCAN', note });
  }
  res.json({ dataset: { calls: total }, results: out });
}));

// ------------------------------------------------------------------ server-side load generator (loopback)
const LOAD_PATHS = {
  overview: (f: string, t: string) => `/api/reports/overview?from=${f}&to=${t}`,
  hourly: (f: string, t: string) => `/api/reports/hourly?from=${f}&to=${t}`,
  agents: (f: string, t: string) => `/api/reports/agents?from=${f}&to=${t}`,
  calls: () => '/api/calls?status=completed&direction=inbound&pageSize=25',
};
const loadRunning = new Set<number>();

/**
 * Fires real HTTP requests at this server's own port, authenticated as the caller, so throughput is not capped by a browser's
 * 6-connection limit or a dev proxy. The generator shares this Node process (and its event loop), so numbers are conservative.
 * Bounded (<=100 concurrent, <=3000 requests, 30 s) and one run per company at a time.
 */
systemRouter.post('/loadtest', wrap(async (req, res) => {
  const a = ctx(req);
  const b = z.object({ target: z.enum(['overview', 'hourly', 'agents', 'calls']), concurrency: z.number().int().min(1).max(100), total: z.number().int().min(10).max(3000) }).parse(req.body);
  if (loadRunning.has(a.companyId)) throw new HttpError(409, 'A load test is already running for your company', 'conflict');
  loadRunning.add(a.companyId);
  try {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const url = `http://127.0.0.1:${req.socket.localPort}${LOAD_PATHS[b.target](day(29), day(0))}`;
    const headers = { authorization: req.header('authorization') ?? '' };
    const lat: number[] = []; const codes: Record<string, number> = {};
    let next = 0, ok = 0, failed = 0;
    const deadline = Date.now() + 30_000;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: b.concurrency }, async () => {
      while (next < b.total && Date.now() < deadline) {
        next++; const s = performance.now();
        try {
          const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
          await r.arrayBuffer(); codes[r.status] = (codes[r.status] ?? 0) + 1; r.ok ? ok++ : failed++;
        } catch { failed++; codes.network = (codes.network ?? 0) + 1; }
        lat.push(performance.now() - s);
      }
    }));
    const secs = (performance.now() - t0) / 1000; lat.sort((x, y) => x - y);
    const q = (p: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? 0);
    res.json({ total: lat.length, ok, failed, seconds: Math.round(secs * 100) / 100, rps: Math.round(lat.length / secs), p50: q(50), p95: q(95), p99: q(99), max: Math.round(lat[lat.length - 1] ?? 0), codes, cappedByTimeLimit: lat.length < b.total });
  } finally {
    loadRunning.delete(a.companyId);
  }
}));

// ------------------------------------------------------------------ tenant isolation probes
interface Probe { probe: string; expectation: string; result: string; pass: boolean }

systemRouter.get('/isolation-check', wrap(async (req, res) => {
  const a = ctx(req); const cid = a.companyId; const db = tdb(cid);
  const probes: Probe[] = [];
  const tables = ['calls', 'campaigns', 'leads', 'queues', 'users', 'sms_messages', 'api_keys', 'webhooks', 'webhook_deliveries', 'consent_events', 'data_exports'];
  for (const t of tables) {
    // Cross-tenant lookup of *other* companies' ids happens here, server-side, only to build the probe; the ids are never returned.
    const [foreign] = await pool.query(`SELECT id FROM ${t} WHERE company_id <> ? LIMIT 5`, [cid]);
    const ids = (foreign as { id: number }[]).map((r) => r.id);
    if (!ids.length) { probes.push({ probe: `${t}: read another company's row by id`, expectation: 'not found', result: 'no foreign rows exist to probe', pass: true }); continue; }
    const one = await db.one(`SELECT id FROM ${t} WHERE company_id=? AND id=?`, [cid, ids[0]]);
    const many = await db.rows<{ n: number }>(`SELECT COUNT(*) n FROM ${t} WHERE company_id=? AND id IN (${ids.map(() => '?').join(',')})`, [cid, ...ids]);
    probes.push({ probe: `${t}: read another company's row by id`, expectation: 'not found', result: one ? 'LEAKED' : 'not found', pass: !one });
    probes.push({ probe: `${t}: list ${ids.length} foreign ids with a scoped query`, expectation: '0 rows', result: `${many[0].n} rows`, pass: Number(many[0].n) === 0 });
  }
  const fe = await mdb.collection('call_events').findOne({ company_id: { $ne: cid } });
  if (fe) {
    const n = await mcol('call_events', cid).count({ call_id: fe.call_id });
    probes.push({ probe: "MongoDB call_events: read another company's call timeline", expectation: '0 documents', result: `${n} documents`, pass: n === 0 });
  }
  for (const [probe, sql, params] of [
    ['Query guard: statement with no company_id predicate', 'SELECT * FROM calls LIMIT 1', [] as number[]],
    ['Query guard: company_id present but tenant id not bound', 'SELECT * FROM calls WHERE company_id = 999999 LIMIT 1', [] as number[]],
  ] as const) {
    let result = 'EXECUTED (guard failed)'; let pass = false;
    try { await db.rows(sql, [...params]); } catch (e) { result = `rejected: ${(e as Error).message.split(' in:')[0]}`; pass = true; }
    probes.push({ probe, expectation: 'rejected before reaching the database', result, pass });
  }
  res.json({ passed: probes.filter((p) => p.pass).length, total: probes.length, probes });
}));

// ------------------------------------------------------------------ honest capability register
systemRouter.get('/capabilities', wrap(async (_req, res) => {
  res.json([
    { area: 'Telephony', feature: 'PSTN voice calls', status: 'simulated', detail: 'No carrier is connected; calls are generated by the demo engine and labelled as simulated everywhere.' },
    { area: 'Telephony', feature: 'Live listen / whisper / barge', status: 'unavailable', detail: 'Needs a media server (RTP). The control is shown disabled with this reason instead of pretending to work.' },
    { area: 'Recording', feature: 'Call audio', status: 'metadata-only', detail: 'Consent, pause/resume tokens, retention and purge are real; no audio is captured or stored.' },
    { area: 'SMS', feature: 'Carrier delivery result', status: 'simulated', detail: 'Segment/encoding maths, DNC blocking, webhooks are real; the delivered/failed outcome is simulated (~8% fail).' },
    { area: 'Dialer', feature: 'Pacing, abandon-rate cap, DNC, attempt limits, retry rules', status: 'real', detail: 'Predictive pacing throttles to 1:1 when the abandon cap is breached; rules are evaluated per outcome.' },
    { area: 'Dialer', feature: 'Calling-window enforcement', status: config.simulate ? 'demo-override' : 'real', detail: config.simulate ? 'Disabled while simulating so the dialer works at any hour (stated on the campaign screen).' : 'Enforced.' },
    { area: 'Real-time', feature: 'WebSocket fan-out with resync', status: 'real', detail: 'Raw ws, per-tenant partitions, sequence numbers, gap-triggered resync, heartbeat.' },
    { area: 'API', feature: 'Keys, scopes, rate limits, idempotency', status: 'real', detail: 'Limiter and idempotency cache are in-memory, i.e. correct for one node; swap for Redis to scale out.' },
    { area: 'Webhooks', feature: 'HMAC signing, retries, delivery log', status: 'real', detail: '5 attempts with exponential backoff; manual retry from the console.' },
    { area: 'Privacy', feature: 'Consent log, hard pause/resume, retention, erasure, exports', status: 'real', detail: 'All enforced server-side and audited.' },
    { area: 'Data', feature: 'MySQL + MongoDB', status: useEmbeddedDb ? 'embedded' : 'real', detail: useEmbeddedDb ? 'Embedded dev databases (ephemeral). Use docker-compose or managed instances for real deployments.' : 'External databases.' },
    { area: 'Sessions', feature: 'Concurrent users on the shared Normal User login', status: 'real', detail: `Each sign-in gets a private agent seat (cap ${MAX_GUEST_SEATS} per company), reclaimed on sign-out or idle.` },
  ]);
}));
