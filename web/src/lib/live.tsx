import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { tokenStore } from './api';
import { useAuth } from './auth';

export type AgentState = 'offline' | 'available' | 'ringing' | 'preview' | 'on_call' | 'wrap_up' | 'break';

export interface LiveAgent { id: number; name: string; extension: string | null; state: AgentState; since: number; reason: string | null; callId: number | null; queueIds: number[]; callsToday: number; talkSecsToday: number; isBot: boolean; reserved?: boolean }
export interface LiveQueue { id: number; name: string; strategy: string; sla: number; waiting: number; longestWaitSecs: number; activeCalls: number; agentsAvailable: number; agentsStaffed: number; offered: number; answered: number; abandoned: number; serviceLevelPct: number | null; avgWaitSecs: number }
export interface LiveCall { id: number; direction: 'inbound' | 'outbound'; queueId: number; campaignId: number | null; agentId: number | null; from: string; to: string; state: string; startedAt: number; answeredAt: number | null; recording: string }
export interface LiveCampaign { id: number; name: string; status: string; mode: string; inflight: number; dialed: number; connected: number; abandonPct: number; effectiveRatio: number; exhausted: boolean }
export interface LiveStats { activeCalls: number; waiting: number; agentsByState: Record<AgentState, number>; offeredToday: number; answeredToday: number; abandonedToday: number; serviceLevelPct: number | null }

export interface MeCall { id: number; direction: 'inbound' | 'outbound'; from: string; to: string; customerName?: string; state: string; startedAt: number; answeredAt?: number; consent: string; recording: 'none' | 'recording' | 'paused' | 'stopped'; queueName?: string; campaignName?: string | null }
export interface MeState {
  agent: LiveAgent | null; call: MeCall | null; wrapCallId: number | null;
  preview: { leadId: number; campaignId: number; name: string; phone: string } | null;
  queues: { id: number; name: string; waiting: number }[]; simulated?: boolean;
}

export type Connection = 'connecting' | 'live' | 'reconnecting';

interface LiveState {
  connection: Connection; lastMessageAt: number; simulated: boolean;
  agents: LiveAgent[]; queues: LiveQueue[]; calls: LiveCall[]; campaigns: LiveCampaign[]; stats: LiveStats | null;
  me: MeState | null;
}
const empty: LiveState = { connection: 'connecting', lastMessageAt: 0, simulated: true, agents: [], queues: [], calls: [], campaigns: [], stats: null, me: null };
const Ctx = createContext<LiveState>(empty);
export const useLive = () => useContext(Ctx);

/** Re-render every `ms` (for live timers). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// ------------------------------------------------------------------ raw frame tap (powers the Platform showcase page)
export interface FeedItem { n: number; t: number; type: string; seq: number | null; bytes: number }
export interface FeedSnapshot { items: FeedItem[]; counts: Record<string, number>; total: number; bytes: number; since: number; recent: number[] }

const feed = (() => {
  let n = 0;
  const base = { items: [] as FeedItem[], counts: {} as Record<string, number>, total: 0, bytes: 0, since: Date.now(), times: [] as number[] };
  let snap: FeedSnapshot = { items: [], counts: {}, total: 0, bytes: 0, since: base.since, recent: [] };
  const subs = new Set<() => void>();
  let pending = false;
  const publish = () => {
    if (pending) return; // coalesce: a burst of frames costs one React render, not one per frame
    pending = true;
    setTimeout(() => {
      pending = false;
      const now = Date.now();
      base.times = base.times.filter((t) => t > now - 30_000);
      const recent = Array.from({ length: 30 }, (_, i) => base.times.filter((t) => t > now - (30 - i) * 1000 && t <= now - (29 - i) * 1000).length);
      snap = { items: base.items.slice(0, 40), counts: { ...base.counts }, total: base.total, bytes: base.bytes, since: base.since, recent };
      subs.forEach((f) => f());
    }, 250);
  };
  return {
    push(type: string, seq: number | null, bytes: number) {
      const t = Date.now();
      base.items.unshift({ n: ++n, t, type, seq, bytes }); if (base.items.length > 60) base.items.pop();
      base.counts[type] = (base.counts[type] ?? 0) + 1; base.total++; base.bytes += bytes; base.times.push(t);
      publish();
    },
    reset() { base.items = []; base.counts = {}; base.total = 0; base.bytes = 0; base.since = Date.now(); base.times = []; publish(); },
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    get: () => snap,
  };
})();
export const useLiveFeed = () => useSyncExternalStore(feed.subscribe, feed.get);

/** Lets the showcase page demonstrate failure handling for real: it genuinely cuts the socket. */
export const liveControl = {
  drop: (_ms: number) => {},
  resync: () => {},
};

