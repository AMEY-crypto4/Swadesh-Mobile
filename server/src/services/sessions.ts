import { pool } from '../db/mysql.js';
import { tdb } from '../lib/tenant.js';
import { randomHex } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { hub } from '../engine/hub.js';
import { runtime } from '../engine/runtime.js';

/**
 * Shared demo logins ("Normal User") never act as one shared identity. Every sign-in is given its own
 * private agent seat — its own user row, state machine, calls, history and WebSocket channel — so any
 * number of people can use the same credential at once without seeing or disturbing each other.
 */
export const MAX_GUEST_SEATS = Number(process.env.MAX_GUEST_SEATS ?? 25);
const IDLE_MS = Number(process.env.GUEST_IDLE_MINUTES ?? 10) * 60_000;

/** Not a bcrypt hash, so a seat can never be signed into directly with a password. */
export const SEAT_HASH = '!guest-seat';

export async function provisionGuestSeat(template: { id: number; company_id: number; slug: string }) {
  const cid = template.company_id;
  const conn = await pool.getConnection();
  let seat: { id: number; name: string; email: string };
  try {
    await conn.beginTransaction();
    // One row lock on the tenant root serialises seat provisioning per company: the cap is exact under a stampede,
    // and (unlike locking an index range) two concurrent sign-ins cannot deadlock each other.
    await conn.query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [cid]);
    const t = tdb(cid, conn);
    const [{ n }] = await t.rows<{ n: number }>("SELECT COUNT(*) n FROM users WHERE company_id=? AND is_session=1 AND status='active'", [cid]);
    if (n >= MAX_GUEST_SEATS) {
      throw new HttpError(503, `All ${MAX_GUEST_SEATS} demo seats for this company are in use. Seats free up when users sign out or go idle for ${Math.round(IDLE_MS / 60000)} minutes — please retry shortly.`, 'capacity');
    }
    const tpl = await t.one<{ skills: string[] | null }>('SELECT skills FROM users WHERE company_id=? AND id=?', [cid, template.id]);
    const name = `Guest ${randomHex(2).toUpperCase()}`;
    const email = `guest-${randomHex(6)}@${template.slug}.session`;
    const r = await t.exec(
      "INSERT INTO users (company_id, email, name, password_hash, role, extension, skills, is_bot, is_session, last_seen_at) VALUES (?,?,?,?, 'agent', ?, ?, 0, 1, NOW(3))",
      [cid, email, name, SEAT_HASH, String(3000 + Math.floor(Math.random() * 900)), JSON.stringify(tpl?.skills ?? [])],
    );
    await t.exec('INSERT INTO queue_members (company_id, queue_id, user_id, priority) SELECT company_id, queue_id, ?, priority FROM queue_members WHERE company_id=? AND user_id=?', [r.insertId, cid, template.id]);
    seat = { id: r.insertId, name, email };
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await runtime.reload(cid);
  return seat;
}

/** Free a seat now (sign-out) or when idle. Returns false if it must wait (agent is on a live call). */
export async function retireSeat(companyId: number, userId: number) {
  const db = tdb(companyId);
  const u = await db.one<{ id: number }>('SELECT id FROM users WHERE company_id=? AND id=? AND is_session=1 AND status=\'active\'', [companyId, userId]);
  if (!u) return true;
  if (!(await runtime.get(companyId).agentRetire(userId))) return false;
  await db.exec("UPDATE users SET status='disabled' WHERE company_id=? AND id=?", [companyId, userId]);
  await runtime.reload(companyId);
  return true;
}

let timer: NodeJS.Timeout | undefined;

/** Cross-tenant maintenance worker (one of the few that is): each seat is handled with its own company_id. */
async function reap() {
  const [rows] = await pool.query("SELECT id, company_id, last_seen_at FROM users WHERE is_session=1 AND status='active'");
  for (const r of rows as { id: number; company_id: number; last_seen_at: Date | null }[]) {
    if (hub.isOnline(r.company_id, r.id)) {
      await tdb(r.company_id).exec('UPDATE users SET last_seen_at=NOW(3) WHERE company_id=? AND id=?', [r.company_id, r.id]);
    } else if (!r.last_seen_at || Date.now() - new Date(r.last_seen_at).getTime() > IDLE_MS) {
      await retireSeat(r.company_id, r.id);
    }
  }
}

export function startSessionReaper(everyMs = 60_000) {
  timer = setInterval(() => void reap().catch((e) => console.error('[sessions]', e)), everyMs);
  timer.unref();
}
export const stopSessionReaper = () => timer && clearInterval(timer);
export { reap as _reapNow };
