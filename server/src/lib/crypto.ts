import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomHex = (bytes: number) => randomBytes(bytes).toString('hex');

export function hmacSignature(secret: string, timestamp: number, body: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Verify an `X-Swadesh-Signature: t=<unix>,v1=<hex>` header. Rejects stale timestamps (replay window). */
export function verifySignature(secret: string, header: string, body: string, toleranceSecs = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSecs) return false;
  const expected = Buffer.from(hmacSignature(secret, t, body));
  const got = Buffer.from(parts.v1);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export const secureEqualHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
