import { useState, type FormEvent } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { ExportButton, useFmt } from './shared';
import './pilotage.css';

interface DossierItem { obligationId: string; objectId: string; label: string; commune: string; status: string; amount: MoneyJSON; createdAt: string; payments: { orderId: string; paymentReference: string; status: string }[] }
interface TrailEvent { at: string; source: string; kind: string; label: string; resourceType: string; resourceId: string | null; actor?: { kind: string; id: string; roles?: string[] }; outcome?: string; details: Record<string, unknown>; hash?: string; seq?: number }
interface Trail {
  dossier: { ref: string; kind: string; id: string }; generatedAt: string; complete: boolean; note: string;
  graph: { objectIds: string[]; obligationIds: string[]; orderIds: string[]; paymentReferences: string[]; receiptNumbers: string[]; ledgerEntryIds: string[]; appealIds: string[] };
  controls: { code: string; label: string; passed: boolean; detail: string }[];
  events: TrailEvent[];
}

const SOURCES: Record<string, string> = { AUDIT: 'Journal d’audit', GRAND_LIVRE: 'Grand livre', QUITTANCE: 'Quittances', RECLAMATION: 'Réclamations', DELIVRANCE: 'Délivrances' };

/** Explorateur de piste d'audit par dossier (auditeurs, enquêteurs) : chronologie fusionnée et contrôles « sans trou ». */
export default function PisteAudit() {
  const { user, fmtDate } = useApp();
  const f = useFmt();
  const list = useApi(() => api<{ items: DossierItem[] }>('/v1/pilotage/piste-audit'), [user?.id]);
  const [ref, setRef] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const trail = useApi<Trail>(ref ? () => api<Trail>(`/v1/pilotage/piste-audit/${encodeURIComponent(ref)}`) : null, [ref, user?.id]);
  const submit = (e: FormEvent) => { e.preventDefault(); if (input.trim()) setRef(input.trim()); };
  const toggle = (s: string) => setHidden((h) => { const n = new Set(h); if (n.has(s)) n.delete(s); else n.add(s); return n; });

  const head = <PageHead eyebrow="Audit · C3-123" title="Piste d’audit par dossier" lead="Chronologie complète d’un objet, d’une obligation ou d’un paiement : événements chaînés, écritures, quittances, réclamations et notifications — avec contrôle d’absence de trou." />;
  if (list.error) return <div className="page page-wide">{head}<ErrorState error={list.error} onRetry={list.reload} /></div>;
  const t = trail.data;
  const events = t ? t.events.filter((e) => !hidden.has(e.source)) : [];

  return (
    <div className="page page-wide">
      {head}
      <div className="pl-layout">
        <aside className="stack-sm" aria-label="Dossiers">
          <form className="pl-search" onSubmit={submit} role="search">
            <label className="sr-only" htmlFor="pl-ref">Référence du dossier</label>
            <input id="pl-ref" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Obligation, référence PR-…, objet, quittance" autoComplete="off" />
            <button type="submit" className="btn btn-primary"><Icon name="history" size={18} /> Ouvrir</button>
          </form>
          <p className="small muted">Dossiers récents</p>
          {list.loading ? <Loading /> : (
            <div className="pl-dossiers">
              {(list.data?.items ?? []).map((d) => (
                <button key={d.obligationId} type="button" className="pl-dossier" aria-pressed={ref === d.obligationId} onClick={() => { setRef(d.obligationId); setInput(d.obligationId); }}>
                  <span className="pl-code">{d.obligationId}</span>
                  <span className="small">{d.commune === 'NON_ATTRIBUE' ? 'Lieu non établi' : d.commune} · {f.money(d.amount)} · {d.status}</span>
                  {d.payments.length > 0 && <span className="small muted">{d.payments.map((p) => `${p.paymentReference} (${p.status})`).join(', ')}</span>}
                </button>
              ))}
            </div>
          )}
        </aside>
        <div className="stack-sm min0">
          {!ref ? <EmptyState title="Choisissez un dossier" icon="history">La consultation est journalisée dans le journal d’audit.</EmptyState>
            : trail.loading ? <Loading /> : trail.error ? <ErrorState error={trail.error} onRetry={trail.reload} /> : t && (
              <>
                <section className="panel">
                  <header className="panel-head">
                    <div>
                      <h2 className="panel-title">{t.dossier.kind === 'objet' ? 'Objet fiscal' : t.dossier.kind === 'obligation' ? 'Obligation' : 'Paiement'} {t.dossier.id}</h2>
                      <p className="panel-sub">{t.events.length} événement(s) · généré le {fmtDate(t.generatedAt, true)}</p>
                    </div>
                    <div className="panel-tools">
                      <StatusBadge tone={t.complete ? 'good' : 'critical'} label={t.complete ? 'Chaîne complète' : 'Trou détecté'} />
                      <ExportButton kind="piste-audit" params={{ ref: t.dossier.ref }} label="Extraction signée" />
                    </div>
                  </header>
                  <ul className="pl-checks">
                    {t.controls.map((c) => (
                      <li key={c.code}><StatusBadge tone={c.passed ? 'good' : 'critical'} label={c.passed ? 'OK' : 'KO'} /><div className="min0"><p className="row-title">{c.label}</p><p className="small muted">{c.detail}</p></div></li>
                    ))}
                  </ul>
                  <p className="small muted">
                    Obligations : {t.graph.obligationIds.join(', ') || '—'} · Paiements : {t.graph.paymentReferences.join(', ') || '—'} · Quittances : {t.graph.receiptNumbers.join(', ') || '—'} · Écritures : {t.graph.ledgerEntryIds.length}
                  </p>
                </section>
                <section className="panel">
                  <header className="panel-head">
                    <div><h2 className="panel-title">Chronologie</h2><p className="panel-sub">{t.note}</p></div>
                  </header>
                  <div className="pl-src-filter" role="group" aria-label="Sources affichées">
                    {Object.entries(SOURCES).map(([k, l]) => (
                      <button key={k} type="button" className="btn btn-ghost btn-sm" aria-pressed={!hidden.has(k)} onClick={() => toggle(k)}>
                        <span className={`pl-dot s-${k}`} aria-hidden="true" /> {l} ({t.events.filter((e) => e.source === k).length})
                      </button>
                    ))}
                  </div>
                  <ol className="pl-trail">
                    {events.map((e, i) => (
                      <li key={`${e.source}-${e.resourceId}-${e.seq ?? i}-${e.kind}`}>
                        <span className={`pl-dot s-${e.source}`} aria-hidden="true" />
                        <div className="min0">
                          <p className="row-title">{e.label}</p>
                          <div className="pl-trail-meta">
                            <span>{fmtDate(e.at, true)}</span>
                            <span>{SOURCES[e.source]}</span>
                            {e.actor && <span>{e.actor.kind === 'user' ? `Agent ${e.actor.id}` : `${e.actor.kind} ${e.actor.id}`}{e.actor.roles?.length ? ` (${e.actor.roles.join(', ')})` : ''}</span>}
                            {e.outcome && e.outcome !== 'SUCCESS' && <StatusBadge tone="warning" label={e.outcome} />}
                            {e.resourceId && <code>{e.resourceType}:{e.resourceId}</code>}
                            {e.hash && <code title={e.hash}>#{e.hash.slice(0, 10)}</code>}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}
        </div>
      </div>
    </div>
  );
}
