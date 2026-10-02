import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtNum, title } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, Notice, PageHeader, Pagination, Select, Spinner, Table, Tabs, TextInput, Toggle, mutationError, useToast } from '../../components/ui';

type Tab = 'settings' | 'consent' | 'exports' | 'erasure';

export function Privacy() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('settings');
  const admin = user?.role === 'admin';
  const tabs = [{ id: 'settings' as const, label: 'Consent & retention' }, { id: 'consent' as const, label: 'Consent log' }, ...(admin ? [{ id: 'exports' as const, label: 'Data exports' }, { id: 'erasure' as const, label: 'Erasure requests' }] : [])];
  return (
    <>
      <PageHeader title="Privacy & compliance" subtitle="Recording consent, hard pause/resume tokens, retention, deletion and structured exports" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'settings' && <Settings canEdit={admin} />}{tab === 'consent' && <ConsentLog />}{tab === 'exports' && <Exports />}{tab === 'erasure' && <Erasure />}
    </>
  );
}

function Settings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const s = useQuery({ queryKey: ['privacy-settings'], queryFn: () => api<any>('/privacy/settings') });
  const preview = useQuery({ queryKey: ['retention-preview'], queryFn: () => api<any>('/privacy/retention/preview') });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (s.data) setF({ ...s.data, allow_pause_resume: !!s.data.allow_pause_resume }); }, [s.data]);
  const save = useMutation({
    mutationFn: () => api('/privacy/settings', { method: 'PUT', body: { retention_recordings_days: +f.retention_recordings_days, retention_calls_days: +f.retention_calls_days, retention_sms_days: +f.retention_sms_days, consent_prompt_text: f.consent_prompt_text, allow_pause_resume: f.allow_pause_resume } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['privacy-settings'] }); qc.invalidateQueries({ queryKey: ['retention-preview'] }); toast('good', 'Privacy settings saved'); },
  });
  const run = useMutation({
    mutationFn: () => api<any>('/privacy/retention/run', { body: {} }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['retention-preview'] }); toast('good', `Purged ${fmtNum(r.recordingsPurged)} recordings, ${fmtNum(r.callsDeleted)} call records, ${fmtNum(r.smsDeleted)} SMS`); },
    onError: (e) => toast('bad', mutationError(e)),
  });
  if (!f) return <Spinner />;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const p = preview.data;
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader title="Consent & retention policy" />
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <fieldset disabled={!canEdit} className="space-y-3">
            <Field label="Consent prompt (played / shown at call start)">{(id) => <textarea id={id} className="input h-20" minLength={10} maxLength={400} value={f.consent_prompt_text} onChange={set('consent_prompt_text')} />}</Field>
            <Toggle checked={f.allow_pause_resume} onChange={(v) => setF({ ...f, allow_pause_resume: v })} label="Allow hard pause/resume of recording (e.g. while a caller reads card details)" />
            <div className="grid grid-cols-3 gap-3">
              <Field label="Recordings (days)">{(id) => <TextInput id={id} type="number" min={1} value={f.retention_recordings_days} onChange={set('retention_recordings_days')} />}</Field>
              <Field label="Call records (days)">{(id) => <TextInput id={id} type="number" min={7} value={f.retention_calls_days} onChange={set('retention_calls_days')} />}</Field>
              <Field label="SMS (days)">{(id) => <TextInput id={id} type="number" min={1} value={f.retention_sms_days} onChange={set('retention_sms_days')} />}</Field>
            </div>
          </fieldset>
          <ErrorBanner error={save.error} />
          {canEdit ? <Button type="submit" variant="primary" busy={save.isPending}>Save</Button> : <Notice>Only administrators can change privacy settings.</Notice>}
        </form>
      </Card>
      <Card>
        <CardHeader title="Retention — what would be purged now" subtitle="The job also runs automatically every 6 hours, in 5,000-row chunks" />
        <div className="space-y-3 p-4">
          {preview.isLoading ? <Spinner /> : p && (
            <dl className="grid grid-cols-3 gap-3 text-center">
              {[['Recordings', p.recordings], ['Call records', p.calls], ['SMS messages', p.sms]].map(([k, v]) => <div key={k as string} className="rounded-lg bg-slate-50 p-3"><dd className="text-2xl font-semibold tabular-nums">{fmtNum(v as number)}</dd><dt className="text-xs text-slate-500">{k}</dt></div>)}
            </dl>
          )}
          <p className="text-xs text-slate-500">Recordings are purged (audio reference removed, call record kept for reporting). Call records past their retention are deleted together with their event timelines, consent events and pause tokens.</p>
          {canEdit && <Button variant="danger" busy={run.isPending} disabled={!p || (p.recordings + p.calls + p.sms === 0)} onClick={() => confirm('Permanently purge expired data now? This cannot be undone.') && run.mutate()}>Run retention now</Button>}
        </div>
      </Card>
    </div>
  );
}

