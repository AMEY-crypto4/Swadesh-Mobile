import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtNum, title } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, Modal, Notice, PageHeader, Pagination, Select, Spinner, Stat, Table, TextInput, mutationError, useToast } from '../../components/ui';
import { statusTone } from './Campaigns';

interface Rule { outcome: string; action: 'retry_after' | 'mark_done' | 'schedule_callback' | 'add_to_dnc'; action_param: number | null }
interface Detail {
  id: number; version: number; name: string; mode: 'preview' | 'progressive' | 'predictive'; status: 'draft' | 'running' | 'paused' | 'completed'; queue_name: string;
  pacing_ratio: number; max_abandon_pct: number; max_attempts: number; retry_delay_minutes: number; ring_timeout_secs: number; caller_id: string;
  rules: Rule[]; leads: Record<string, number>;
}

const OUTCOMES = ['no_answer', 'busy', 'voicemail', 'failed', 'abandoned', 'sale_closed', 'interested', 'callback_requested', 'not_interested', 'wrong_number', 'dnc_request', 'already_customer'];
const ACTIONS = { retry_after: 'Retry after N minutes', mark_done: 'Mark lead done', schedule_callback: 'Schedule callback in N minutes', add_to_dnc: 'Add to do-not-call list' } as const;
const LEAD_STATUS = ['', 'new', 'dialing', 'callback', 'contacted', 'done', 'exhausted', 'dnc'];

export function CampaignDetail() {
  const id = Number(useParams().id);
  const { user } = useAuth();
  const { campaigns } = useLive();
  const q = useQuery({ queryKey: ['campaign', id], queryFn: () => api<Detail>(`/campaigns/${id}`) });
  const live = campaigns.find((c) => c.id === id);
  const isAdmin = user?.role === 'admin';
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBanner error={q.error} />;
  const c = q.data;
  const total = Object.values(c.leads).reduce((s, n) => s + n, 0);

  return (
    <>
      <Link to="/campaigns" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden />Campaigns</Link>
      <PageHeader title={c.name} subtitle={<>Queue {c.queue_name} · {title(c.mode)} · caller ID {c.caller_id}</>} actions={<Badge tone={statusTone[c.status]}>{title(c.status)}</Badge>} />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Total leads" value={fmtNum(total)} />
        <Stat label="Dialable now" value={fmtNum((c.leads.new ?? 0) + (c.leads.callback ?? 0))} />
        <Stat label="In flight" value={live?.inflight ?? '—'} hint="live" />
        <Stat label="Abandon (last 100)" value={live ? `${live.abandonPct}%` : '—'} tone={live && live.abandonPct > c.max_abandon_pct ? 'bad' : 'default'} hint={`cap ${c.max_abandon_pct}%`} />
        <Stat label="Effective pacing" value={live ? `${live.effectiveRatio}:1` : '—'} hint={c.mode === 'predictive' ? `configured ${c.pacing_ratio}:1` : title(c.mode)} />
      </div>
      <Notice tone="warn">Demo override: the calling-window check (09:00–20:00 local) is disabled so the simulator can dial at any hour. Do-not-call checks, attempt limits and retry rules are fully enforced.</Notice>
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Settings c={c} canEdit={isAdmin && c.status !== 'completed'} />
        <Rules c={c} canEdit={isAdmin && c.status !== 'completed'} />
      </div>
      <Leads campaignId={id} canImport={isAdmin && c.status !== 'completed'} />
    </>
  );
}

