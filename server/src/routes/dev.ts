import express, { Router } from 'express';
import { verifySignature } from '../lib/crypto.js';

/** Dev-only webhook receiver so the demo's seeded webhooks show real, verified deliveries. Not mounted in production. */
export const devRouter = Router();

const log: { slug: string; at: string; event: string; verified: boolean }[] = [];

devRouter.post('/webhook-sink/fail', (_req, res) => res.status(500).json({ error: 'sink configured to fail (use it to watch retry/backoff)' }));

devRouter.post('/webhook-sink/:slug', express.text({ type: '*/*', limit: '256kb' }), (req, res) => {
  const sig = req.header('x-swadesh-signature') ?? '';
  const verified = verifySignature(`whsec_demo_${req.params.slug}`, sig, String(req.body));
  let event = 'unknown';
  try { event = JSON.parse(String(req.body)).type; } catch { /* ignore */ }
  log.unshift({ slug: req.params.slug, at: new Date().toISOString(), event, verified });
  log.length = Math.min(log.length, 100);
  if (!verified) return res.status(400).json({ error: 'bad signature' });
  res.json({ received: true });
});

devRouter.get('/webhook-sink/:slug/log', (req, res) => res.json(log.filter((l) => l.slug === req.params.slug)));
