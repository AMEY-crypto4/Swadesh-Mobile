import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/mysql.js';
import { HttpError } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';

interface KeyRow {
  id: number;
  company_id: number;
  name: string;
  scopes: string[];
  rate_limit_per_min: number;
  revoked_at: Date | null;
}

const limits = new Map<number, number>();

/** Public API auth: `Authorization: Bearer swk_live_...`. Keys are stored as SHA-256 only. */
export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.header('authorization');
    if (!h?.startsWith('Bearer swk_')) throw new HttpError(401, 'Provide an API key as "Authorization: Bearer swk_..."', 'unauthorized');
    // Key lookup is the one place that resolves a tenant FROM a credential (hash is globally unique).
    const [rows] = await pool.query('SELECT id, company_id, name, scopes, rate_limit_per_min, revoked_at FROM api_keys WHERE key_hash = ?', [sha256(h.slice(7))]);
    const k = (rows as KeyRow[])[0];
    if (!k || k.revoked_at) throw new HttpError(401, 'Invalid or revoked API key', 'unauthorized');
    req.apiKey = { id: k.id, companyId: k.company_id, scopes: k.scopes, name: k.name };
    limits.set(k.id, k.rate_limit_per_min);
    pool.query('UPDATE api_keys SET last_used_at = NOW(3) WHERE id = ? AND company_id = ?', [k.id, k.company_id]).catch(() => {});
    next();
  } catch (e) {
    next(e);
  }
}

export const keyLimit = (req: Request) => limits.get(req.apiKey!.id) ?? 60;

export const requireScope = (scope: string) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.apiKey?.scopes.includes(scope)) return next(new HttpError(403, `API key lacks required scope "${scope}"`, 'insufficient_scope'));
  next();
};