function ConsentLog() {
  const [page, setPage] = useState(1); const [type, setType] = useState('');
  const q = useQuery({ queryKey: ['consent', page, type], queryFn: () => api<{ total: number; pageSize: number; rows: any[]; summary: { type: string; n: number }[] }>('/privacy/consent-events', { query: { page, type } }), placeholderData: (p) => p });
  return (
    <>
      {q.data && <div className="mb-4 flex flex-wrap gap-2">{q.data.summary.map((s) => <Badge key={s.type} tone={s.type === 'declined' ? 'amber' : s.type.includes('pause') || s.type.includes('override') ? 'purple' : 'blue'}>{title(s.type)}: {fmtNum(s.n)} <span className="font-normal opacity-70">(14 d)</span></Badge>)}</div>}
      <Card>
        <CardHeader title="Consent & recording-control events" actions={<div className="w-48"><Select aria-label="Event type" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}><option value="">All events</option>{['prompt_played', 'granted', 'declined', 'recording_paused', 'recording_resumed', 'recording_stopped', 'pause_override'].map((t) => <option key={t} value={t}>{title(t)}</option>)}</Select></div>} />
        <ErrorBanner error={q.error} />
        <Table>
          <thead><tr><th className="th">When</th><th className="th">Event</th><th className="th">Call</th><th className="th">Subject</th><th className="th">Actor</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{q.data?.rows.map((e) => <tr key={e.id}><td className="td whitespace-nowrap">{fmtDateTime(e.created_at)}</td><td className="td">{title(e.type)}</td><td className="td tabular-nums">{e.call_id ? `#${e.call_id}` : '—'}</td><td className="td tabular-nums">{e.subject_phone ?? <span className="text-slate-400">erased</span>}</td><td className="td">{e.actor}</td></tr>)}</tbody>
        </Table>
        {q.data && <Pagination page={page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
      </Card>
    </>
  );
}

function Exports() {
  const qc = useQueryClient(); const toast = useToast();
  const [f, setF] = useState({ type: 'calls', from: '', to: '', phone: '' });
  const list = useQuery({ queryKey: ['exports'], queryFn: () => api<any[]>('/privacy/exports'), refetchInterval: (s) => (s.state.data?.some((e) => e.status === 'queued' || e.status === 'running') ? 1500 : false) });
  const create = useMutation({
    mutationFn: () => api('/privacy/exports', { body: { type: f.type, from: f.from || undefined, to: f.to || undefined, phone: f.type === 'subject' ? f.phone : undefined } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['exports'] }); toast('good', 'Export queued'); },
  });
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Request an export" subtitle="Generated asynchronously with keyset pagination, so it scales to millions of rows. Every request and download is audited." />
        <form className="grid gap-3 p-4 md:grid-cols-5" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Dataset">{(id) => <Select id={id} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="calls">Call records</option><option value="sms">SMS messages</option><option value="consent">Consent events</option><option value="subject">Data-subject access (by phone)</option></Select>}</Field>
          {f.type === 'subject' ? <div className="md:col-span-2"><Field label="Subject phone (E.164)">{(id) => <TextInput id={id} required pattern="\+[1-9]\d{7,14}" placeholder="+9198…" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field></div> : <>
            <Field label="From">{(id) => <TextInput id={id} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field><Field label="To">{(id) => <TextInput id={id} type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field></>}
          <div className="flex items-end"><Button type="submit" variant="primary" busy={create.isPending}>Create export</Button></div>
          <div className="md:col-span-5"><ErrorBanner error={create.error} /></div>
        </form>
      </Card>
      <Card>
        <CardHeader title="Exports" />
        <Table>
          <thead><tr><th className="th">#</th><th className="th">Dataset</th><th className="th">Requested</th><th className="th">By</th><th className="th">Status</th><th className="th text-right">Rows</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">{list.data?.map((e) => (
            <tr key={e.id}><td className="td">{e.id}</td><td className="td">{title(e.type)}</td><td className="td">{fmtDateTime(e.created_at)}</td><td className="td">{e.requested_by}</td>
              <td className="td"><Badge tone={e.status === 'ready' ? 'green' : e.status === 'failed' ? 'red' : 'amber'}>{title(e.status)}</Badge>{e.error && <div className="text-xs text-red-600">{e.error}</div>}</td><td className="td text-right">{e.row_count !== null ? fmtNum(e.row_count) : '—'}</td>
              <td className="td text-right">{e.status === 'ready' && <Button variant="ghost" className="!py-1 text-xs" onClick={() => download(`/privacy/exports/${e.id}/download`, `export-${e.id}.csv`).catch((x) => toast('bad', mutationError(x)))}>Download CSV</Button>}</td></tr>))}</tbody>
        </Table>
        {list.data?.length === 0 && <Empty>No exports yet.</Empty>}
      </Card>
    </div>
  );
}

