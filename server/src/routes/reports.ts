import { Router } from 'express';
import { pool } from '../db/mysql.js';
import { mcol } from '../db/mongo.js';
import { toCsv } from '../lib/csv.js';
import { badRequest, wrap } from '../lib/errors.js';
import { ctx, requireAuth, requireRole } from '../middleware/auth.js';
import { REPORTS, parseRange, type ReportName } from '../services/reports.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole('admin', 'supervisor'));

async function tz(companyId: number) {
  const [rows] = await pool.query('SELECT tz_offset_minutes FROM companies WHERE id = ?', [companyId]);
  return (rows as { tz_offset_minutes: number }[])[0].tz_offset_minutes;
}

/** Minute-resolution telemetry history (Mongo) for the wallboard sparkline. */
reportsRouter.get('/telemetry', wrap(async (req, res) => {
  const a = ctx(req);
  const minutes = Math.min(Number(req.query.minutes) || 120, 720);
  const rows = await mcol('wallboard_snapshots', a.companyId).find({ ts: { $gte: new Date(Date.now() - minutes * 60_000) } }).sort({ ts: 1 }).project({ _id: 0, company_id: 0 }).toArray();
  res.json(rows);
}));

reportsRouter.get('/:name', wrap(async (req, res) => {
  const a = ctx(req);
  const name = String(req.params.name) as ReportName;
  if (!(name in REPORTS)) throw badRequest(`Unknown report. Available: ${Object.keys(REPORTS).join(', ')}`);
  const range = parseRange(req.query, await tz(a.companyId));
  const data = await REPORTS[name](a.companyId, range);
  if (req.query.format === 'csv') {
    const rows = (Array.isArray(data) ? data : [data]).map((r) => Object.fromEntries(Object.entries(r as object).filter(([, v]) => typeof v !== 'object' || v === null)));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${name}-report.csv"`);
    return res.send(toCsv(rows as Record<string, unknown>[]));
  }
  res.json(data);
}));
