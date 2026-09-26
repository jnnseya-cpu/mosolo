import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { PageHead } from '../components/Shell';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { ErrorState, Loading } from '../components/States';
import { Icon } from '../components/Icon';
import { api, asList } from '../lib/api';
import type { AuditEvent, AuditVerify } from '../lib/types';

type Ev = AuditEvent & { resourceType?: string; resourceId?: string; outcome?: string; actor?: string | { id?: string; kind?: string } };

export default function Audit() {
  const { tr, fmtDate, user } = useApp();
  const v = useApi(() => api<AuditVerify>('/v1/audit/verify'), [user?.id]);
  const ev = useApi(async () => asList<Ev>(await api<unknown>('/v1/audit/events'), 'events', 'records'), [user?.id]);
  const events = (ev.data ?? []).slice().reverse();
  const actor = (e: Ev) => (typeof e.actor === 'string' ? e.actor : e.actor?.id ?? '—');
  return (
    <div className="page page-wide">
      <PageHead eyebrow={tr('audit.eyebrow')} title={tr('audit.title')} lead={tr('audit.lead')}>
        <button type="button" className="btn btn-secondary" onClick={() => { v.reload(); ev.reload(); }}><Icon name="refresh" size={18} /> {tr('audit.reverify')}</button>
      </PageHead>
      <section className="panel" aria-labelledby="chain-state">
        <h2 id="chain-state" className="panel-title">{tr('audit.chain')}</h2>
        {v.loading && <Loading />}
        {v.error !== null && <ErrorState error={v.error} onRetry={v.reload} />}
        {v.data && (
          <div className={`chain-verdict ${v.data.ok ? 'ok' : 'broken'}`} role="status">
            <Icon name={v.data.ok ? 'shieldCheck' : 'alert'} size={36} />
            <div>
              <p className="verdict-title">{v.data.ok ? tr('audit.ok', { n: v.data.length }) : tr('audit.broken', { n: v.data.brokenAt ?? '?' })}</p>
              <p className="small muted">
                {v.data.reason ? `${v.data.reason} · ` : ''}{v.data.headHash ? `${tr('treasury.head')} ${v.data.headHash.slice(0, 16)}… · ` : ''}{v.data.verifiedAt ? fmtDate(v.data.verifiedAt, true) : ''}
              </p>
            </div>
            <StatusBadge tone={v.data.ok ? 'good' : 'critical'} label={v.data.ok ? tr('audit.intact') : tr('audit.altered')} />
          </div>
        )}
      </section>
      <section className="section" aria-labelledby="ev-title">
        <div className="section-head"><h2 id="ev-title">{tr('audit.events')}</h2>{ev.data && <span className="count">{ev.data.length}</span>}</div>
        {ev.loading && <Loading />}
        {ev.error !== null && <ErrorState error={ev.error} onRetry={ev.reload} />}
        {ev.data && (
          <DataTable rows={events.slice(0, 200)} rowKey={(e) => String(e.seq ?? e.id ?? e.hash)} caption={tr('audit.events')}
            columns={[
              { key: 'seq', label: '#', num: true, render: (e) => <span className="mono">{e.seq ?? '—'}</span> },
              { key: 'at', label: tr('audit.at'), render: (e) => fmtDate(e.at ?? e.timestamp, true) },
              { key: 'actor', label: tr('audit.actor'), render: (e) => <span className="mono small">{actor(e)}</span> },
              { key: 'action', label: tr('audit.action'), primary: true, render: (e) => <span className="mono">{e.action ?? e.type}</span> },
              { key: 'res', label: tr('audit.resource'), render: (e) => <span className="small">{[e.resourceType, e.resourceId ?? e.subject].filter(Boolean).join(' · ') || '—'}</span> },
              { key: 'hash', label: tr('audit.hash'), render: (e) => <span className="mono small hash">{e.hash ? `${e.hash.slice(0, 12)}…` : '—'}</span> },
            ]} />
        )}
      </section>
    </div>
  );
}
