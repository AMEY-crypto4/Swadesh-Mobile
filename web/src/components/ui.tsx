import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Info, Loader2, Lock, X, Coffee, Phone, PhoneCall, PhoneIncoming, Power, Timer, Eye, Circle } from 'lucide-react';
import type { AgentState } from '../lib/live';
import { ApiError } from '../lib/api';

// ------------------------------------------------------------------ buttons
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
export function Button({ variant = 'secondary', busy, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400 disabled:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300',
    ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-400',
  };
  return (
    <button {...rest} disabled={rest.disabled || busy} className={clsx('inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors', styles[variant], className)}>
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** Truthful-UI primitive: a control that exists but cannot work yet says so, visibly, with the reason. */
export function Unavailable({ children, reason }: { children: ReactNode; reason: string }) {
  const id = useId();
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button disabled aria-describedby={id} title={reason} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-400">
        <Lock className="h-3.5 w-3.5" aria-hidden /> {children}
      </button>
      <span id={id} className="text-[11px] text-slate-500">Not available: {reason}</span>
    </span>
  );
}

// ------------------------------------------------------------------ layout bits
export const Card = ({ className, children }: { className?: string; children: ReactNode }) => <section className={clsx('card', className)}>{children}</section>;

export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad' }) {
  const tones = { default: 'text-slate-900', good: 'text-emerald-600', warn: 'text-amber-600', bad: 'text-red-600' };
  return (
    <div className="card px-4 py-3">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', tones[tone])}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Badge({ tone = 'slate', children }: { tone?: 'slate' | 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'cyan' | 'orange'; children: ReactNode }) {
  const t = {
    slate: 'bg-slate-100 text-slate-700', green: 'bg-emerald-100 text-emerald-800', blue: 'bg-blue-100 text-blue-800', amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800', purple: 'bg-purple-100 text-purple-800', cyan: 'bg-cyan-100 text-cyan-800', orange: 'bg-orange-100 text-orange-800',
  };
  return <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', t[tone])}>{children}</span>;
}

/** State is conveyed by icon + text + colour, never colour alone. */
export const AGENT_STATE: Record<AgentState, { label: string; tone: Parameters<typeof Badge>[0]['tone']; icon: typeof Phone; dot: string }> = {
  available: { label: 'Available', tone: 'green', icon: Circle, dot: 'bg-emerald-500' },
  on_call: { label: 'On call', tone: 'blue', icon: PhoneCall, dot: 'bg-blue-500' },
  ringing: { label: 'Ringing', tone: 'amber', icon: PhoneIncoming, dot: 'bg-amber-500' },
  wrap_up: { label: 'Wrap-up', tone: 'purple', icon: Timer, dot: 'bg-purple-500' },
  preview: { label: 'Previewing', tone: 'cyan', icon: Eye, dot: 'bg-cyan-500' },
  break: { label: 'Break', tone: 'orange', icon: Coffee, dot: 'bg-orange-500' },
  offline: { label: 'Offline', tone: 'slate', icon: Power, dot: 'bg-slate-400' },
};

export function StateBadge({ state }: { state: AgentState }) {
  const s = AGENT_STATE[state]; const Icon = s.icon;
  return <Badge tone={s.tone}><Icon className="h-3 w-3" aria-hidden />{s.label}</Badge>;
}

export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <div role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{label}…</div>
);

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : (error as Error).message ?? 'Something went wrong';
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex-1">{msg}{error instanceof ApiError && error.details?.length ? <ul className="mt-1 list-disc pl-4 text-xs">{error.details.map((d, i) => <li key={i}>{d.path}: {d.message}</li>)}</ul> : null}</div>
      {onRetry && <button onClick={onRetry} className="font-medium underline">Retry</button>}
    </div>
  );
}

export const Notice = ({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'good'; children: ReactNode }) => {
  const t = { info: 'border-blue-200 bg-blue-50 text-blue-900', warn: 'border-amber-200 bg-amber-50 text-amber-900', good: 'border-emerald-200 bg-emerald-50 text-emerald-900' };
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : Info;
  return <div className={clsx('flex items-start gap-2 rounded-lg border p-3 text-sm', t[tone])}><Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><div>{children}</div></div>;
};

export const Empty = ({ children }: { children: ReactNode }) => <div className="p-8 text-center text-sm text-slate-500">{children}</div>;

// ------------------------------------------------------------------ forms
export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      {children(id)}
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}
export const TextInput = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={clsx('input', className)} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={clsx('input pr-8', className)}>{children}</select>;

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
        className={clsx('relative h-5 w-9 rounded-full transition-colors', checked ? 'bg-brand-600' : 'bg-slate-300')}>
        <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      <span>{label}</span>
    </label>
  );
}

// ------------------------------------------------------------------ table + pagination
export const Table = ({ children }: { children: ReactNode }) => <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-100">{children}</table></div>;

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
      <span>{total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total.toLocaleString('en-IN')}` : 'No results'}</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" className="!px-2 !py-1" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <span aria-current="page">Page {page} / {pages.toLocaleString('en-IN')}</span>
        <Button variant="ghost" className="!px-2 !py-1" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------ modal
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) { // focus trap
        const f = ref.current.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={clsx('card w-full', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button data-close onClick={onClose} aria-label="Close dialog" className="rounded p-1 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ toasts
interface Toast { id: number; tone: 'good' | 'bad'; text: string }
const ToastCtx = createContext<(tone: 'good' | 'bad', text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: 'good' | 'bad', text: string) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, tone, text }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg', t.tone === 'good' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900')}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={clsx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', value === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>{t.label}</button>
      ))}
    </div>
  );
}

export const mutationError = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);
