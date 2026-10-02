import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Card, Empty, ErrorBanner, PageHeader, Spinner, Table } from '../../components/ui';

export function Audit() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api<{ ts: string; actor: string; action: string; target?: string; details?: Record<string, unknown> }[]>('/audit') });
  return (
    <>
      <PageHeader title="Audit log" subtitle="Security- and privacy-relevant actions in your company, stored in MongoDB (latest 100)" />
      {q.isLoading && <Spinner />}<ErrorBanner error={q.error} />
      <Card>
        <Table>
          <thead><tr><th className="th">When</th><th className="th">Actor</th><th className="th">Action</th><th className="th">Target</th><th className="th">Details</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {q.data?.map((a, i) => <tr key={i}><td className="td whitespace-nowrap">{fmtDateTime(a.ts)}</td><td className="td">{a.actor}</td><td className="td font-mono text-xs">{a.action}</td><td className="td">{a.target ?? '—'}</td><td className="td max-w-xs truncate font-mono text-xs text-slate-500" title={a.details ? JSON.stringify(a.details) : ''}>{a.details ? JSON.stringify(a.details) : ''}</td></tr>)}
          </tbody>
        </Table>
        {q.data?.length === 0 && <Empty>No audit entries yet.</Empty>}
      </Card>
    </>
  );
}
