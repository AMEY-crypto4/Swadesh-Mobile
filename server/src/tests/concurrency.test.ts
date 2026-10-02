/**
 * Concurrent-user guarantees: many people on the shared "Normal User" login must never collide,
 * and several admins editing the same configuration must be told, not silently overwritten.
 */
process.env.SIMULATE = 'false';
process.env.MAX_GUEST_SEATS = '8';
process.env.LOGIN_RATE_LIMIT = '1000';

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { Stack } from '../boot.js';

let stack: Stack;
let base: string;
let pool: typeof import('../db/mysql.js').pool;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
const login = (email: string) => req('/api/auth/login', { body: { email, password: 'Demo@1234' } });

function listen(token: string) {
  const frames: any[] = [];
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', (m) => frames.push(JSON.parse(m.toString())));
  return { ws, frames, ready: async () => { for (let i = 0; i < 40 && !frames.some((f) => f.type === 'snapshot'); i++) await sleep(100); } };
}

before(async () => {
  const { boot } = await import('../boot.js');
  stack = await boot({ port: 0, seed: true });
  base = `http://127.0.0.1:${stack.port}`;
  pool = (await import('../db/mysql.js')).pool;
});
after(async () => { await stack?.stop(); });

test('every sign-in on the shared Normal User login gets its own private seat', async () => {
  const [a, b] = await Promise.all([login('user@aarav.test'), login('user@aarav.test')]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.json.user.id, b.json.user.id, 'distinct identities');
  assert.equal(a.json.user.role, 'agent'); assert.equal(a.json.user.seat, true);
  assert.match(a.json.user.email, /^guest-[0-9a-f]{12}@aarav\.session$/);

  // independent state machines
  assert.equal((await req('/api/agent/state', { token: a.json.token, body: { state: 'available' } })).status, 200);
  const meA = (await req('/api/agent/me', { token: a.json.token })).json;
  const meB = (await req('/api/agent/me', { token: b.json.token })).json;
  assert.equal(meA.agent.state, 'available');
  assert.equal(meB.agent.state, 'offline', "B is unaffected by A's status change");
  assert.ok(meA.queues.length > 0, 'seat inherits the template queue memberships');

  // a seat can never be signed into directly
  assert.equal((await login(a.json.user.email)).status, 401);
  // history is per seat
  const histB = (await req('/api/agent/history', { token: b.json.token })).json;
  assert.deepEqual(histB, [], 'a new seat starts with an empty history');
  for (const s of [a, b]) await req('/api/auth/logout', { token: s.json.token, body: {} }); // keep seats free for later tests
});

test('seat capacity is exact under a login stampede (row-locked, not best-effort)', async () => {
  // 12 parallel logins against a cap of 8 seats in a tenant that has none yet
  const results = await Promise.all(Array.from({ length: 12 }, () => login('user@kaveri.test')));
  const ok = results.filter((r) => r.status === 200);
  const full = results.filter((r) => r.status === 503);
  assert.equal(ok.length, 8, 'exactly the cap succeed');
  assert.equal(full.length, 4);
  assert.equal(full[0].json.error.code, 'capacity');
  assert.equal(new Set(ok.map((r) => r.json.user.id)).size, 8, 'all unique');
  const [{ n }] = (await pool.query("SELECT COUNT(*) n FROM users WHERE is_session=1 AND status='active' AND company_id=(SELECT id FROM companies WHERE slug='kaveri')"))[0] as { n: number }[];
  assert.equal(n, 8);

  // signing out frees a seat immediately
  const out = await req('/api/auth/logout', { method: 'POST', token: ok[0].json.token, body: {} });
  assert.equal(out.json.released, true);
  assert.equal((await req('/api/agent/me', { token: ok[0].json.token })).json.error.code, 'session_expired', 'a released seat\'s token is dead');
  assert.equal((await login('user@kaveri.test')).status, 200, 'the freed seat can be taken by someone new');
  // capacity is per company: Zenith is unaffected
  assert.equal((await login('user@zenith.test')).status, 200);
});

