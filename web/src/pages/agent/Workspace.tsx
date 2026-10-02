import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle, Coffee, Headphones, LogOut, Mic, MicOff, Phone, PhoneIncoming, PhoneOff, Power, ShieldCheck, SkipForward } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtDur, fmtTime, title } from '../../lib/format';
import { useLive, useLiveFeed, useNow, type MeCall } from '../../lib/live';
import { ConnectionChip, SimulationBanner } from '../../components/Layout';
import { AGENT_STATE, Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, Modal, Notice, Select, StateBadge, Table, TextInput, mutationError, useToast } from '../../components/ui';

interface AgentMe { dispositions: { code: string; label: string; category: string }[]; consentPrompt: string; pauseResumeEnabled: boolean }

export function AgentWorkspace() {
  const { user, company, logout } = useAuth();
  const { me, connection } = useLive();
  const qc = useQueryClient(); const toast = useToast();
  const meta = useQuery({ queryKey: ['agent-meta'], queryFn: () => api<AgentMe>('/agent/me') });
  const history = useQuery({ queryKey: ['agent-history'], queryFn: () => api<any[]>('/agent/history') });
  const agent = me?.agent ?? null;
  const call = me?.call ?? null;
  const state = agent?.state ?? 'offline';

  // refresh history whenever a wrap-up finishes
  const [lastWrap, setLastWrap] = useState<number | null>(null);
  useEffect(() => { if (lastWrap && !me?.wrapCallId) qc.invalidateQueries({ queryKey: ['agent-history'] }); setLastWrap(me?.wrapCallId ?? null); }, [me?.wrapCallId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setState = useMutation({ mutationFn: (b: { state: string; reason?: string }) => api('/agent/state', { body: b }), onError: (e) => toast('bad', mutationError(e)) });
  const [breakReason, setBreakReason] = useState('Tea break');
  const locked = ['on_call', 'ringing', 'wrap_up', 'preview'].includes(state);

  return (
    <div className="min-h-screen bg-slate-100">
      <SimulationBanner />
      <header className="flex flex-wrap items-center justify-between gap-3 bg-ink-900 px-4 py-2.5 text-white">
        <div className="flex items-center gap-2"><Headphones className="h-5 w-5 text-brand-500" aria-hidden /><span className="font-semibold">Agent workspace</span><span className="text-sm text-slate-400">· {company?.name}</span></div>
        <div className="flex items-center gap-3"><ConnectionChip /><span className="text-sm">{user?.name}</span>{user?.seat && <span title="Your own private agent seat on the shared Normal User login — other people signed in as Normal User cannot see or affect it" className="rounded bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-200">private seat</span>}<button onClick={logout} className="flex items-center gap-1 text-xs text-slate-300 hover:text-white"><LogOut className="h-3.5 w-3.5" aria-hidden />Sign out</button></div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-4 p-4 lg:grid-cols-[18rem_1fr]">
        <aside className="space-y-4">
          <Card>
            <CardHeader title="My status" actions={<StateBadge state={state} />} />
            <div className="space-y-2 p-4">
              <AgentTimer since={agent?.since} reason={agent?.reason} />
              <div className="grid gap-2" role="group" aria-label="Set status">
                <Button variant={state === 'available' ? 'primary' : 'secondary'} disabled={locked || state === 'available'} busy={setState.isPending} onClick={() => setState.mutate({ state: 'available' })}><Circle className="h-4 w-4" aria-hidden />Available</Button>
                <div className="flex gap-2">
                  <Select aria-label="Break reason" className="!py-1.5" value={breakReason} onChange={(e) => setBreakReason(e.target.value)} disabled={locked}>{['Tea break', 'Lunch', 'Training', 'Meeting'].map((r) => <option key={r}>{r}</option>)}</Select>
                  <Button variant={state === 'break' ? 'primary' : 'secondary'} disabled={locked || state === 'break'} onClick={() => setState.mutate({ state: 'break', reason: breakReason })}><Coffee className="h-4 w-4" aria-hidden />Break</Button>
                </div>
                <Button disabled={locked || state === 'offline'} onClick={() => setState.mutate({ state: 'offline' })}><Power className="h-4 w-4" aria-hidden />Go offline</Button>
              </div>
              {locked && <p className="text-xs text-slate-500">Status is locked while you are {AGENT_STATE[state].label.toLowerCase()}. Finish the task to change it.</p>}
              {state === 'offline' && <p className="text-xs text-slate-500">You are offline and will not receive calls.</p>}
            </div>
          </Card>
          <QueueBoard />
          <LiveUpdates />
        </aside>

        <section className="space-y-4" aria-live="polite">
          {connection !== 'live' && <Notice tone="warn">Live connection {connection === 'connecting' ? 'is starting' : 'lost — reconnecting'}. Call state below may be out of date; buttons still send requests but check the result.</Notice>}
          {!me ? <Card><Empty>Loading your workspace…</Empty></Card> : !agent ? <Card><Empty>Your account is not set up as an agent.</Empty></Card> : (
            <>
              {state === 'ringing' && call && <Ringing call={call} />}
              {state === 'preview' && me.preview && <Preview lead={me.preview} />}
              {state === 'on_call' && call && <Active call={call} meta={meta.data} />}
              {state === 'wrap_up' && me.wrapCallId && <Wrap callId={me.wrapCallId} dispositions={meta.data?.dispositions ?? []} />}
              {['available', 'break', 'offline'].includes(state) && <Idle state={state} />}
            </>
          )}
          <Card>
            <CardHeader title="My recent calls" />
            <Table>
              <thead><tr><th className="th">When</th><th className="th">Dir</th><th className="th">Customer</th><th className="th">Queue</th><th className="th">Disposition</th><th className="th text-right">Talk</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{history.data?.map((h) => <tr key={h.id}><td className="td whitespace-nowrap">{fmtDateTime(h.started_at)}</td><td className="td">{h.direction === 'inbound' ? 'In' : 'Out'}</td><td className="td tabular-nums">{h.customer ?? '—'}</td><td className="td">{h.queue_name}</td><td className="td">{h.disposition ? title(h.disposition) : <span className="text-slate-400">pending</span>}</td><td className="td text-right tabular-nums">{fmtDur(h.talk_secs)}</td></tr>)}</tbody>
            </Table>
            {history.data?.length === 0 && <Empty>No calls yet.</Empty>}
          </Card>
        </section>
      </main>
    </div>
  );
}

function AgentTimer({ since, reason }: { since?: number; reason?: string | null }) {
  const now = useNow(1000);
  if (!since) return null;
  return <div className="text-sm text-slate-600"><span className="text-xs">In this state</span> <span className="font-semibold tabular-nums">{fmtDur((now - since) / 1000)}</span>{reason && <span className="text-xs text-slate-500"> · {reason}</span>}</div>;
}

function Idle({ state }: { state: string }) {
  const toast = useToast();
  const next = useMutation({ mutationFn: () => api('/agent/preview/next', { body: {} }), onError: (e) => toast('bad', mutationError(e)) });
  const demo = useMutation({ mutationFn: () => api('/agent/demo-call', { body: {} }), onError: (e) => toast('bad', mutationError(e)) });
  return (
    <Card className="p-8 text-center">
      <Phone className="mx-auto mb-3 h-8 w-8 text-slate-300" aria-hidden />
      <h2 className="text-lg font-semibold">{state === 'available' ? 'Waiting for the next call' : state === 'break' ? 'You are on a break' : 'You are offline'}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{state === 'available' ? 'Inbound calls and campaign calls are routed to you automatically. In preview campaigns you can pull the next lead yourself.' : 'Set yourself Available to start receiving calls.'}</p>
      {state === 'available' && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button variant="primary" busy={demo.isPending} onClick={() => demo.mutate()}>Simulate an incoming call (demo)</Button>
          <Button busy={next.isPending} onClick={() => next.mutate()}>Get next preview lead</Button>
        </div>
      )}
    </Card>
  );
}

function Ringing({ call }: { call: MeCall }) {
  const toast = useToast(); const now = useNow(500);
  const answer = useMutation({ mutationFn: () => api(`/agent/calls/${call.id}/answer`, { body: {} }), onError: (e) => toast('bad', mutationError(e)) });
  const left = Math.max(0, 20 - Math.floor((now - call.startedAt) / 1000));
  return (
    <Card className="border-2 border-amber-400 p-6 text-center">
      <PhoneIncoming className="mx-auto mb-2 h-10 w-10 animate-pulse text-amber-500" aria-hidden />
      <h2 className="text-xl font-semibold">Incoming {call.direction} call</h2>
      <p className="mt-1 text-lg tabular-nums">{call.direction === 'inbound' ? call.from : call.to}</p>
      <p className="text-sm text-slate-500">{call.queueName}{call.campaignName ? ` · ${call.campaignName}` : ''}</p>
      <Button variant="primary" className="mt-4 !px-8 !py-3 text-base" busy={answer.isPending} onClick={() => answer.mutate()}><Phone className="h-5 w-5" aria-hidden />Answer</Button>
      <p className="mt-2 text-xs text-slate-500">Unanswered calls re-route and put you on break (ring-no-answer) in about {left}s.</p>
    </Card>
  );
}

function Preview({ lead }: { lead: NonNullable<ReturnType<typeof useLive>['me']>['preview'] }) {
  const toast = useToast();
  const dial = useMutation({ mutationFn: () => api('/agent/preview/dial', { body: {} }), onError: (e) => toast('bad', mutationError(e)) });
  const skip = useMutation({ mutationFn: () => api('/agent/preview/skip', { body: {} }), onError: (e) => toast('bad', mutationError(e)) });
  return (
    <Card className="p-6">
      <Badge tone="cyan">Preview lead</Badge>
      <h2 className="mt-2 text-xl font-semibold">{lead!.name}</h2><p className="text-lg tabular-nums text-slate-600">{lead!.phone}</p>
      <div className="mt-4 flex gap-2"><Button variant="primary" busy={dial.isPending} onClick={() => dial.mutate()}><Phone className="h-4 w-4" aria-hidden />Dial</Button><Button busy={skip.isPending} onClick={() => skip.mutate()}><SkipForward className="h-4 w-4" aria-hidden />Skip (retry in 10 min)</Button></div>
    </Card>
  );
}

function Active({ call, meta }: { call: MeCall; meta?: AgentMe }) {
  const toast = useToast(); const now = useNow(1000);
  const [token, setToken] = useState<string | null>(null);
  const [resumeToken, setResumeToken] = useState('');
  const end = useMutation({ mutationFn: () => api(`/agent/calls/${call.id}/end`, { body: {} }), onError: (e) => toast('bad', mutationError(e)) });
  const pause = useMutation({ mutationFn: () => api<{ token: string }>(`/agent/calls/${call.id}/recording/pause`, { body: {} }), onSuccess: (r) => setToken(r.token), onError: (e) => toast('bad', mutationError(e)) });
  const resume = useMutation({ mutationFn: () => api(`/agent/calls/${call.id}/recording/resume`, { body: { token: resumeToken.trim() } }), onSuccess: () => { setResumeToken(''); toast('good', 'Recording resumed'); }, onError: (e) => toast('bad', mutationError(e)) });

  return (
    <Card className="border-2 border-blue-400">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-blue-50 px-4 py-3">
        <div><div className="text-xs font-medium uppercase tracking-wide text-blue-700">On call · {title(call.direction)}</div><div className="text-xl font-semibold">{call.customerName ?? (call.direction === 'inbound' ? call.from : call.to)}</div><div className="tabular-nums text-slate-600">{call.direction === 'inbound' ? call.from : call.to}</div></div>
        <div className="text-right"><div className="text-3xl font-semibold tabular-nums">{fmtDur((now - (call.answeredAt ?? call.startedAt)) / 1000)}</div><div className="text-xs text-slate-500">{call.queueName}{call.campaignName ? ` · ${call.campaignName}` : ''}</div></div>
      </div>
      <div className="space-y-4 p-4">
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-slate-500" aria-hidden />Recording & consent</div>
          {call.consent === 'not_required' && <p className="text-sm text-slate-600">This queue does not record calls.</p>}
          {call.consent === 'declined' && <Notice tone="warn">The caller declined recording. This call is <strong>not</strong> being recorded.</Notice>}
          {(call.consent === 'announced' || call.consent === 'granted') && (
            <>
              <p className="mb-2 text-sm text-slate-600">{call.consent === 'announced' ? <>Consent notice played: “{meta?.consentPrompt}”</> : 'Caller opted in to recording.'}</p>
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={call.recording === 'recording' ? 'red' : call.recording === 'paused' ? 'amber' : 'slate'}>{call.recording === 'recording' ? '● Recording' : call.recording === 'paused' ? '⏸ Recording PAUSED' : title(call.recording)}</Badge>
                {meta?.pauseResumeEnabled && call.recording === 'recording' && <Button busy={pause.isPending} onClick={() => pause.mutate()}><MicOff className="h-4 w-4" aria-hidden />Pause recording (e.g. card details)</Button>}
              </div>
              {call.recording === 'paused' && (
                <form className="mt-3 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); resume.mutate(); }}>
                  <div className="flex-1"><Field label="Resume token" hint="Recording cannot restart without the token issued when you paused. A supervisor can force-resume (audited).">{(id) => <TextInput id={id} autoComplete="off" placeholder="rpt_…" value={resumeToken} onChange={(e) => setResumeToken(e.target.value)} />}</Field></div>
                  <Button type="submit" variant="primary" busy={resume.isPending} disabled={resumeToken.length < 8}><Mic className="h-4 w-4" aria-hidden />Resume</Button>
                </form>
              )}
            </>
          )}
        </div>
        <Button variant="danger" className="!px-6" busy={end.isPending} onClick={() => end.mutate()}><PhoneOff className="h-4 w-4" aria-hidden />End call</Button>
      </div>
      {token && (
        <Modal title="Recording paused — resume token" onClose={() => setToken(null)}>
          <Notice tone="warn">Recording is now hard-paused. This token is shown <strong>once</strong>; recording only resumes when it is submitted.</Notice>
          <code className="my-3 block break-all rounded bg-slate-100 p-3 text-sm">{token}</code>
          <div className="flex justify-end"><Button variant="primary" onClick={() => { navigator.clipboard?.writeText(token).catch(() => {}); setResumeToken(token); setToken(null); }}>Copy & close</Button></div>
        </Modal>
      )}
    </Card>
  );
}

function Wrap({ callId, dispositions }: { callId: number; dispositions: AgentMe['dispositions'] }) {
  const toast = useToast();
  const [code, setCode] = useState(''); const [notes, setNotes] = useState('');
  const submit = useMutation({ mutationFn: () => api(`/agent/calls/${callId}/disposition`, { body: { code, notes: notes || undefined } }), onSuccess: () => { setCode(''); setNotes(''); toast('good', 'Call saved — you are available again'); }, onError: (e) => toast('bad', mutationError(e)) });
  const groups = ['positive', 'neutral', 'negative'] as const;
  return (
    <Card className="border-2 border-purple-400">
      <CardHeader title={`Wrap-up · call #${callId}`} subtitle="Choose a disposition to finish. You stay in wrap-up (no new calls) until you submit." />
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); submit.mutate(); }}>
        <fieldset>
          <legend className="label">Disposition</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {groups.map((g) => (
              <div key={g}><div className="mb-1 text-xs font-semibold uppercase text-slate-400">{g}</div>
                {dispositions.filter((d) => d.category === g).map((d) => (
                  <label key={d.code} className={clsx('mb-1 flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm', code === d.code ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50')}>
                    <input type="radio" name="disposition" value={d.code} checked={code === d.code} onChange={() => setCode(d.code)} />{d.label}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </fieldset>
        <Field label="Notes (optional)">{(id) => <textarea id={id} maxLength={500} className="input h-20" value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <ErrorBanner error={submit.error} />
        <Button type="submit" variant="primary" disabled={!code} busy={submit.isPending}>Save & become available</Button>
      </form>
    </Card>
  );
}

function QueueBoard() {
  const { board, me } = useLive();
  const mine = new Set(me?.queues.map((q) => q.id));
  const rows = (board?.queues ?? []).filter((q) => mine.has(q.id));
  const t = board?.team;
  return (
    <Card>
      <CardHeader title="Live queue board" subtitle="Pushed to you every second over the WebSocket" />
      {rows.length === 0 ? <Empty>{board ? 'You are not a member of any queue.' : 'Waiting for live data…'}</Empty> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {rows.map((q) => (
            <li key={q.id} className="px-4 py-2">
              <div className="flex items-center justify-between"><span className="font-medium">{q.name}</span>{q.waiting > 0 ? <Badge tone="amber">{q.waiting} waiting</Badge> : <span className="text-xs text-slate-400">no wait</span>}</div>
              <div className="mt-0.5 text-xs text-slate-500">{q.agentsAvailable} of {q.agentsStaffed} agents free{q.waiting > 0 ? ` · longest wait ${fmtDur(q.longestWaitSecs)}` : ''} · service level {q.serviceLevelPct === null ? '—' : `${q.serviceLevelPct}%`}</div>
            </li>
          ))}
        </ul>
      )}
      {t && <div className="flex flex-wrap gap-1.5 border-t border-slate-100 px-4 py-2.5 text-xs"><Badge tone="green">{t.available} available</Badge><Badge tone="blue">{t.on_call} on call</Badge><Badge tone="purple">{t.wrap_up} wrap-up</Badge><Badge tone="orange">{t.break} on break</Badge><span className="self-center text-slate-500">{board.activeCalls} live calls</span></div>}
    </Card>
  );
}

function LiveUpdates() {
  const feed = useLiveFeed();
  const perSec = feed.recent.slice(-5).reduce((a, b) => a + b, 0) / 5;
  return (
    <Card>
      <CardHeader title="Live updates" subtitle={`${feed.total.toLocaleString('en-IN')} received · ${perSec.toFixed(1)}/s`} />
      <ul className="divide-y divide-slate-100 font-mono text-[11px]">
        {feed.items.slice(0, 6).map((f) => <li key={f.n} className="flex justify-between px-4 py-1.5"><span className="text-slate-400">{fmtTime(new Date(f.t))}</span><span className="font-semibold text-slate-700">{f.type}</span><span className="text-slate-500">{f.bytes} B</span></li>)}
      </ul>
      {feed.items.length === 0 && <Empty>Waiting for the first update…</Empty>}
    </Card>
  );
}
