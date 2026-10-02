import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * In-process request telemetry for the "Platform showcase" page. Everything that is per-request is keyed by
 * tenant, so an admin only ever sees their own company's traffic; only process-level gauges are global.
 */
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

const RING = 500;
interface Group { count: number; errors: number; lat: number[]; i: number }
interface Tenant { total: number; errors5xx: number; groups: Map<string, Group>; perSec: number[]; perSecAt: number }
const tenants = new Map<number, Tenant>();
const startedAt = Date.now();

function tenant(id: number): Tenant {
  let t = tenants.get(id);
  if (!t) { t = { total: 0, errors5xx: 0, groups: new Map(), perSec: new Array(30).fill(0), perSecAt: Math.floor(Date.now() / 1000) }; tenants.set(id, t); }
  return t;
}
function roll(t: Tenant) {
  const sec = Math.floor(Date.now() / 1000);
  while (t.perSecAt < sec) { t.perSec.shift(); t.perSec.push(0); t.perSecAt++; }
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const p = req.originalUrl;
    if (!(p.startsWith('/api/') || p.startsWith('/v1/')) || p.startsWith('/api/system')) return;
    const cid = req.auth?.companyId ?? req.apiKey?.companyId ?? 0;
    if (!cid) return; // unauthenticated noise (bad logins, 401s) is not attributable to a tenant
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const t = tenant(cid);
    roll(t);
    t.total++; t.perSec[t.perSec.length - 1]++;
    if (res.statusCode >= 500) t.errors5xx++;
    const key = `${req.method} ${req.baseUrl}${req.route?.path === '/' ? '' : (req.route?.path ?? '')}`;
    let g = t.groups.get(key);
    if (!g) { g = { count: 0, errors: 0, lat: [], i: 0 }; t.groups.set(key, g); }
    g.count++; if (res.statusCode >= 400) g.errors++;
    if (g.lat.length < RING) g.lat.push(ms); else { g.lat[g.i] = ms; g.i = (g.i + 1) % RING; }
  });
  next();
}

const pctl = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

export function tenantHttp(companyId: number) {
  const t = tenant(companyId);
  roll(t);
  const groups = [...t.groups.entries()].map(([route, g]) => {
    const s = [...g.lat].sort((a, b) => a - b);
    return { route, count: g.count, errors: g.errors, p50: r1(pctl(s, 50)), p95: r1(pctl(s, 95)), p99: r1(pctl(s, 99)) };
  }).sort((a, b) => b.count - a.count).slice(0, 14);
  const last10 = t.perSec.slice(-10);
  return { total: t.total, errors5xx: t.errors5xx, reqPerSec: r1(last10.reduce((a, b) => a + b, 0) / 10), perSec: [...t.perSec], groups };
}

export function processStats() {
  const m = process.memoryUsage();
  const out = {
    node: process.version, pid: process.pid, platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length,
    uptimeSecs: Math.round(process.uptime()), startedAt,
    rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576), heapTotalMb: Math.round(m.heapTotal / 1048576),
    load1: r1(os.loadavg()[0]),
    eventLoopMs: { mean: r1(loop.mean / 1e6), p99: r1(loop.percentile(99) / 1e6), max: r1(loop.max / 1e6) },
  };
  loop.reset();
  return out;
}
