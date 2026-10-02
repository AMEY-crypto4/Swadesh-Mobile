import { Profiler, version as reactVersion, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts';
import { CheckCircle2, Lock, Play, XCircle } from 'lucide-react';
import { api, tokenStore } from '../../lib/api';
import { fmtDateTime, fmtNum, fmtTime, title } from '../../lib/format';
import { liveControl, useLive, useLiveFeed, useNow } from '../../lib/live';
import { ConnectionChip } from '../../components/Layout';
import { Badge, Button, Card, CardHeader, ErrorBanner, Notice, PageHeader, Select, Spinner, Stat, Table, Unavailable } from '../../components/ui';

interface Overview {
  process: { node: string; pid: number; platform: string; cpus: number; uptimeSecs: number; rssMb: number; heapUsedMb: number; heapTotalMb: number; load1: number; eventLoopMs: { mean: number; p99: number; max: number } };
  http: { total: number; errors5xx: number; reqPerSec: number; perSec: number[]; groups: { route: string; count: number; errors: number; p50: number; p95: number; p99: number }[] };
  ws: { connections: number; framesOut: number; framesIn: number; bytesOut: number; framesPerSec: number; perSec: number[]; byType: Record<string, number>; seq: number; sessions: { userId: number; name: string; role: string; since: number; sockets: number }[] };
  db: { mode: string; mysql: string; mongo: string; poolOpen: number | null; poolIdle: number | null; sizes: { mysql: Record<string, number>; mongo: Record<string, number> } };
  sessions: { guestSeatCap: number };
}

const SECTIONS = [['node', 'Node.js API'], ['ws', 'WebSockets'], ['react', 'React'], ['data', 'Heavy data'], ['iso', 'Multi-tenant'], ['truth', 'Truthful UI'], ['roles', 'Roles & concurrency']] as const;

function Section({ id, jd, heading, children }: { id: string; jd: string; heading: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-2"><h2 id={`${id}-h`} className="text-lg font-semibold">{heading}</h2><span className="rounded bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">JD: {jd}</span></div>
      {children}
    </section>
  );
}

const Spark = ({ data, color }: { data: number[]; color: string }) => (
  <div className="h-14"><ResponsiveContainer><AreaChart data={data.map((v, i) => ({ v, i }))} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}><Tooltip formatter={(v: number) => [v, 'per second']} labelFormatter={() => ''} /><Area type="monotone" dataKey="v" stroke={color} fill={color} fillOpacity={0.2} isAnimationActive={false} /></AreaChart></ResponsiveContainer></div>
);
const dur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

