import { tdb, type TenantDb } from '../lib/tenant.js';
import { badRequest } from '../lib/errors.js';

export interface Range { from: Date; to: Date; tz: number; queueId?: number; campaignId?: number; agentId?: number }

/** `from`/`to` are inclusive local (company-tz) dates, YYYY-MM-DD. Returns UTC bounds [from, to+1d). */
export function parseRange(q: Record<string, unknown>, tz: number): Range {
  const day = 86_400_000;
  const today = Math.floor((Date.now() + tz * 60_000) / day) * day;
  const parse = (v: unknown, dflt: number) => {
    if (v === undefined || v === '') return dflt;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw badRequest('Dates must be YYYY-MM-DD');
    return Date.parse(`${v}T00:00:00Z`);
  };
  const f = parse(q.from, today - 6 * day);
  const t = parse(q.to, today);
  if (t < f) throw badRequest('`to` must not be before `from`');
  if ((t - f) / day > 366) throw badRequest('Range limited to 366 days');
  const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));
  return { from: new Date(f - tz * 60_000), to: new Date(t + day - tz * 60_000), tz, queueId: num(q.queueId), campaignId: num(q.campaignId), agentId: num(q.agentId) };
}

function where(db: TenantDb, r: Range, alias = 'c') {
  let sql = `${alias}.company_id = ? AND ${alias}.started_at >= ? AND ${alias}.started_at < ?`;
  const p: (number | Date)[] = [db.companyId, r.from, r.to];
  if (r.queueId) { sql += ` AND ${alias}.queue_id = ?`; p.push(r.queueId); }
  if (r.campaignId) { sql += ` AND ${alias}.campaign_id = ?`; p.push(r.campaignId); }
  if (r.agentId) { sql += ` AND ${alias}.agent_id = ?`; p.push(r.agentId); }
  return { sql, p };
}

/** Positive-outcome codes for the tenant, resolved once so the big scans avoid a per-row join. */
async function positiveCodes(db: TenantDb) {
  const rows = await db.rows<{ code: string }>("SELECT code FROM dispositions WHERE company_id=? AND category='positive'", [db.companyId]);
  return rows.length ? rows.map((r) => r.code) : ['__none__'];
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function overview(companyId: number, r: Range) {
  const db = tdb(companyId); const w = where(db, r); const pos = await positiveCodes(db);
  const [row] = await db.rows<Record<string, number>>(
    `SELECT COUNT(*) total,
            SUM(c.direction='inbound') inbound, SUM(c.direction='outbound') outbound,
            SUM(c.direction='inbound' AND c.status='completed') in_answered,
            SUM(c.direction='inbound' AND c.status='abandoned') in_abandoned,
            SUM(c.direction='inbound' AND c.status='completed' AND c.wait_secs <= COALESCE(q.sla_seconds, 20)) in_within_sla,
            SUM(c.direction='outbound' AND c.status='completed') out_connected,
            SUM(c.direction='outbound' AND c.status='abandoned') out_abandoned,
            AVG(CASE WHEN c.direction='inbound' AND c.status IN ('completed','abandoned') THEN c.wait_secs END) avg_wait,
            AVG(CASE WHEN c.status='completed' THEN c.talk_secs END) avg_talk,
            AVG(CASE WHEN c.status='completed' THEN c.wrap_secs END) avg_wrap,
            SUM(c.disposition IN (${pos.map(() => '?').join(',')})) positive
       FROM calls c LEFT JOIN queues q ON q.id=c.queue_id AND q.company_id=c.company_id
      WHERE ${w.sql}`, [...pos, ...w.p]);
  const inboundOffered = n(row.in_answered) + n(row.in_abandoned);
  return {
    totalCalls: n(row.total), inbound: n(row.inbound), outbound: n(row.outbound),
    answerRatePct: pct(n(row.in_answered), inboundOffered), abandonRatePct: pct(n(row.in_abandoned), inboundOffered),
    serviceLevelPct: pct(n(row.in_within_sla), inboundOffered),
    outboundConnectPct: pct(n(row.out_connected), n(row.outbound)),
    avgWaitSecs: Math.round(n(row.avg_wait)), avgTalkSecs: Math.round(n(row.avg_talk)), avgWrapSecs: Math.round(n(row.avg_wrap)),
    positiveOutcomes: n(row.positive),
  };
}

export async function daily(companyId: number, r: Range) {
  const db = tdb(companyId); const w = where(db, r);
  const rows = await db.rows<Record<string, unknown>>(
    `SELECT DATE(DATE_ADD(c.started_at, INTERVAL ? MINUTE)) day,
            SUM(c.direction='inbound') inbound, SUM(c.direction='outbound') outbound,
            SUM(c.status='abandoned') abandoned, SUM(c.status='completed') answered
       FROM calls c WHERE ${w.sql} GROUP BY day ORDER BY day`, [r.tz, ...w.p]);
  return rows.map((x) => ({ day: new Date(x.day as Date).toISOString().slice(0, 10), inbound: n(x.inbound), outbound: n(x.outbound), abandoned: n(x.abandoned), answered: n(x.answered) }));
}

export async function hourly(companyId: number, r: Range) {
  const db = tdb(companyId); const w = where(db, r);
  const rows = await db.rows<Record<string, unknown>>(
    `SELECT HOUR(DATE_ADD(c.started_at, INTERVAL ? MINUTE)) hour,
            SUM(c.direction='inbound') inbound, SUM(c.direction='outbound') outbound, SUM(c.status='abandoned') abandoned
       FROM calls c WHERE ${w.sql} GROUP BY hour ORDER BY hour`, [r.tz, ...w.p]);
  const map = new Map(rows.map((x) => [n(x.hour), x]));
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, inbound: n(map.get(h)?.inbound), outbound: n(map.get(h)?.outbound), abandoned: n(map.get(h)?.abandoned) }));
}

