import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime, title } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, Modal, Notice, PageHeader, Pagination, Select, Table, Tabs, TextInput, Toggle, mutationError, useToast } from '../../components/ui';

type Tab = 'keys' | 'webhooks' | 'deliveries' | 'reference';
const SCOPES = ['sms:send', 'sms:read', 'calls:write', 'calls:read'];

export function Developer() {
  const [tab, setTab] = useState<Tab>('keys');
  return (
    <>
      <PageHeader title="Developer platform" subtitle="API keys, webhooks and the SMS / voice REST API your customers integrate against" />
      <Tabs tabs={[{ id: 'keys', label: 'API keys' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'deliveries', label: 'Delivery log' }, { id: 'reference', label: 'API reference & try-it' }]} value={tab} onChange={setTab} />
      {tab === 'keys' && <Keys />}{tab === 'webhooks' && <Webhooks />}{tab === 'deliveries' && <Deliveries />}{tab === 'reference' && <Reference />}
    </>
  );
}

const copy = (text: string, toast: ReturnType<typeof useToast>) => navigator.clipboard?.writeText(text).then(() => toast('good', 'Copied'), () => toast('bad', 'Copy failed — select and copy manually'));

function Keys() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['keys'], queryFn: () => api<any[]>('/developer/api-keys') });
  const [creating, setCreating] = useState(false); const [secret, setSecret] = useState<string | null>(null);
  const revoke = useMutation({ mutationFn: (id: number) => api(`/developer/api-keys/${id}`, { method: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['keys'] }); toast('good', 'Key revoked — it stops working immediately'); }, onError: (e) => toast('bad', mutationError(e)) });
  return (
    <Card>
      <CardHeader title="API keys" subtitle="Only a SHA-256 hash is stored. Each key has scopes and its own per-minute rate limit." actions={<Button variant="primary" onClick={() => setCreating(true)}>Create key</Button>} />
      <ErrorBanner error={q.error} />
      <Table>
        <thead><tr><th className="th">Name</th><th className="th">Key</th><th className="th">Scopes</th><th className="th text-right">Limit / min</th><th className="th">Last used</th><th className="th">Status</th><th className="th" /></tr></thead>
        <tbody className="divide-y divide-slate-100">{q.data?.map((k) => (
          <tr key={k.id}><td className="td font-medium">{k.name}</td><td className="td font-mono text-xs">{k.prefix}…</td><td className="td"><div className="flex flex-wrap gap-1">{k.scopes.map((s: string) => <Badge key={s}>{s}</Badge>)}</div></td>
            <td className="td text-right">{k.rate_limit_per_min}</td><td className="td">{fmtDateTime(k.last_used_at)}</td><td className="td"><Badge tone={k.revoked_at ? 'red' : 'green'}>{k.revoked_at ? 'Revoked' : 'Active'}</Badge></td>
            <td className="td text-right">{!k.revoked_at && <Button variant="ghost" className="!py-1 text-xs text-red-600" onClick={() => confirm(`Revoke "${k.name}"? Integrations using it will break.`) && revoke.mutate(k.id)}>Revoke</Button>}</td></tr>))}</tbody>
      </Table>
      {creating && <CreateKey onClose={() => setCreating(false)} onCreated={(k) => { setCreating(false); setSecret(k); qc.invalidateQueries({ queryKey: ['keys'] }); }} />}
      {secret && <SecretModal title="Your new API key" value={secret} onClose={() => setSecret(null)} note="Copy it now. For security only its hash is stored — it cannot be shown again." toast={toast} />}
    </Card>
  );
}

function SecretModal({ title: t, value, note, onClose, toast }: { title: string; value: string; note: string; onClose: () => void; toast: ReturnType<typeof useToast> }) {
  return (
    <Modal title={t} onClose={onClose}>
      <Notice tone="warn">{note}</Notice>
      <div className="my-3 flex items-center gap-2"><code className="flex-1 break-all rounded bg-slate-100 p-2 text-xs">{value}</code><Button onClick={() => copy(value, toast)} aria-label="Copy to clipboard"><Copy className="h-4 w-4" /></Button></div>
      <div className="flex justify-end"><Button variant="primary" onClick={onClose}>I have stored it</Button></div>
    </Modal>
  );
}