function Erasure() {
  const qc = useQueryClient(); const toast = useToast();
  const [phone, setPhone] = useState(''); const [typed, setTyped] = useState('');
  const history = useQuery({ queryKey: ['deletions'], queryFn: () => api<any[]>('/privacy/deletions') });
  const preview = useMutation({ mutationFn: () => api<any>('/privacy/deletions/preview', { body: { phone: phone.trim() } }) });
  const exec = useMutation({
    mutationFn: () => api<any>('/privacy/deletions', { body: { phone: phone.trim(), confirm: true } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['deletions'] }); preview.reset(); setPhone(''); setTyped(''); toast('good', 'Data subject erased'); },
    onError: (e) => toast('bad', mutationError(e)),
  });
  const p = preview.data;
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader title="Erase a data subject" subtitle="Right-to-erasure request by phone number" />
        <div className="space-y-3 p-4">
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); preview.mutate(); }}>
            <div className="flex-1"><Field label="Phone (E.164)">{(id) => <TextInput id={id} required pattern="\+[1-9]\d{7,14}" placeholder="+919876543210" value={phone} onChange={(e) => { setPhone(e.target.value); preview.reset(); setTyped(''); }} />}</Field></div>
            <Button type="submit" busy={preview.isPending}>Preview impact</Button>
          </form>
          <ErrorBanner error={preview.error ?? exec.error} />
          {p && (
            <>
              <dl className="grid grid-cols-4 gap-2 text-center">{[['Calls anonymised', p.calls], ['Recordings purged', p.recordings], ['SMS deleted', p.sms], ['Leads deleted', p.leads]].map(([k, v]) => <div key={k as string} className="rounded-lg bg-slate-50 p-2"><dd className="text-xl font-semibold">{v as number}</dd><dt className="text-[11px] text-slate-500">{k}</dt></div>)}</dl>
              <Notice tone="warn">Call rows are anonymised (numbers removed) so aggregate reports stay correct; SMS bodies, leads and event timelines are deleted. The number is added to do-not-call. This cannot be undone.</Notice>
              <Field label={`Type the last 4 digits (${phone.trim().slice(-4)}) to confirm`}>{(id) => <TextInput id={id} value={typed} onChange={(e) => setTyped(e.target.value)} />}</Field>
              <Button variant="danger" busy={exec.isPending} disabled={typed !== phone.trim().slice(-4)} onClick={() => exec.mutate()}>Erase permanently</Button>
            </>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Erasure history" subtitle="Counts only — no personal data is retained" />
        <ul className="divide-y divide-slate-100 text-sm">{history.data?.map((d) => <li key={d.id} className="flex justify-between px-4 py-2"><span className="tabular-nums">{d.subject_phone}</span><span className="text-slate-500">{d.summary.calls} calls · {d.summary.sms} SMS · {fmtDateTime(d.created_at)}</span></li>)}</ul>
        {history.data?.length === 0 && <Empty>No erasure requests.</Empty>}
      </Card>
    </div>
  );
}
