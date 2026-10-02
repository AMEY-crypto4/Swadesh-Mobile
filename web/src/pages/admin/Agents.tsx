import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDur, title } from '../../lib/format';
import { useLive, useNow, type AgentState } from '../../lib/live';
import { AGENT_STATE, Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, Modal, PageHeader, Select, StateBadge, Table, Tabs, TextInput, Unavailable, mutationError, useToast } from '../../components/ui';

const ORDER: AgentState[] = ['on_call', 'ringing', 'wrap_up', 'preview', 'available', 'break', 'offline'];

export function Agents() {
  const [tab, setTab] = useState<'live' | 'team'>('live');
  return (
    <>
      <PageHeader title="Agents" subtitle="Real-time status map and team management" />
      <Tabs tabs={[{ id: 'live', label: 'Live status' }, { id: 'team', label: 'Team' }]} value={tab} onChange={setTab} />
      {tab === 'live' ? <LiveMap /> : <Team />}
    </>
  );
}

function LiveMap() {
  const { agents, queues, connection } = useLive();
  const now = useNow(1000);
  const [queueId, setQueueId] = useState('');
  const [state, setState] = useState<AgentState | ''>('');
  const shown = agents.filter((a) => (!queueId || a.queueIds.includes(Number(queueId))) && (!state || a.state === state))
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
  const counts = ORDER.map((s) => [s, agents.filter((a) => (!queueId || a.queueIds.includes(Number(queueId))) && a.state === s).length] as const);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by state">
          {counts.map(([s, n]) => (
            <button key={s} onClick={() => setState(state === s ? '' : s)} aria-pressed={state === s}
              className={clsx('flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium', state === s ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
              <span className={clsx('h-2 w-2 rounded-full', AGENT_STATE[s].dot)} aria-hidden />{AGENT_STATE[s].label} <span className="tabular-nums">{n}</span>
            </button>
          ))}
        </div>
        <div className="w-48"><Field label="Queue">{(id) => <Select id={id} value={queueId} onChange={(e) => setQueueId(e.target.value)}><option value="">All queues</option>{queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</Select>}</Field></div>
        <div className="ml-auto"><Unavailable reason="live listen / whisper / barge needs the media server, which this build does not include">Listen · Whisper · Barge</Unavailable></div>
      </div>
      {agents.length === 0 ? <Empty>{connection === 'live' ? 'No agents' : 'Waiting for live data…'}</Empty> : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((a) => (
            <li key={a.id} className={clsx('card border-l-4 p-3', { available: 'border-l-emerald-500', on_call: 'border-l-blue-500', ringing: 'border-l-amber-500', wrap_up: 'border-l-purple-500', preview: 'border-l-cyan-500', break: 'border-l-orange-500', offline: 'border-l-slate-300' }[a.state])}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{a.name}</div><div className="text-xs text-slate-500">Ext {a.extension ?? '—'}{!a.isBot && ' · human'}</div></div>
                <StateBadge state={a.state} />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                <span>{a.reason ? `${a.reason} · ` : ''}<span className="tabular-nums font-medium text-slate-700">{fmtDur((now - a.since) / 1000)}</span> in state</span>
              </div>
              <div className="mt-1 flex justify-between text-xs text-slate-500"><span>{a.callsToday} calls</span><span>{fmtDur(a.talkSecsToday)} talk</span></div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface TeamUser { id: number; name: string; email: string; role: string; status: string; extension: string | null; skills: string[] | null; is_bot: number; is_shared_demo: number }

function Team() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<TeamUser[]>('/users') });
  const [adding, setAdding] = useState(false);
  const toggle = useMutation({
    mutationFn: (u: TeamUser) => api(`/users/${u.id}`, { method: 'PATCH', body: { status: u.status === 'active' ? 'disabled' : 'active' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }), onError: (e) => toast('bad', mutationError(e)),
  });
  const isAdmin = user?.role === 'admin';
  return (
    <Card>
      <CardHeader title="Team" subtitle={`${q.data?.length ?? 0} users`} actions={isAdmin && <Button variant="primary" onClick={() => setAdding(true)}>Add user</Button>} />
      <ErrorBanner error={q.error} />
      <Table>
        <thead><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th><th className="th">Ext</th><th className="th">Skills</th><th className="th">Status</th><th className="th" /></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {q.data?.map((u) => (
            <tr key={u.id}>
              <td className="td font-medium">{u.name}</td><td className="td text-slate-500">{u.email}</td><td className="td">{title(u.role)}{u.is_bot ? <span className="ml-1 text-xs text-slate-400">(sim)</span> : null}{u.is_shared_demo ? <span className="ml-1" title="Template for the shared Normal User login: each sign-in gets a private seat cloned from this account"><Badge tone="green">shared login</Badge></span> : null}</td>
              <td className="td">{u.extension ?? '—'}</td><td className="td">{u.skills?.join(', ') || '—'}</td>
              <td className="td"><Badge tone={u.status === 'active' ? 'green' : 'slate'}>{title(u.status)}</Badge></td>
              <td className="td text-right">{isAdmin && u.id !== user?.id && u.role !== 'admin' && <Button variant="ghost" className="!py-1 text-xs" onClick={() => toggle.mutate(u)}>{u.status === 'active' ? 'Disable' : 'Enable'}</Button>}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {adding && <AddUser onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddUser({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [f, setF] = useState({ name: '', email: '', role: 'agent', extension: '', skills: '', password: '' });
  const m = useMutation({
    mutationFn: () => api('/users', { body: { name: f.name, email: f.email, role: f.role, extension: f.extension || undefined, skills: f.skills.split(',').map((s) => s.trim()).filter(Boolean), password: f.password } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast('good', 'User created'); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add user" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Full name">{(id) => <TextInput id={id} required value={f.name} onChange={set('name')} />}</Field>
        <Field label="Email">{(id) => <TextInput id={id} type="email" required value={f.email} onChange={set('email')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">{(id) => <Select id={id} value={f.role} onChange={set('role')}><option value="agent">Agent</option><option value="supervisor">Supervisor</option></Select>}</Field>
          <Field label="Extension">{(id) => <TextInput id={id} inputMode="numeric" pattern="\d{3,8}" value={f.extension} onChange={set('extension')} />}</Field>
        </div>
        <Field label="Skills" hint="Comma separated, e.g. hindi, negotiation">{(id) => <TextInput id={id} value={f.skills} onChange={set('skills')} />}</Field>
        <Field label="Initial password" hint="Minimum 10 characters">{(id) => <TextInput id={id} type="password" minLength={10} required value={f.password} onChange={set('password')} />}</Field>
        <ErrorBanner error={m.error} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={m.isPending}>Create user</Button></div>
      </form>
    </Modal>
  );
}