function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const [name, setName] = useState(''); const [scopes, setScopes] = useState<string[]>(['sms:send', 'sms:read']); const [limit, setLimit] = useState(60);
  const m = useMutation({ mutationFn: () => api<{ key: string }>('/developer/api-keys', { body: { name, scopes, rate_limit_per_min: limit } }), onSuccess: (r) => onCreated(r.key) });
  return (
    <Modal title="Create API key" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Name">{(id) => <TextInput id={id} required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CRM sync" />}</Field>
        <fieldset><legend className="label">Scopes (least privilege)</legend><div className="grid grid-cols-2 gap-1">{SCOPES.map((s) => <label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />{s}</label>)}</div></fieldset>
        <Field label="Rate limit (requests / minute)">{(id) => <TextInput id={id} type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />}</Field>
        <ErrorBanner error={m.error} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={m.isPending} disabled={!scopes.length}>Create</Button></div>
      </form>
    </Modal>
  );
}

function Webhooks() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['webhooks'], queryFn: () => api<{ events: string[]; hooks: any[] }>('/developer/webhooks') });
  const [creating, setCreating] = useState(false); const [secret, setSecret] = useState<string | null>(null);
  const inval = () => qc.invalidateQueries({ queryKey: ['webhooks'] });
  const toggle = useMutation({ mutationFn: (h: any) => api(`/developer/webhooks/${h.id}`, { method: 'PATCH', body: { active: !h.active } }), onSuccess: inval, onError: (e) => toast('bad', mutationError(e)) });
  const test = useMutation({ mutationFn: (id: number) => api(`/developer/webhooks/${id}/test`, { body: {} }), onSuccess: () => { toast('good', 'Test event queued — see the Delivery log'); qc.invalidateQueries({ queryKey: ['deliveries'] }); }, onError: (e) => toast('bad', mutationError(e)) });
  const del = useMutation({ mutationFn: (id: number) => api(`/developer/webhooks/${id}`, { method: 'DELETE' }), onSuccess: inval });
  return (
    <Card>
      <CardHeader title="Webhooks" subtitle="Signed with HMAC-SHA256 (X-Swadesh-Signature: t=…,v1=…). Failed deliveries retry 5 times with exponential backoff." actions={<Button variant="primary" onClick={() => setCreating(true)}>Add endpoint</Button>} />
      <ErrorBanner error={q.error} />
      <Table>
        <thead><tr><th className="th">Endpoint</th><th className="th">Events</th><th className="th">7-day deliveries</th><th className="th">Active</th><th className="th" /></tr></thead>
        <tbody className="divide-y divide-slate-100">{q.data?.hooks.map((h) => (
          <tr key={h.id}><td className="td"><div className="max-w-xs truncate font-mono text-xs" title={h.url}>{h.url}</div><div className="text-xs text-slate-400">secret {h.secret_hint}</div></td>
            <td className="td"><div className="flex flex-wrap gap-1">{h.events.filter((e: string) => e !== 'webhook.test').map((e: string) => <Badge key={e}>{e}</Badge>)}</div></td>
            <td className="td text-xs">{Object.keys(h.deliveries).length ? Object.entries(h.deliveries).map(([s, n]) => <span key={s} className="mr-2"><Badge tone={s === 'success' ? 'green' : s === 'failed' ? 'red' : 'amber'}>{s} {n as number}</Badge></span>) : '—'}</td>
            <td className="td"><Toggle checked={!!h.active} onChange={() => toggle.mutate(h)} label={h.active ? 'On' : 'Off'} /></td>
            <td className="td text-right whitespace-nowrap"><Button variant="ghost" className="!py-1 text-xs" disabled={!h.active} onClick={() => test.mutate(h.id)}>Send test</Button><Button variant="ghost" className="!py-1 text-xs text-red-600" onClick={() => confirm('Delete this endpoint and its delivery history?') && del.mutate(h.id)}>Delete</Button></td></tr>))}</tbody>
      </Table>
      {creating && <CreateHook events={q.data?.events ?? []} onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); setSecret(s); inval(); }} />}
      {secret && <SecretModal title="Signing secret" value={secret} onClose={() => setSecret(null)} note="Use this secret to verify the X-Swadesh-Signature header. It is shown once." toast={toast} />}
    </Card>
  );
}