function Settings({ c, canEdit }: { c: Detail; canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const [f, setF] = useState({ mode: c.mode, pacing_ratio: c.pacing_ratio, max_abandon_pct: c.max_abandon_pct, max_attempts: c.max_attempts, retry_delay_minutes: c.retry_delay_minutes, ring_timeout_secs: c.ring_timeout_secs });
  const m = useMutation({
    mutationFn: () => api(`/campaigns/${c.id}`, { method: 'PATCH', body: { ...f, version: c.version } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaign', c.id] }); toast('good', 'Settings saved'); }, onError: (e) => { toast('bad', mutationError(e)); qc.invalidateQueries({ queryKey: ['campaign', c.id] }); },
  });
  const n = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: Number(e.target.value) });
  return (
    <Card>
      <CardHeader title="Dialer settings" />
      <form className="grid gap-3 p-4 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <fieldset disabled={!canEdit} className="contents">
          <Field label="Mode">{(id) => <Select id={id} value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as never })}><option value="preview">Preview</option><option value="progressive">Progressive</option><option value="predictive">Predictive</option></Select>}</Field>
          <Field label="Pacing ratio" hint="Predictive only">{(id) => <TextInput id={id} type="number" step="0.1" min={1} max={3} disabled={f.mode !== 'predictive'} value={f.pacing_ratio} onChange={n('pacing_ratio')} />}</Field>
          <Field label="Abandon cap (%)" hint="Max 5%. Pacing drops to 1:1 above the cap.">{(id) => <TextInput id={id} type="number" step="0.5" min={0.5} max={5} value={f.max_abandon_pct} onChange={n('max_abandon_pct')} />}</Field>
          <Field label="Max attempts per lead">{(id) => <TextInput id={id} type="number" min={1} max={10} value={f.max_attempts} onChange={n('max_attempts')} />}</Field>
          <Field label="Default retry delay (min)">{(id) => <TextInput id={id} type="number" min={1} max={1440} value={f.retry_delay_minutes} onChange={n('retry_delay_minutes')} />}</Field>
          <Field label="Ring timeout (s)">{(id) => <TextInput id={id} type="number" min={10} max={60} value={f.ring_timeout_secs} onChange={n('ring_timeout_secs')} />}</Field>
        </fieldset>
        {canEdit && <div className="md:col-span-2"><Button type="submit" variant="primary" busy={m.isPending}>Save settings</Button></div>}
      </form>
    </Card>
  );
}

