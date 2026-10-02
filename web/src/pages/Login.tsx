import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Headphones } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button, ErrorBanner, Field, TextInput } from '../components/ui';

const DEMO = [
  { tenant: 'Aarav Insurance', slug: 'aarav', note: '30k calls · 4 queues · 2 running campaigns' },
  { tenant: 'Zenith Collections', slug: 'zenith', note: '12k calls · collections buckets' },
  { tenant: 'Kaveri Healthcare', slug: 'kaveri', note: '6k calls · opt-in recording consent' },
];

export function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={user.role === 'agent' ? '/agent' : '/'} replace />;

  const submit = async (e: FormEvent, creds = { email, password }) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const u = await login(creds.email, creds.password); nav(u.role === 'agent' ? '/agent' : '/', { replace: true }); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-ink-900 p-4">
      <div className="grid w-full max-w-4xl gap-6 md:grid-cols-2">
        <div className="card p-6">
          <div className="mb-4 flex items-center gap-2"><Headphones className="h-6 w-6 text-brand-600" aria-hidden /><h1 className="text-xl font-semibold">Swadesh<span className="text-brand-600"> CC</span></h1></div>
          <p className="mb-5 text-sm text-slate-500">Contact-centre console and agent workspace.</p>
          <form onSubmit={submit} className="space-y-3">
            <Field label="Email">{(id) => <TextInput id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label="Password">{(id) => <TextInput id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            <ErrorBanner error={error} />
            <Button type="submit" variant="primary" busy={busy} className="w-full">Sign in</Button>
          </form>
        </div>
        <div className="card p-6">
          <h2 className="mb-1 text-sm font-semibold">Demo tenants</h2>
          <p className="mb-4 text-xs text-slate-500">Password for every demo user: <code className="rounded bg-slate-100 px-1">Demo@1234</code>. Each company's data is fully isolated.</p>
          <div className="space-y-3">
            {DEMO.map((d) => (
              <div key={d.slug} className="rounded-lg border border-slate-200 p-3">
                <div className="text-sm font-medium">{d.tenant}</div>
                <div className="mb-2 text-xs text-slate-500">{d.note}</div>
                <div className="flex flex-wrap gap-2">
                  {(['admin', 'supervisor', 'agent'] as const).map((r) => (
                    <Button key={r} type="button" className="!px-2 !py-1 text-xs capitalize" disabled={busy}
                      onClick={(e) => submit(e as unknown as FormEvent, { email: `${r}@${d.slug}.test`, password: 'Demo@1234' })}>{r}</Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
