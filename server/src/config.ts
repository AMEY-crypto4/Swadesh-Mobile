import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-change-me',
  nodeEnv: env.NODE_ENV ?? 'development',
  mysqlUrl: env.MYSQL_URL ?? '',
  mongoUrl: env.MONGO_URL ?? '',
  mongoDb: env.MONGO_DB ?? 'swadesh_cc',
  /** Simulation speed multiplier (1 = real-time, 3 = three times faster call lifecycles). */
  simSpeed: Number(env.SIM_SPEED ?? 3),
  simulate: env.SIMULATE !== 'false',
  exportDir: env.EXPORT_DIR ?? 'data/exports',
  publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 4000}`,
};

/** When no external DB URLs are configured we boot embedded MySQL/Mongo and auto-seed (dev only). */
export const useEmbeddedDb = !config.mysqlUrl || !config.mongoUrl;
export const isProd = config.nodeEnv === 'production';
