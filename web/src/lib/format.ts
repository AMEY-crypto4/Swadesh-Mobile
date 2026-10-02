export const fmtDur = (secs: number | null | undefined) => {
  if (secs === null || secs === undefined) return '—';
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
export const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
export const fmtNum = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('en-IN'));
export const fmtDateTime = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
export const fmtTime = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
export const title = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));
