// /alerting/open?name=&host=&at= : where links in Slack / Teams / email land. Finds the alert episode by name, host
// and start time (Alertmanager does not know ObservaOne's ids) and opens its details; otherwise the alert list.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { StateView } from '@/components/ui';

export default function AlertOpen() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [missing, setMissing] = useState('');
  useEffect(() => {
    const name = params.get('name') || '';
    const query = { name, host: params.get('host') || '', at: params.get('at') || '' };
    api<{ id: number }>('/alerts/find', { query })
      .then((r) => navigate(`/alerting/alert/${r.id}`, { replace: true }))
      .catch((e) => {
        setMissing((e as Error).message);
        setTimeout(() => navigate(`/alerting?tab=all&q=${encodeURIComponent(name)}`, { replace: true }), 1500);
      });
  }, [params, navigate]);
  return <StateView kind={missing ? 'empty' : 'loading'} title={missing ? 'Alert not found: opening the alert list' : 'Opening the alert…'} text={missing || undefined} />;
}