export async function byQueue(companyId: number, r: Range) {
  const db = tdb(companyId); const w = where(db, r);
  const rows = await db.rows<Record<string, unknown>>(
    `SELECT q.id, q.name, q.sla_seconds,
            COUNT(*) calls, SUM(c.status='completed') answered, SUM(c.status='abandoned') abandoned,
            SUM(c.direction='inbound' AND c.status='completed' AND c.wait_secs <= q.sla_seconds) within_sla,
            SUM(c.direction='inbound') inbound,
            AVG(CASE WHEN c.direction='inbound' THEN c.wait_secs END) avg_wait,
            AVG(CASE WHEN c.status='completed' THEN c.talk_secs END) avg_talk,
            MAX(CASE WHEN c.direction='inbound' THEN c.wait_secs END) max_wait
       FROM calls c JOIN queues q ON q.id=c.queue_id AND q.company_id=c.company_id
      WHERE ${w.sql} GROUP BY q.id, q.name, q.sla_seconds ORDER BY calls DESC`, w.p);
  return rows.map((x) => ({
    id: n(x.id), name: x.name, slaSeconds: n(x.sla_seconds), calls: n(x.calls), answered: n(x.answered), abandoned: n(x.abandoned),
    serviceLevelPct: pct(n(x.within_sla), n(x.inbound)), abandonRatePct: pct(n(x.abandoned), n(x.inbound)),
    avgWaitSecs: Math.round(n(x.avg_wait)), avgTalkSecs: Math.round(n(x.avg_talk)), maxWaitSecs: n(x.max_wait),
  }));
}

export async function byAgent(companyId: number, r: Range) {
  const db = tdb(companyId); const w = where(db, r); const pos = await positiveCodes(db);
  const rows = await db.rows<Record<string, unknown>>(
    `SELECT u.id, u.name, COUNT(*) handled, SUM(c.talk_secs) talk, AVG(c.talk_secs) avg_talk, AVG(c.wrap_secs) avg_wrap,
            SUM(c.direction='inbound') inbound, SUM(c.direction='outbound') outbound,
            SUM(c.disposition IN (${pos.map(() => '?').join(',')})) positive, SUM(c.disposition='sale_closed') sales
       FROM calls c JOIN users u ON u.id=c.agent_id AND u.company_id=c.company_id
      WHERE ${w.sql} AND c.status='completed' GROUP BY u.id, u.name ORDER BY handled DESC`, [...pos, ...w.p]);
  return rows.map((x) => ({
    id: n(x.id), name: x.name, handled: n(x.handled), inbound: n(x.inbound), outbound: n(x.outbound), talkHours: Math.round((n(x.talk) / 3600) * 10) / 10,
    avgTalkSecs: Math.round(n(x.avg_talk)), avgWrapSecs: Math.round(n(x.avg_wrap)), positivePct: pct(n(x.positive), n(x.handled)), sales: n(x.sales),
  }));
}

export async function byCampaign(companyId: number, r: Range) {
  const db = tdb(companyId); const w = where(db, r); const pos = await positiveCodes(db);
  const rows = await db.rows<Record<string, unknown>>(
    `SELECT cp.id, cp.name, cp.mode, cp.status, COUNT(*) dialed, SUM(c.status='completed') connected, SUM(c.status='abandoned') abandoned,
            SUM(c.status='no_answer') no_answer, SUM(c.status='busy') busy, SUM(c.status='voicemail') voicemail,
            SUM(c.disposition='sale_closed') sales, SUM(c.disposition IN (${pos.map(() => '?').join(',')})) positive, AVG(CASE WHEN c.status='completed' THEN c.talk_secs END) avg_talk
       FROM calls c JOIN campaigns cp ON cp.id=c.campaign_id AND cp.company_id=c.company_id
      WHERE ${w.sql} GROUP BY cp.id, cp.name, cp.mode, cp.status ORDER BY dialed DESC`, [...pos, ...w.p]);
  const leadRows = await db.rows<{ campaign_id: number; status: string; n: number }>('SELECT campaign_id, status, COUNT(*) n FROM leads WHERE company_id=? GROUP BY campaign_id, status', [companyId]);
  return rows.map((x) => {
    const leads = Object.fromEntries(leadRows.filter((l) => l.campaign_id === n(x.id)).map((l) => [l.status, n(l.n)]));
    return {
      id: n(x.id), name: x.name, mode: x.mode, status: x.status, dialed: n(x.dialed), connected: n(x.connected), connectRatePct: pct(n(x.connected), n(x.dialed)),
      abandonRatePct: pct(n(x.abandoned), n(x.connected) + n(x.abandoned)), noAnswer: n(x.no_answer), busy: n(x.busy), voicemail: n(x.voicemail),
      sales: n(x.sales), positivePct: pct(n(x.positive), n(x.connected)), avgTalkSecs: Math.round(n(x.avg_talk)), leads,
    };
  });
}

export async function dispositions(companyId: number, r: Range) {
  const db = tdb(companyId); const w = where(db, r);
  const rows = await db.rows<Record<string, unknown>>(
    `SELECT d.code, d.label, d.category, COUNT(*) n FROM calls c JOIN dispositions d ON d.code=c.disposition AND d.company_id=c.company_id
      WHERE ${w.sql} GROUP BY d.code, d.label, d.category ORDER BY n DESC`, w.p);
  return rows.map((x) => ({ code: x.code, label: x.label, category: x.category, count: n(x.n) }));
}

export const REPORTS = { overview, daily, hourly, queues: byQueue, agents: byAgent, campaigns: byCampaign, dispositions } as const;
export type ReportName = keyof typeof REPORTS;
