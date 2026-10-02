import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtDateTime, fmtDur, title } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Modal, Notice, PageHeader, Pagination, Select, Spinner, Table, TextInput, mutationError, useToast } from '../../components/ui';

interface CallRow { id: number; direction: string; status: string; disposition: string | null; from_number: string | null; to_number: string | null; started_at: string; wait_secs: number; talk_secs: number; recording_consent: string; recording_state: string; queue_name: string | null; agent_name: string | null }
const STATUSES = ['completed', 'abandoned', 'no_answer', 'busy', 'voicemail', 'failed', 'in_progress'];
const statusTone = (s: string) => (s === 'completed' ? 'green' : s === 'abandoned' || s === 'failed' ? 'red' : s === 'in_progress' ? 'blue' : 'slate') as 'green' | 'red' | 'blue' | 'slate';

export function CallLog() {
  const [page, setPage] = useState(1);
  const [f, setF] = useState({ status: '', direction: '', queueId: '', agentId: '', phone: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const [open, setOpen] = useState<number | null>(null);
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api<{ id: number; name: string }[]>('/queues') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<{ id: number; name: string; role: string }[]>('/users') });
  const calls = useQuery({ queryKey: ['calls', page, applied], queryFn: () => api<{ total: number; pageSize: number; rows: CallRow[] }>('/calls', { query: { page, ...applied } }), placeholderData: (p) => p });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Call log" subtitle="Server-side filtered and paginated — stays fast on very large tenants" />
      <Card className="mb-4 p-4">
        <form className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7" onSubmit={(e) => { e.preventDefault(); setPage(1); setApplied(f); }}>
          <Field label="Status">{(id) => <Select id={id} value={f.status} onChange={set('status')}><option value="">Any</option>{STATUSES.map((s) => <option key={s} value={s}>{title(s)}</option>)}</Select>}</Field>
          <Field label="Direction">{(id) => <Select id={id} value={f.direction} onChange={set('direction')}><option value="">Any</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option></Select>}</Field>
          <Field label="Queue">{(id) => <Select id={id} value={f.queueId} onChange={set('queueId')}><option value="">Any</option>{queues.data?.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</Select>}</Field>
          <Field label="Agent">{(id) => <Select id={id} value={f.agentId} onChange={set('agentId')}><option value="">Any</option>{users.data?.filter((u) => u.role === 'agent').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
          <Field label="Phone (exact)">{(id) => <TextInput id={id} placeholder="+9198…" pattern="\+?\d{4,15}" value={f.phone} onChange={set('phone')} />}</Field>
          <Field label="From">{(id) => <TextInput id={id} type="date" value={f.from} onChange={set('from')} />}</Field>
          <Field label="To">{(id) => <TextInput id={id} type="date" value={f.to} onChange={set('to')} />}</Field>
          <div className="flex gap-2 sm:col-span-3 lg:col-span-7"><Button type="submit" variant="primary">Apply filters</Button><Button type="button" onClick={() => { const e = { status: '', direction: '', queueId: '', agentId: '', phone: '', from: '', to: '' }; setF(e); setApplied(e); setPage(1); }}>Reset</Button></div>
        </form>
      </Card>
      <ErrorBanner error={calls.error} />
      <Card>
        <Table>
          <thead><tr><th className="th">ID</th><th className="th">Started</th><th className="th">Dir</th><th className="th">Customer</th><th className="th">Queue</th><th className="th">Agent</th><th className="th">Status</th><th className="th">Disposition</th><th className="th text-right">Wait</th><th className="th text-right">Talk</th><th className="th">Rec</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {calls.data?.rows.map((c) => (
              <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(c.id)}>
                <td className="td tabular-nums"><button className="font-medium text-brand-700 hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(c.id); }}>#{c.id}</button></td>
                <td className="td whitespace-nowrap">{fmtDateTime(c.started_at)}</td><td className="td">{c.direction === 'inbound' ? 'In' : 'Out'}</td>
                <td className="td tabular-nums">{(c.direction === 'inbound' ? c.from_number : c.to_number) ?? <span className="text-slate-400">erased</span>}</td>
                <td className="td">{c.queue_name}</td><td className="td">{c.agent_name ?? '—'}</td><td className="td"><Badge tone={statusTone(c.status)}>{title(c.status)}</Badge></td>
                <td className="td">{c.disposition ? title(c.disposition) : '—'}</td><td className="td text-right tabular-nums">{fmtDur(c.wait_secs)}</td><td className="td text-right tabular-nums">{fmtDur(c.talk_secs)}</td>
                <td className="td"><RecBadge state={c.recording_state} consent={c.recording_consent} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
        {calls.data && calls.data.rows.length === 0 && <Empty>No calls match these filters.</Empty>}
        {calls.data && <Pagination page={page} pageSize={calls.data.pageSize} total={calls.data.total} onPage={setPage} />}
      </Card>
      {open && <CallDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function RecBadge({ state, consent }: { state: string; consent: string }) {
  if (consent === 'declined') return <Badge tone="amber">Declined</Badge>;
  if (state === 'stopped') return <Badge tone="blue">Recorded</Badge>;
  if (state === 'recording' || state === 'paused') return <Badge tone={state === 'paused' ? 'amber' : 'red'}>{state === 'paused' ? 'Paused' : '● Live'}</Badge>;
  if (state === 'purged') return <Badge>Purged</Badge>;
  return <span className="text-slate-400">—</span>;
}

function CallDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['call', id], queryFn: () => api<any>(`/calls/${id}`), refetchInterval: (s) => (s.state.data?.status === 'in_progress' ? 3000 : false) });
  const override = useMutation({ mutationFn: () => api(`/calls/${id}/recording/override-resume`, { body: {} }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['call', id] }); toast('good', 'Recording resumed (logged as supervisor override)'); }, onError: (e) => toast('bad', mutationError(e)) });
  const c = q.data;
  return (
    <Modal title={`Call #${id}`} onClose={onClose} wide>
      {q.isLoading && <Spinner />}<ErrorBanner error={q.error} />
      {c && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
            {[['Direction', title(c.direction)], ['Status', title(c.status)], ['Disposition', c.disposition ? title(c.disposition) : '—'], ['Queue', c.queue_name ?? '—'], ['Campaign', c.campaign_name ?? '—'], ['Agent', c.agent_name ?? '—'],
              ['From', c.from_number ?? 'erased'], ['To', c.to_number ?? 'erased'], ['Started', fmtDateTime(c.started_at)], ['Wait', fmtDur(c.wait_secs)], ['Talk', fmtDur(c.talk_secs)], ['Wrap-up', fmtDur(c.wrap_secs)]].map(([k, v]) => (
              <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium">{v}</dd></div>
            ))}
          </dl>
          {c.notes && <p className="rounded bg-slate-50 p-2 text-sm"><strong>Notes:</strong> {c.notes}</p>}
          <div>
            <h3 className="mb-1 text-sm font-semibold">Recording & consent</h3>
            <p className="mb-2 text-sm text-slate-600">Consent: <strong>{title(c.recording_consent)}</strong> · Recording: <strong>{title(c.recording_state)}</strong>{c.recording_key && <span className="text-slate-400"> · {c.recording_key}</span>}</p>
            {c.recording_state === 'paused' && <Notice tone="warn"><div className="flex items-center justify-between gap-3"><span>Recording is hard-paused. Only the issued resume token can resume it — or a supervisor override, which is audited.</span><Button className="shrink-0" busy={override.isPending} onClick={() => override.mutate()}>Override & resume</Button></div></Notice>}
            {c.consent.length > 0 && <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">{c.consent.map((e: any, i: number) => <li key={i} className="flex justify-between px-3 py-1.5"><span>{title(e.type)}</span><span className="text-slate-500">{e.actor} · {fmtDateTime(e.created_at)}</span></li>)}</ul>}
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">Event timeline</h3>
            {c.events.length === 0 ? <p className="text-sm text-slate-500">No event timeline is stored for this call (timelines are kept for recent calls only).</p> : (
              <ol className="space-y-1 border-l-2 border-slate-200 pl-3 text-sm">{c.events.map((e: any, i: number) => <li key={i}><span className="font-medium">{title(e.type.replace('.', ' '))}</span> <span className="text-slate-500">{new Date(e.ts).toLocaleTimeString('en-IN', { hour12: false })}</span></li>)}</ol>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