test('idle seats are reclaimed; seats that are online are not', async () => {
  const { _reapNow } = await import('../services/sessions.js');
  const idle = (await login('user@zenith.test')).json;
  const live = (await login('user@zenith.test')).json;
  const sock = listen(live.token); await sock.ready();
  await pool.query("UPDATE users SET last_seen_at = DATE_SUB(NOW(3), INTERVAL 2 HOUR) WHERE id IN (?, ?)", [idle.user.id, live.user.id]);
  await _reapNow();
  assert.equal((await req('/api/agent/me', { token: idle.token })).status, 401, 'idle seat reclaimed');
  assert.equal((await req('/api/agent/me', { token: live.token })).status, 200, 'connected seat kept');
  sock.ws.close();
});

test('WebSocket traffic is isolated per user and per tenant', async () => {
  const [a, b] = [(await login('user@aarav.test')).json, (await login('user@aarav.test')).json];
  const adminA = (await login('admin@aarav.test')).json;
  const adminZ = (await login('admin@zenith.test')).json;
  const sa = listen(a.token), sb = listen(b.token), sAdmin = listen(adminA.token), sZ = listen(adminZ.token);
  await Promise.all([sa.ready(), sb.ready(), sAdmin.ready(), sZ.ready()]);
  const markB = sb.frames.length, markZ = sZ.frames.length;

  await req('/api/agent/state', { token: a.token, body: { state: 'available' } });
  await sleep(1500);

  assert.ok(sa.frames.some((f) => f.type === 'me' && f.agent?.state === 'available'), "A is told about A's change");
  assert.ok(!sb.frames.slice(markB).some((f) => f.agent?.id === a.user.id), "B never receives A's agent state");
  assert.ok(sAdmin.frames.some((f) => f.type === 'agent.state' && f.agent.id === a.user.id && f.agent.state === 'available'), 'the same tenant\'s admin sees it live');
  assert.equal(sZ.frames.slice(markZ).filter((f) => f.type === 'agent.state' && f.agent?.id === a.user.id).length, 0, 'another tenant\'s admin sees nothing');
  for (const s of [sa, sb, sAdmin, sZ]) s.ws.close();
  for (const s of [a, b]) await req('/api/auth/logout', { token: s.token, body: {} });
});

