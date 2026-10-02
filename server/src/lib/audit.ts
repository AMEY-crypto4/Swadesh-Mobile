import { mcol } from '../db/mongo.js';

export interface AuditDoc {
  ts: Date;
  actor: string;
  action: string;
  target?: string;
  details?: Record<string, unknown>;
}

export async function audit(companyId: number, actor: string, action: string, target?: string, details?: Record<string, unknown>) {
  await mcol<AuditDoc & { company_id: number }>('audit_log', companyId).insertOne({ ts: new Date(), actor, action, target, details });
}
