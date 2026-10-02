import { config } from '../config.js';
import { pool } from '../db/mysql.js';
import { mdb } from '../db/mongo.js';
import { tdb } from '../lib/tenant.js';
import type { Server } from 'node:http';
import { indianMobile } from '../lib/rng.js';
import { enqueueWebhook } from '../services/webhooks.js';
import { hub } from './hub.js';
import type { AuthCtx } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';

export type AgentState = 'offline' | 'available' | 'ringing' | 'preview' | 'on_call' | 'wrap_up' | 'break';
type Disp = 'positive' | 'neutral' | 'negative';

export interface RtAgent {
  id: number; name: string; extension: string | null; skills: string[]; isBot: boolean; queueIds: number[];
  state: AgentState; since: number; reason?: string;
  callId?: number; wrapCallId?: number; reservedFor?: number;
  callsToday: number; talkSecsToday: number;
  preview?: { leadId: number; campaignId: number; name: string; phone: string };
}
export interface RtCall {
  id: number; direction: 'inbound' | 'outbound'; queueId: number; campaignId: number | null; leadId: number | null;
  agentId: number | null; from: string; to: string; customerName?: string;
  state: 'dialing' | 'queued' | 'ringing' | 'in_progress' | 'ended';
  startedAt: number; answeredAt?: number; patienceMs: number;
  consent: 'not_required' | 'announced' | 'granted' | 'declined';
  recording: 'none' | 'recording' | 'paused' | 'stopped';
  timers: NodeJS.Timeout[]; reservedAgent?: number;
}
interface RtQueue {
  id: number; name: string; strategy: string; sla: number; maxWait: number; wrap: number; skill: string | null;
  consentMode: 'none' | 'announce' | 'opt_in'; rate: number; waiting: RtCall[]; rr: number;
  offered: number; answered: number; abandoned: number; withinSla: number; waitSum: number;
}
interface Rule { priority: number; outcome: string; action: 'retry_after' | 'mark_done' | 'schedule_callback' | 'add_to_dnc'; param: number | null }
interface RtCampaign {
  id: number; name: string; queueId: number; mode: 'preview' | 'progressive' | 'predictive'; status: string;
  pacing: number; maxAbandonPct: number; maxAttempts: number; retryDelay: number; callerId: string;
  rules: Rule[]; inflight: number; dialed: number; connected: number; recent: boolean[]; exhausted: boolean;
}

const wr = <T>(items: readonly (readonly [T, number])[]): T => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = Math.random() * total;
  for (const [v, w] of items) { x -= w; if (x <= 0) return v; }
  return items[0][0];
};
const expo = (mean: number) => -Math.log(1 - Math.random()) * mean;
const simMs = (secs: number) => Math.max(400, (secs * 1000) / config.simSpeed);
export const maskPhone = (p: string) => (p.length > 8 ? `${p.slice(0, 5)}••••${p.slice(-3)}` : p);
const DAY = 86_400_000;

const OUT_DISP: [string, number][] = [['sale_closed', 12], ['interested', 22], ['callback_requested', 18], ['not_interested', 33], ['wrong_number', 6], ['dnc_request', 3], ['already_customer', 6]];
const IN_DISP: [string, number][] = [['resolved', 62], ['info_provided', 20], ['complaint', 10], ['callback_requested', 8]];

/** Per-tenant live engine. All mutations are serialised through `run` so a tenant never races itself. */
export class TenantRuntime {
  agents = new Map<number, RtAgent>();
  queues = new Map<number, RtQueue>();
  campaigns = new Map<number, RtCampaign>();
  calls = new Map<number, RtCall>();
  seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private db;
  private lastStats = 0;
  private offlineTimers = new Map<number, NodeJS.Timeout>();

