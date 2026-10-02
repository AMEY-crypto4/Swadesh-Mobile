import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtNum, title } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Badge, Button, Card, ErrorBanner, Field, Modal, PageHeader, Select, TextInput, mutationError, useToast } from '../../components/ui';

export interface CampaignRow {
  id: number; name: string; queue_id: number; queue_name: string; mode: 'preview' | 'progressive' | 'predictive'; status: 'draft' | 'running' | 'paused' | 'completed';
  pacing_ratio: number; max_abandon_pct: number; max_attempts: number; retry_delay_minutes: number; caller_id: string; leads: Record<string, number>;
}

export const statusTone = { running: 'green', paused: 'amber', draft: 'slate', completed: 'blue' } as const;
const MODES = { preview: 'Preview — agent reviews each lead, then dials', progressive: 'Progressive — one call per free agent', predictive: 'Predictive — over-dials using a pacing ratio' } as const;

export function Campaigns() {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const { campaigns: live } = useLive();
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => api<CampaignRow[]>('/campaigns') });
  const [creating, setCreating] = useState(false);
  const isAdmin = user?.role === 'admin';
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api(`/campaigns/${id}/status`, { body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['campaigns'] }), onError: (e) => toast('bad', mutationError(e)),
  });

  return (
    <>
      <PageHeader title="Campaigns" subtitle="Outbound dialing campaigns, pacing and retry rules" actions={isAdmin && <Button variant="primary" onClick={() => setCreating(true)}>New campaign</Button>} />
      <ErrorBanner error={q.error} />
      <div className="grid gap-4 lg:grid-cols-2">
        {q.data?.map((c) => {
          const l = live.find((x) => x.id === c.id);
          const total = Object.values(c.leads).reduce((s, n) => s + n, 0);
          const dialable = (c.leads.new ?? 0) + (c.leads.callback ?? 0);
          const finished = total - dialable - (c.leads.dialing ?? 0);
          return (
            <Card key={c.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div><Link to={`/campaigns/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.name}</Link><div className="text-xs text-slate-500">Queue: {c.queue_name} · {title(c.mode)}{c.mode === 'predictive' && ` ${c.pacing_ratio}:1`}</div></div>
                <Badge tone={statusTone[c.status]}>{title(c.status)}</Badge>
              </div>
              <div className="mt-3">
                <div className="mb-1 flex justify-between text-xs text-slate-500"><span>{fmtNum(finished)} of {fmtNum(total)} leads worked</span><span>{fmtNum(dialable)} dialable</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={total ? Math.round((finished / total) * 100) : 0} aria-valuemin={0} aria-valuemax={100} aria-label="Leads worked">
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${total ? (finished / total) * 100 : 0}%` }} />
                </div>
              </div>
              {l && c.status === 'running' && <div className="mt-2 text-xs text-slate-500">Live: {l.inflight} dialing · {l.connected} connected · abandon {l.abandonPct}%{l.exhausted && <span className="text-amber-700"> · no dialable leads</span>}</div>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={`/campaigns/${c.id}`}><Button className="!py-1 text-xs">Open</Button></Link>
                {isAdmin && c.status !== 'completed' && (
                  <>
                    {(c.status === 'draft' || c.status === 'paused') && <Button variant="primary" className="!py-1 text-xs" busy={setStatus.isPending} onClick={() => setStatus.mutate({ id: c.id, status: 'running' })}>{c.status === 'draft' ? 'Start' : 'Resume'}</Button>}
                    {c.status === 'running' && <Button className="!py-1 text-xs" busy={setStatus.isPending} onClick={() => setStatus.mutate({ id: c.id, status: 'paused' })}>Pause</Button>}
                    {c.status !== 'draft' && <Button variant="ghost" className="!py-1 text-xs" onClick={() => confirm(`Mark "${c.name}" completed? This cannot be undone.`) && setStatus.mutate({ id: c.id, status: 'completed' })}>Complete</Button>}
                  </>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      {creating && <CreateCampaign onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateCampaign({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api<{ id: number; name: string }[]>('/queues') });
  const [f, setF] = useState({ name: '', queue_id: '', mode: 'progressive', pacing_ratio: 1.5, caller_id: '+912240001234' });
  const m = useMutation({
    mutationFn: () => api('/campaigns', { body: { ...f, queue_id: Number(f.queue_id), pacing_ratio: Number(f.pacing_ratio) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); toast('good', 'Campaign created as draft. Import leads, then start it.'); onClose(); },
  });
  return (
    <Modal title="New campaign" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Name">{(id) => <TextInput id={id} required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Queue (agents who take the calls)">{(id) => <Select id={id} required value={f.queue_id} onChange={(e) => setF({ ...f, queue_id: e.target.value })}><option value="">Select…</option>{queues.data?.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</Select>}</Field>
        <Field label="Dialing mode">{(id) => <Select id={id} value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>{Object.entries(MODES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
        {f.mode === 'predictive' && <Field label="Pacing ratio (calls dialed per free agent)" hint="Automatically throttled to 1:1 when the abandon cap is breached">{(id) => <TextInput id={id} type="number" step="0.1" min={1} max={3} value={f.pacing_ratio} onChange={(e) => setF({ ...f, pacing_ratio: Number(e.target.value) })} />}</Field>}
        <Field label="Caller ID (E.164)">{(id) => <TextInput id={id} pattern="\+[1-9]\d{7,14}" required value={f.caller_id} onChange={(e) => setF({ ...f, caller_id: e.target.value })} />}</Field>
        <ErrorBanner error={m.error} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={m.isPending}>Create</Button></div>
      </form>
    </Modal>
  );
}
