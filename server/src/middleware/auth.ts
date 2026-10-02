import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';

export type Role = 'admin' | 'supervisor' | 'agent';

export interface AuthCtx {
  userId: number;
  companyId: number;
  role: Role;
  email: string;
  name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthCtx;
    apiKey?: { id: number; companyId: number; scopes: string[]; name: string };
  }
}

export const signToken = (a: AuthCtx) => jwt.sign(a, config.jwtSecret, { expiresIn: '12h' });

export function verifyToken(token: string): AuthCtx {
  try {
    const p = jwt.verify(token, config.jwtSecret) as AuthCtx;
    return { userId: p.userId, companyId: p.companyId, role: p.role, email: p.email, name: p.name };
  } catch {
    throw new HttpError(401, 'Invalid or expired token', 'unauthorized');
  }
}

/** The tenant (companyId) is derived ONLY from the verified token — never from request params/body. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.header('authorization');
  if (!h?.startsWith('Bearer ')) return next(new HttpError(401, 'Missing bearer token', 'unauthorized'));
  try {
    req.auth = verifyToken(h.slice(7));
    next();
  } catch (e) {
    next(e);
  }
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return next(new HttpError(403, 'Insufficient role', 'forbidden'));
    next();
  };

/** Always call after requireAuth. */
export const ctx = (req: Request): AuthCtx => {
  if (!req.auth) throw new HttpError(401, 'Unauthenticated', 'unauthorized');
  return req.auth;
};
