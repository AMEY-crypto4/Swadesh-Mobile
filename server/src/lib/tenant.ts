import { pool, type Conn, type Exec, type Row } from '../db/mysql.js';

type Params = (string | number | boolean | null | Date)[];

export interface TenantDb {
  readonly companyId: number;
  rows<T = Row>(sql: string, params?: Params): Promise<T[]>;
  one<T = Row>(sql: string, params?: Params): Promise<T | null>;
  exec(sql: string, params?: Params): Promise<Exec>;
  tx<R>(fn: (t: TenantDb) => Promise<R>): Promise<R>;
}

/**
 * Tenant-scoped MySQL access. This is the ONLY query surface request handlers get.
 *
 * Guardrails (fail loudly rather than leak across customers):
 *  1. The statement must reference `company_id`.
 *  2. The tenant's id must be among the bound parameters.
 * They do not prove a query is correct (a JOIN can still forget one side) — the
 * tenant-isolation test suite exercises every route against a second tenant.
 */
export function tdb(companyId: number, conn?: Conn): TenantDb {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error('Tenant context required');

  const guard = (sql: string, params: Params) => {
    if (!/\bcompany_id\b/i.test(sql)) throw new Error(`Tenant guard: no company_id predicate in: ${sql.slice(0, 100)}`);
    if (!params.includes(companyId)) throw new Error(`Tenant guard: company id not bound in: ${sql.slice(0, 100)}`);
  };
  const target = () => conn ?? pool;

  const self: TenantDb = {
    companyId,
    async rows<T>(sql: string, params: Params = []) {
      guard(sql, params);
      const [r] = await target().query(sql, params);
      return r as unknown as T[];
    },
    async one<T>(sql: string, params: Params = []) {
      const r = await self.rows<T>(sql, params);
      return r[0] ?? null;
    },
    async exec(sql: string, params: Params = []) {
      guard(sql, params);
      const [r] = await target().query(sql, params);
      return r as Exec;
    },
    async tx<R>(fn: (t: TenantDb) => Promise<R>) {
      if (conn) return fn(self);
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        const out = await fn(tdb(companyId, c));
        await c.commit();
        return out;
      } catch (e) {
        await c.rollback();
        throw e;
      } finally {
        c.release();
      }
    },
  };
  return self;
}