export function System() {
  const ov = useQuery({ queryKey: ['system-overview'], queryFn: () => api<Overview>('/system/overview'), refetchInterval: 2000, refetchIntervalInBackground: true }); // keep polling when the window loses focus (e.g. while screen-sharing another app)
  const o = ov.data;
  return (
    <>
      <PageHeader title="Platform showcase" subtitle="Live proof of each requirement in the job description — everything on this page is measured from the running system, not mocked." actions={<ConnectionChip />} />
      <nav aria-label="Sections" className="mb-5 flex flex-wrap gap-2">{SECTIONS.map(([id, l]) => <a key={id} href={`#${id}`} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">{l}</a>)}</nav>
      <ErrorBanner error={ov.error} />
      {!o ? <Spinner label="Reading platform metrics" /> : (
        <div className="space-y-8">
          <NodeSection o={o} />
          <WsSection o={o} />
          <ReactSection />
          <DataSection o={o} />
          <IsolationSection />
          <TruthSection />
          <RolesSection o={o} />
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Node.js
function NodeSection({ o }: { o: Overview }) {
  const p = o.process;
  return (
    <Section id="node" jd="Node.js + TypeScript production REST APIs" heading="Node.js + TypeScript API">
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Node.js" value={p.node} hint={`pid ${p.pid} · ${p.platform}`} />
        <Stat label="Uptime" value={dur(p.uptimeSecs)} />
        <Stat label="Memory (RSS)" value={`${p.rssMb} MB`} hint={`heap ${p.heapUsedMb}/${p.heapTotalMb} MB`} />
        <Stat label="Event-loop lag p99" value={`${p.eventLoopMs.p99} ms`} tone={p.eventLoopMs.p99 > 100 ? 'bad' : p.eventLoopMs.p99 > 30 ? 'warn' : 'good'} hint={`mean ${p.eventLoopMs.mean} · max ${p.eventLoopMs.max}`} />
        <Stat label="Your requests / s" value={o.http.reqPerSec} hint={`${fmtNum(o.http.total)} total · ${o.http.errors5xx} server errors`} />
        <Stat label="MySQL pool" value={o.db.poolOpen ?? '—'} hint={`${o.db.poolIdle ?? '—'} idle of 20`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card><CardHeader title="Requests per second" subtitle="Your company's traffic, last 30 s" /><div className="px-3 pb-3"><Spark data={o.http.perSec} color="#4b4bc2" /></div></Card>
        <Card className="xl:col-span-2">
          <CardHeader title="Latency by endpoint" subtitle="p50 / p95 / p99 in ms over the last 500 calls of each route — click around the console and watch this fill" />
          <Table>
            <thead><tr><th className="th">Route</th><th className="th text-right">Calls</th><th className="th text-right">Errors</th><th className="th text-right">p50</th><th className="th text-right">p95</th><th className="th text-right">p99</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{o.http.groups.map((g) => <tr key={g.route}><td className="td font-mono text-xs">{g.route}</td><td className="td text-right tabular-nums">{g.count}</td><td className="td text-right tabular-nums">{g.errors || '—'}</td><td className="td text-right tabular-nums">{g.p50}</td><td className="td text-right tabular-nums">{g.p95}</td><td className="td text-right tabular-nums">{g.p99}</td></tr>)}</tbody>
          </Table>
          {o.http.groups.length === 0 && <div className="p-4 text-sm text-slate-500">No traffic recorded yet — open another console page.</div>}
        </Card>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ WebSockets
function WsSection({ o }: { o: Overview }) {
  const feed = useLiveFeed();
  const { connection, lastMessageAt } = useLive();
  const now = useNow(1000);
  const [dropped, setDropped] = useState<number | null>(null);
  const perSec = feed.recent.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const types = Object.entries(feed.counts).sort((a, b) => b[1] - a[1]);
  const doDrop = () => { liveControl.drop(8000); setDropped(Date.now() + 8000); };

  return (
    <Section id="ws" jd="stateful, real-time design using raw WebSockets" heading="Raw WebSockets">
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Connection" value={connection === 'live' ? 'Live' : 'Down'} tone={connection === 'live' ? 'good' : 'warn'} hint={lastMessageAt ? `last frame ${Math.max(0, Math.round((now - lastMessageAt) / 1000))}s ago` : '—'} />
        <Stat label="Frames received (this tab)" value={fmtNum(feed.total)} hint={`${(feed.bytes / 1024).toFixed(1)} KB`} />
        <Stat label="Frames / s (this tab)" value={perSec.toFixed(1)} />
        <Stat label="Server frames sent (company)" value={fmtNum(o.ws.framesOut)} hint={`${o.ws.framesPerSec}/s · ${o.ws.framesIn} received`} />
        <Stat label="Sockets open (company)" value={o.ws.connections} hint={`${o.ws.sessions.length} distinct users`} />
        <Stat label="Event sequence #" value={fmtNum(o.ws.seq)} hint="gap ⇒ automatic resync" />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Frames per second" subtitle="Received by this browser tab, last 30 s" />
          <div className="px-3 pb-3"><Spark data={feed.recent} color="#10b981" /></div>
          <div className="border-t border-slate-100 p-3">
            <div className="mb-2 text-xs font-medium text-slate-600">Prove failure handling is real</div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={doDrop} disabled={connection !== 'live'}>Cut the connection for 8 s</Button>
              <Button onClick={() => liveControl.resync()} disabled={connection !== 'live'}>Force resync</Button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {connection !== 'live' && dropped && dropped > now ? `Socket is closed. Watch the header chip: it says data may be stale. Reconnecting in ${Math.max(0, Math.ceil((dropped - now) / 1000))}s…`
                : 'This really closes the WebSocket. The UI must say it is stale, reconnect with backoff, then fetch a fresh snapshot — it does not keep showing old numbers as if live.'}
            </p>
          </div>
        </Card>
        <Profiled>
          <Card>
            <CardHeader title="Live frame tap" subtitle="Raw frames as they arrive (newest first)" />
            <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto font-mono text-xs" aria-live="off">
              {feed.items.slice(0, 14).map((f) => (
                <li key={f.n} className="flex items-center justify-between px-3 py-1.5"><span><span className="text-slate-400">{fmtTime(new Date(f.t))}</span> <span className="font-semibold text-slate-800">{f.type}</span></span><span className="text-slate-500">{f.seq !== null ? `seq ${f.seq} · ` : ''}{f.bytes} B</span></li>
              ))}
            </ul>
            {feed.items.length === 0 && <div className="p-4 text-sm text-slate-500">Waiting for frames…</div>}
          </Card>
        </Profiled>
        <Card>
          <CardHeader title="Who is connected right now" subtitle="Your company's live sockets — open this app in another browser to see it grow" />
          <Table>
            <thead><tr><th className="th">User</th><th className="th">Role</th><th className="th">Since</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{o.ws.sessions.map((s) => <tr key={s.userId}><td className="td">{s.name}{s.sockets > 1 && <span className="ml-1 text-xs text-slate-400">×{s.sockets}</span>}</td><td className="td"><Badge tone={s.role === 'admin' ? 'purple' : s.role === 'agent' ? 'green' : 'blue'}>{s.role}</Badge></td><td className="td">{fmtTime(new Date(s.since))}</td></tr>)}</tbody>
          </Table>
          <div className="border-t border-slate-100 p-3">
            <div className="mb-1 text-xs font-medium text-slate-600">Frame types seen by this tab</div>
            <div className="flex flex-wrap gap-1">{types.map(([t, n]) => <Badge key={t}>{t} {n}</Badge>)}</div>
          </div>
        </Card>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ React
const profile = { commits: 0, total: 0, max: 0 };
function Profiled({ children }: { children: ReactNode }) {
  return <Profiler id="frame-tap" onRender={(_id, _phase, actual) => { profile.commits++; profile.total += actual; profile.max = Math.max(profile.max, actual); }}>{children}</Profiler>;
}

function ReactSection() {
  useNow(1000);
  const feed = useLiveFeed();
  const t0 = useRef(Date.now());
  return (
    <Section id="react" jd="React + TypeScript on heavy, user-facing client systems" heading="React + TypeScript front end">
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="React" value={reactVersion} hint="StrictMode on · function components + hooks" />
        <Stat label="Build" value={import.meta.env.MODE} hint="Vite · TypeScript strict · Tailwind CSS" />
        <Stat label="Frame-tap renders" value={profile.commits} hint={`${(profile.commits / Math.max(1, (Date.now() - t0.current) / 1000)).toFixed(1)} commits/s for ${feed.total} frames`} />
        <Stat label="Avg / max render" value={`${(profile.total / Math.max(1, profile.commits)).toFixed(2)} / ${profile.max.toFixed(1)} ms`} tone={profile.max > 50 ? 'warn' : 'good'} hint="React Profiler (actual duration)" />
      </div>
      <Notice>Frames arrive faster than the screen needs them, so the socket client coalesces updates (one React render per 250 ms for the tap; reducers apply every delta to wallboard state). The Profiler numbers above are measured on the live frame list while you watch.</Notice>
    </Section>
  );
}

// ------------------------------------------------------------------ Heavy data
interface Bench { dataset: { calls: number }; results: { name: string; store: string; ms: number; rows: number | null; index: string | null; access: string | null; note: string }[] }
const LOAD_TARGETS = {
  overview: { label: 'Report overview, last 30 days', url: () => { const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10); return `/api/reports/overview?from=${d(29)}&to=${d(0)}`; } },
  calls: { label: 'Call log, filtered + paginated', url: () => '/api/calls?status=completed&direction=inbound&pageSize=25' },
  hourly: { label: 'Hour-of-day report, last 30 days', url: () => { const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10); return `/api/reports/hourly?from=${d(29)}&to=${d(0)}`; } },
  agents: { label: 'Agent leaderboard, last 30 days', url: () => { const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10); return `/api/reports/agents?from=${d(29)}&to=${d(0)}`; } },
} as const;

interface LoadResult { total: number; ok: number; failed: number; seconds: number; rps: number; p50: number; p95: number; p99: number; max: number; codes: Record<string, number> }

function DataSection({ o }: { o: Overview }) {
  const sizes = o.db.sizes;
  const bench = useMutation({ mutationFn: () => api<Bench>('/system/benchmarks') });
  const [target, setTarget] = useState<keyof typeof LOAD_TARGETS>('overview');
  const [conc, setConc] = useState(20); const [total, setTotal] = useState(300);
  const [progress, setProgress] = useState<number | null>(null); const [res, setRes] = useState<LoadResult | null>(null);
  const [origin, setOrigin] = useState<'browser' | 'server'>('server');
  const cancel = useRef(false);

  const runOnServer = useMutation({
    mutationFn: () => api<LoadResult>('/system/loadtest', { body: { target, concurrency: conc, total } }),
    onMutate: () => setRes(null),
    onSuccess: (r) => setRes(r),
  });

  const run = async () => {
    if (origin === 'server') { runOnServer.mutate(); return; }
    cancel.current = false; setRes(null); setProgress(0);
    const url = LOAD_TARGETS[target].url(); const lat: number[] = []; const codes: Record<string, number> = {};
    let next = 0, done = 0, ok = 0, failed = 0;
    const t0 = performance.now();
    const worker = async () => {
      while (next < total && !cancel.current) {
        next++; const s = performance.now();
        try {
          const r = await fetch(url, { headers: { authorization: `Bearer ${tokenStore.get()}` } });
          await r.arrayBuffer(); codes[r.status] = (codes[r.status] ?? 0) + 1; r.ok ? ok++ : failed++;
        } catch { failed++; codes.network = (codes.network ?? 0) + 1; }
        lat.push(performance.now() - s); done++; if (done % 5 === 0) setProgress(done);
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    const secs = (performance.now() - t0) / 1000; lat.sort((a, b) => a - b);
    const q = (p: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? 0);
    setRes({ total: done, ok, failed, seconds: Math.round(secs * 100) / 100, rps: Math.round(done / secs), p50: q(50), p95: q(95), p99: q(99), max: Math.round(lat[lat.length - 1] ?? 0), codes });
    setProgress(null);
  };

  return (
    <Section id="data" jd="MySQL + MongoDB at scale, index optimisation, 100k+ row datasets" heading="Heavy-data backend">
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {Object.entries({ ...sizes.mysql }).map(([k, v]) => <Stat key={k} label={`MySQL · ${k}`} value={fmtNum(v)} />)}
        {Object.entries(sizes.mongo).map(([k, v]) => <Stat key={k} label={`Mongo · ${k}`} value={fmtNum(v)} />)}
      </div>
      <p className="mb-3 text-xs text-slate-500">Your company only · MySQL {o.db.mysql} · MongoDB {o.db.mongo} · {o.db.mode}. For the 150,000-call dataset run <code>npm run dev:scale</code>.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Query benchmarks" subtitle="Median of 3 runs, with the index MySQL actually chose (EXPLAIN)" actions={<Button variant="primary" busy={bench.isPending} onClick={() => bench.mutate()}><Play className="h-4 w-4" aria-hidden />Run benchmarks</Button>} />
          <ErrorBanner error={bench.error} />
          {bench.data ? (
            <Table>
              <thead><tr><th className="th">Query</th><th className="th">Store</th><th className="th text-right">ms</th><th className="th">Index used</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{bench.data.results.map((r) => <tr key={r.name}><td className="td">{r.name}<div className="text-[11px] text-slate-400">{r.note}</div></td><td className="td"><Badge tone={r.store === 'MySQL' ? 'blue' : 'green'}>{r.store}</Badge></td><td className="td text-right tabular-nums font-medium">{r.ms}</td><td className="td font-mono text-xs">{r.index ?? <span className="text-red-600">none!</span>}</td></tr>)}</tbody>
            </Table>
          ) : <div className="p-4 text-sm text-slate-500">Runs ~12 queries against {fmtNum(sizes.mysql.calls)} calls and reports timing and index usage. A full-table scan would show up as “none!”.</div>}
        </Card>
        <Card>
          <CardHeader title="Load test from this browser" subtitle="Fires parallel authenticated requests at a heavy endpoint and measures the result" />
          <div className="space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-xs font-medium text-slate-600 sm:col-span-3">Endpoint<Select className="mt-1" value={target} onChange={(e) => setTarget(e.target.value as keyof typeof LOAD_TARGETS)}>{Object.entries(LOAD_TARGETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select></label>
              <label className="text-xs font-medium text-slate-600">Concurrency<Select className="mt-1" value={conc} onChange={(e) => setConc(Number(e.target.value))}>{[5, 10, 20, 40, 80].map((n) => <option key={n}>{n}</option>)}</Select></label>
              <label className="text-xs font-medium text-slate-600">Total requests<Select className="mt-1" value={total} onChange={(e) => setTotal(Number(e.target.value))}>{[100, 300, 600, 1500].map((n) => <option key={n}>{n}</option>)}</Select></label>
              <fieldset className="sm:col-span-3"><legend className="mb-1 text-xs font-medium text-slate-600">Generate load from</legend>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-1.5"><input type="radio" name="origin" checked={origin === 'server'} onChange={() => setOrigin('server')} />The server (loopback — no browser/proxy limits)</label>
                  <label className="flex items-center gap-1.5"><input type="radio" name="origin" checked={origin === 'browser'} onChange={() => setOrigin('browser')} />This browser (limited to ~6 connections)</label>
                </div></fieldset>
              <div className="flex items-end gap-2 sm:col-span-3"><Button variant="primary" className="flex-1" busy={runOnServer.isPending} disabled={progress !== null} onClick={run}><Play className="h-4 w-4" aria-hidden />Start load test</Button>{progress !== null && <Button onClick={() => { cancel.current = true; }}>Stop</Button>}</div>
            </div>
            {progress !== null && <div role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={total} aria-label="Load test progress" className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-brand-500 transition-all" style={{ width: `${(progress / total) * 100}%` }} /></div>}
            <ErrorBanner error={runOnServer.error} />
            {res && (
              <div aria-live="polite" className="grid grid-cols-3 gap-2 text-center">
                <Stat label="Throughput" value={`${res.rps}/s`} hint={`${res.total} reqs in ${res.seconds}s`} tone="good" />
                <Stat label="p50 / p95" value={`${res.p50} / ${res.p95} ms`} />
                <Stat label="p99 / max" value={`${res.p99} / ${res.max} ms`} />
                <Stat label="Succeeded" value={res.ok} tone="good" /><Stat label="Failed" value={res.failed} tone={res.failed ? 'bad' : 'default'} />
                <Stat label="Status codes" value={Object.entries(res.codes).map(([c, n]) => `${c}×${n}`).join(' ')} />
              </div>
            )}
            <p className="text-xs text-slate-500">{origin === 'server' ? 'The load generator runs inside the same Node process, so it competes with the server for the event loop — numbers are conservative.' : "Measured through the Vite dev proxy and your browser's connection pool, so it is a floor, not the server's ceiling."} Watch the Node section above: event-loop lag and the route table move while this runs.</p>
          </div>
        </Card>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ Multi-tenant
interface Iso { passed: number; total: number; probes: { probe: string; expectation: string; result: string; pass: boolean }[] }
function IsolationSection() {
  const iso = useMutation({ mutationFn: () => api<Iso>('/system/isolation-check') });
  return (
    <Section id="iso" jd="Multi-tenant rigor — one customer must never see another's data" heading="Multi-tenant isolation">
      <Card>
        <CardHeader title="Attack your own company's boundary" subtitle="Takes real rows that belong to OTHER companies and tries to read them through the same scoped data layer every API route uses" actions={<Button variant="primary" busy={iso.isPending} onClick={() => iso.mutate()}><Play className="h-4 w-4" aria-hidden />Run isolation probes</Button>} />
        <ErrorBanner error={iso.error} />
        {iso.data ? (
          <>
            <div className="px-4 py-2"><Badge tone={iso.data.passed === iso.data.total ? 'green' : 'red'}>{iso.data.passed} / {iso.data.total} probes passed</Badge></div>
            <Table>
              <thead><tr><th className="th">Probe</th><th className="th">Expected</th><th className="th">Result</th><th className="th" /></tr></thead>
              <tbody className="divide-y divide-slate-100">{iso.data.probes.map((p, i) => <tr key={i}><td className="td">{p.probe}</td><td className="td text-slate-500">{p.expectation}</td><td className="td font-mono text-xs">{p.result}</td><td className="td">{p.pass ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="passed" /> : <XCircle className="h-4 w-4 text-red-600" aria-label="failed" />}</td></tr>)}</tbody>
            </Table>
          </>
        ) : <div className="p-4 text-sm text-slate-500">Probes cover calls, campaigns, leads, queues, users, SMS, API keys, webhooks, deliveries, consent events and MongoDB event streams, plus two checks that the query guard refuses unscoped SQL before it reaches the database.</div>}
      </Card>
    </Section>
  );
}

// ------------------------------------------------------------------ Truthful UI
interface Cap { area: string; feature: string; status: 'real' | 'simulated' | 'unavailable' | 'metadata-only' | 'demo-override' | 'embedded'; detail: string }
const CAP_TONE = { real: 'green', simulated: 'amber', unavailable: 'slate', 'metadata-only': 'blue', 'demo-override': 'amber', embedded: 'blue' } as const;
function TruthSection() {
  const caps = useQuery({ queryKey: ['capabilities'], queryFn: () => api<Cap[]>('/system/capabilities') });
  return (
    <Section id="truth" jd="Truthful interfaces — never obscure actual application state" heading="Truthful UI">
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="What is real, what is simulated, what is unavailable" subtitle="The same register the UI uses to label controls — no marketing, no hidden stubs" />
          <ErrorBanner error={caps.error} />
          <Table>
            <thead><tr><th className="th">Area</th><th className="th">Capability</th><th className="th">Status</th><th className="th">Detail</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{caps.data?.map((c) => <tr key={c.feature}><td className="td text-slate-500">{c.area}</td><td className="td font-medium">{c.feature}</td><td className="td"><Badge tone={CAP_TONE[c.status]}>{c.status === 'unavailable' && <Lock className="h-3 w-3" aria-hidden />}{title(c.status.replace('-', ' '))}</Badge></td><td className="td text-xs text-slate-600">{c.detail}</td></tr>)}</tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Where to see it in the product" />
          <ul className="space-y-3 p-4 text-sm">
            <li><div className="mb-1 font-medium">A control that cannot work yet says so</div><Unavailable reason="live listen / whisper / barge needs a media server, which this build does not include">Listen · Whisper · Barge</Unavailable></li>
            <li><span className="font-medium">Stale data is announced.</span> Cut the socket in the WebSockets section; the header chip changes to “data may be stale” with the age of the last update.</li>
            <li><span className="font-medium">Simulation is labelled</span> by the amber banner on every screen; call windows, abandon-rate throttling and rule outcomes are explained inline on the campaign page.</li>
            <li><span className="font-medium">Failures are shown, not swallowed:</span> Developer → Delivery log lists every failed webhook with the HTTP code and next retry time.</li>
            <li><span className="font-medium">No fake success.</span> Actions wait for the server's answer; a seat that was reclaimed signs you out instead of pretending to work.</li>
          </ul>
        </Card>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ Roles & concurrency
const Y = <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-600" aria-label="yes" />;
const N = <span className="text-slate-300" aria-label="no">—</span>;
const MATRIX: [string, ReactNode, ReactNode, ReactNode][] = [
  ['Live wallboard, agent map, queue counts', Y, Y, N],
  ['View queues, campaigns, dialer rules', Y, Y, N],
  ['Edit queues, campaigns, rules, users; start/pause campaigns', Y, N, N],
  ['Reports, call log and call detail', Y, Y, N],
  ['Developer platform: API keys, webhooks, delivery log', Y, N, N],
  ['Privacy: consent log (read)', Y, Y, N],
  ['Privacy: retention, erasure, exports, settings', Y, N, N],
  ['Audit log and Platform showcase', Y, N, N],
  ['Agent workspace (answer, pause recording, dispositions)', N, N, Y],
];

function RolesSection({ o }: { o: Overview }) {
  return (
    <Section id="roles" jd="Full lifecycle ownership; many users in one shared system" heading="Roles & concurrent users">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Who can do what" subtitle="Enforced on the server for every route (and the WebSocket); the UI only mirrors it" />
          <Table>
            <thead><tr><th className="th">Capability</th><th className="th text-center">Admin</th><th className="th text-center">Supervisor</th><th className="th text-center">Normal user</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{MATRIX.map(([l, a, s, u]) => <tr key={l}><td className="td">{l}</td><td className="td text-center">{a}</td><td className="td text-center">{s}</td><td className="td text-center">{u}</td></tr>)}</tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="How concurrent users avoid colliding" />
          <ul className="space-y-3 p-4 text-sm text-slate-700">
            <li><strong>Private seats.</strong> Everyone who signs in with the shared Normal User login gets their own agent identity (state, calls, history, WebSocket channel), capped at {o.sessions.guestSeatCap} seats per company and reclaimed on sign-out or idle. Provisioning is serialised with a row lock, so the cap is exact even when many sign in at once.</li>
            <li><strong>Optimistic locking.</strong> Queues and campaigns carry a version. If two admins edit the same one, the second save is rejected with “someone else changed this” instead of silently overwriting.</li>
            <li><strong>One writer per company.</strong> All call/agent state changes for a company run through a single serialised runtime, so two agents can never be handed the same call and a call can never be answered twice.</li>
            <li><strong>Tenant partitions.</strong> WebSocket frames, queries and exports are scoped by company; the probes above prove it.</li>
            <li><strong>Try it:</strong> open this app in a second browser or private window, sign in as <em>Normal user</em> for the same company, and watch the “Who is connected” table in the WebSockets section gain a seat — then change that seat's status and see only your own agent card move.</li>
          </ul>
          <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Server clock {fmtDateTime(new Date())}</div>
        </Card>
      </div>
    </Section>
  );
}
