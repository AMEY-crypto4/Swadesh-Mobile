import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Headphones, ShieldCheck, UserRound, Eye } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button, ErrorBanner, Field, Notice, TextInput } from '../components/ui';

const TENANTS = [
  { slug: 'aarav', name: 'Aarav Insurance', note: '30k calls · 4 queues · 2 live campaigns' },
  { slug: 'zenith', name: 'Zenith Collections', note: '12k calls · collections buckets' },
  { slug: 'kaveri', name: 'Kaveri Healthcare', note: '6k calls · opt-in recording consent' },
];

export function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenant, setTenant] = useState(TENANTS[0].slug);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (user) return <Navigate to={user.role === 'agent' ? '/agent' : '/'} replace />;

  const signIn = async (creds: { email: string; password: string }, key: string) => {
    setBusy(key); setError(null);
    try { const u = await login(creds.email, creds.password); nav(u.role === 'agent' ? '/agent' : '/', { replace: true }); }
    catch (err) { setError(err); } finally { setBusy(null); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void signIn({ email, password }, 'form'); };
  const demo = (role: 'admin' | 'user' | 'supervisor') => signIn({ email: `${role}@${tenant}.test`, password: 'Demo@1234' }, role);

  return (
    <div className="grid min-h-screen place-items-center bg-ink-900 p-4">
      <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="card p-6">
          <div className="mb-4 flex items-center gap-2"><Headphones className="h-6 w-6 text-brand-600" aria-hidden /><h1 className="text-xl font-semibold">Swadesh<span className="text-brand-600"> CC</span></h1></div>
          <p className="mb-5 text-sm text-slate-500">Contact-centre console and agent workspace.</p>
          <form onSubmit={submit} className="space-y-3">
            <Field label="Email">{(id) => <TextInput id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label="Password">{(id) => <TextInput id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" busy={busy === 'form'} className="w-full">Sign in</Button>
          </form>
          <div className="mt-4"><ErrorBanner error={error} /></div>
        </div>

        <div className="card p-6">
          <h2 className="mb-1 text-sm font-semibold">Demo access</h2>
          <p className="mb-4 text-xs text-slate-500">Pick a company, then a role. Password for every demo login: <code className="rounded bg-slate-100 px-1">Demo@1234</code>. Companies are fully isolated from each other.</p>

          <div role="radiogroup" aria-label="Company" className="mb-4 grid gap-2 sm:grid-cols-3">
            {TENANTS.map((t) => (
              <button key={t.slug} role="radio" aria-checked={tenant === t.slug} onClick={() => setTenant(t.slug)}
                className={clsx('rounded-lg border p-2.5 text-left', tenant === t.slug ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50')}>
                <div className="text-sm font-medium">{t.name}</div><div className="text-[11px] text-slate-500">{t.note}</div>
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-4">
              <ShieldCheck className="mb-2 h-6 w-6 text-brand-600" aria-hidden />
              <h3 className="font-semibold">Admin</h3>
              <p className="mb-3 mt-1 text-xs text-slate-600">Full console: live wallboard, queues, campaigns and dialer rules, reports, API keys &amp; webhooks, privacy tools and the <strong>Platform showcase</strong>.</p>
              <Button variant="primary" className="w-full" busy={busy === 'admin'} disabled={!!busy} onClick={() => demo('admin')}>Sign in as Admin</Button>
              <div className="mt-1.5 text-center text-[11px] text-slate-500">admin@{tenant}.test</div>
            </div>
            <div className="rounded-xl border border-slate-200 p-4">
              <UserRound className="mb-2 h-6 w-6 text-emerald-600" aria-hidden />
              <h3 className="font-semibold">Normal user</h3>
              <p className="mb-3 mt-1 text-xs text-slate-600">Agent workspace: take calls, recording consent &amp; pause, dispositions. <strong>Every sign-in gets its own private seat</strong>, so many people can use it at once.</p>
              <Button className="w-full !border-emerald-600 !bg-emerald-600 !text-white hover:!bg-emerald-700" busy={busy === 'user'} disabled={!!busy} onClick={() => demo('user')}>Sign in as Normal user</Button>
              <div className="mt-1.5 text-center text-[11px] text-slate-500">user@{tenant}.test</div>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span className="flex items-center gap-1.5"><Eye className="h-3.5 w-3.5" aria-hidden />Supervisor: monitoring &amp; reports, no configuration changes</span>
            <button className="font-medium text-brand-700 hover:underline disabled:opacity-50" disabled={!!busy} onClick={() => demo('supervisor')}>Sign in</button>
          </div>
          <div className="mt-3"><Notice>Seats are released on sign-out or after 10 idle minutes. If a company's demo seats are all taken you'll be told, rather than sharing someone else's session.</Notice></div>
        </div>
      </div>
    </div>
  );
}
