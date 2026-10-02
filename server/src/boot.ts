import { createServer, type Server } from 'node:http';
import { config, useEmbeddedDb } from './config.js';
import { connectMysql, pool } from './db/mysql.js';
import { closeMongo, connectMongo } from './db/mongo.js';
import { migrate } from './db/migrate.js';
import { seedAll } from './db/seed.js';
import { startEmbedded, type EmbeddedDbs } from './db/embedded.js';
import { createApp } from './app.js';
import { runtime } from './engine/runtime.js';
import { hub } from './engine/hub.js';
import { startWebhookWorker, stopWebhookWorker } from './services/webhooks.js';
import { startRetentionWorker } from './services/privacy.js';
import { startSessionReaper, stopSessionReaper } from './services/sessions.js';

export interface Stack { server: Server; port: number; stop: () => Promise<void> }

export async function boot(opts: { port?: number; seed?: boolean; scale?: boolean } = {}): Promise<Stack> {
  let embedded: EmbeddedDbs | undefined;
  let mysqlUrl = config.mysqlUrl, mongoUrl = config.mongoUrl;
  if (useEmbeddedDb) {
    embedded = await startEmbedded();
    mysqlUrl = embedded.mysqlUrl; mongoUrl = embedded.mongoUrl;
  }
  await connectMysql(mysqlUrl);
  await connectMongo(mongoUrl, config.mongoDb);
  await migrate();
  if (opts.seed ?? useEmbeddedDb) await seedAll({ scale: opts.scale });

  const server = createServer(createApp());
  await runtime.start(server);
  startWebhookWorker();
  startRetentionWorker();
  startSessionReaper();
  const port = await new Promise<number>((resolve) => server.listen(opts.port ?? config.port, () => resolve((server.address() as { port: number }).port)));

  return {
    server, port,
    stop: async () => {
      stopWebhookWorker();
      stopSessionReaper();
      await runtime.stop();
      hub.close();
      await new Promise((r) => server.close(r));
      await closeMongo();
      await pool.end();
      await embedded?.stop();
    },
  };
}
