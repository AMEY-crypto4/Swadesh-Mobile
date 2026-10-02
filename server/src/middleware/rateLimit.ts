import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors.js';

/**
 * Sliding-window-log limiter (exact, no boundary bursts). In-memory: correct for a single node.
 * For a horizontally scaled deployment swap `hits` for Redis (ZADD/ZREMRANGEBYSCORE) — the interface stays the same.
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private windowMs = 60_000) {
    setInterval(() => this.gc(), windowMs).unref();
  }

  check(key: string, limit: number, now = Date.now()) {
    const arr = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    const allowed = arr.length < limit;
    if (allowed) arr.push(now);
    this.hits.set(key, arr);
    const oldest = arr[0] ?? now;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - arr.length),
      resetSecs: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
    };
  }

  private gc() {
    const cutoff = Date.now() - this.windowMs;
    for (const [k, v] of this.hits) if (!v.length || v[v.length - 1] <= cutoff) this.hits.delete(k);
  }
}

const LOGIN_LIMIT = Number(process.env.LOGIN_RATE_LIMIT ?? 20); // per IP per minute
const apiLimiter = new SlidingWindowLimiter(60_000);
const loginLimiter = new SlidingWindowLimiter(60_000);

function apply(res: Response, r: ReturnType<SlidingWindowLimiter['check']>) {
  res.setHeader('X-RateLimit-Limit', r.limit);
  res.setHeader('X-RateLimit-Remaining', r.remaining);
  res.setHeader('X-RateLimit-Reset', r.resetSecs);
  if (!r.allowed) {
    res.setHeader('Retry-After', r.resetSecs);
    throw new HttpError(429, `Rate limit of ${r.limit} requests/minute exceeded. Retry in ${r.resetSecs}s.`, 'rate_limited');
  }
}

/** Per-API-key limit; the limit itself is configured per key. Must run after API key auth. */
export function apiKeyRateLimit(getLimit: (req: Request) => number) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      apply(res, apiLimiter.check(`key:${req.apiKey!.id}`, getLimit(req)));
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  try {
    apply(res, loginLimiter.check(`ip:${req.ip}`, LOGIN_LIMIT));
    next();
  } catch (e) {
    next(e);
  }
}
