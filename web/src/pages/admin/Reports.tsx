import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download } from 'lucide-react';
import { api, download } from '../../lib/api';
import { daysAgo, fmtDur, fmtNum, fmtPct, title } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, PageHeader, Select, Spinner, Stat, Table, Tabs, TextInput, useToast, mutationError } from '../../components/ui';
import { COLORS } from './Wallboard';

type Tab = 'overview' | 'queues' | 'agents' | 'campaigns' | 'dispositions';
const tone = (v: number | null, good: number, warn: number, invert = false) => (v === null ? 'slate' : (invert ? v <= good : v >= good) ? 'green' : (invert ? v <= warn : v >= warn) ? 'amber' : 'red') as 'green' | 'amber' | 'red' | 'slate';

export function Reports() {
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState({ from: daysAgo(6), to: daysAgo(0), queueId: '' });
  const toast = useToast();
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api<{ id: number; name: string }[]>('/queues') });
  const query = { from: range.from, to: range.to, queueId: tab === 'queues' || tab === 'agents' || tab === 'dispositions' || tab === 'overview' ? range.queueId : '' };
  const exportable: Record<Tab, string> = { overview: 'daily', queues: 'queues', agents: 'agents', campaigns: 'campaigns', dispositions: 'dispositions' };

  return (
    <>
      <PageHeader title="Reports" subtitle="All figures are computed in SQL on indexed ranges and bucketed in company-local time (IST)"
        actions={<Button onClick={() => download(`/reports/${exportable[tab]}`, `${exportable[tab]}-report.csv`, { ...query, format: 'csv' }).catch((e) => toast('bad', mutationError(e)))}><Download className="h-4 w-4" aria-hidden />Export CSV</Button>} />
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">{(id) => <TextInput id={id} type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
          <Field label="To">{(id) => <TextInput id={id} type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
          <Field label="Queue">{(id) => <Select id={id} value={range.queueId} onChange={(e) => setRange({ ...range, queueId: e.target.value })}><option value="">All queues</option>{queues.data?.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</Select>}</Field>
          {[['Today', 0], ['7 days', 6], ['30 days', 29]].map(([l, d]) => <Button key={l as string} variant="ghost" onClick={() => setRange({ ...range, from: daysAgo(d as number), to: daysAgo(0) })}>{l}</Button>)}
        </div>
      </Card>
      <Tabs tabs={[{ id: 'overview', label: 'Overview' }, { id: 'queues', label: 'Queues' }, { id: 'agents', label: 'Agents' }, { id: 'campaigns', label: 'Campaigns' }, { id: 'dispositions', label: 'Dispositions' }]} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview query={query} />}
      {tab === 'queues' && <QueuesReport query={query} />}
      {tab === 'agents' && <AgentsReport query={query} />}
      {tab === 'campaigns' && <CampaignsReport query={query} />}
      {tab === 'dispositions' && <DispositionsReport query={query} />}
    </>
  );
}

type Q = Record<string, string>;
const useReport = <T,>(name: string, query: Q) => useQuery({ queryKey: ['report', name, query], queryFn: () => api<T>(`/reports/${name}`, { query }), placeholderData: (p) => p });

function Overview({ query }: { query: Q }) {
  const o = useReport<any>('overview', query); const d = useReport<any[]>('daily', query); const h = useReport<any[]>('hourly', query);
  if (o.isLoading) return <Spinner />;
  if (o.error) return <ErrorBanner error={o.error} />;
  const x = o.data;
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Total calls" value={fmtNum(x.totalCalls)} hint={`${fmtNum(x.inbound)} in · ${fmtNum(x.outbound)} out`} />
        <Stat label="Service level" value={fmtPct(x.serviceLevelPct)} tone={x.serviceLevelPct === null ? 'default' : x.serviceLevelPct >= 80 ? 'good' : x.serviceLevelPct >= 65 ? 'warn' : 'bad'} />
        <Stat label="Answer rate (inbound)" value={fmtPct(x.answerRatePct)} />
        <Stat label="Abandon rate" value={fmtPct(x.abandonRatePct)} tone={x.abandonRatePct !== null && x.abandonRatePct > 5 ? 'bad' : 'default'} />
        <Stat label="Outbound connect" value={fmtPct(x.outboundConnectPct)} />
        <Stat label="Positive outcomes" value={fmtNum(x.positiveOutcomes)} />
        <Stat label="Avg wait" value={fmtDur(x.avgWaitSecs)} /><Stat label="Avg talk" value={fmtDur(x.avgTalkSecs)} /><Stat label="Avg wrap-up" value={fmtDur(x.avgWrapSecs)} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card><CardHeader title="Daily volume" /><div className="h-72 p-3"><ResponsiveContainer><LineChart data={d.data ?? []}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} /><YAxis tick={{ fontSize: 11 }} /><Tooltip /><Legend />
          <Line type="monotone" dataKey="inbound" name="Inbound" stroke={COLORS.inbound} strokeWidth={2} dot={false} /><Line type="monotone" dataKey="outbound" name="Outbound" stroke={COLORS.outbound} strokeWidth={2} dot={false} /><Line type="monotone" dataKey="abandoned" name="Abandoned" stroke={COLORS.abandoned} strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div></Card>
        <Card><CardHeader title="Hour-of-day profile" subtitle="Company-local time" /><div className="h-72 p-3"><ResponsiveContainer><BarChart data={h.data ?? []}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="hour" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} /><Tooltip /><Legend />
          <Bar dataKey="inbound" name="Inbound" stackId="a" fill={COLORS.inbound} /><Bar dataKey="outbound" name="Outbound" stackId="a" fill={COLORS.outbound} /></BarChart></ResponsiveContainer></div></Card>
      </div>
    </>
  );
}

