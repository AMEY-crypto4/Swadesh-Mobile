import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowLimiter } from '../middleware/rateLimit.js';
import { hmacSignature, verifySignature } from '../lib/crypto.js';
import { csvCell, csvRow } from '../lib/csv.js';
import { segmentsFor } from '../services/sms.js';
import { parseRange } from '../services/reports.js';

test('sliding-window limiter allows N then blocks, and recovers as the window slides', () => {
  const l = new SlidingWindowLimiter(60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(l.check('k', 3, t0 + i).allowed, true);
  const blocked = l.check('k', 3, t0 + 10);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.resetSecs >= 1 && blocked.resetSecs <= 60);
  assert.equal(l.check('k', 3, t0 + 60_001).allowed, true, 'first hit has left the window');
  assert.equal(l.check('other', 3, t0).allowed, true, 'keys are independent');
});

test('webhook signature verifies, rejects tampering and stale timestamps', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ hello: 'world' });
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${hmacSignature(secret, t, body)}`;
  assert.equal(verifySignature(secret, header, body), true);
  assert.equal(verifySignature(secret, header, body + ' '), false, 'body tampered');
  assert.equal(verifySignature('other', header, body), false, 'wrong secret');
  const old = t - 3600;
  assert.equal(verifySignature(secret, `t=${old},v1=${hmacSignature(secret, old, body)}`, body), false, 'replay outside tolerance');
  assert.equal(verifySignature(secret, 'garbage', body), false);
});

test('csv escapes quotes/commas and neutralises formula injection but keeps phone numbers intact', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("http://x")').startsWith(`"'=`), true);
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('+919876543210'), '+919876543210');
  assert.equal(csvCell(null), '');
  assert.equal(csvRow(['a', 1]), 'a,1\r\n');
});

test('SMS segment maths: GSM-7 vs UCS-2', () => {
  assert.deepEqual(segmentsFor('x'.repeat(160)), { encoding: 'GSM-7', segments: 1 });
  assert.deepEqual(segmentsFor('x'.repeat(161)), { encoding: 'GSM-7', segments: 2 });
  assert.deepEqual(segmentsFor('x'.repeat(306)), { encoding: 'GSM-7', segments: 2 });
  assert.deepEqual(segmentsFor('x'.repeat(307)), { encoding: 'GSM-7', segments: 3 });
  assert.deepEqual(segmentsFor('नमस्ते'), { encoding: 'UCS-2', segments: 1 });
  assert.equal(segmentsFor('न'.repeat(71)).segments, 2);
});

test('report ranges are company-local and validated', () => {
  const r = parseRange({ from: '2026-10-01', to: '2026-10-01' }, 330);
  assert.equal(r.from.toISOString(), '2026-09-30T18:30:00.000Z', 'IST midnight in UTC');
  assert.equal(r.to.toISOString(), '2026-10-01T18:30:00.000Z');
  assert.throws(() => parseRange({ from: '2026-10-05', to: '2026-10-01' }, 330));
  assert.throws(() => parseRange({ from: 'yesterday' }, 330));
  assert.throws(() => parseRange({ from: '2024-01-01', to: '2026-01-01' }, 330), /366/);
});