  constructor(public companyId: number, public tzOffsetMin: number) {
    this.db = tdb(companyId);
  }

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch((e) => { if (!(e instanceof HttpError)) console.error(`[runtime ${this.companyId}]`, e); });
    return p;
  }

  private emit(msg: { type: string } & Record<string, unknown>) {
    hub.broadcast(this.companyId, { ...msg, seq: ++this.seq });
  }

  // ---------------------------------------------------------------- loading
  async load(initial = false) {
    const db = this.db;
    if (initial) {
      // Crash recovery: anything in flight when the process died cannot still be live.
      await db.exec("UPDATE leads SET status='new' WHERE company_id=? AND status='dialing'", [this.companyId]);
      await db.exec("UPDATE calls SET status='failed', ended_at=NOW(3), notes='Interrupted by server restart' WHERE company_id=? AND status IN ('queued','ringing','in_progress')", [this.companyId]);
    }
    const users = await db.rows<{ id: number; name: string; extension: string | null; skills: string[] | null; is_bot: number }>(
      "SELECT id, name, extension, skills, is_bot FROM users WHERE company_id=? AND role='agent' AND status='active' AND is_shared_demo=0", [this.companyId]);
    const qs = await db.rows<Record<string, any>>('SELECT * FROM queues WHERE company_id=? AND active=1', [this.companyId]);
    const members = await db.rows<{ queue_id: number; user_id: number }>('SELECT queue_id, user_id FROM queue_members WHERE company_id=?', [this.companyId]);
    const camps = await db.rows<Record<string, any>>("SELECT * FROM campaigns WHERE company_id=? AND status <> 'completed'", [this.companyId]);
    const rules = await db.rows<Record<string, any>>('SELECT campaign_id, priority, outcome, action, action_param FROM dialer_rules WHERE company_id=? ORDER BY priority', [this.companyId]);

    const today0 = Math.floor((Date.now() + this.tzOffsetMin * 60_000) / DAY) * DAY - this.tzOffsetMin * 60_000;
    const stats = initial
      ? await db.rows<{ queue_id: number; offered: number; answered: number; abandoned: number; within: number; waitsum: number }>(
        `SELECT c.queue_id, COUNT(*) offered, SUM(c.status='completed') answered, SUM(c.status='abandoned') abandoned,
                SUM(c.status='completed' AND c.wait_secs <= q.sla_seconds) within, COALESCE(SUM(c.wait_secs),0) waitsum
           FROM calls c JOIN queues q ON q.id=c.queue_id AND q.company_id=c.company_id
          WHERE c.company_id=? AND c.direction='inbound' AND c.started_at >= ? GROUP BY c.queue_id`, [this.companyId, new Date(today0)])
      : [];
    const perAgent = initial
      ? await db.rows<{ agent_id: number; n: number; talk: number }>('SELECT agent_id, COUNT(*) n, SUM(talk_secs) talk FROM calls WHERE company_id=? AND agent_id IS NOT NULL AND started_at >= ? GROUP BY agent_id', [this.companyId, new Date(today0)])
      : [];

    // queues
    const seenQ = new Set<number>();
    for (const q of qs) {
      seenQ.add(q.id);
      const prev = this.queues.get(q.id);
      const s = stats.find((x) => x.queue_id === q.id);
      this.queues.set(q.id, {
        id: q.id, name: q.name, strategy: q.strategy, sla: q.sla_seconds, maxWait: q.max_wait_seconds, wrap: q.wrap_up_seconds,
        skill: q.required_skill, consentMode: q.recording_consent_mode, rate: Number(q.inbound_rate_per_min),
        waiting: prev?.waiting ?? [], rr: prev?.rr ?? 0,
        offered: prev?.offered ?? s?.offered ?? 0, answered: prev?.answered ?? Number(s?.answered ?? 0), abandoned: prev?.abandoned ?? Number(s?.abandoned ?? 0),
        withinSla: prev?.withinSla ?? Number(s?.within ?? 0), waitSum: prev?.waitSum ?? Number(s?.waitsum ?? 0),
      });
    }
    for (const id of [...this.queues.keys()]) if (!seenQ.has(id)) this.queues.delete(id);

    // agents
    const seenA = new Set<number>();
    users.forEach((u, idx) => {
      seenA.add(u.id);
      const prev = this.agents.get(u.id);
      const pa = perAgent.find((x) => x.agent_id === u.id);
      const queueIds = members.filter((m) => m.user_id === u.id).map((m) => m.queue_id);
      if (prev) { prev.name = u.name; prev.skills = u.skills ?? []; prev.queueIds = queueIds; return; }
      let state: AgentState = 'offline';
      if (u.is_bot && config.simulate) state = idx % 7 === 6 ? 'break' : idx % 9 === 8 ? 'offline' : 'available';
      this.agents.set(u.id, {
        id: u.id, name: u.name, extension: u.extension, skills: u.skills ?? [], isBot: !!u.is_bot, queueIds,
        state, since: Date.now() - Math.floor(Math.random() * 600_000), reason: state === 'break' ? 'Lunch' : undefined,
        callsToday: Number(pa?.n ?? 0), talkSecsToday: Number(pa?.talk ?? 0),
      });
    });
    for (const id of [...this.agents.keys()]) if (!seenA.has(id)) { this.agents.delete(id); this.emit({ type: 'agent.removed', id }); }

    // campaigns
    const seenC = new Set<number>();
    for (const c of camps) {
      seenC.add(c.id);
      const prev = this.campaigns.get(c.id);
      this.campaigns.set(c.id, {
        id: c.id, name: c.name, queueId: c.queue_id, mode: c.mode, status: c.status, pacing: Number(c.pacing_ratio),
        maxAbandonPct: Number(c.max_abandon_pct), maxAttempts: c.max_attempts, retryDelay: c.retry_delay_minutes, callerId: c.caller_id,
        rules: rules.filter((r) => r.campaign_id === c.id).map((r) => ({ priority: r.priority, outcome: r.outcome, action: r.action, param: r.action_param })),
        inflight: prev?.inflight ?? 0, dialed: prev?.dialed ?? 0, connected: prev?.connected ?? 0, recent: prev?.recent ?? [], exhausted: false,
      });
    }
    for (const id of [...this.campaigns.keys()]) if (!seenC.has(id)) this.campaigns.delete(id);
  }

  // ---------------------------------------------------------------- state helpers
  private setAgent(a: RtAgent, state: AgentState, reason?: string) {
    if (a.state === state && a.reason === reason) return;
    const prev = a.state;
    a.state = state; a.since = Date.now(); a.reason = reason;
    stateLogBuffer.push({ company_id: this.companyId, agent_id: a.id, state, from: prev, reason: reason ?? null, ts: new Date() });
    this.emit({ type: 'agent.state', agent: this.agentView(a) });
    this.pushMe(a);
  }

  private agentView(a: RtAgent) {
    return { id: a.id, name: a.name, extension: a.extension, state: a.state, since: a.since, reason: a.reason ?? null, callId: a.callId ?? null,
      queueIds: a.queueIds, callsToday: a.callsToday, talkSecsToday: a.talkSecsToday, isBot: a.isBot, reserved: a.reservedFor !== undefined };
  }
  private callView(c: RtCall) {
    return { id: c.id, direction: c.direction, queueId: c.queueId, campaignId: c.campaignId, agentId: c.agentId, from: maskPhone(c.from), to: maskPhone(c.to),
      state: c.state, startedAt: c.startedAt, answeredAt: c.answeredAt ?? null, recording: c.recording };
  }
  private queueView(q: RtQueue) {
    const now = Date.now();
    const members = [...this.agents.values()].filter((a) => a.queueIds.includes(q.id));
    return {
      id: q.id, name: q.name, strategy: q.strategy, sla: q.sla, waiting: q.waiting.length,
      longestWaitSecs: q.waiting.length ? Math.floor((now - Math.min(...q.waiting.map((c) => c.startedAt))) / 1000) : 0,
      activeCalls: [...this.calls.values()].filter((c) => c.queueId === q.id && c.state === 'in_progress').length,
      agentsAvailable: members.filter((a) => a.state === 'available').length,
      agentsStaffed: members.filter((a) => a.state !== 'offline').length,
      offered: q.offered, answered: q.answered, abandoned: q.abandoned,
      serviceLevelPct: q.offered ? Math.round((q.withinSla / q.offered) * 1000) / 10 : null,
      avgWaitSecs: q.offered ? Math.round(q.waitSum / Math.max(1, q.answered + q.abandoned)) : 0,
    };
  }
  private campaignView(c: RtCampaign) {
    const aband = c.recent.length ? (c.recent.filter(Boolean).length / c.recent.length) * 100 : 0;
    return { id: c.id, name: c.name, status: c.status, mode: c.mode, inflight: c.inflight, dialed: c.dialed, connected: c.connected,
      abandonPct: Math.round(aband * 10) / 10, effectiveRatio: this.effectiveRatio(c), exhausted: c.exhausted };
  }
  private effectiveRatio(c: RtCampaign) {
    if (c.mode !== 'predictive') return 1;
    const aband = c.recent.length >= 20 ? (c.recent.filter(Boolean).length / c.recent.length) * 100 : 0;
    return aband > c.maxAbandonPct ? 1 : c.pacing; // regulatory guard: throttle to 1:1 whenever the abandon cap is breached
  }

  snapshot() {
    const agents = [...this.agents.values()];
    return {
      seq: this.seq, now: Date.now(), simulated: config.simulate,
      agents: agents.map((a) => this.agentView(a)),
      queues: [...this.queues.values()].map((q) => this.queueView(q)),
      calls: [...this.calls.values()].filter((c) => c.state !== 'ended').map((c) => this.callView(c)),
      campaigns: [...this.campaigns.values()].map((c) => this.campaignView(c)),
      stats: this.stats(),
    };
  }

  stats() {
    const agents = [...this.agents.values()];
    const qs = [...this.queues.values()].map((q) => this.queueView(q));
    const offered = qs.reduce((s, q) => s + q.offered, 0);
    const within = [...this.queues.values()].reduce((s, q) => s + q.withinSla, 0);
    return {
      activeCalls: [...this.calls.values()].filter((c) => c.state === 'in_progress').length,
      waiting: qs.reduce((s, q) => s + q.waiting, 0),
      agentsByState: Object.fromEntries((['available', 'on_call', 'ringing', 'wrap_up', 'preview', 'break', 'offline'] as AgentState[]).map((s) => [s, agents.filter((a) => a.state === s).length])),
      offeredToday: offered, answeredToday: qs.reduce((s, q) => s + q.answered, 0), abandonedToday: qs.reduce((s, q) => s + q.abandoned, 0),
      serviceLevelPct: offered ? Math.round((within / offered) * 1000) / 10 : null,
    };
  }

  /** Aggregate numbers an agent may see about the floor: queue load and team state counts (no names, no numbers). */
  private boardSnapshot() {
    const s = this.stats();
    return { queues: [...this.queues.values()].map((q) => this.queueView(q)), team: s.agentsByState, activeCalls: s.activeCalls, waiting: s.waiting };
  }

  /** What a single human agent's workspace needs. */
  me(userId: number) {
    const a = this.agents.get(userId);
    if (!a) return { seq: this.seq, agent: null };
    const call = a.callId ? this.calls.get(a.callId) : undefined;
    return {
      seq: this.seq, now: Date.now(), simulated: config.simulate, agent: this.agentView(a),
      call: call ? { ...call, timers: undefined, from: call.from, to: call.to, customerName: call.customerName, queueName: this.queues.get(call.queueId)?.name, campaignName: call.campaignId ? this.campaigns.get(call.campaignId)?.name : null } : null,
      wrapCallId: a.wrapCallId ?? null, preview: a.preview ?? null, board: this.boardSnapshot(),
      queues: a.queueIds.map((id) => this.queues.get(id)).filter(Boolean).map((q) => ({ id: q!.id, name: q!.name, waiting: q!.waiting.length })),
    };
  }
  private pushMe(a: RtAgent) {
    if (!a.isBot) hub.sendToUser(this.companyId, a.id, { type: 'me', ...this.me(a.id) });
  }

  // ---------------------------------------------------------------- persistence helpers
  private async newCall(p: Pick<RtCall, 'direction' | 'queueId' | 'campaignId' | 'leadId' | 'from' | 'to' | 'customerName'> & { state: RtCall['state'] }): Promise<RtCall> {
    const startedAt = Date.now();
    const res = await this.db.exec(
      'INSERT INTO calls (company_id, direction, campaign_id, queue_id, lead_id, from_number, to_number, status, started_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [this.companyId, p.direction, p.campaignId, p.queueId, p.leadId, p.from, p.to, p.state === 'queued' ? 'queued' : 'ringing', new Date(startedAt)]);
    const q = this.queues.get(p.queueId);
    const call: RtCall = { ...p, id: res.insertId, agentId: null, startedAt, patienceMs: simMs((q?.maxWait ?? 60) * (0.35 + Math.random() * 0.7)), consent: 'not_required', recording: 'none', timers: [] };
    this.calls.set(call.id, call);
    this.evt(call, p.direction === 'inbound' ? 'call.queued' : 'call.dialing');
    this.emit({ type: 'call.update', call: this.callView(call) });
    return call;
  }

  private evt(c: RtCall, type: string, data?: Record<string, unknown>) {
    eventBuffer.push({ company_id: this.companyId, call_id: c.id, type, ts: new Date(), ...(data ? { data } : {}) });
  }

  private async persist(c: RtCall, set: Record<string, unknown>) {
    const cols = Object.keys(set);
    await this.db.exec(`UPDATE calls SET ${cols.map((k) => `${k}=?`).join(', ')} WHERE company_id=? AND id=?`, [...cols.map((k) => set[k] as never), this.companyId, c.id]);
  }

  private async consentEvent(c: RtCall, type: string, actor = 'system') {
    await this.db.exec('INSERT INTO consent_events (company_id, call_id, subject_phone, type, actor) VALUES (?,?,?,?,?)', [this.companyId, c.id, c.direction === 'inbound' ? c.from : c.to, type, actor]);
  }

  private clearTimers(c: RtCall) { c.timers.forEach(clearTimeout); c.timers = []; }
  private later(c: RtCall, ms: number, fn: () => Promise<void> | void) {
    c.timers.push(setTimeout(() => void this.run(fn), ms));
  }

  // ---------------------------------------------------------------- agent selection
  private eligible(q: RtQueue) {
    return [...this.agents.values()].filter((a) => a.state === 'available' && a.reservedFor === undefined && a.queueIds.includes(q.id) && (!q.skill || a.skills.includes(q.skill)));
  }
  private pickAgent(q: RtQueue, pool_: RtAgent[] = this.eligible(q)): RtAgent | undefined {
    if (!pool_.length) return undefined;
    switch (q.strategy) {
      case 'round_robin': { q.rr = (q.rr + 1) % 1_000_000; return [...pool_].sort((a, b) => a.id - b.id)[q.rr % pool_.length]; }
      case 'least_calls': return [...pool_].sort((a, b) => a.callsToday - b.callsToday)[0];
      case 'ring_all': return pool_[Math.floor(Math.random() * pool_.length)];
      default: return [...pool_].sort((a, b) => a.since - b.since)[0]; // longest_idle / skills_based
    }
  }

  // ---------------------------------------------------------------- call lifecycle
  private assignRinging(call: RtCall, agent: RtAgent) {
    call.agentId = agent.id; call.state = 'ringing'; agent.callId = call.id;
    this.setAgent(agent, 'ringing');
    this.evt(call, 'call.agent_ringing', { agent_id: agent.id });
    this.emit({ type: 'call.update', call: this.callView(call) });
    if (agent.isBot) this.later(call, simMs(1 + Math.random() * 2), () => this.answer(call, agent));
    else this.later(call, 20_000, () => this.ringNoAnswer(call, agent)); // RONA
  }

  private ringNoAnswer(call: RtCall, agent: RtAgent) {
    if (call.state !== 'ringing' || agent.callId !== call.id) return;
    this.evt(call, 'call.ring_no_answer', { agent_id: agent.id });
    agent.callId = undefined; call.agentId = null; call.state = 'queued';
    this.queues.get(call.queueId)?.waiting.unshift(call);
    this.setAgent(agent, 'break', 'Missed call (not answered)');
  }

  private async answer(call: RtCall, agent: RtAgent) {
    if (call.state === 'ended' || (call.state === 'in_progress')) return;
    this.clearTimers(call);
    call.answeredAt = Date.now(); call.state = 'in_progress'; call.agentId = agent.id; agent.callId = call.id;
    this.setAgent(agent, 'on_call');
    const q = this.queues.get(call.queueId)!;
    const waitSecs = Math.round((call.answeredAt - call.startedAt) / 1000);

    // Recording consent (privacy by design: decided & logged before any audio is retained)
    let consentEvents: string[] = [];
    if (q.consentMode === 'announce') { call.consent = 'announced'; call.recording = 'recording'; consentEvents = ['prompt_played']; }
    else if (q.consentMode === 'opt_in') {
      const ok = Math.random() > 0.12;
      call.consent = ok ? 'granted' : 'declined'; call.recording = ok ? 'recording' : 'none'; consentEvents = ['prompt_played', ok ? 'granted' : 'declined'];
    }
    this.evt(call, 'call.answered', { agent_id: agent.id });
    if (call.consent !== 'not_required') this.evt(call, `consent.${call.consent}`);
    await this.persist(call, { status: 'in_progress', agent_id: agent.id, answered_at: new Date(call.answeredAt), wait_secs: Math.min(waitSecs, 65535), recording_consent: call.consent, recording_state: call.recording, recording_key: call.recording === 'recording' ? `rec/${this.companyId}/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${call.id}.opus` : null });
    for (const t of consentEvents) await this.consentEvent(call, t, t === 'granted' || t === 'declined' ? 'caller' : 'system');
    this.emit({ type: 'call.update', call: this.callView(call) });
    this.pushMe(agent);
    if (call.direction === 'inbound') { q.answered++; q.waitSum += waitSecs; if (waitSecs <= q.sla) q.withinSla++; }

    if (agent.isBot) {
      const mean = call.direction === 'inbound' ? 190 : 120;
      this.later(call, simMs(35 + expo(mean)), () => this.endCall(call, 'agent'));
    } else {
      this.later(call, 8 * 60_000, () => this.endCall(call, 'caller')); // simulated caller hang-up safety net
    }
  }

  async endCall(call: RtCall, by: 'agent' | 'caller' | 'system') {
    if (call.state !== 'in_progress') return;
    this.clearTimers(call);
    const agent = this.agents.get(call.agentId!);
    const endedAt = Date.now();
    const talk = Math.round((endedAt - call.answeredAt!) / 1000);
    call.state = 'ended';
    if (call.recording === 'recording' || call.recording === 'paused') { await this.consentEvent(call, 'recording_stopped'); call.recording = 'stopped'; }
    this.evt(call, 'call.completed', { talk_secs: talk, ended_by: by });
    await this.persist(call, { status: 'completed', ended_at: new Date(endedAt), talk_secs: talk, recording_state: call.recording === 'none' ? 'none' : 'stopped' });
    this.calls.delete(call.id);
    this.emit({ type: 'call.end', callId: call.id });
    if (!agent) return;
    agent.callsToday++; agent.talkSecsToday += talk; agent.callId = undefined; agent.wrapCallId = call.id;
    const q = this.queues.get(call.queueId)!;
    this.setAgent(agent, 'wrap_up');
    const wrapStarted = Date.now();
    if (agent.isBot) {
      const disp = wr(call.direction === 'inbound' ? IN_DISP : OUT_DISP);
      setTimeout(() => void this.run(() => this.finishWrap(agent, call, disp, undefined, Math.round((Date.now() - wrapStarted) / 1000))), simMs(q.wrap * (0.5 + Math.random())));
    }
    this.wrapMeta.set(call.id, { wrapStarted, call });
  }
  private wrapMeta = new Map<number, { wrapStarted: number; call: RtCall }>();

  private async finishWrap(agent: RtAgent, call: RtCall, disposition: string | null, notes: string | undefined, wrapSecs: number) {
    if (agent.wrapCallId !== call.id) return;
    agent.wrapCallId = undefined; this.wrapMeta.delete(call.id);
    await this.persist(call, { disposition, notes: notes?.slice(0, 500) ?? null, wrap_secs: Math.min(wrapSecs, 65535) });
    this.evt(call, 'call.disposition', { disposition });
    if (call.direction === 'outbound' && call.leadId) await this.applyRules(call, [disposition ?? 'completed', 'completed']);
    void enqueueWebhook(this.companyId, 'call.completed', { call_id: call.id, direction: call.direction, queue_id: call.queueId, campaign_id: call.campaignId, agent_id: agent.id, from: call.from, to: call.to, disposition, talk_secs: Math.round((Date.now() - (call.answeredAt ?? Date.now())) / 1000) }).catch(() => {});
    if (agent.state === 'wrap_up') this.setAgent(agent, 'available');
    this.emit({ type: 'queue.counts', queues: [...this.queues.values()].map((q) => this.queueView(q)) });
  }

  // Human agent actions ----------------------------------------------------
  agentSetState(userId: number, state: 'available' | 'break' | 'offline', reason?: string) {
    return this.run(() => {
      const a = this.agents.get(userId);
      if (!a) throw new HttpError(404, 'You are not an agent in this tenant');
      if (['on_call', 'ringing', 'wrap_up', 'preview'].includes(a.state)) throw new HttpError(409, `Cannot change status while ${a.state.replace('_', ' ')}. Finish the current task first.`, 'conflict');
      this.setAgent(a, state, state === 'break' ? reason || 'Break' : undefined);
    });
  }
  agentAnswer(userId: number, callId: number) {
    return this.run(async () => {
      const a = this.agents.get(userId); const c = this.calls.get(callId);
      if (!a || !c || c.agentId !== userId || c.state !== 'ringing') throw new HttpError(409, 'No ringing call to answer', 'conflict');
      await this.answer(c, a);
    });
  }
  agentEnd(userId: number, callId: number) {
    return this.run(async () => {
      const c = this.calls.get(callId);
      if (!c || c.agentId !== userId || c.state !== 'in_progress') throw new HttpError(409, 'No active call to end', 'conflict');
      await this.endCall(c, 'agent');
    });
  }
  agentDisposition(userId: number, callId: number, code: string, notes?: string) {
    return this.run(async () => {
      const a = this.agents.get(userId); const meta = this.wrapMeta.get(callId);
      if (!a || !meta || a.wrapCallId !== callId) throw new HttpError(409, 'No call awaiting disposition', 'conflict');
      const ok = await this.db.one('SELECT id FROM dispositions WHERE company_id=? AND code=?', [this.companyId, code]);
      if (!ok) throw new HttpError(422, `Unknown disposition "${code}"`, 'validation_failed');
      await this.finishWrap(a, meta.call, code, notes, Math.round((Date.now() - meta.wrapStarted) / 1000));
    });
  }

  /** Demo helper: route a simulated inbound call straight to this (human) agent so the workspace can be exercised on demand. */
  agentDemoCall(userId: number) {
    return this.run(async () => {
      if (!config.simulate) throw new HttpError(404, 'Simulation is disabled', 'not_found');
      const a = this.agents.get(userId);
      if (a?.state === 'available' && a.reservedFor !== undefined) throw new HttpError(409, 'A campaign call is already being connected to you — answer it first', 'conflict');
      if (!a || a.state !== 'available') throw new HttpError(409, 'Set yourself Available first', 'conflict');
      const q = a.queueIds.map((id) => this.queues.get(id)).find((x) => x && x.consentMode !== undefined);
      if (!q) throw new HttpError(409, 'You are not in any active queue', 'conflict');
      const call = await this.newCall({ direction: 'inbound', queueId: q.id, campaignId: null, leadId: null, from: indianMobile(Math.random), to: '+912240009999', state: 'queued' });
      q.offered++;
      this.assignRinging(call, a);
    });
  }

  hasAgent(userId: number) { return this.agents.has(userId); }

  /**
   * Release a guest seat. Refuses (returns false) while the agent is on a live call so a customer is never dropped;
   * a pending wrap-up is closed with no disposition and a note, and a previewed lead goes back to the pool.
   */
  agentRetire(userId: number) {
    return this.run(async () => {
      const a = this.agents.get(userId);
      if (!a) return true;
      if (a.state === 'on_call' || a.state === 'ringing') return false;
      if (a.wrapCallId) {
        const meta = this.wrapMeta.get(a.wrapCallId);
        if (meta) await this.finishWrap(a, meta.call, null, 'Auto-closed: agent session ended before a disposition was chosen', Math.round((Date.now() - meta.wrapStarted) / 1000));
      }
      if (a.preview) await this.db.exec("UPDATE leads SET status='new', attempts=GREATEST(attempts,1)-1 WHERE company_id=? AND id=?", [this.companyId, a.preview.leadId]);
      const t = this.offlineTimers.get(userId); if (t) { clearTimeout(t); this.offlineTimers.delete(userId); }
      this.agents.delete(userId);
      this.emit({ type: 'agent.removed', id: userId });
      return true;
    });
  }

  // Preview dialing ---------------------------------------------------------
  agentPreviewNext(userId: number) {
    return this.run(async () => {
      const a = this.agents.get(userId);
      if (!a || a.state !== 'available') throw new HttpError(409, 'Set yourself Available first', 'conflict');
      const c = [...this.campaigns.values()].find((c) => c.mode === 'preview' && c.status === 'running' && a.queueIds.includes(c.queueId));
      if (!c) throw new HttpError(404, 'No running preview campaign for your queues', 'not_found');
      const [lead] = await this.claimLeads(c, 1);
      if (!lead) { c.exhausted = true; throw new HttpError(404, 'No dialable leads right now (all attempted, scheduled for later, or outside retry window)', 'not_found'); }
      a.preview = { leadId: lead.id, campaignId: c.id, name: `${lead.first_name} ${lead.last_name ?? ''}`.trim(), phone: lead.phone };
      this.setAgent(a, 'preview');
    });
  }
  agentPreviewDial(userId: number) {
    return this.run(async () => {
      const a = this.agents.get(userId);
      if (!a?.preview || a.state !== 'preview') throw new HttpError(409, 'No lead is being previewed', 'conflict');
      await this.dial(this.campaigns.get(a.preview.campaignId)!, { id: a.preview.leadId, first_name: a.preview.name, last_name: null, phone: a.preview.phone }, a);
    });
  }
  agentPreviewSkip(userId: number) {
    return this.run(async () => {
      const a = this.agents.get(userId);
      if (!a?.preview) throw new HttpError(409, 'No lead is being previewed', 'conflict');
      await this.db.exec("UPDATE leads SET status='new', attempts=GREATEST(attempts,1)-1, next_attempt_at=DATE_ADD(NOW(3), INTERVAL 10 MINUTE) WHERE company_id=? AND id=?", [this.companyId, a.preview.leadId]);
      a.preview = undefined; this.setAgent(a, 'available');
    });
  }

  /** Click-to-call from the public API: dial `to` and bridge it to a free agent. */
  originate(to: string, agentId?: number) {
    return this.run(async () => {
      const cands = [...this.agents.values()].filter((a) => a.state === 'available' && a.reservedFor === undefined && (agentId === undefined || a.id === agentId));
      if (agentId !== undefined && !this.agents.has(agentId)) throw new HttpError(404, 'agent_id not found', 'not_found');
      const agent = cands[0];
      if (!agent) throw new HttpError(409, agentId ? 'Agent is not available' : 'No agent is available', 'no_agent_available');
      const qid = agent.queueIds[0] ?? [...this.queues.keys()][0];
      const q = this.queues.get(qid);
      if (!q) throw new HttpError(409, 'No queue configured', 'conflict');
      const call = await this.newCall({ direction: 'outbound', queueId: qid, campaignId: null, leadId: null, from: `+9122${String(40000000 + (this.companyId * 7919) % 9999999)}`, to, state: 'ringing' });
      agent.reservedFor = call.id; call.reservedAgent = agent.id;
      this.later(call, simMs(4 + Math.random() * 6), () => this.resolveDial(call, undefined, 'answered'));
      return call;
    });
  }

  // ---------------------------------------------------------------- dialer
  private async claimLeads(c: RtCampaign, n: number) {
    if (n <= 0) return [];
    return this.db.tx(async (t) => {
      const rows = await t.rows<{ id: number; first_name: string; last_name: string | null; phone: string }>(
        `SELECT l.id, l.first_name, l.last_name, l.phone FROM leads l
          WHERE l.company_id=? AND l.campaign_id=? AND l.status IN ('new','callback')
            AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= ?) AND l.attempts < ?
            AND NOT EXISTS (SELECT 1 FROM dnc_numbers d WHERE d.company_id=? AND d.phone=l.phone)
          ORDER BY l.priority DESC, l.id LIMIT ${Math.floor(n)} FOR UPDATE SKIP LOCKED`,
        [this.companyId, c.id, new Date(), c.maxAttempts, this.companyId]);
      if (rows.length) await t.exec(`UPDATE leads SET status='dialing', attempts=attempts+1, last_attempt_at=NOW(3) WHERE company_id=? AND id IN (${rows.map(() => '?').join(',')})`, [this.companyId, ...rows.map((r) => r.id)]);
      return rows;
    });
  }

  private async dial(c: RtCampaign, lead: { id: number; first_name: string; last_name: string | null; phone: string }, reserved?: RtAgent) {
    const call = await this.newCall({ direction: 'outbound', queueId: c.queueId, campaignId: c.id, leadId: lead.id, from: c.callerId, to: lead.phone, customerName: `${lead.first_name} ${lead.last_name ?? ''}`.trim(), state: 'ringing' });
    c.inflight++; c.dialed++;
    if (reserved) {
      reserved.reservedFor = call.id; call.reservedAgent = reserved.id; reserved.preview = undefined; reserved.callId = call.id;
      if (reserved.state === 'preview') this.setAgent(reserved, 'ringing', 'Dialing');
    }
    this.later(call, simMs(5 + Math.random() * 15), () => this.resolveDial(call, c));
  }

  private async resolveDial(call: RtCall, c?: RtCampaign, forced?: string) {
    if (call.state === 'ended') return;
    const outcome = forced ?? wr([['answered', 40], ['no_answer', 27], ['busy', 10], ['voicemail', 15], ['failed', 8]] as const);
    if (c) c.inflight = Math.max(0, c.inflight - 1);
    const reserved = call.reservedAgent ? this.agents.get(call.reservedAgent) : undefined;
    if (outcome === 'answered') {
      let agent = reserved;
      if (!agent) agent = this.pickAgent(this.queues.get(call.queueId)!);
      if (c) { c.connected++; c.recent.push(!agent); if (c.recent.length > 100) c.recent.shift(); }
      if (!agent) { // nobody free: the abandoned call that predictive dialers must keep under the regulatory cap
        await this.finalizeUnconnected(call, 'abandoned', c); return;
      }
      agent.reservedFor = undefined;
      await this.answer(call, agent);
      return;
    }
    if (reserved) { reserved.reservedFor = undefined; reserved.callId = undefined; if (reserved.state === 'ringing') this.setAgent(reserved, 'available'); }
    await this.finalizeUnconnected(call, outcome, c);
  }

  private async finalizeUnconnected(call: RtCall, status: string, c?: RtCampaign) {
    call.state = 'ended'; this.clearTimers(call);
    this.evt(call, `call.${status}`);
    await this.persist(call, { status, ended_at: new Date(), wait_secs: 0 });
    this.calls.delete(call.id);
    if (call.reservedAgent) { const a = this.agents.get(call.reservedAgent); if (a) { a.reservedFor = undefined; a.callId = undefined; } }
    this.emit({ type: 'call.end', callId: call.id });
    if (call.direction === 'inbound') {
      const q = this.queues.get(call.queueId); if (q && status === 'abandoned') { q.abandoned++; q.waitSum += Math.round((Date.now() - call.startedAt) / 1000); }
    }
    if (call.leadId) await this.applyRules(call, [status], c);
    if (status === 'abandoned') void enqueueWebhook(this.companyId, 'call.abandoned', { call_id: call.id, direction: call.direction, queue_id: call.queueId, from: call.from, to: call.to }).catch(() => {});
  }

  /** Dialer rules engine: first rule (by priority) matching any outcome key wins. */
  private async applyRules(call: RtCall, keys: string[], camp?: RtCampaign) {
    const c = camp ?? (call.campaignId ? this.campaigns.get(call.campaignId) : undefined);
    if (!c || !call.leadId) return;
    const rule = c.rules.find((r) => keys.includes(r.outcome));
    const id = call.leadId, cid = this.companyId;
    const lead = await this.db.one<{ attempts: number }>('SELECT attempts FROM leads WHERE company_id=? AND id=?', [cid, id]);
    if (!lead) return;
    const retry = async (mins: number) => {
      if (lead.attempts >= c.maxAttempts) return this.db.exec("UPDATE leads SET status='exhausted', last_outcome=? WHERE company_id=? AND id=?", [keys[0], cid, id]);
      return this.db.exec("UPDATE leads SET status='new', last_outcome=?, next_attempt_at=DATE_ADD(NOW(3), INTERVAL ? MINUTE) WHERE company_id=? AND id=?", [keys[0], mins, cid, id]);
    };
    if (!rule) { if (keys.includes('completed')) await this.db.exec("UPDATE leads SET status='contacted', last_outcome=? WHERE company_id=? AND id=?", [keys[0], cid, id]); else await retry(c.retryDelay); return; }
    switch (rule.action) {
      case 'retry_after': await retry(rule.param ?? c.retryDelay); break;
      case 'mark_done': await this.db.exec("UPDATE leads SET status='done', last_outcome=? WHERE company_id=? AND id=?", [keys[0], cid, id]); break;
      case 'schedule_callback': await this.db.exec("UPDATE leads SET status='callback', last_outcome=?, next_attempt_at=DATE_ADD(NOW(3), INTERVAL ? MINUTE) WHERE company_id=? AND id=?", [keys[0], rule.param ?? 60, cid, id]); break;
      case 'add_to_dnc':
        await this.db.exec("INSERT IGNORE INTO dnc_numbers (company_id, phone, reason) VALUES (?,?,?)", [cid, call.to, `Rule: ${rule.outcome}`]);
        await this.db.exec("UPDATE leads SET status='dnc', last_outcome=? WHERE company_id=? AND phone=?", [keys[0], cid, call.to]);
        break;
    }
  }

  private inWindow() {
    return config.simulate; // demo override; production would compare company-local time with campaign window
  }

  private async dialerTick() {
    for (const c of this.campaigns.values()) {
      if (c.status !== 'running' || !this.inWindow()) continue;
      const q = this.queues.get(c.queueId); if (!q) continue;
      const protect = q.waiting.length + (q.rate > 0 ? 1 : 0); // keep headroom for inbound
      const idle = this.eligible(q).filter((a) => this.campaignsFor(a).includes(c.id));
      if (c.mode === 'preview') {
        for (const bot of idle.filter((a) => a.isBot).slice(0, 1)) {
          if (Math.random() > 0.15) continue;
          const [lead] = await this.claimLeads(c, 1);
          if (!lead) { c.exhausted = true; break; }
          bot.preview = { leadId: lead.id, campaignId: c.id, name: lead.first_name, phone: lead.phone };
          this.setAgent(bot, 'preview');
          setTimeout(() => void this.run(() => this.dial(c, lead, bot)), simMs(3 + Math.random() * 4));
        }
        continue;
      }
      const spare = Math.max(0, idle.length - protect);
      const want = c.mode === 'progressive' ? spare - c.inflight : Math.floor(spare * this.effectiveRatio(c)) - c.inflight;
      const n = Math.min(Math.max(0, want), 4);
      if (!n) continue;
      const leads = await this.claimLeads(c, n);
      c.exhausted = leads.length === 0 && c.inflight === 0;
      for (const lead of leads) {
        let agent: RtAgent | undefined;
        // progressive — and predictive while throttled to 1:1 — reserves a concrete agent so the answered call can never be abandoned
        if (c.mode === 'progressive' || this.effectiveRatio(c) <= 1) {
          const free = idle.filter((a) => a.reservedFor === undefined);
          const bots = free.filter((a) => a.isBot);
          agent = this.pickAgent(q, bots.length ? bots : free); // demo: keep the one human agent free for hands-on testing while simulated agents are available
        }
        await this.dial(c, lead, agent);
      }
    }
  }
  private campaignsFor(a: RtAgent) { return [...this.campaigns.values()].filter((c) => a.queueIds.includes(c.queueId)).map((c) => c.id); }

  // ---------------------------------------------------------------- tick
  private tickN = 0;
  async tick() {
    this.tickN++;
    const now = Date.now();
    if (config.simulate) {
      // inbound arrivals (Poisson per second); RATE_SCALE keeps the demo busy but not saturated
      for (const q of this.queues.values()) {
        if (q.rate <= 0 || !this.eligibleStaffed(q)) continue;
        const lambda = (q.rate * 0.45) / 60;
        let k = 0, p = Math.exp(-lambda), s = p; const u = Math.random();
        while (u > s && k < 6) { k++; p *= lambda / k; s += p; }
        for (let i = 0; i < k; i++) {
          const call = await this.newCall({ direction: 'inbound', queueId: q.id, campaignId: null, leadId: null, from: indianMobile(Math.random), to: `+91224${String(1000000 + q.id * 1111).slice(0, 7)}`, state: 'queued' });
          q.waiting.push(call); q.offered++;
        }
      }
      // bots wander between available and break
      for (const a of this.agents.values()) {
        if (!a.isBot) continue;
        if (a.state === 'available' && Math.random() < 0.002) this.setAgent(a, 'break', wr([['Tea break', 3], ['Lunch', 1], ['Training', 1]] as const));
        else if (a.state === 'break' && now - a.since > simMs(240) && Math.random() < 0.05) this.setAgent(a, 'available');
        else if (a.state === 'offline' && Math.random() < 0.004) this.setAgent(a, 'available');
      }
    }
    // pump queues + abandon impatient callers
    for (const q of this.queues.values()) {
      for (const call of [...q.waiting]) {
        if (now - call.startedAt > call.patienceMs && now - call.startedAt > 3000) {
          q.waiting = q.waiting.filter((c) => c !== call);
          await this.finalizeUnconnected(call, 'abandoned');
        }
      }
      while (q.waiting.length) {
        const agent = this.pickAgent(q);
        if (!agent) break;
        this.assignRinging(q.waiting.shift()!, agent);
      }
    }
    if (config.simulate) await this.dialerTick();
    const qv = [...this.queues.values()].map((q) => this.queueView(q));
    this.emit({ type: 'queue.counts', queues: qv });
    hub.broadcastAgents(this.companyId, { type: 'board', queues: qv, team: this.stats().agentsByState, activeCalls: this.stats().activeCalls, waiting: this.stats().waiting });
    if (now - this.lastStats >= 2000) {
      this.lastStats = now;
      this.emit({ type: 'stats', stats: this.stats(), campaigns: [...this.campaigns.values()].map((c) => this.campaignView(c)) });
    }
  }
  private eligibleStaffed(q: RtQueue) { return [...this.agents.values()].some((a) => a.state !== 'offline' && a.queueIds.includes(q.id)); }

  // presence (human agents) -------------------------------------------------
  presence(userId: number, online: boolean) {
    return this.run(() => {
      const a = this.agents.get(userId); if (!a || a.isBot) return;
      const t = this.offlineTimers.get(userId); if (t) { clearTimeout(t); this.offlineTimers.delete(userId); }
      if (online) { this.pushMe(a); return; }
      this.offlineTimers.set(userId, setTimeout(() => void this.run(() => { if (a.state === 'available' || a.state === 'break') this.setAgent(a, 'offline', 'Disconnected'); }), 15_000));
    });
  }

  /** Recording state mirror used by the privacy service. */
  setRecording(callId: number, rec: RtCall['recording']) {
    const c = this.calls.get(callId); if (!c) return;
    c.recording = rec;
    this.emit({ type: 'call.update', call: this.callView(c) });
    const a = c.agentId ? this.agents.get(c.agentId) : undefined; if (a) this.pushMe(a);
  }
  getCall(callId: number) { return this.calls.get(callId); }
}

