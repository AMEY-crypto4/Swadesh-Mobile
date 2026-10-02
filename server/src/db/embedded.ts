import { createDB } from 'mysql-memory-server';
import { MongoMemoryServer } from 'mongodb-memory-server';

export interface EmbeddedDbs {
  mysqlUrl: string;
  mongoUrl: string;
  stop: () => Promise<void>;
}

/** Zero-install dev databases. First run downloads MySQL/MongoDB binaries (~1-2 min). Data is ephemeral. */
export async function startEmbedded(): Promise<EmbeddedDbs> {
  console.log('[db] no MYSQL_URL/MONGO_URL set -> starting embedded MySQL + MongoDB (dev only, first run downloads binaries)');
  const [mongo, mysql] = await Promise.all([
    MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } }),
    createDB({ logLevel: 'ERROR', version: '8.4.x' }),
  ]);
  return {
    mongoUrl: mongo.getUri(),
    mysqlUrl: `mysql://${mysql.username}@127.0.0.1:${mysql.port}/${mysql.dbName}`,
    stop: async () => {
      await Promise.allSettled([mongo.stop(), mysql.stop()]);
    },
  };
}