test('WebSocket rejects unauthenticated sockets, bad tokens and reclaimed seats', async () => {
  const closed = (token: string | null) => new Promise<number>((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    ws.on('open', () => token !== null && ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('close', (code) => resolve(code));
  });
  assert.equal(await closed('garbage'), 4401);
  const g = (await login('user@aarav.test')).json;
  await req('/api/auth/logout', { token: g.token, body: {} });
  assert.equal(await closed(g.token), 4401, 'a reclaimed seat cannot reconnect');
});

test('optimistic locking: concurrent admin edits are detected, not silently overwritten', async () => {
  const admin1 = (await login('admin@aarav.test')).json.token;
  const admin2 = (await login('admin@aarav.test')).json.token;
  const queues = (await req('/api/queues', { token: admin1 })).json;
  const q = queues.find((x: any) => x.name === 'Sales');
  assert.ok(q.version >= 1);

  // both admins open the same queue (same version), then both save
  const first = await req(`/api/queues/${q.id}`, { token: admin1, method: 'PATCH', body: { sla_seconds: 25, version: q.version } });
  assert.equal(first.status, 200);
  const second = await req(`/api/queues/${q.id}`, { token: admin2, method: 'PATCH', body: { sla_seconds: 45, version: q.version } });
  assert.equal(second.status, 409); assert.equal(second.json.error.code, 'version_conflict');
  const after = (await req('/api/queues', { token: admin1 })).json.find((x: any) => x.id === q.id);
  assert.equal(after.sla_seconds, 25, "the loser's change was not applied");
  assert.equal(after.version, q.version + 1);
  // retrying with the fresh version succeeds
  assert.equal((await req(`/api/queues/${q.id}`, { token: admin2, method: 'PATCH', body: { sla_seconds: 45, version: after.version } })).status, 200);

  // the same on campaigns, including status changes made by someone else in between
  const camps = (await req('/api/campaigns', { token: admin1 })).json;
  const c = camps.find((x: any) => x.status === 'paused');
  const stale = c.version;
  assert.equal((await req(`/api/campaigns/${c.id}/status`, { token: admin1, body: { status: 'running' } })).status, 200);
  const conflict = await req(`/api/campaigns/${c.id}`, { token: admin2, method: 'PATCH', body: { max_attempts: 5, version: stale } });
  assert.equal(conflict.status, 409);
  assert.equal((await req(`/api/campaigns/${c.id}/status`, { token: admin1, body: { status: 'paused' } })).status, 200);
});

test('many users hammering the API at once: no errors, no cross-talk', async () => {
  const seats = await Promise.all(Array.from({ length: 5 }, async () => (await login('user@aarav.test')).json));
  const admin = (await login('admin@aarav.test')).json.token;
  const t0 = Date.now();
  const jobs: Promise<{ status: number }>[] = [];
  for (let i = 0; i < 40; i++) {
    jobs.push(req('/api/reports/overview', { token: admin }));
    jobs.push(req('/api/calls?pageSize=25', { token: admin }));
    jobs.push(req('/api/agent/me', { token: seats[i % seats.length].token }));
    jobs.push(req('/api/agent/history', { token: seats[(i + 1) % seats.length].token }));
  }
  const out = await Promise.all(jobs);
  assert.ok(out.every((r) => r.status === 200), `all 160 concurrent requests succeeded (${[...new Set(out.map((o) => o.status))]})`);
  assert.ok(Date.now() - t0 < 20_000, 'finished promptly');
  // every seat still sees only itself
  for (const s of seats) assert.equal((await req('/api/agent/me', { token: s.token })).json.agent.id, s.user.id);
  for (const s of seats) await req('/api/auth/logout', { token: s.token, body: {} });
});

test('platform showcase API: admin only, tenant-scoped, and the isolation probes all pass', async () => {
  const admin = (await login('admin@aarav.test')).json.token;
  const sup = (await login('supervisor@aarav.test')).json.token;
  const seat = (await login('user@aarav.test')).json.token;
  for (const t of [sup, seat]) assert.equal((await req('/api/system/overview', { token: t })).status, 403);
  assert.equal((await req('/api/system/overview')).status, 401);

  await req('/api/calls?pageSize=10', { token: admin });
  const ov = (await req('/api/system/overview', { token: admin })).json;
  assert.match(ov.process.node, /^v\d+/);
  assert.ok(ov.db.mysql && ov.db.mongo);
  assert.ok(ov.db.sizes.mysql.calls > 1000);
  assert.ok(ov.http.groups.some((g: any) => g.route.startsWith('GET /api/calls')), `route table has the call log: ${ov.http.groups.map((g: any) => g.route)}`);

  const iso = (await req('/api/system/isolation-check', { token: admin })).json;
  assert.ok(iso.total >= 20, `ran ${iso.total} probes`);
  assert.equal(iso.passed, iso.total, JSON.stringify(iso.probes.filter((p: any) => !p.pass)));
  assert.ok(iso.probes.some((p: any) => p.result.startsWith('rejected')), 'the query guard rejected unscoped SQL');

  const bm = (await req('/api/system/benchmarks', { token: admin })).json;
  assert.ok(bm.results.length >= 10);
  for (const r of bm.results.filter((x: any) => x.store === 'MySQL' && x.access !== 'range')) assert.ok(r.index, `${r.name} used an index`);
  assert.ok((await req('/api/system/capabilities', { token: admin })).json.some((c: any) => c.status === 'unavailable'));
});

test('server-side load generator: admin only, bounded, and the server really serves the burst', async () => {
  const admin = (await login('admin@aarav.test')).json.token;
  const sup = (await login('supervisor@aarav.test')).json.token;
  assert.equal((await req('/api/system/loadtest', { token: sup, body: { target: 'calls', concurrency: 5, total: 20 } })).status, 403);
  assert.equal((await req('/api/system/loadtest', { token: admin, body: { target: 'calls', concurrency: 1000, total: 20 } })).status, 422, 'concurrency is capped');
  assert.equal((await req('/api/system/loadtest', { token: admin, body: { target: 'nope', concurrency: 5, total: 20 } })).status, 422, 'target is a whitelist');

  const r = await req('/api/system/loadtest', { token: admin, body: { target: 'calls', concurrency: 20, total: 120 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 120); assert.equal(r.json.ok, 120); assert.equal(r.json.failed, 0);
  assert.deepEqual(r.json.codes, { 200: 120 });
  assert.ok(r.json.rps > 5 && r.json.p99 >= r.json.p50);

  // two runs for one company cannot overlap
  const [one, two] = await Promise.all([
    req('/api/system/loadtest', { token: admin, body: { target: 'overview', concurrency: 5, total: 60 } }),
    sleep(30).then(() => req('/api/system/loadtest', { token: admin, body: { target: 'overview', concurrency: 5, total: 60 } })),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
});
