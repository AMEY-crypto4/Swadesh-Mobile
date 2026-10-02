/**
 * Integration tests against real (embedded) MySQL + MongoDB with the seeded demo data.
 * They focus on the properties the product cannot afford to get wrong: tenant isolation,
 * privacy guarantees, API contract (auth / scopes / rate limits / idempotency) and index usage.
 */
process.env.SIMULATE = 'false';
process.env.EXPORT_DIR = 'data/test-exports';

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Stack } from '../boot.js';

let stack: Stack;
let base: string;
let pool: typeof import('../db/mysql.js').pool;
const tokens: Record<string, string> = {};

const KEY_A = 'swk_live_aarav_demo_7f3a9c1e5b2d4068a1f8';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(path: string, opts: { method?: string; token?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* csv etc */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(email: string) {
  const r = await req('/api/auth/login', { body: { email, password: 'Demo@1234' } });
  assert.equal(r.status, 200, `login ${email}`);
  return r.json.token as string;
}

const q = async <T = any>(sql: string, p: unknown[] = []) => ((await pool.query(sql, p))[0] as T[]);

before(async () => {
  const { boot } = await import('../boot.js');
  stack = await boot({ port: 0, seed: true });
  base = `http://127.0.0.1:${stack.port}`;
  pool = (await import('../db/mysql.js')).pool;
  // seeded webhooks point at PUBLIC_URL; aim them at this ephemeral test server
  await pool.query("UPDATE webhooks SET url = CONCAT(?, '/dev/webhook-sink/', (SELECT slug FROM companies WHERE id = webhooks.company_id)) WHERE url LIKE '%/dev/webhook-sink/%'", [base]);
  tokens.adminA = await login('admin@aarav.test');
  tokens.supA = await login('supervisor@aarav.test');
  tokens.agentA = await login('agent@aarav.test');
  tokens.adminB = await login('admin@zenith.test');
});

after(async () => { await stack?.stop(); });

// ---------------------------------------------------------------- auth
test('auth: wrong password and unknown user get the same 401; protected routes need a token; roles are enforced', async () => {
  const a = await req('/api/auth/login', { body: { email: 'admin@aarav.test', password: 'nope' } });
  const b = await req('/api/auth/login', { body: { email: 'ghost@aarav.test', password: 'nope' } });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.json.error.message, b.json.error.message, 'no user enumeration');
  assert.equal((await req('/api/queues')).status, 401);
  assert.equal((await req('/api/queues', { token: 'garbage' })).status, 401);
  assert.equal((await req('/api/developer/api-keys', { token: tokens.supA })).status, 403, 'supervisor is not admin');
  assert.equal((await req('/api/queues', { token: tokens.agentA })).status, 403, 'agent cannot use the console API');
  assert.equal((await req('/api/agent/me', { token: tokens.adminA })).status, 403, 'admin is not an agent');
});

// ---------------------------------------------------------------- tenant isolation
test('isolation: tenant A can never read or modify tenant B resources by id', async () => {
  const [bCall] = await q('SELECT id FROM calls WHERE company_id=(SELECT id FROM companies WHERE slug=?) LIMIT 1', ['zenith']);
  const [bCampaign] = await q('SELECT id, queue_id FROM campaigns WHERE company_id=(SELECT id FROM companies WHERE slug=?) LIMIT 1', ['zenith']);
  const [bUser] = await q("SELECT id FROM users WHERE company_id=(SELECT id FROM companies WHERE slug=?) AND role='agent' LIMIT 1", ['zenith']);
  const [bHook] = await q('SELECT id FROM webhooks WHERE company_id=(SELECT id FROM companies WHERE slug=?) LIMIT 1', ['zenith']);
  const [bKey] = await q('SELECT id FROM api_keys WHERE company_id=(SELECT id FROM companies WHERE slug=?) LIMIT 1', ['zenith']);
  const [bSms] = await q('SELECT id FROM sms_messages WHERE company_id=(SELECT id FROM companies WHERE slug=?) LIMIT 1', ['zenith']);
  const A = tokens.adminA;

  assert.equal((await req(`/api/calls/${bCall.id}`, { token: A })).status, 404);
  assert.equal((await req(`/api/campaigns/${bCampaign.id}`, { token: A })).status, 404);
  assert.equal((await req(`/api/campaigns/${bCampaign.id}/leads`, { token: A })).json.total, 0, 'leads of a foreign campaign are invisible');
  assert.equal((await req(`/api/campaigns/${bCampaign.id}/status`, { token: A, body: { status: 'paused' } })).status, 404);
  assert.equal((await req(`/api/queues/${bCampaign.queue_id}`, { token: A, method: 'PATCH', body: { name: 'hijacked' } })).status, 404);
  assert.equal((await req(`/api/users/${bUser.id}`, { token: A, method: 'PATCH', body: { status: 'disabled' } })).status, 404);
  assert.equal((await req(`/api/developer/webhooks/${bHook.id}`, { token: A, method: 'DELETE' })).status, 404);
  assert.equal((await req(`/api/developer/api-keys/${bKey.id}`, { token: A, method: 'DELETE' })).status, 404);
  assert.equal((await req(`/api/calls/${bCall.id}/recording/override-resume`, { token: A, body: {} })).status, 404);

  // Cross-tenant references inside A's own writes must be rejected, not silently accepted.
  const [aQueue] = await q('SELECT id FROM queues WHERE company_id=(SELECT id FROM companies WHERE slug=?) LIMIT 1', ['aarav']);
  assert.equal((await req(`/api/queues/${aQueue.id}`, { token: A, method: 'PATCH', body: { members: [bUser.id] } })).status, 400, 'foreign agent as queue member');
  assert.equal((await req('/api/campaigns', { token: A, body: { name: 'x-tenant', queue_id: bCampaign.queue_id, caller_id: '+912240001111' } })).status, 400, 'foreign queue for campaign');
  assert.equal((await req(`/api/calls?agentId=${bUser.id}`, { token: A })).json.total, 0, 'filtering by a foreign agent yields nothing');

  // Public API: key of A cannot see B's SMS.
  assert.equal((await req(`/v1/sms/${bSms.id}`, { key: KEY_A })).status, 404);
  const list = await req('/v1/sms?limit=100', { key: KEY_A });
  const ids = list.json.data.map((m: any) => m.id);
  const foreign = await q('SELECT id FROM sms_messages WHERE company_id=(SELECT id FROM companies WHERE slug=?)', ['zenith']);
  assert.ok(!foreign.some((f) => ids.includes(f.id)), 'SMS list never contains foreign rows');
});

test('isolation: list endpoints, reports and exports only ever contain the caller\'s tenant', async () => {
  const [{ id: aId }] = await q('SELECT id FROM companies WHERE slug=?', ['aarav']);
  const [{ id: bId }] = await q('SELECT id FROM companies WHERE slug=?', ['zenith']);
  const [{ n: nA }] = await q('SELECT COUNT(*) n FROM calls WHERE company_id=?', [aId]);
  const [{ n: nB }] = await q('SELECT COUNT(*) n FROM calls WHERE company_id=?', [bId]);
  assert.notEqual(nA, nB);
  assert.equal((await req('/api/calls', { token: tokens.adminA })).json.total, nA);
  assert.equal((await req('/api/calls', { token: tokens.adminB })).json.total, nB);

  const usersA = (await req('/api/users', { token: tokens.adminA })).json;
  assert.ok(usersA.every((u: any) => u.email.endsWith('@aarav.test')));
  const qs = (await req('/api/queues', { token: tokens.adminB })).json.map((x: any) => x.name);
  assert.ok(!qs.includes('Sales'), 'B does not see A queues');

  const range = { from: '2000-01-01', to: '2026-12-31' };
  const rep = await req(`/api/reports/overview?from=2026-01-01&to=2026-12-31`, { token: tokens.adminA });
  assert.equal(rep.json.totalCalls, nA, `overview totals match tenant A (${JSON.stringify(range)})`);

  // export of A contains zero rows from B
  const ex = await req('/api/privacy/exports', { token: tokens.adminA, body: { type: 'sms' } });
  assert.equal(ex.status, 202);
  let row: any;
  for (let i = 0; i < 40; i++) { [row] = await q('SELECT * FROM data_exports WHERE id=?', [ex.json.id]); if (row.status === 'ready') break; await sleep(250); }
  assert.equal(row.status, 'ready');
  const [{ n: smsA }] = await q('SELECT COUNT(*) n FROM sms_messages WHERE company_id=?', [aId]);
  assert.equal(row.row_count, smsA);
  const csv = await readFile(row.file_path, 'utf8');
  assert.equal(csv.trim().split('\r\n').length - 1, smsA, 'one CSV row per SMS of tenant A only');
  assert.equal((await req(`/api/privacy/exports/${ex.json.id}/download`, { token: tokens.adminB })).status, 404, 'tenant B cannot download A export');
  assert.equal((await req(`/api/privacy/exports/${ex.json.id}/download`, { token: tokens.adminA })).status, 200);
});

test('isolation: the tenant guard refuses unscoped SQL', async () => {
  const { tdb } = await import('../lib/tenant.js');
  const db = tdb(1);
  await assert.rejects(() => db.rows('SELECT * FROM calls LIMIT 1'), /Tenant guard/);
  await assert.rejects(() => db.rows('SELECT * FROM calls WHERE company_id = ? LIMIT 1', [2]), /not bound/);
  assert.throws(() => tdb(0), /Tenant context/);
});

// ---------------------------------------------------------------- public API
test('v1: auth, scopes, validation, DNC blocking', async () => {
  assert.equal((await req('/v1/sms')).status, 401);
  assert.equal((await req('/v1/sms', { key: 'swk_live_nope' })).status, 401);
  assert.equal((await req('/v1/account', { key: 'not-a-key' })).status, 401);

  const ok = await req('/v1/sms', { key: KEY_A, body: { to: '+919876500001', body: 'Hello' } });
  assert.equal(ok.status, 202); assert.equal(ok.json.status, 'queued'); assert.equal(ok.json.segments, 1);

  const bad = await req('/v1/sms', { key: KEY_A, body: { to: '9876500001', body: 'Hello' } });
  assert.equal(bad.status, 422); assert.equal(bad.json.error.code, 'validation_failed');

  // key with read-only scope cannot send
  const created = await req('/api/developer/api-keys', { token: tokens.adminA, body: { name: 'ro', scopes: ['sms:read'], rate_limit_per_min: 100 } });
  assert.equal(created.status, 201);
  assert.match(created.json.key, /^swk_live_/);
  assert.equal((await req('/v1/sms', { key: created.json.key, body: { to: '+919876500001', body: 'x' } })).status, 403);
  assert.equal((await req('/v1/sms', { key: created.json.key })).status, 200);
  const [row] = await q('SELECT key_hash FROM api_keys WHERE id=?', [created.json.id]);
  assert.notEqual(row.key_hash, created.json.key, 'only a hash is stored');

  // revoke takes effect immediately
  assert.equal((await req(`/api/developer/api-keys/${created.json.id}`, { token: tokens.adminA, method: 'DELETE' })).status, 200);
  assert.equal((await req('/v1/sms', { key: created.json.key })).status, 401);

  // DNC
  const [{ id: aId }] = await q('SELECT id FROM companies WHERE slug=?', ['aarav']);
  await pool.query("INSERT IGNORE INTO dnc_numbers (company_id, phone, reason) VALUES (?,?,'test')", [aId, '+919876500099']);
  const blocked = await req('/v1/sms', { key: KEY_A, body: { to: '+919876500099', body: 'spam' } });
  assert.equal(blocked.status, 422); assert.equal(blocked.json.error.code, 'recipient_blocked');
});

test('v1: per-key rate limit returns 429 with Retry-After and honest headers', async () => {
  const k = await req('/api/developer/api-keys', { token: tokens.adminA, body: { name: 'tiny-limit', scopes: ['sms:read'], rate_limit_per_min: 3 } });
  const statuses: number[] = [];
  let last: Awaited<ReturnType<typeof req>> | undefined;
  for (let i = 0; i < 5; i++) { last = await req('/v1/sms?limit=1', { key: k.json.key }); statuses.push(last.status); }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal(last!.headers.get('x-ratelimit-limit'), '3');
  assert.equal(last!.headers.get('x-ratelimit-remaining'), '0');
  assert.ok(Number(last!.headers.get('retry-after')) >= 1);
  assert.equal(last!.json.error.code, 'rate_limited');
  // another key is unaffected
  assert.equal((await req('/v1/sms?limit=1', { key: KEY_A })).status, 200);
});

test('v1: Idempotency-Key replays the original response instead of sending twice', async () => {
  const [{ id: aId }] = await q('SELECT id FROM companies WHERE slug=?', ['aarav']);
  const [{ n: before }] = await q('SELECT COUNT(*) n FROM sms_messages WHERE company_id=?', [aId]);
  const h = { 'idempotency-key': `test-${Date.now()}` };
  const a = await req('/v1/sms', { key: KEY_A, body: { to: '+919876500002', body: 'once' }, headers: h });
  const b = await req('/v1/sms', { key: KEY_A, body: { to: '+919876500002', body: 'once' }, headers: h });
  assert.equal(a.status, 202); assert.equal(b.status, 202);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.equal(a.json.id, b.json.id);
  const [{ n: after }] = await q('SELECT COUNT(*) n FROM sms_messages WHERE company_id=?', [aId]);
  assert.equal(after - before, 1);
});

// ---------------------------------------------------------------- webhooks
test('webhooks: SMS lifecycle is delivered to the endpoint, signed and verified', async () => {
  const [{ id: aId }] = await q('SELECT id FROM companies WHERE slug=?', ['aarav']);
  const [{ n: before }] = await q("SELECT COUNT(*) n FROM webhook_deliveries WHERE company_id=? AND status='success'", [aId]);
  const sent = await req('/v1/sms', { key: KEY_A, body: { to: '+919876500003', body: 'webhook me' } });
  assert.equal(sent.status, 202);
  let after = before;
  for (let i = 0; i < 40 && after <= before; i++) { await sleep(500); [{ n: after }] = await q("SELECT COUNT(*) n FROM webhook_deliveries WHERE company_id=? AND status='success'", [aId]); }
  assert.ok(after > before, 'a signed delivery succeeded (the sink returns 400 on a bad signature)');
  const sink = await req('/dev/webhook-sink/aarav/log');
  assert.ok(sink.json.length > 0 && sink.json.every((l: any) => l.verified), 'every received delivery verified');
});

test('webhooks: failing endpoint is retried with backoff (attempt 1 recorded, next attempt scheduled)', async () => {
  const hook = await req('/api/developer/webhooks', { token: tokens.adminA, body: { url: `${base}/dev/webhook-sink/fail`, events: ['call.completed'] } });
  assert.equal(hook.status, 201); assert.match(hook.json.secret, /^whsec_/);
  assert.equal((await req(`/api/developer/webhooks/${hook.json.id}/test`, { token: tokens.adminA, body: {} })).status, 200);
  let d: any;
  for (let i = 0; i < 30; i++) { await sleep(500); [d] = await q('SELECT * FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 1', [hook.json.id]); if (d?.attempts >= 1) break; }
  assert.equal(d.attempts, 1); assert.equal(d.status, 'pending'); assert.equal(d.response_code, 500);
  assert.ok(new Date(d.next_attempt_at).getTime() > Date.now(), 'retry scheduled in the future');
  // clean up so the worker stops hitting the failing sink
  await req(`/api/developer/webhooks/${hook.json.id}`, { token: tokens.adminA, method: 'DELETE' });
});

// ---------------------------------------------------------------- privacy
test('privacy: hard pause/resume token — wrong token denied, right token resumes once, override is audited', async () => {
  const { pauseRecording, resumeRecording, overrideResume } = await import('../services/privacy.js');
  const [{ id: aId }] = await q('SELECT id FROM companies WHERE slug=?', ['aarav']);
  const mk = async () => (await pool.query("INSERT INTO calls (company_id, direction, status, started_at, recording_consent, recording_state) VALUES (?, 'inbound', 'in_progress', NOW(3), 'announced', 'recording')", [aId]) as any)[0].insertId as number;
  const call = await mk();

  const { token } = await pauseRecording(aId, call, 'agent@aarav.test');
  assert.match(token, /^rpt_[0-9a-f]{24}$/);
  assert.equal((await q('SELECT recording_state s FROM calls WHERE id=?', [call]))[0].s, 'paused');
  await assert.rejects(() => pauseRecording(aId, call, 'x'), /nothing to pause/);
  await assert.rejects(() => resumeRecording(aId, call, 'rpt_wrong0000000000000000', 'agent@aarav.test'), /Invalid resume token/);
  assert.equal((await q('SELECT recording_state s FROM calls WHERE id=?', [call]))[0].s, 'paused', 'still paused after a bad token');
  await resumeRecording(aId, call, token, 'agent@aarav.test');
  assert.equal((await q('SELECT recording_state s FROM calls WHERE id=?', [call]))[0].s, 'recording');
  await assert.rejects(() => resumeRecording(aId, call, token, 'agent@aarav.test'), /No active pause/, 'token is single-use');

  const call2 = await mk();
  await pauseRecording(aId, call2, 'agent@aarav.test');
  await overrideResume(aId, call2, 'supervisor@aarav.test');
  const ev = await q('SELECT type, actor FROM consent_events WHERE call_id=? ORDER BY id', [call2]);
  assert.deepEqual(ev.map((e) => e.type), ['recording_paused', 'pause_override']);
  assert.equal(ev[1].actor, 'supervisor@aarav.test');
  const audit = await req('/api/audit', { token: tokens.adminA });
  assert.ok(audit.json.some((a: any) => a.action === 'recording.pause_override'));
  assert.ok(audit.json.some((a: any) => a.action === 'recording.resume_denied'));
});

test('privacy: retention purges expired data in the right tenant only', async () => {
  const { runRetention } = await import('../services/privacy.js');
  const [{ id: bId }] = await q('SELECT id FROM companies WHERE slug=?', ['kaveri']);
  const [{ id: aId }] = await q('SELECT id FROM companies WHERE slug=?', ['aarav']);
  // old rows in both tenants, 800 days ago (older than every retention window)
  for (const cid of [aId, bId]) {
    await pool.query("INSERT INTO calls (company_id, direction, status, started_at, ended_at, recording_state, recording_key) VALUES (?, 'inbound','completed', DATE_SUB(NOW(), INTERVAL 800 DAY), DATE_SUB(NOW(), INTERVAL 800 DAY), 'stopped', 'rec/old.opus')", [cid]);
    await pool.query("INSERT INTO sms_messages (company_id, from_number, to_number, body, created_at) VALUES (?, '+912200000000','+919800000000','old', DATE_SUB(NOW(), INTERVAL 800 DAY))", [cid]);
  }
  const [{ n: aBefore }] = await q('SELECT COUNT(*) n FROM calls WHERE company_id=?', [aId]);
  const out = await runRetention(bId, 'test');
  assert.ok(out.callsDeleted >= 1 && out.smsDeleted >= 1);
  assert.equal((await q("SELECT COUNT(*) n FROM calls WHERE company_id=? AND started_at < DATE_SUB(NOW(), INTERVAL 700 DAY)", [bId]))[0].n, 0, 'B expired calls gone');
  assert.equal((await q('SELECT COUNT(*) n FROM calls WHERE company_id=?', [aId]))[0].n, aBefore, 'A untouched');
  assert.ok((await q("SELECT COUNT(*) n FROM sms_messages WHERE company_id=? AND body='old'", [aId]))[0].n >= 1, 'A old SMS untouched');
  // recording retention (kaveri = 30 days): recordings older than that are purged but the call row remains for reporting
  const purged = await q("SELECT COUNT(*) n FROM calls WHERE company_id=? AND recording_state='purged'", [bId]);
  assert.ok(purged[0].n > 0, 'old recordings purged');
  assert.equal((await q("SELECT COUNT(*) n FROM calls WHERE company_id=? AND recording_state='purged' AND recording_key IS NOT NULL", [bId]))[0].n, 0, 'audio reference removed');
});

test('privacy: erasure anonymises one tenant\'s records for a number and leaves the same number in other tenants alone', async () => {
  const phone = '+919800077777';
  const [{ id: aId }] = await q('SELECT id FROM companies WHERE slug=?', ['aarav']);
  const [{ id: bId }] = await q('SELECT id FROM companies WHERE slug=?', ['zenith']);
  for (const cid of [aId, bId]) {
    await pool.query("INSERT INTO calls (company_id, direction, status, started_at, from_number, to_number, notes) VALUES (?, 'inbound','completed', NOW(3), ?, '+912240000000', 'sensitive')", [cid, phone]);
    await pool.query("INSERT INTO sms_messages (company_id, from_number, to_number, body) VALUES (?, '+912240000000', ?, 'secret')", [cid, phone]);
  }
  const prev = await req('/api/privacy/deletions/preview', { token: tokens.adminA, body: { phone } });
  assert.equal(prev.json.calls, 1); assert.equal(prev.json.sms, 1);
  assert.equal((await req('/api/privacy/deletions', { token: tokens.adminA, body: { phone } })).status, 422, 'explicit confirm required');
  const done = await req('/api/privacy/deletions', { token: tokens.adminA, body: { phone, confirm: true } });
  assert.equal(done.status, 201);
  assert.equal((await q('SELECT COUNT(*) n FROM calls WHERE company_id=? AND from_number=?', [aId, phone]))[0].n, 0);
  assert.equal((await q("SELECT COUNT(*) n FROM calls WHERE company_id=? AND notes='sensitive'", [aId]))[0].n, 0, 'notes cleared');
  assert.equal((await q('SELECT COUNT(*) n FROM sms_messages WHERE company_id=? AND to_number=?', [aId, phone]))[0].n, 0);
  assert.equal((await q('SELECT COUNT(*) n FROM dnc_numbers WHERE company_id=? AND phone=?', [aId, phone]))[0].n, 1, 'added to DNC');
  assert.equal((await q('SELECT COUNT(*) n FROM calls WHERE company_id=? AND from_number=?', [bId, phone]))[0].n, 1, 'other tenant untouched');
  assert.equal((await q('SELECT COUNT(*) n FROM sms_messages WHERE company_id=? AND to_number=?', [bId, phone]))[0].n, 1);
  const rec = await q('SELECT subject_phone, summary FROM deletion_requests WHERE company_id=?', [aId]);
  assert.ok(rec.every((r) => !String(r.subject_phone).includes('7777') || String(r.subject_phone).includes('•')), 'evidence record stores a masked number only');
});

// ---------------------------------------------------------------- campaigns / leads
test('campaigns: cannot start without dialable leads; CSV import validates, dedupes and honours DNC', async () => {
  const A = tokens.adminA;
  const [aQueue] = await q("SELECT id FROM queues WHERE company_id=(SELECT id FROM companies WHERE slug='aarav') AND name='Sales'");
  const c = await req('/api/campaigns', { token: A, body: { name: 'Integration test campaign', queue_id: aQueue.id, caller_id: '+912240001111' } });
  assert.equal(c.status, 201);
  const start = await req(`/api/campaigns/${c.json.id}/status`, { token: A, body: { status: 'running' } });
  assert.equal(start.status, 409); assert.equal(start.json.error.code, 'no_leads');
  assert.equal((await req(`/api/campaigns/${c.json.id}/status`, { token: A, body: { status: 'paused' } })).status, 409, 'draft -> paused is not a legal transition');

  const csv = ['first_name,last_name,phone,email', 'Asha,Rao,+919811100001,a@x.in', 'Asha,Rao,+919811100001,dup@x.in', 'Bad,Phone,12345,b@x.in', 'Dnc,Person,+919876500099,d@x.in', ',NoName,+919811100002,'].join('\n');
  const imp = await req(`/api/campaigns/${c.json.id}/leads/import`, { token: A, body: { csv } });
  assert.equal(imp.json.imported, 1); assert.equal(imp.json.duplicates, 1); assert.equal(imp.json.dnc, 1); assert.equal(imp.json.invalidCount, 2);
  assert.equal((await req(`/api/campaigns/${c.json.id}/status`, { token: A, body: { status: 'running' } })).status, 200);
  assert.equal((await req(`/api/campaigns/${c.json.id}/status`, { token: A, body: { status: 'completed' } })).status, 200);
  assert.equal((await req(`/api/campaigns/${c.json.id}/status`, { token: A, body: { status: 'running' } })).status, 409, 'completed is terminal');
});

// ---------------------------------------------------------------- reports + scale
test('reports: SQL aggregates agree with a direct count, and CSV export is well-formed', async () => {
  const [{ id: aId }] = await q('SELECT id FROM companies WHERE slug=?', ['aarav']);
  const r = await req('/api/reports/queues?from=2026-01-01&to=2026-12-31', { token: tokens.adminA });
  const total = r.json.reduce((s: number, x: any) => s + x.calls, 0);
  const [{ n }] = await q('SELECT COUNT(*) n FROM calls WHERE company_id=? AND queue_id IS NOT NULL', [aId]);
  assert.equal(total, n);
  const hourly = await req('/api/reports/hourly?from=2026-01-01&to=2026-12-31', { token: tokens.adminA });
  assert.equal(hourly.json.length, 24);
  const csv = await req('/api/reports/agents?from=2026-01-01&to=2026-12-31&format=csv', { token: tokens.adminA });
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.ok(csv.text.split('\r\n')[0].includes('name'));
  assert.equal((await req('/api/reports/nonsense', { token: tokens.adminA })).status, 400);
  assert.equal((await req('/api/reports/overview?from=garbage', { token: tokens.adminA })).status, 400);
});

test('scale: hot queries use composite tenant-leading indexes (no full scans)', async () => {
  const [{ id: aId }] = await q('SELECT id FROM companies WHERE slug=?', ['aarav']);
  const [camp] = await q('SELECT id FROM campaigns WHERE company_id=? LIMIT 1', [aId]);
  const cases: [string, string, unknown[]][] = [
    ['call log page', 'SELECT id FROM calls c WHERE c.company_id=? ORDER BY c.started_at DESC, c.id DESC LIMIT 25', [aId]],
    ['report date range', 'SELECT COUNT(*) FROM calls c WHERE c.company_id=? AND c.started_at >= ? AND c.started_at < ?', [aId, new Date('2026-09-01'), new Date('2026-10-30')]],
    ['by queue + range', 'SELECT COUNT(*) FROM calls c WHERE c.company_id=? AND c.queue_id=? AND c.started_at >= ?', [aId, 1, new Date('2026-09-01')]],
    ['by agent + range', 'SELECT COUNT(*) FROM calls c WHERE c.company_id=? AND c.agent_id=? AND c.started_at >= ?', [aId, 3, new Date('2026-09-01')]],
    ['phone lookup', 'SELECT id FROM calls c WHERE c.company_id=? AND c.to_number=?', [aId, '+919800000000']],
    ['dial candidates', "SELECT id FROM leads l WHERE l.company_id=? AND l.campaign_id=? AND l.status IN ('new','callback') ORDER BY l.priority DESC, l.id LIMIT 4", [aId, camp.id]],
    ['lead by phone', 'SELECT id FROM leads l WHERE l.company_id=? AND l.phone=?', [aId, '+919800000000']],
    ['due webhooks', "SELECT id FROM webhook_deliveries WHERE status='pending' AND next_attempt_at <= NOW(3) LIMIT 25", []],
    ['consent by call', 'SELECT id FROM consent_events WHERE company_id=? AND call_id=?', [aId, 1]],
  ];
  for (const [name, sql, params] of cases) {
    const rows = await q<any>(`EXPLAIN ${sql}`, params);
    for (const r of rows) {
      assert.notEqual(r.type, 'ALL', `${name}: full table scan on ${r.table} (key=${r.key})`);
      assert.ok(r.key, `${name}: no index chosen on ${r.table}`);
    }
  }
});