export function LiveProvider({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const [state, setState] = useState<LiveState>(empty);
  const seq = useRef(0);

  useEffect(() => {
    if (!user) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let blockedUntil = 0;
    let retry: ReturnType<typeof setTimeout>;
    feed.reset();

    liveControl.drop = (ms) => { blockedUntil = Date.now() + ms; ws?.close(4000, 'simulated network drop'); };
    liveControl.resync = () => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resync' })); };

    const connect = () => {
      setState((s) => ({ ...s, connection: attempt === 0 ? 'connecting' : 'reconnecting' }));
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => ws!.send(JSON.stringify({ type: 'auth', token: tokenStore.get() }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        const now = Date.now();
        feed.push(m.type, typeof m.seq === 'number' ? m.seq : null, typeof ev.data === 'string' ? ev.data.length : 0);
        if (m.type === 'ready') { attempt = 0; return setState((s) => ({ ...s, connection: 'live', lastMessageAt: now })); }
        if (m.type === 'snapshot' && m.agents) seq.current = m.seq;
        // Sequence-gap detection: a missed delta means local state is wrong, so ask the server for a fresh snapshot.
        if (typeof m.seq === 'number' && m.type !== 'snapshot' && m.type !== 'me') {
          if (seq.current && m.seq !== seq.current + 1) ws!.send(JSON.stringify({ type: 'resync' }));
          seq.current = m.seq;
        }
        setState((s) => reduce(s, m, now));
      };
      ws.onclose = (ev) => {
        if (closed) return;
        if (ev.code === 4401) { logout(); return; } // token rejected / seat reclaimed: reconnecting would loop forever
        setState((s) => ({ ...s, connection: 'reconnecting' }));
        attempt++;
        const backoff = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)) + Math.random() * 500;
        retry = setTimeout(connect, Math.max(backoff, blockedUntil - Date.now()));
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => { closed = true; clearTimeout(retry); ws?.close(); setState(empty); seq.current = 0; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo(() => state, [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function reduce(s: LiveState, m: any, now: number): LiveState {
  const base = { ...s, lastMessageAt: now };
  switch (m.type) {
    case 'snapshot':
      if (m.agents) { return { ...base, connection: 'live', simulated: m.simulated, agents: m.agents, queues: m.queues, calls: m.calls, campaigns: m.campaigns, stats: m.stats }; }
      return { ...base, me: m, simulated: m.simulated ?? s.simulated };
    case 'me': return { ...base, me: m };
    case 'agent.state': return { ...base, agents: s.agents.some((a) => a.id === m.agent.id) ? s.agents.map((a) => (a.id === m.agent.id ? m.agent : a)) : [...s.agents, m.agent] };
    case 'agent.removed': return { ...base, agents: s.agents.filter((a) => a.id !== m.id) };
    case 'queue.counts': return { ...base, queues: m.queues };
    case 'call.update': return { ...base, calls: s.calls.some((c) => c.id === m.call.id) ? s.calls.map((c) => (c.id === m.call.id ? m.call : c)) : [...s.calls, m.call] };
    case 'call.end': return { ...base, calls: s.calls.filter((c) => c.id !== m.callId) };
    case 'stats': return { ...base, stats: m.stats, campaigns: m.campaigns };
    default: return base;
  }
}
