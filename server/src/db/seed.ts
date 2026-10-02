import bcrypt from 'bcryptjs';
import { pool, connectMysql } from './mysql.js';
import { connectMongo, mdb, closeMongo } from './mongo.js';
import { migrate } from './migrate.js';
import { config } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { FIRST, LAST, expo, indianMobile, int, mulberry32, pick, weighted } from '../lib/rng.js';

export const DEMO_PASSWORD = 'Demo@1234';
const DAY = 86_400_000;
const IST = 330 * 60_000;

interface TenantSpec {
  name: string;
  slug: string;
  plan: 'starter' | 'growth' | 'enterprise';
  agents: number;
  historyCalls: number;
  scaleCalls: number;
  retentionRecordingsDays: number;
  queues: { name: string; strategy: string; sla: number; maxWait: number; wrap: number; consent: 'none' | 'announce' | 'opt_in'; inbound: number; skill?: string }[];
  campaigns: { name: string; queue: string; mode: 'preview' | 'progressive' | 'predictive'; status: 'draft' | 'running' | 'paused' | 'completed'; pacing: number }[];
  demoKey: string;
}

const TENANTS: TenantSpec[] = [
  {
    name: 'Aarav Insurance Services', slug: 'aarav', plan: 'enterprise', agents: 14, historyCalls: 30_000, scaleCalls: 150_000, retentionRecordingsDays: 90,
    queues: [
      { name: 'Sales', strategy: 'longest_idle', sla: 20, maxWait: 60, wrap: 20, consent: 'announce', inbound: 1.2 },
      { name: 'Support', strategy: 'round_robin', sla: 30, maxWait: 90, wrap: 25, consent: 'announce', inbound: 2.6 },
      { name: 'Renewals', strategy: 'least_calls', sla: 25, maxWait: 75, wrap: 20, consent: 'opt_in', inbound: 0.8 },
      { name: 'Claims (Hindi)', strategy: 'skills_based', sla: 40, maxWait: 120, wrap: 40, consent: 'announce', inbound: 1.0, skill: 'hindi' },
    ],
    campaigns: [
      { name: 'Term Life Cross-Sell – Oct', queue: 'Sales', mode: 'predictive', status: 'running', pacing: 1.8 },
      { name: 'Policy Renewal Reminders', queue: 'Renewals', mode: 'progressive', status: 'running', pacing: 1.0 },
      { name: 'Health Cover Lead Nurture', queue: 'Sales', mode: 'preview', status: 'paused', pacing: 1.0 },
      { name: 'Diwali Offer Launch', queue: 'Sales', mode: 'progressive', status: 'draft', pacing: 1.2 },
      { name: 'Q3 Win-Back', queue: 'Sales', mode: 'predictive', status: 'completed', pacing: 1.5 },
    ],
    demoKey: 'swk_live_aarav_demo_7f3a9c1e5b2d4068a1f8',
  },
  {
    name: 'Zenith Collections', slug: 'zenith', plan: 'growth', agents: 10, historyCalls: 12_000, scaleCalls: 80_000, retentionRecordingsDays: 60,
    queues: [
      { name: 'Early Bucket', strategy: 'longest_idle', sla: 30, maxWait: 90, wrap: 30, consent: 'announce', inbound: 0.6 },
      { name: 'Late Bucket', strategy: 'skills_based', sla: 30, maxWait: 90, wrap: 45, consent: 'opt_in', inbound: 0.4, skill: 'negotiation' },
      { name: 'Customer Care', strategy: 'round_robin', sla: 20, maxWait: 60, wrap: 20, consent: 'announce', inbound: 1.4 },
    ],
    campaigns: [
      { name: 'EMI Reminder – 1-30 DPD', queue: 'Early Bucket', mode: 'progressive', status: 'running', pacing: 1.0 },
      { name: 'Recovery – 90+ DPD', queue: 'Late Bucket', mode: 'preview', status: 'running', pacing: 1.0 },
      { name: 'Settlement Offers', queue: 'Late Bucket', mode: 'predictive', status: 'draft', pacing: 1.4 },
    ],
    demoKey: 'swk_live_zenith_demo_2c8e4b6a9d1f3075b3c7',
  },
  {
    name: 'Kaveri Healthcare', slug: 'kaveri', plan: 'starter', agents: 7, historyCalls: 6_000, scaleCalls: 20_000, retentionRecordingsDays: 30,
    queues: [
      { name: 'Appointments', strategy: 'longest_idle', sla: 20, maxWait: 60, wrap: 15, consent: 'opt_in', inbound: 1.5 },
      { name: 'Billing Desk', strategy: 'round_robin', sla: 45, maxWait: 120, wrap: 25, consent: 'announce', inbound: 0.7 },
    ],
    campaigns: [
      { name: 'Annual Health Check Recall', queue: 'Appointments', mode: 'progressive', status: 'running', pacing: 1.0 },
      { name: 'Vaccination Reminders', queue: 'Appointments', mode: 'progressive', status: 'paused', pacing: 1.0 },
    ],
    demoKey: 'swk_live_kaveri_demo_9d5b1e7c3a2f4081c6d2',
  },
];