function QueuesReport({ query }: { query: Q }) {
  const r = useReport<any[]>('queues', query);
  if (r.isLoading) return <Spinner />;
  return (
    <Card><ErrorBanner error={r.error} /><Table>
      <thead><tr><th className="th">Queue</th><th className="th text-right">Calls</th><th className="th text-right">Answered</th><th className="th text-right">Abandoned</th><th className="th text-right">SLA %</th><th className="th text-right">Abandon %</th><th className="th text-right">Avg wait</th><th className="th text-right">Max wait</th><th className="th text-right">Avg talk</th></tr></thead>
      <tbody className="divide-y divide-slate-100">{r.data?.map((q) => <tr key={q.id}><td className="td font-medium">{q.name}<div className="text-xs font-normal text-slate-400">target {q.slaSeconds}s</div></td><td className="td text-right">{fmtNum(q.calls)}</td><td className="td text-right">{fmtNum(q.answered)}</td><td className="td text-right">{fmtNum(q.abandoned)}</td>
        <td className="td text-right"><Badge tone={tone(q.serviceLevelPct, 80, 65)}>{fmtPct(q.serviceLevelPct)}</Badge></td><td className="td text-right"><Badge tone={tone(q.abandonRatePct, 3, 6, true)}>{fmtPct(q.abandonRatePct)}</Badge></td><td className="td text-right">{fmtDur(q.avgWaitSecs)}</td><td className="td text-right">{fmtDur(q.maxWaitSecs)}</td><td className="td text-right">{fmtDur(q.avgTalkSecs)}</td></tr>)}</tbody>
    </Table>{r.data?.length === 0 && <Empty>No data for this range.</Empty>}</Card>
  );
}

function AgentsReport({ query }: { query: Q }) {
  const r = useReport<any[]>('agents', query);
  if (r.isLoading) return <Spinner />;
  return (
    <Card><ErrorBanner error={r.error} /><Table>
      <thead><tr><th className="th">Agent</th><th className="th text-right">Handled</th><th className="th text-right">In / Out</th><th className="th text-right">Talk hours</th><th className="th text-right">Avg talk</th><th className="th text-right">Avg wrap</th><th className="th text-right">Positive %</th><th className="th text-right">Sales</th></tr></thead>
      <tbody className="divide-y divide-slate-100">{r.data?.map((a) => <tr key={a.id}><td className="td font-medium">{a.name}</td><td className="td text-right">{fmtNum(a.handled)}</td><td className="td text-right">{a.inbound} / {a.outbound}</td><td className="td text-right">{a.talkHours}</td><td className="td text-right">{fmtDur(a.avgTalkSecs)}</td><td className="td text-right">{fmtDur(a.avgWrapSecs)}</td><td className="td text-right">{fmtPct(a.positivePct)}</td><td className="td text-right">{a.sales}</td></tr>)}</tbody>
    </Table>{r.data?.length === 0 && <Empty>No data for this range.</Empty>}</Card>
  );
}

function CampaignsReport({ query }: { query: Q }) {
  const r = useReport<any[]>('campaigns', { from: query.from, to: query.to });
  if (r.isLoading) return <Spinner />;
  return (
    <Card><ErrorBanner error={r.error} /><Table>
      <thead><tr><th className="th">Campaign</th><th className="th text-right">Dialed</th><th className="th text-right">Connected</th><th className="th text-right">Connect %</th><th className="th text-right">Abandon %</th><th className="th text-right">No answer</th><th className="th text-right">Busy</th><th className="th text-right">Voicemail</th><th className="th text-right">Sales</th><th className="th text-right">Leads left</th></tr></thead>
      <tbody className="divide-y divide-slate-100">{r.data?.map((c) => <tr key={c.id}><td className="td font-medium">{c.name}<div className="text-xs font-normal text-slate-400">{title(c.mode)} · {title(c.status)}</div></td><td className="td text-right">{fmtNum(c.dialed)}</td><td className="td text-right">{fmtNum(c.connected)}</td><td className="td text-right">{fmtPct(c.connectRatePct)}</td>
        <td className="td text-right"><Badge tone={tone(c.abandonRatePct, 3, 5, true)}>{fmtPct(c.abandonRatePct)}</Badge></td><td className="td text-right">{c.noAnswer}</td><td className="td text-right">{c.busy}</td><td className="td text-right">{c.voicemail}</td><td className="td text-right">{c.sales}</td><td className="td text-right">{fmtNum((c.leads.new ?? 0) + (c.leads.callback ?? 0))}</td></tr>)}</tbody>
    </Table>{r.data?.length === 0 && <Empty>No campaign calls in this range.</Empty>}</Card>
  );
}

function DispositionsReport({ query }: { query: Q }) {
  const r = useReport<{ code: string; label: string; category: string; count: number }[]>('dispositions', query);
  if (r.isLoading) return <Spinner />;
  const total = (r.data ?? []).reduce((s, x) => s + x.count, 0);
  return (
    <Card><ErrorBanner error={r.error} />
      <ul className="divide-y divide-slate-100">{r.data?.map((x) => (
        <li key={x.code} className="grid grid-cols-[12rem_1fr_6rem] items-center gap-3 px-4 py-2 text-sm">
          <span>{x.label} <Badge tone={x.category === 'positive' ? 'green' : x.category === 'negative' ? 'red' : 'slate'}>{x.category}</Badge></span>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-500" style={{ width: `${total ? (x.count / total) * 100 : 0}%` }} /></div>
          <span className="text-right tabular-nums">{fmtNum(x.count)} · {total ? Math.round((x.count / total) * 100) : 0}%</span>
        </li>))}</ul>{r.data?.length === 0 && <Empty>No dispositions in this range.</Empty>}
    </Card>
  );
}
