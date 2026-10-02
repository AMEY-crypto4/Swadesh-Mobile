import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../lib/api';
import { daysAgo, fmtDur, fmtNum, fmtPct, fmtTime, title } from '../../lib/format';
import { useLive, type LiveCall } from '../../lib/live';
import { Badge, Card, CardHeader, Empty, ErrorBanner, PageHeader, Stat, Table } from '../../components/ui';

export const COLORS = { inbound: '#4b4bc2', outbound: '#0ea5e9', abandoned: '#ef4444', available: '#10b981', onCall: '#3b82f6', waiting: '#f59e0b' };

export function Wallboard() {
  const { stats, queues, campaigns, calls, agents, connection } = useLive();
  const telemetry = useQuery({ queryKey: ['telemetry'], queryFn: () => api<any[]>('/reports/telemetry', { query: { minutes: 180 } }), refetchInterval: 30_000 });
  const today = daysAgo(0);
  const hourly = useQuery({ queryKey: ['hourly-today'], queryFn: () => api<any[]>('/reports/hourly', { query: { from: today, to: today } }), refetchInterval: 60_000 });

  const slaTone = stats?.serviceLevelPct == null ? 'default' : stats.serviceLevelPct >= 80 ? 'good' : stats.serviceLevelPct >= 65 ? 'warn' : 'bad';
  const agentName = (id: number | null) => agents.find((a) => a.id === id)?.name ?? '—';
  const queueName = (id: number) => queues.find((q) => q.id === id)?.name ?? `#${id}`;
  const live = calls.filter((c) => c.state !== 'ended').sort((a, b) => b.startedAt - a.startedAt).slice(0, 12);

  return (
    <>
      <PageHeader title="Operations wallboard" subtitle="Live from the WebSocket stream; today's totals reset at local midnight." />
      {!stats ? (
        <Empty>{connection === 'live' ? 'Waiting for first snapshot…' : 'Connecting to the live feed…'}</Empty>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Active calls" value={stats.activeCalls} />
            <Stat label="Waiting in queue" value={stats.waiting} tone={stats.waiting > 3 ? 'warn' : 'default'} />
            <Stat label="Agents available" value={stats.agentsByState.available} tone={stats.agentsByState.available === 0 ? 'bad' : 'good'} hint={`${stats.agentsByState.on_call + stats.agentsByState.wrap_up + stats.agentsByState.ringing} busy · ${stats.agentsByState.break} on break`} />
            <Stat label="Offered today" value={fmtNum(stats.offeredToday)} hint={`${fmtNum(stats.answeredToday)} answered`} />
            <Stat label="Service level" value={fmtPct(stats.serviceLevelPct)} tone={slaTone} hint="answered within queue SLA" />
            <Stat label="Abandoned today" value={stats.abandonedToday} tone={stats.abandonedToday > 0 ? 'warn' : 'default'} />
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Queues" subtitle="Inbound performance since midnight" />
              <Table>
                <thead><tr><th className="th">Queue</th><th className="th text-right">Waiting</th><th className="th text-right">Longest wait</th><th className="th text-right">Avail / staffed</th><th className="th text-right">Offered</th><th className="th text-right">Abandoned</th><th className="th text-right">Avg wait</th><th className="th text-right">SLA</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {queues.map((q) => (
                    <tr key={q.id}>
                      <td className="td font-medium">{q.name}<div className="text-xs font-normal text-slate-400">{title(q.strategy)} · SLA {q.sla}s</div></td>
                      <td className="td text-right tabular-nums">{q.waiting > 0 ? <Badge tone="amber">{q.waiting}</Badge> : 0}</td>
                      <td className="td text-right tabular-nums">{q.waiting ? fmtDur(q.longestWaitSecs) : '—'}</td>
                      <td className="td text-right tabular-nums">{q.agentsAvailable} / {q.agentsStaffed}</td>
                      <td className="td text-right tabular-nums">{q.offered}</td>
                      <td className="td text-right tabular-nums">{q.abandoned}</td>
                      <td className="td text-right tabular-nums">{fmtDur(q.avgWaitSecs)}</td>
                      <td className="td text-right tabular-nums">{q.serviceLevelPct === null ? '—' : <Badge tone={q.serviceLevelPct >= 80 ? 'green' : q.serviceLevelPct >= 65 ? 'amber' : 'red'}>{q.serviceLevelPct}%</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>

            <Card>
              <CardHeader title="Dialer" subtitle="Live campaign pacing" />
              {campaigns.filter((c) => c.status === 'running' || c.status === 'paused').length === 0 ? <Empty>No active campaigns</Empty> : (
                <ul className="divide-y divide-slate-100">
                  {campaigns.filter((c) => c.status === 'running' || c.status === 'paused').map((c) => (
                    <li key={c.id} className="px-4 py-3 text-sm">
                      <div className="flex items-center justify-between"><span className="font-medium">{c.name}</span><Badge tone={c.status === 'running' ? 'green' : 'amber'}>{title(c.status)}</Badge></div>
                      <div className="mt-1 grid grid-cols-4 gap-1 text-xs text-slate-500">
                        <span>{title(c.mode)}</span><span>Dialing {c.inflight}</span><span>Connected {c.connected}</span>
                        <span className={c.abandonPct > 3 ? 'font-semibold text-red-600' : ''}>Aband. {c.abandonPct}%</span>
                      </div>
                      {c.mode === 'predictive' && <div className="mt-0.5 text-xs text-slate-500">Effective pacing {c.effectiveRatio}:1{c.effectiveRatio === 1 ? ' (throttled to protect abandon cap)' : ''}</div>}
                      {c.exhausted && c.status === 'running' && <div className="mt-0.5 text-xs text-amber-700">No dialable leads right now</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="xl:col-span-2">
              <CardHeader title="Agents & waiting — last 3 hours" subtitle="Minute snapshots stored in MongoDB" />
              <div className="h-64 p-3">
                {telemetry.error ? <ErrorBanner error={telemetry.error} /> : (
                  <ResponsiveContainer>
                    <AreaChart data={(telemetry.data ?? []).map((d) => ({ ...d, t: fmtTime(d.ts).slice(0, 5) }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip /><Legend />
                      <Area type="monotone" dataKey="agents_on_call" name="On call" stroke={COLORS.onCall} fill={COLORS.onCall} fillOpacity={0.15} />
                      <Area type="monotone" dataKey="agents_available" name="Available" stroke={COLORS.available} fill={COLORS.available} fillOpacity={0.15} />
                      <Area type="monotone" dataKey="calls_waiting" name="Waiting" stroke={COLORS.waiting} fill={COLORS.waiting} fillOpacity={0.25} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Call volume today" subtitle="By hour" />
              <div className="h-64 p-3">
                <ResponsiveContainer>
                  <BarChart data={(hourly.data ?? []).filter((h) => h.hour >= 8 && h.hour <= 21)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="hour" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip /><Legend />
                    <Bar dataKey="inbound" name="Inbound" stackId="a" fill={COLORS.inbound} /><Bar dataKey="outbound" name="Outbound" stackId="a" fill={COLORS.outbound} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="xl:col-span-3">
              <CardHeader title="Live calls" subtitle="Customer numbers are masked on the wallboard" />
              {live.length === 0 ? <Empty>No calls in progress</Empty> : (
                <Table>
                  <thead><tr><th className="th">Call</th><th className="th">Direction</th><th className="th">Queue</th><th className="th">Customer</th><th className="th">Agent</th><th className="th">State</th><th className="th text-right">Duration</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">{live.map((c) => <LiveRow key={c.id} c={c} queue={queueName(c.queueId)} agent={agentName(c.agentId)} />)}</tbody>
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function LiveRow({ c, queue, agent }: { c: LiveCall; queue: string; agent: string }) {
  const secs = (Date.now() - (c.answeredAt ?? c.startedAt)) / 1000;
  return (
    <tr>
      <td className="td tabular-nums">#{c.id}</td><td className="td">{title(c.direction)}</td><td className="td">{queue}</td>
      <td className="td tabular-nums">{c.direction === 'inbound' ? c.from : c.to}</td><td className="td">{agent}</td>
      <td className="td"><Badge tone={c.state === 'in_progress' ? 'blue' : c.state === 'ringing' ? 'amber' : 'slate'}>{title(c.state)}</Badge>{c.recording === 'recording' && <span className="ml-1 text-xs text-red-600">● REC</span>}{c.recording === 'paused' && <span className="ml-1 text-xs text-amber-700">⏸ rec paused</span>}</td>
      <td className="td text-right tabular-nums">{fmtDur(secs)}</td>
    </tr>
  );
}
