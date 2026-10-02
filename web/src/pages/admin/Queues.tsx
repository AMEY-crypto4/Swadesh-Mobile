import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDur, title } from '../../lib/format';
import { useLive } from '../../lib/live';
import { Badge, Button, Card, ErrorBanner, Field, Modal, Notice, PageHeader, Select, Table, TextInput, mutationError, useToast } from '../../components/ui';

interface Queue {
  id: number; name: string; strategy: string; sla_seconds: number; max_wait_seconds: number; wrap_up_seconds: number; required_skill: string | null;
  recording_consent_mode: 'none' | 'announce' | 'opt_in'; active: number; members: number[]; version: number;
}
interface TeamUser { id: number; name: string; role: string; status: string; skills: string[] | null }

const STRATEGIES = [
  ['longest_idle', 'Longest idle — agent idle the longest gets the call'],
  ['round_robin', 'Round robin — rotate evenly'],
  ['least_calls', 'Least calls — fewest calls handled today'],
  ['skills_based', 'Skills based — only agents holding the required skill'],
  ['ring_all', 'Ring all — any free agent (first to pick up)'],
] as const;
const CONSENT = [['none', 'No recording'], ['announce', 'Announce — "this call may be recorded"'], ['opt_in', 'Opt-in — caller must agree before recording starts']] as const;

export function Queues() {
  const { user } = useAuth();
  const { queues: live } = useLive();
  const q = useQuery({ queryKey: ['queues'], queryFn: () => api<Queue[]>('/queues') });
  const [editing, setEditing] = useState<Queue | 'new' | null>(null);
  const isAdmin = user?.role === 'admin';

  return (
    <>
      <PageHeader title="Queues" subtitle="Routing strategy, service-level targets and recording consent per queue" actions={isAdmin && <Button variant="primary" onClick={() => setEditing('new')}>New queue</Button>} />
      <ErrorBanner error={q.error} />
      <Card>
        <Table>
          <thead><tr><th className="th">Queue</th><th className="th">Strategy</th><th className="th text-right">SLA</th><th className="th text-right">Max wait</th><th className="th">Recording</th><th className="th text-right">Members</th><th className="th text-right">Waiting now</th><th className="th text-right">Avail now</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {q.data?.map((x) => {
              const l = live.find((v) => v.id === x.id);
              return (
                <tr key={x.id}>
                  <td className="td font-medium">{x.name}{!x.active && <Badge>Inactive</Badge>}{x.required_skill && <div className="text-xs font-normal text-slate-400">needs skill: {x.required_skill}</div>}</td>
                  <td className="td">{title(x.strategy)}</td><td className="td text-right">{x.sla_seconds}s</td><td className="td text-right">{fmtDur(x.max_wait_seconds)}</td>
                  <td className="td"><Badge tone={x.recording_consent_mode === 'none' ? 'slate' : x.recording_consent_mode === 'opt_in' ? 'purple' : 'blue'}>{x.recording_consent_mode === 'opt_in' ? 'Opt-in' : title(x.recording_consent_mode)}</Badge></td>
                  <td className="td text-right">{x.members.length}</td>
                  <td className="td text-right tabular-nums">{l ? l.waiting : '—'}</td><td className="td text-right tabular-nums">{l ? `${l.agentsAvailable}/${l.agentsStaffed}` : '—'}</td>
                  <td className="td text-right"><Button variant="ghost" className="!py-1 text-xs" onClick={() => setEditing(x)}>{isAdmin ? 'Edit' : 'View'}</Button></td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
      {editing && <QueueForm queue={editing === 'new' ? null : editing} readOnly={!isAdmin} onClose={() => setEditing(null)} />}
    </>
  );
}

function QueueForm({ queue, readOnly, onClose }: { queue: Queue | null; readOnly: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<TeamUser[]>('/users') });
  const [f, setF] = useState({
    name: queue?.name ?? '', strategy: queue?.strategy ?? 'longest_idle', sla_seconds: queue?.sla_seconds ?? 20, max_wait_seconds: queue?.max_wait_seconds ?? 90,
    wrap_up_seconds: queue?.wrap_up_seconds ?? 20, required_skill: queue?.required_skill ?? '', recording_consent_mode: queue?.recording_consent_mode ?? 'announce', active: queue ? !!queue.active : true,
    members: queue?.members ?? ([] as number[]),
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, required_skill: f.required_skill.trim() || null };
      return queue ? api(`/queues/${queue.id}`, { method: 'PATCH', body: { ...body, version: queue.version } }) : api('/queues', { body });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['queues'] }); toast('good', 'Queue saved'); onClose(); },
    onError: (e) => { toast('bad', mutationError(e)); qc.invalidateQueries({ queryKey: ['queues'] }); }, // on a version conflict, pull the latest so the next attempt starts from it
  });
  const agents = (users.data ?? []).filter((u) => u.role === 'agent' && u.status === 'active');
  const num = (k: 'sla_seconds' | 'max_wait_seconds' | 'wrap_up_seconds') => (e: { target: { value: string } }) => setF({ ...f, [k]: Number(e.target.value) });

  return (
    <Modal title={queue ? `Queue: ${queue.name}` : 'New queue'} onClose={onClose} wide>
      <form className="grid gap-4 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <fieldset disabled={readOnly} className="contents">
          <Field label="Name">{(id) => <TextInput id={id} required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Distribution strategy">{(id) => <Select id={id} value={f.strategy} onChange={(e) => setF({ ...f, strategy: e.target.value })}>{STRATEGIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
          <Field label="Service-level target (s)">{(id) => <TextInput id={id} type="number" min={5} max={600} value={f.sla_seconds} onChange={num('sla_seconds')} />}</Field>
          <Field label="Max wait before abandon-treatment (s)">{(id) => <TextInput id={id} type="number" min={15} max={1800} value={f.max_wait_seconds} onChange={num('max_wait_seconds')} />}</Field>
          <Field label="Wrap-up (s)">{(id) => <TextInput id={id} type="number" min={0} max={600} value={f.wrap_up_seconds} onChange={num('wrap_up_seconds')} />}</Field>
          <Field label="Required skill" hint="Only agents with this skill are eligible (blank = none)">{(id) => <TextInput id={id} value={f.required_skill} onChange={(e) => setF({ ...f, required_skill: e.target.value })} />}</Field>
          <div className="md:col-span-2"><Field label="Recording consent">{(id) => <Select id={id} value={f.recording_consent_mode} onChange={(e) => setF({ ...f, recording_consent_mode: e.target.value as never })}>{CONSENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field></div>
          <div className="md:col-span-2">
            <span className="label">Members ({f.members.length} selected)</span>
            <div className="grid max-h-44 grid-cols-2 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
              {agents.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.members.includes(a.id)} onChange={(e) => setF({ ...f, members: e.target.checked ? [...f.members, a.id] : f.members.filter((x) => x !== a.id) })} />
                  {a.name}
                </label>
              ))}
            </div>
          </div>
        </fieldset>
        {f.recording_consent_mode === 'opt_in' && <div className="md:col-span-2"><Notice>With opt-in, recording only starts after the caller agrees. Declined calls are handled normally but never recorded.</Notice></div>}
        <div className="md:col-span-2"><ErrorBanner error={save.error} /></div>
        {!readOnly && <div className="flex justify-end gap-2 md:col-span-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={save.isPending}>Save queue</Button></div>}
      </form>
    </Modal>
  );
}