// ------------------------------------------------------------------ manager
export const eventBuffer: Record<string, unknown>[] = [];
export const stateLogBuffer: Record<string, unknown>[] = [];

class RuntimeManager {
  private tenants = new Map<number, TenantRuntime>();
  private timers: NodeJS.Timeout[] = [];

  async start(server: Server) {
    const [rows] = await pool.query('SELECT id, tz_offset_minutes FROM companies');
    for (const r of rows as { id: number; tz_offset_minutes: number }[]) {
      const rt = new TenantRuntime(r.id, r.tz_offset_minutes);
      await rt.load(true);
      this.tenants.set(r.id, rt);
    }
    hub.attach(server, {
      snapshot: (a: AuthCtx) => (a.role === 'agent' ? this.get(a.companyId).me(a.userId) : this.get(a.companyId).snapshot()),
      presence: (a: AuthCtx, online: boolean) => void this.get(a.companyId).presence(a.userId, online),
      valid: (a: AuthCtx) => a.role !== 'agent' || this.get(a.companyId).hasAgent(a.userId),
    });
    let busy = false;
    this.timers.push(setInterval(async () => {
      if (busy) return; busy = true;
      try { await Promise.all([...this.tenants.values()].map((t) => t.run(() => t.tick()))); } catch (e) { console.error('[tick]', e); } finally { busy = false; }
    }, 1000));
    this.timers.push(setInterval(() => void this.flush(), 2000));
    this.timers.push(setInterval(() => void this.snapshotTelemetry(), 30_000));
  }

  get(companyId: number) {
    const t = this.tenants.get(companyId);
    if (!t) throw new HttpError(404, 'Unknown tenant');
    return t;
  }
  reload(companyId: number) { const t = this.get(companyId); return t.run(() => t.load()); }

  private async flush() {
    try {
      if (eventBuffer.length) await mdb.collection('call_events').insertMany(eventBuffer.splice(0, 5000) as never);
      if (stateLogBuffer.length) await mdb.collection('agent_state_log').insertMany(stateLogBuffer.splice(0, 5000) as never);
    } catch (e) { console.error('[flush]', e); }
  }

  private async snapshotTelemetry() {
    try {
      const docs = [...this.tenants.values()].map((t) => {
        const s = t.stats();
        return { company_id: t.companyId, ts: new Date(), agents_on_call: s.agentsByState.on_call, agents_available: s.agentsByState.available, calls_waiting: s.waiting, active_calls: s.activeCalls };
      });
      if (docs.length) await mdb.collection('wallboard_snapshots').insertMany(docs);
    } catch (e) { console.error('[telemetry]', e); }
  }

  async stop() { this.timers.forEach(clearInterval); await this.flush(); }
}

export const runtime = new RuntimeManager();
