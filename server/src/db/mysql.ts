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
  // Pin the *session* time zone to UTC. `timezone: 'Z'` only tells the driver how to read DATETIMEs; without this,
  // NOW()/CURRENT_TIMESTAMP default to the MySQL server's local zone and every DB-stamped row is skewed in the UI.
  (pool as unknown as { pool: { on(e: string, f: (c: { query(sql: string): void }) => void): void } }).pool.on('connection', (c) => c.query("SET time_zone = '+00:00'"));
  await pool.query('SELECT 1');
  return pool;
}

export type Row = RowDataPacket;
export type Exec = ResultSetHeader;
export type Conn = PoolConnection;
