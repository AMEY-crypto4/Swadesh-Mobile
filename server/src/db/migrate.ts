import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './mysql.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Forward-only, ordered, idempotent migrations tracked in schema_migrations. */
export async function migrate() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(80) PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))',
  );
  const [done] = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set((done as { version: string }[]).map((r) => r.version));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    const statements = sql.split(/;\s*\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const s of statements) await pool.query(s);
    await pool.query('INSERT INTO schema_migrations (version) VALUES (?)', [f]);
    console.log(`[migrate] applied ${f}`);
  }
}