function Rules({ c, canEdit }: { c: Detail; canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const [rules, setRules] = useState<Rule[]>(c.rules);
  useEffect(() => setRules(c.rules), [c.rules]);
  const m = useMutation({
    mutationFn: () => api(`/campaigns/${c.id}/rules`, { method: 'PUT', body: rules, query: { version: c.version } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaign', c.id] }); toast('good', 'Rules saved'); }, onError: (e) => { toast('bad', mutationError(e)); qc.invalidateQueries({ queryKey: ['campaign', c.id] }); },
  });
  const set = (i: number, patch: Partial<Rule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Card>
      <CardHeader title="Dialer rules" subtitle="Evaluated top to bottom after every attempt; the first rule matching the call status or disposition wins" />
      <div className="space-y-2 p-4">
        {rules.map((r, i) => (
          <div key={i} className="grid grid-cols-[1.4fr_1.6fr_5rem_2rem] items-end gap-2">
            <Field label={i === 0 ? 'When outcome is' : ''}>{(id) => <Select id={id} disabled={!canEdit} value={r.outcome} onChange={(e) => set(i, { outcome: e.target.value })}>{[...new Set([...OUTCOMES, r.outcome])].map((o) => <option key={o} value={o}>{title(o)}</option>)}</Select>}</Field>
            <Field label={i === 0 ? 'Then' : ''}>{(id) => <Select id={id} disabled={!canEdit} value={r.action} onChange={(e) => set(i, { action: e.target.value as Rule['action'], action_param: e.target.value === 'retry_after' ? 30 : e.target.value === 'schedule_callback' ? 60 : null })}>{Object.entries(ACTIONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
            <Field label={i === 0 ? 'Minutes' : ''}>{(id) => <TextInput id={id} type="number" min={1} disabled={!canEdit || !(r.action === 'retry_after' || r.action === 'schedule_callback')} value={r.action_param ?? ''} onChange={(e) => set(i, { action_param: Number(e.target.value) })} />}</Field>
            {canEdit && <button aria-label={`Remove rule ${i + 1}`} onClick={() => setRules(rules.filter((_, j) => j !== i))} className="mb-1 rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
          </div>
        ))}
        {canEdit && (
          <div className="flex gap-2 pt-2">
            <Button onClick={() => setRules([...rules, { outcome: 'no_answer', action: 'retry_after', action_param: 30 }])}>Add rule</Button>
            <Button variant="primary" busy={m.isPending} onClick={() => m.mutate()}>Save rules</Button>
          </div>
        )}
        {!rules.length && <Empty>No rules: unanswered leads retry after the default delay.</Empty>}
      </div>
    </Card>
  );
}

function Leads({ campaignId, canImport }: { campaignId: number; canImport: boolean }) {
  const [page, setPage] = useState(1); const [status, setStatus] = useState(''); const [search, setSearch] = useState(''); const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  useEffect(() => { const t = setTimeout(() => { setQ(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const leads = useQuery({ queryKey: ['leads', campaignId, page, status, q], queryFn: () => api<{ total: number; page: number; pageSize: number; rows: any[] }>(`/campaigns/${campaignId}/leads`, { query: { page, status, q } }), placeholderData: (p) => p });
  return (
    <Card className="mt-5">
      <CardHeader title="Leads" actions={<>
        <div className="w-36"><Select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>{LEAD_STATUS.map((s) => <option key={s} value={s}>{s ? title(s) : 'All statuses'}</option>)}</Select></div>
        <div className="w-44"><TextInput aria-label="Search leads" placeholder="Phone or first name…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        {canImport && <Button onClick={() => setImporting(true)}>Import CSV</Button>}
      </>} />
      <ErrorBanner error={leads.error} />
      <Table>
        <thead><tr><th className="th">Name</th><th className="th">Phone</th><th className="th">Status</th><th className="th text-right">Attempts</th><th className="th">Last outcome</th><th className="th">Last attempt</th><th className="th">Next attempt</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {leads.data?.rows.map((l) => (
            <tr key={l.id}><td className="td">{l.first_name} {l.last_name}</td><td className="td tabular-nums">{l.phone}</td><td className="td"><Badge tone={l.status === 'dnc' ? 'red' : l.status === 'new' ? 'blue' : l.status === 'callback' ? 'amber' : 'slate'}>{title(l.status)}</Badge></td>
              <td className="td text-right">{l.attempts}</td><td className="td">{l.last_outcome ? title(l.last_outcome) : '—'}</td><td className="td">{fmtDateTime(l.last_attempt_at)}</td><td className="td">{fmtDateTime(l.next_attempt_at)}</td></tr>
          ))}
        </tbody>
      </Table>
      {leads.data && <Pagination page={page} pageSize={leads.data.pageSize} total={leads.data.total} onPage={setPage} />}
      {importing && <ImportLeads campaignId={campaignId} onClose={() => setImporting(false)} />}
    </Card>
  );
}

function ImportLeads({ campaignId, onClose }: { campaignId: number; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [csv, setCsv] = useState('first_name,last_name,phone,email\nAnita,Rao,+919820011122,anita.rao@example.in\nKabir,Shaikh,+919867755443,kabir.s@example.in');
  const m = useMutation({
    mutationFn: () => api<{ imported: number; duplicates: number; dnc: number; invalidCount: number; invalid: { row: number; reason: string }[] }>(`/campaigns/${campaignId}/leads/import`, { body: { csv } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['leads', campaignId] }); qc.invalidateQueries({ queryKey: ['campaign', campaignId] }); toast('good', `Imported ${r.imported}`); },
  });
  return (
    <Modal title="Import leads (CSV)" onClose={onClose} wide>
      <p className="mb-2 text-sm text-slate-500">Header row required: <code>first_name,last_name,phone,email</code>. Phones must be E.164. Numbers on the do-not-call list and duplicates are skipped. Max 5000 rows.</p>
      <textarea aria-label="CSV content" className="input h-48 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} />
      <ErrorBanner error={m.error} />
      {m.data && (
        <div className="mt-3"><Notice tone="good">Imported {m.data.imported} · duplicates skipped {m.data.duplicates} · DNC skipped {m.data.dnc} · invalid {m.data.invalidCount}</Notice>
          {m.data.invalid.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-red-700">{m.data.invalid.map((i) => <li key={i.row}>Row {i.row}: {i.reason}</li>)}</ul>}</div>
      )}
      <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>Close</Button><Button variant="primary" busy={m.isPending} onClick={() => m.mutate()}>Import</Button></div>
    </Modal>
  );
}
