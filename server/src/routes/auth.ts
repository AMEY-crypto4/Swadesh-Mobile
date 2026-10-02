import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/mysql.js';
import { HttpError, wrap } from '../lib/errors.js';
import { ctx, requireAuth, signToken } from '../middleware/auth.js';
import { loginRateLimit } from '../middleware/rateLimit.js';
import { provisionGuestSeat, retireSeat } from '../services/sessions.js';

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 8);

authRouter.post('/login', loginRateLimit, wrap(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  // Login is the one pre-tenant lookup: email is globally unique and resolves the tenant.
  const [rows] = await pool.query(
    "SELECT u.id, u.company_id, u.name, u.email, u.role, u.password_hash, u.is_shared_demo, c.name company_name, c.slug FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = ? AND u.status = 'active'",
    [email.toLowerCase()],
  );
  const u = (rows as any[])[0];
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH).catch(() => false); // constant-ish time even for unknown emails
  if (!u || !ok) throw new HttpError(401, 'Incorrect email or password', 'unauthorized');

  let identity = { id: u.id as number, name: u.name as string, email: u.email as string };
  let seat = false;
  if (u.is_shared_demo) {
    // Shared "Normal User" login: hand this browser its own private agent seat.
    identity = await provisionGuestSeat({ id: u.id, company_id: u.company_id, slug: u.slug });
    seat = true;
  }
  const token = signToken({ userId: identity.id, companyId: u.company_id, role: u.role, email: identity.email, name: identity.name });
  res.json({ token, user: { id: identity.id, name: identity.name, email: identity.email, role: u.role, seat }, company: { id: u.company_id, name: u.company_name, slug: u.slug } });
}));

authRouter.get('/me', requireAuth, wrap(async (req, res) => {
  const a = ctx(req);
  // `companies` is the tenant root (its own id IS the tenant), so it is read straight from the pool.
  const [rows] = await pool.query('SELECT id, name, slug, plan, tz_offset_minutes FROM companies WHERE id = ?', [a.companyId]);
  res.json({ user: { id: a.userId, name: a.name, email: a.email, role: a.role, seat: a.email.endsWith('.session') }, company: (rows as any[])[0] });
}));

/** Releases a guest seat immediately (no-op for regular accounts) so capacity frees up as soon as people leave. */
authRouter.post('/logout', requireAuth, wrap(async (req, res) => {
  const a = ctx(req);
  const released = a.email.endsWith('.session') ? await retireSeat(a.companyId, a.userId) : true;
  res.json({ ok: true, released });
}));
