import { tdb } from '../lib/tenant.js';
import { enqueueWebhook } from './webhooks.js';

const GSM7 = /^[\n\r !"#$%&'()*+,\-./0-9:;<=>?@A-Za-z¡£¤¥§¿ÄÅÆÇÉÑÖØÜßàäåæèéìñòöøùü_ΔΦΓΛΩΠΨΣΘΞ€\\^{}\[~\]|]*$/;

/** GSM-7: 160 single / 153 per concatenated segment. Anything else is UCS-2: 70 / 67. */
export function segmentsFor(body: string) {
  const gsm = GSM7.test(body);
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  const len = [...body].length;
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', segments: len <= single ? 1 : Math.ceil(len / multi) };
}

export const E164 = /^\+[1-9]\d{7,14}$/;

export async function sendSms(companyId: number, apiKeyId: number | null, p: { to: string; body: string; from?: string }) {
  const db = tdb(companyId);
  const from = p.from ?? (await db.one<{ caller_id: string }>('SELECT caller_id FROM campaigns WHERE company_id=? ORDER BY id LIMIT 1', [companyId]))?.caller_id ?? '+912240000000';
  const { segments, encoding } = segmentsFor(p.body);
  const res = await db.exec(
    "INSERT INTO sms_messages (company_id, api_key_id, direction, from_number, to_number, body, segments, status) VALUES (?,?,'outbound',?,?,?,?,'queued')",
    [companyId, apiKeyId, from, p.to, p.body, segments],
  );
  const id = res.insertId;
  // Simulated carrier: queued -> sent -> delivered|failed
  setTimeout(async () => {
    try {
      await db.exec("UPDATE sms_messages SET status='sent' WHERE company_id=? AND id=?", [companyId, id]);
      setTimeout(async () => {
        const ok = Math.random() > 0.08;
        await db.exec('UPDATE sms_messages SET status=?, error=? WHERE company_id=? AND id=?', [ok ? 'delivered' : 'failed', ok ? null : 'Carrier rejected (DND registry)', companyId, id]);
        await enqueueWebhook(companyId, ok ? 'sms.delivered' : 'sms.failed', { sms_id: id, to: p.to, status: ok ? 'delivered' : 'failed' });
      }, 1000 + Math.random() * 2500);
    } catch (e) { console.error('[sms]', e); }
  }, 700 + Math.random() * 1200);
  return { id, from, to: p.to, segments, encoding, status: 'queued' as const };
}
