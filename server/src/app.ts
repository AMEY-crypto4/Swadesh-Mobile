import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { errorHandler } from './lib/errors.js';
import { isProd } from './config.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { callsRouter } from './routes/calls.js';
import { reportsRouter } from './routes/reports.js';
import { developerRouter } from './routes/developer.js';
import { privacyRouter } from './routes/privacy.js';
import { agentRouter } from './routes/agent.js';
import { v1Router } from './routes/v1.js';
import { devRouter } from './routes/dev.js';
import { systemRouter } from './routes/system.js';
import { metricsMiddleware } from './lib/metrics.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: isProd ? false : true }));
  if (!isProd) app.use('/dev', devRouter); // before the JSON parser: the sink needs the raw body to verify signatures
  app.use(express.json({ limit: '2.5mb' }));
  app.use(metricsMiddleware);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/agent', agentRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/developer', developerRouter);
  app.use('/api/privacy', privacyRouter);
  app.use('/api/system', systemRouter);
  app.use('/api', adminRouter); // users, queues, campaigns, dnc, dispositions, audit
  app.use('/v1', v1Router);

  // Single-port production: serve the built SPA if present.
  const dist = path.resolve(process.cwd(), '../web/dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/|v1\/|ws$|dev\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint' } }));
  app.use(errorHandler);
  return app;
}