function CreateHook({ events, onClose, onCreated }: { events: string[]; onClose: () => void; onCreated: (secret: string) => void }) {
  const [url, setUrl] = useState(''); const [sel, setSel] = useState<string[]>(['call.completed']);
  const m = useMutation({ mutationFn: () => api<{ secret: string }>('/developer/webhooks', { body: { url, events: sel } }), onSuccess: (r) => onCreated(r.secret) });
  return (
    <Modal title="Add webhook endpoint" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Endpoint URL" hint="Production requires https and rejects private/internal addresses (SSRF protection).">{(id) => <TextInput id={id} type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/swadesh" />}</Field>
        <fieldset><legend className="label">Events</legend><div className="grid grid-cols-2 gap-1">{events.filter((e) => e !== 'webhook.test').map((e) => <label key={e} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sel.includes(e)} onChange={(x) => setSel(x.target.checked ? [...sel, e] : sel.filter((s) => s !== e))} />{e}</label>)}</div></fieldset>
        <ErrorBanner error={m.error} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={m.isPending} disabled={!sel.length}>Create endpoint</Button></div>
      </form>
    </Modal>
  );
}

function Deliveries() {
  const qc = useQueryClient(); const toast = useToast();
  const [page, setPage] = useState(1); const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['deliveries', page, status], queryFn: () => api<{ total: number; pageSize: number; rows: any[] }>('/developer/deliveries', { query: { page, status } }), refetchInterval: 5000, placeholderData: (p) => p });
  const retry = useMutation({ mutationFn: (id: number) => api(`/developer/deliveries/${id}/retry`, { body: {} }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['deliveries'] }); toast('good', 'Re-queued'); }, onError: (e) => toast('bad', mutationError(e)) });
  return (
    <Card>
      <CardHeader title="Delivery log" subtitle="Refreshes every 5 seconds" actions={<div className="w-36"><Select aria-label="Filter status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All</option><option value="pending">Pending</option><option value="success">Success</option><option value="failed">Failed</option></Select></div>} />
      <ErrorBanner error={q.error} />
      <Table>
        <thead><tr><th className="th">When</th><th className="th">Event</th><th className="th">Endpoint</th><th className="th">Status</th><th className="th text-right">Attempts</th><th className="th">Response</th><th className="th" /></tr></thead>
        <tbody className="divide-y divide-slate-100">{q.data?.rows.map((d) => (
          <tr key={d.id}><td className="td whitespace-nowrap">{fmtDateTime(d.created_at)}</td><td className="td font-mono text-xs">{d.event}</td><td className="td max-w-[14rem] truncate font-mono text-xs" title={d.url}>{d.url}</td>
            <td className="td"><Badge tone={d.status === 'success' ? 'green' : d.status === 'failed' ? 'red' : 'amber'}>{title(d.status)}</Badge>{d.status === 'pending' && d.attempts > 0 && <div className="text-[11px] text-slate-500">retry {fmtDateTime(d.next_attempt_at)}</div>}</td>
            <td className="td text-right">{d.attempts}</td><td className="td text-xs">{d.response_code ?? ''} {d.last_error ?? ''}</td><td className="td text-right">{d.status === 'failed' && <Button variant="ghost" className="!py-1 text-xs" onClick={() => retry.mutate(d.id)}>Retry</Button>}</td></tr>))}</tbody>
      </Table>
      {q.data?.rows.length === 0 && <Empty>No deliveries yet.</Empty>}
      {q.data && <Pagination page={page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
    </Card>
  );
}

const ENDPOINTS = [
  { id: 'sms', label: 'POST /v1/sms — send an SMS', method: 'POST', path: '/v1/sms', body: '{\n  "to": "+919876543210",\n  "body": "Your renewal is due on 12 Oct."\n}' },
  { id: 'sms-list', label: 'GET /v1/sms — list messages', method: 'GET', path: '/v1/sms?limit=5', body: '' },
  { id: 'call', label: 'POST /v1/calls — click-to-call', method: 'POST', path: '/v1/calls', body: '{\n  "to": "+919820099887"\n}' },
  { id: 'calls-list', label: 'GET /v1/calls — list calls', method: 'GET', path: '/v1/calls?limit=5', body: '' },
  { id: 'account', label: 'GET /v1/account — key info & limits', method: 'GET', path: '/v1/account', body: '' },
];

function Reference() {
  const [key, setKey] = useState(''); const [ep, setEp] = useState(ENDPOINTS[0]); const [body, setBody] = useState(ENDPOINTS[0].body);
  const [out, setOut] = useState<{ status: number; headers: [string, string][]; body: string } | null>(null); const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setOut(null);
    try {
      const res = await fetch(ep.path, { method: ep.method, headers: { authorization: `Bearer ${key.trim()}`, ...(ep.method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) }, body: ep.method === 'POST' ? body : undefined });
      const text = await res.text();
      setOut({ status: res.status, headers: [...res.headers.entries()].filter(([k]) => /ratelimit|retry-after|idempotent/i.test(k)), body: (() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })() });
    } catch (e) { setOut({ status: 0, headers: [], body: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader title="Try the API" subtitle="Calls /v1 from your browser with a key you paste below (not stored)" />
        <div className="space-y-3 p-4">
          <Notice>Create a key on the <strong>API keys</strong> tab, or use the seeded demo key listed in the README. Hammer <em>Send</em> past the key's limit to see the <code>429</code> and <code>Retry-After</code>.</Notice>
          <Field label="API key">{(id) => <TextInput id={id} type="password" autoComplete="off" placeholder="swk_live_…" value={key} onChange={(e) => setKey(e.target.value)} />}</Field>
          <Field label="Endpoint">{(id) => <Select id={id} value={ep.id} onChange={(e) => { const n = ENDPOINTS.find((x) => x.id === e.target.value)!; setEp(n); setBody(n.body); }}>{ENDPOINTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>}</Field>
          {ep.method === 'POST' && <Field label="JSON body">{(id) => <textarea id={id} className="input h-28 font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />}</Field>}
          <Button variant="primary" busy={busy} disabled={!key.startsWith('swk_')} onClick={run}>Send request</Button>
          {out && (
            <div aria-live="polite" className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-1 flex items-center gap-2 text-sm"><Badge tone={out.status >= 200 && out.status < 300 ? 'green' : 'red'}>{out.status || 'network error'}</Badge>{out.headers.map(([k, v]) => <span key={k} className="font-mono text-[11px] text-slate-500">{k}: {v}</span>)}</div>
              <pre className="max-h-64 overflow-auto text-xs">{out.body}</pre>
            </div>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Reference" />
        <div className="space-y-4 p-4 text-sm">
          <div><h3 className="font-semibold">Authentication</h3><p className="text-slate-600">Send <code>Authorization: Bearer swk_live_…</code>. A key is bound to one company; it can never read another tenant's data.</p></div>
          <div><h3 className="font-semibold">Rate limiting</h3><p className="text-slate-600">Sliding one-minute window per key. Every response carries <code>X-RateLimit-Limit</code>, <code>-Remaining</code>, <code>-Reset</code>; over the limit returns <code>429</code> + <code>Retry-After</code>.</p></div>
          <div><h3 className="font-semibold">Idempotency</h3><p className="text-slate-600">Add an <code>Idempotency-Key</code> header to POSTs; a replay within 24 h returns the original response with <code>Idempotent-Replay: true</code>.</p></div>
          <div><h3 className="font-semibold">Webhook verification (Node)</h3>
            <pre className="overflow-auto rounded-lg bg-ink-900 p-3 text-xs text-slate-100">{`const [t, v1] = header.split(',').map(p => p.split('=')[1]);
const expected = crypto.createHmac('sha256', SECRET)
  .update(\`\${t}.\${rawBody}\`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
  && Math.abs(Date.now()/1000 - t) < 300;   // reject replays`}</pre></div>
          <div><h3 className="font-semibold">Events</h3><p className="text-slate-600"><code>call.completed</code> · <code>call.abandoned</code> · <code>sms.delivered</code> · <code>sms.failed</code> · <code>recording.paused</code> · <code>recording.resumed</code></p></div>
          <div><h3 className="font-semibold">Errors</h3><p className="text-slate-600">Always <code>{`{ "error": { "code", "message" } }`}</code>: 401 bad key · 403 missing scope · 422 validation / recipient on DNC · 429 rate limited.</p></div>
        </div>
      </Card>
    </div>
  );
}
