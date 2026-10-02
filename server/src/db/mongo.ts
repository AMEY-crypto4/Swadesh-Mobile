import { MongoClient, type Db, type Document, type Filter } from 'mongodb';

let client: MongoClient;
export let mdb: Db;

export async function connectMongo(url: string, dbName: string) {
  client = new MongoClient(url);
  await client.connect();
  mdb = client.db(dbName);
  // Every collection leads with company_id so tenant-scoped reads are index-covered.
  await Promise.all([
    mdb.collection('call_events').createIndex({ company_id: 1, call_id: 1, ts: 1 }),
    mdb.collection('call_events').createIndex({ company_id: 1, ts: -1 }),
    mdb.collection('agent_state_log').createIndex({ company_id: 1, agent_id: 1, ts: -1 }),
    mdb.collection('audit_log').createIndex({ company_id: 1, ts: -1 }),
    mdb.collection('wallboard_snapshots').createIndex({ company_id: 1, ts: -1 }),
    mdb.collection('wallboard_snapshots').createIndex({ ts: 1 }, { expireAfterSeconds: 60 * 60 * 48 }),
  ]);
  return mdb;
}

export async function closeMongo() {
  await client?.close();
}

/** Tenant-scoped Mongo collection: company_id is merged into every filter and document. */
export function mcol<T extends Document = Document>(name: string, companyId: number) {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error('Tenant context required');
  const scope = (f: Filter<T> = {}) => ({ ...f, company_id: companyId }) as Filter<T>;
  const col = () => mdb.collection<T>(name);
  return {
    find: (f?: Filter<T>) => col().find(scope(f)),
    findOne: (f?: Filter<T>) => col().findOne(scope(f)),
    insertOne: (doc: Omit<T, 'company_id'>) => col().insertOne({ ...doc, company_id: companyId } as never),
    insertMany: (docs: Omit<T, 'company_id'>[]) =>
      col().insertMany(docs.map((d) => ({ ...d, company_id: companyId })) as never),
    count: (f?: Filter<T>) => col().countDocuments(scope(f)),
    deleteMany: (f?: Filter<T>) => col().deleteMany(scope(f)),
  };
}