const DISPOSITIONS: [string, string, 'positive' | 'neutral' | 'negative'][] = [
  ['sale_closed', 'Sale closed', 'positive'],
  ['interested', 'Interested – follow up', 'positive'],
  ['resolved', 'Issue resolved', 'positive'],
  ['info_provided', 'Information provided', 'neutral'],
  ['callback_requested', 'Callback requested', 'neutral'],
  ['already_customer', 'Already a customer', 'neutral'],
  ['not_interested', 'Not interested', 'negative'],
  ['wrong_number', 'Wrong number', 'negative'],
  ['complaint', 'Complaint raised', 'negative'],
  ['dnc_request', 'Do-not-call request', 'negative'],
];

const OUTBOUND_DISP: [string, number][] = [['sale_closed', 12], ['interested', 22], ['callback_requested', 18], ['not_interested', 33], ['wrong_number', 6], ['dnc_request', 3], ['already_customer', 6]];
const INBOUND_DISP: [string, number][] = [['resolved', 62], ['info_provided', 20], ['complaint', 10], ['callback_requested', 8]];

async function bulk(table: string, cols: string[], rows: unknown[][], size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    await pool.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ?`, [rows.slice(i, i + size)]);
  }
}

function istStartOfToday(now: number) {
  return Math.floor((now + IST) / DAY) * DAY - IST;
}

export async function seedAll(opts: { scale?: boolean } = {}) {
  const [{ n }] = (await pool.query('SELECT COUNT(*) n FROM companies'))[0] as { n: number }[];
  if (n > 0) {
    console.log('[seed] data already present, skipping');
    return;
  }
  const t0 = Date.now();
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 8);
  const now = Date.now();
  const histDays = opts.scale ? 120 : 60;

  for (let ti = 0; ti < TENANTS.length; ti++) {
    const spec = TENANTS[ti];
    const r = mulberry32(1000 + ti);
    const [cRes] = await pool.query('INSERT INTO companies (name, slug, plan) VALUES (?,?,?)', [spec.name, spec.slug, spec.plan]);
    const cid = (cRes as { insertId: number }).insertId;

    await pool.query(
      'INSERT INTO privacy_settings (company_id, retention_recordings_days) VALUES (?,?)',
      [cid, spec.retentionRecordingsDays],
    );
    await bulk('dispositions', ['company_id', 'code', 'label', 'category'], DISPOSITIONS.map((d) => [cid, ...d]));

    // ---- users ----
    const skillsPool = ['hindi', 'english', 'marathi', 'negotiation', 'upsell'];
    const userRows: unknown[][] = [
      [cid, `admin@${spec.slug}.test`, 'Asha Kulkarni (Admin)', passwordHash, 'admin', null, null, 0],
      [cid, `supervisor@${spec.slug}.test`, 'Rakesh Menon (Supervisor)', passwordHash, 'supervisor', null, null, 0],
      [cid, `agent@${spec.slug}.test`, 'Demo Agent (You)', passwordHash, 'agent', '2000', JSON.stringify(['english', 'hindi', 'negotiation']), 0],
    ];
    const used = new Set<string>();
    for (let i = 0; i < spec.agents - 1; i++) {
      let name: string, email: string;
      do {
        name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
        email = `${name.toLowerCase().replace(/\s+/g, '.')}@${spec.slug}.test`;
      } while (used.has(email));
      used.add(email);
      const skills = JSON.stringify([...new Set(['english', pick(r, skillsPool), pick(r, skillsPool)])]);
      userRows.push([cid, email, name, passwordHash, 'agent', String(2001 + i), skills, 1]);
    }
    await bulk('users', ['company_id', 'email', 'name', 'password_hash', 'role', 'extension', 'skills', 'is_bot'], userRows);
    const agents = (await pool.query("SELECT id, skills FROM users WHERE company_id=? AND role='agent' ORDER BY id", [cid]))[0] as { id: number; skills: string[] }[];

    // ---- queues + members ----
    const queueIds: Record<string, number> = {};
    const queueMeta: Record<string, TenantSpec['queues'][number]> = {};
    for (const q of spec.queues) {
      const [res] = await pool.query(
        'INSERT INTO queues (company_id,name,strategy,sla_seconds,max_wait_seconds,wrap_up_seconds,required_skill,recording_consent_mode,inbound_rate_per_min) VALUES (?,?,?,?,?,?,?,?,?)',
        [cid, q.name, q.strategy, q.sla, q.maxWait, q.wrap, q.skill ?? null, q.consent, q.inbound],
      );
      queueIds[q.name] = (res as { insertId: number }).insertId;
      queueMeta[q.name] = q;
    }
    const members: unknown[][] = [];
    const memberMap: Record<number, number[]> = {};
    for (const q of spec.queues) {
      const qid = queueIds[q.name];
      memberMap[qid] = [];
      agents.forEach((a, idx) => {
        const skillOk = !q.skill || (typeof a.skills === 'string' ? JSON.parse(a.skills) : a.skills).includes(q.skill) || idx === 0;
        const inQueue = skillOk && (r() < 0.62 || idx === 0);
        if (inQueue) {
          members.push([cid, qid, a.id, 1]);
          memberMap[qid].push(a.id);
        }
      });
      if (memberMap[qid].length < 3) {
        for (const a of agents.slice(0, 4)) if (!memberMap[qid].includes(a.id)) { members.push([cid, qid, a.id, 1]); memberMap[qid].push(a.id); }
      }
    }
    await bulk('queue_members', ['company_id', 'queue_id', 'user_id', 'priority'], members);

    // ---- campaigns, rules, leads ----
    const campaignIds: { id: number; queue: string; status: string; mode: string }[] = [];
    const callerId = `+9122${int(r, 40000000, 49999999)}`;
    for (const c of spec.campaigns) {
      const [res] = await pool.query(
        'INSERT INTO campaigns (company_id,name,queue_id,mode,status,pacing_ratio,max_abandon_pct,caller_id) VALUES (?,?,?,?,?,?,3.0,?)',
        [cid, c.name, queueIds[c.queue], c.mode, c.status, c.pacing, callerId],
      );
      const id = (res as { insertId: number }).insertId;
      campaignIds.push({ id, queue: c.queue, status: c.status, mode: c.mode });
      await bulk('dialer_rules', ['company_id', 'campaign_id', 'priority', 'outcome', 'action', 'action_param'], [
        [cid, id, 1, 'dnc_request', 'add_to_dnc', null],
        [cid, id, 2, 'callback_requested', 'schedule_callback', 60],
        [cid, id, 3, 'busy', 'retry_after', 15],
        [cid, id, 4, 'no_answer', 'retry_after', 30],
        [cid, id, 5, 'voicemail', 'retry_after', 240],
        [cid, id, 6, 'failed', 'mark_done', null],
        [cid, id, 7, 'sale_closed', 'mark_done', null],
        [cid, id, 8, 'wrong_number', 'add_to_dnc', null],
      ]);
      if (c.status === 'draft') continue;
      const leadCount = opts.scale ? 15_000 : c.status === 'running' ? (ti === 0 ? 2_500 : 1_500) : 800;
      const phones = new Set<string>();
      const leadRows: unknown[][] = [];
      while (leadRows.length < leadCount) {
        const phone = indianMobile(r);
        if (phones.has(phone)) continue;
        phones.add(phone);
        const first = pick(r, FIRST), last = pick(r, LAST);
        let status = 'new', attempts = 0, outcome: string | null = null, lastAt: Date | null = null;
        if (c.status === 'completed') {
          status = weighted(r, [['done', 70], ['exhausted', 22], ['dnc', 8]] as const); attempts = int(r, 1, 3);
          outcome = status === 'dnc' ? 'dnc_request' : 'not_interested'; lastAt = new Date(now - int(r, 5, 40) * DAY);
        } else if (r() < 0.38) {
          status = weighted(r, [['done', 30], ['exhausted', 25], ['callback', 15], ['dnc', 5], ['contacted', 25]] as const); attempts = int(r, 1, 3);
          outcome = status === 'dnc' ? 'dnc_request' : status === 'callback' ? 'callback_requested' : weighted(r, [['no_answer', 4], ['voicemail', 2], ['interested', 3]] as const);
          lastAt = new Date(now - int(r, 1, 20) * DAY);
        }
        leadRows.push([cid, id, first, last, phone, `${first}.${last}${int(r, 1, 99)}@example.in`.toLowerCase(), status, attempts, int(r, 1, 9), outcome, lastAt, status === 'callback' ? new Date(now + int(r, 1, 48) * 3600_000) : null]);
      }
      await bulk('leads', ['company_id', 'campaign_id', 'first_name', 'last_name', 'phone', 'email', 'status', 'attempts', 'priority', 'last_outcome', 'last_attempt_at', 'next_attempt_at'], leadRows);
    }
    const dncLeads = (await pool.query("SELECT phone FROM leads WHERE company_id=? AND status='dnc' LIMIT 400", [cid]))[0] as { phone: string }[];
    if (dncLeads.length) await bulk('dnc_numbers', ['company_id', 'phone', 'reason'], [...new Map(dncLeads.map((d) => [d.phone, [cid, d.phone, 'Customer request']])).values()]);

    // ---- call history ----
    const n = opts.scale ? spec.scaleCalls : spec.historyCalls;
    const today0 = istStartOfToday(now);
    const hourW: [number, number][] = [[9, 6], [10, 10], [11, 12], [12, 8], [13, 6], [14, 9], [15, 11], [16, 10], [17, 8], [18, 5], [19, 3], [20, 1]];
    const inboundWeights = spec.queues.map((q) => [q.name, q.inbound || 0.1] as [string, number]);
    const runningCamps = campaignIds.filter((c) => c.status !== 'draft');
    const agentQuality = new Map(agents.map((a, i) => [a.id, 0.7 + ((i * 37) % 10) / 16]));
    const callRows: unknown[][] = [];
    for (let i = 0; i < n; i++) {
      const d = weighted(r, Array.from({ length: histDays }, (_, k) => [k, (k % 7 === 5 || k % 7 === 6 ? 0.35 : 1) * (1.4 - k / histDays)] as [number, number]));
      const hour = weighted(r, hourW);
      let ts = today0 - d * DAY + hour * 3600_000 + Math.floor(r() * 3600_000);
      if (ts > now - 120_000) ts -= DAY;
      const inbound = r() < 0.55;
      let qName: string, campaignId: number | null = null, leadNo = indianMobile(r);
      if (inbound) qName = weighted(r, inboundWeights);
      else { const c = pick(r, runningCamps); qName = c.queue; campaignId = c.id; }
      const q = queueMeta[qName], qid = queueIds[qName];
      const agentId = pick(r, memberMap[qid]);
      const qual = agentQuality.get(agentId) ?? 1;
      let status: string, answered: number | null = null, wait = 0, talk = 0, wrap = 0, disp: string | null = null, ended: number;
      if (inbound) {
        wait = Math.min(Math.round(expo(r, 16)), q.maxWait + 20);
        if (wait > q.maxWait || r() < 0.04) { status = 'abandoned'; ended = ts + wait * 1000; wait = Math.min(wait, q.maxWait); }
        else {
          status = 'completed'; answered = ts + wait * 1000; talk = Math.round(60 + expo(r, 200 * qual)); wrap = int(r, 8, q.wrap + 15);
          disp = weighted(r, INBOUND_DISP); ended = answered + talk * 1000;
        }
      } else {
        const camp = campaignIds.find((c) => c.id === campaignId)!;
        status = weighted(r, [['completed', 38], ['no_answer', 27], ['busy', 9], ['voicemail', 13], ['failed', 4], ['abandoned', camp.mode === 'predictive' ? 2.5 : 0.2]] as const);
        const ring = int(r, 6, 25);
        if (status === 'completed') {
          wait = int(r, 0, 4); answered = ts + ring * 1000; talk = Math.round(35 + expo(r, 130 * qual)); wrap = int(r, 8, q.wrap + 15);
          disp = weighted(r, OUTBOUND_DISP.map(([k, w]) => [k, k === 'sale_closed' ? w * qual : w] as [string, number])); ended = answered + talk * 1000;
        } else ended = ts + ring * 1000;
      }
      const hasAgent = status === 'completed';
      let consent: string = 'not_required', recState: string = 'none', recKey: string | null = null;
      if (hasAgent && q.consent !== 'none') {
        if (q.consent === 'opt_in' && r() < 0.12) consent = 'declined';
        else { consent = q.consent === 'opt_in' ? 'granted' : 'announced'; recState = 'stopped'; }
      }
      callRows.push([cid, inbound ? 'inbound' : 'outbound', campaignId, qid, null, hasAgent ? agentId : null, inbound ? leadNo : callerId, inbound ? callerId : leadNo, status, disp, new Date(ts), answered ? new Date(answered) : null, new Date(ended), wait, talk, wrap, consent, recState, recKey]);
    }
    callRows.sort((x, y) => (x[10] as Date).getTime() - (y[10] as Date).getTime()); // auto-increment ids follow time, as in production
    await bulk('calls', ['company_id', 'direction', 'campaign_id', 'queue_id', 'lead_id', 'agent_id', 'from_number', 'to_number', 'status', 'disposition', 'started_at', 'answered_at', 'ended_at', 'wait_secs', 'talk_secs', 'wrap_secs', 'recording_consent', 'recording_state', 'recording_key'], callRows, 2000);
    await pool.query("UPDATE calls SET recording_key = CONCAT('rec/', company_id, '/', DATE_FORMAT(started_at,'%Y/%m'), '/', id, '.opus') WHERE company_id=? AND recording_state='stopped'", [cid]);

    // ---- consent events (last 14 days) ----
    const recent = (await pool.query("SELECT id, from_number, to_number, direction, recording_consent, started_at FROM calls WHERE company_id=? AND recording_consent <> 'not_required' AND started_at > ? LIMIT 6000", [cid, new Date(now - 14 * DAY)]))[0] as { id: number; from_number: string; to_number: string; direction: string; recording_consent: string; started_at: Date }[];
    const ce: unknown[][] = [];
    for (const c of recent) {
      const subject = c.direction === 'inbound' ? c.from_number : c.to_number;
      ce.push([cid, c.id, subject, 'prompt_played', 'system', c.started_at]);
      ce.push([cid, c.id, subject, c.recording_consent === 'declined' ? 'declined' : 'granted', c.recording_consent === 'announced' ? 'system' : 'caller', c.started_at]);
    }
    await bulk('consent_events', ['company_id', 'call_id', 'subject_phone', 'type', 'actor', 'created_at'], ce, 2000);

    // ---- SMS history ----
    const smsRows: unknown[][] = [];
    const smsBodies = ['Your policy renewal is due on {d}. Pay now: https://pay.example.in/r/{n}', 'OTP {n} for your login. Valid for 5 minutes. Do not share.', 'Your appointment is confirmed for {d}. Reply 1 to confirm, 2 to reschedule.', 'EMI of Rs.{n} is due. Pay by {d} to avoid late fee.', 'Thank you for contacting us. Your ticket #{n} has been resolved.'];
    const smsCount = opts.scale ? 8000 : ti === 0 ? 3000 : 800;
    for (let i = 0; i < smsCount; i++) {
      const body = pick(r, smsBodies).replace('{d}', `${int(r, 1, 28)} Oct`).replace(/\{n\}/g, String(int(r, 1000, 99999)));
      const status = weighted(r, [['delivered', 90], ['sent', 4], ['failed', 6]] as const);
      smsRows.push([cid, 'outbound', callerId, indianMobile(r), body, Math.ceil(body.length / 153) || 1, status, status === 'failed' ? 'Carrier rejected (DND registry)' : null, new Date(now - Math.floor(r() * histDays * DAY))]);
    }
    await bulk('sms_messages', ['company_id', 'direction', 'from_number', 'to_number', 'body', 'segments', 'status', 'error', 'created_at'], smsRows, 2000);

    // ---- developer platform ----
    await pool.query('INSERT INTO api_keys (company_id,name,prefix,key_hash,scopes,rate_limit_per_min) VALUES (?,?,?,?,?,?)', [cid, 'Demo integration key', spec.demoKey.slice(0, 18), sha256(spec.demoKey), JSON.stringify(['sms:send', 'sms:read', 'calls:write', 'calls:read']), 60]);
    await pool.query('INSERT INTO api_keys (company_id,name,prefix,key_hash,scopes,rate_limit_per_min,revoked_at) VALUES (?,?,?,?,?,?,NOW(3))', [cid, 'Old CRM sync (revoked)', 'swk_live_old_crm_', sha256(`old-${cid}`), JSON.stringify(['sms:read']), 30]);
    await pool.query('INSERT INTO webhooks (company_id,url,secret,events) VALUES (?,?,?,?)', [cid, `${config.publicUrl}/dev/webhook-sink/${spec.slug}`, `whsec_demo_${spec.slug}`, JSON.stringify(['call.completed', 'sms.delivered', 'sms.failed'])]);
    await pool.query('INSERT INTO webhooks (company_id,url,secret,events,active) VALUES (?,?,?,?,0)', [cid, 'https://crm.example.in/hooks/swadesh', `whsec_demo_crm_${spec.slug}`, JSON.stringify(['call.completed'])]);

    // ---- Mongo: event timelines for the most recent finished calls + telemetry history ----
    const last = (await pool.query("SELECT id, direction, status, started_at, answered_at, ended_at, recording_consent FROM calls WHERE company_id=? AND ended_at < ? ORDER BY started_at DESC LIMIT 300", [cid, new Date(now - 60_000)]))[0] as { id: number; direction: string; status: string; started_at: Date; answered_at: Date | null; ended_at: Date; recording_consent: string }[];
    const events = last.flatMap((c) => {
      const ev: Record<string, unknown>[] = [{ company_id: cid, call_id: c.id, type: c.direction === 'inbound' ? 'call.queued' : 'call.dialing', ts: c.started_at }];
      if (c.answered_at) {
        ev.push({ company_id: cid, call_id: c.id, type: 'call.answered', ts: c.answered_at });
        if (c.recording_consent !== 'not_required') ev.push({ company_id: cid, call_id: c.id, type: `consent.${c.recording_consent}`, ts: c.answered_at });
      }
      ev.push({ company_id: cid, call_id: c.id, type: `call.${c.status}`, ts: c.ended_at });
      return ev;
    });
    if (events.length) await mdb.collection('call_events').insertMany(events);
    const snaps = Array.from({ length: 120 }, (_, i) => {
      const t = new Date(now - (120 - i) * 60_000);
      const wave = 0.5 + 0.5 * Math.sin(i / 14);
      const on = Math.round(spec.agents * (0.25 + 0.4 * wave) + r() * 2);
      return { company_id: cid, ts: t, agents_on_call: on, agents_available: Math.max(0, Math.round(spec.agents * 0.4 - on * 0.4)), calls_waiting: Math.round(wave * 3 * r()), active_calls: on };
    });
    await mdb.collection('wallboard_snapshots').insertMany(snaps);
    await mdb.collection('audit_log').insertMany([
      { company_id: cid, ts: new Date(now - 3 * DAY), actor: `admin@${spec.slug}.test`, action: 'campaign.created', target: spec.campaigns[0].name },
      { company_id: cid, ts: new Date(now - 2 * DAY), actor: `admin@${spec.slug}.test`, action: 'api_key.created', target: 'Demo integration key' },
      { company_id: cid, ts: new Date(now - 1 * DAY), actor: `supervisor@${spec.slug}.test`, action: 'queue.updated', target: spec.queues[0].name },
    ]);
    console.log(`[seed] ${spec.name}: ${n.toLocaleString()} calls, ${agents.length} agents, ${spec.campaigns.length} campaigns`);
  }
  console.log(`[seed] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export const DEMO_ACCOUNTS = TENANTS.map((t) => ({ tenant: t.name, admin: `admin@${t.slug}.test`, supervisor: `supervisor@${t.slug}.test`, agent: `agent@${t.slug}.test`, apiKey: t.demoKey }));

// CLI: `npm run seed` / `npm run seed:scale` against external databases.
if (process.argv[1]?.endsWith('seed.ts')) {
  if (!config.mysqlUrl || !config.mongoUrl) {
    console.error('Set MYSQL_URL and MONGO_URL to seed external databases. (Embedded dev DBs are seeded automatically by `npm run dev`.)');
    process.exit(1);
  }
  await connectMysql(config.mysqlUrl);
  await connectMongo(config.mongoUrl, config.mongoDb);
  await migrate();
  await seedAll({ scale: process.argv.includes('--scale') });
  await pool.end();
  await closeMongo();
}
