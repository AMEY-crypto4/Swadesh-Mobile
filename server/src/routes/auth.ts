import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/mysql.js';
import { HttpError, wrap } from '../lib/errors.js';
import { ctx, requireAuth, signToken } from '../middleware/auth.js';
import { loginRateLimit } from '../middleware/rateLimit.js';

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 8);

authRouter.post('/login', loginRateLimit, wrap(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  // Login is the one pre-tenant lookup: email is globally unique and resolves the tenant.
  const [rows] = await pool.query(
    "SELECT u.id, u.company_id, u.name, u.email, u.role, u.password_hash, c.name company_name, c.slug FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = ? AND u.status = 'active'",
    [email.toLowerCase()],
  );
  const u = (rows as any[])[0];
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH); // constant-ish time even for unknown emails
  if (!u || !ok) throw new HttpError(401, 'Incorrect email or password', 'unauthorized');
  const token = signToken({ userId: u.id, companyId: u.company_id, role: u.role, email: u.email, name: u.name });
  res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role }, company: { id: u.company_id, name: u.company_name, slug: u.slug } });
}));

authRouter.get('/me', requireAuth, wrap(async (req, res) => {
  const a = ctx(req);
  // `companies` is the tenant root (its own id IS the tenant), so it is read straight from the pool.
  const [rows] = await pool.query('SELECT id, name, slug, plan, tz_offset_minutes FROM companies WHERE id = ?', [a.companyId]);
  res.json({ user: { id: a.userId, name: a.name, email: a.email, role: a.role }, company: (rows as any[])[0] });
}));
