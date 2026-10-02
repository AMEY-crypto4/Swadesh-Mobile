import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/**
 * Raw pool. Only migrations, seeds and the cross-tenant background workers
 * (webhook delivery, retention) may import this directly. Every request path
 * MUST go through `tdb(companyId)` from lib/tenant.ts.
 */
export let pool: Pool;

export async function connectMysql(uri: string) {
  pool = mysql.createPool({
    uri,
    timezone: 'Z',
    decimalNumbers: true,
    connectionLimit: 20,
    dateStrings: false,
  });
  await pool.query('SELECT 1');
  return pool;
}

export type Row = RowDataPacket;
export type Exec = ResultSetHeader;
export type Conn = PoolConnection;
