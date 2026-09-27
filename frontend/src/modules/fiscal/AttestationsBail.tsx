/**
 * Attestation de bail enregistré (bailleur ou locataire) : délivrée avec QR vérifiable après enregistrement du
 * bail ; la vérification publique n'affiche ni nom ni loyer. Valeur juridique [À VÉRIFIER — J7].
 */
import { useState } from 'react';
import { formatMoney } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { DemoNote, FiscalTabs, PERIODICITY, PROBATIVE, ReasonAction, useViewer, VerifyQr } from './common';
import type { LeaseAttestationView, LeaseRow } from './types';
import './fiscal.css';
import { BauxVisuels } from './visuels';

function Attestation({ a }: { a: LeaseAttestationView }) {
  const { fmtDate } = useApp();
  return (
    <div className="fs-quitus-doc fs-att">
      <div className="min0">
        <p className="eyebrow">Attestation de bail enregistré — {a.issuedToRole === 'LOCATAIRE' ? 'exemplaire du locataire' : 'exemplaire du bailleur'}</p>
        <h3 className="fs-igf mono">{a.number}</h3>
        <dl className="kv kv-dense">
          <div><dt>Unité</dt><dd>{a.lease.unitLabel} <span className="mono">{a.lease.unitIgf}</span> — {a.lease.commune} › {a.lease.quartier}</dd></div>
          <div><dt>Bailleur</dt><dd>{a.lease.lessor}</dd></div>
          <div><dt>Locataire</dt><dd>{a.lease.lessee}</dd></div>
          <div><dt>Loyer déclaré</dt><dd>{formatMoney(a.lease.rent)} ({PERIODICITY[a.lease.periodicity] ?? a.lease.periodicity})</dd></div>
          <div><dt>Période</dt><dd>depuis le {fmtDate(a.lease.start)}{a.lease.end ? ` jusqu’au ${fmtDate(a.lease.end)}` : ''}</dd></div>
          <div><dt>Délivrée le</dt><dd>{fmtDate(a.issuedAt, true)}</dd></div>
        </dl>
        <ValidityCountdown from={a.lease.start} until={a.lease.end} blocked={a.status !== 'VALIDE' ? 'Attestation révoquée' : null} label="Période du bail" />
        <p className="small muted">{a.legalNote}</p>
      </div>
      <VerifyQr path={a.verifyPath} code={a.shortCodeDisplay} caption={a.number} size={112} />
    </div>
  );
}

/** Résiliation du bail par une partie (§ 30 : déclaré, vérifié, résilié, contesté) : date d'effet et motif, jamais supprimé. */
export function LeaseTermination({ l, onDone }: { l: LeaseRow; onDone: () => void }) {
  const { fmtDate } = useApp();
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  if (l.termination) return <p className="small">Bail résilié au {fmtDate(l.termination.endDate)} ({l.termination.byRole === 'BAILLEUR' ? 'par le bailleur' : l.termination.byRole === 'LOCATAIRE' ? 'par le locataire' : 'par un mandataire'}) — {l.termination.reason}</p>;
  return (
    <ReasonAction label="Résilier le bail" confirmLabel="Enregistrer la résiliation" tone="secondary" minLength={5}
      onSubmit={async (reason) => { await api(`/v1/fiscal/leases/${encodeURIComponent(l.id)}/resiliation`, { method: 'POST', body: { endDate, reason } }); onDone(); }}>
      <label className="label" htmlFor={`rs-date-${l.id}`}>Date d’effet de la résiliation</label>
      <input id={`rs-date-${l.id}`} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
    </ReasonAction>
  );
}

export default function AttestationsBail() {
  const { user } = useApp();
  const { isTaxpayer } = useViewer();
  const q = useApi(isTaxpayer ? () => api<LeaseRow[]>('/v1/fiscal/leases') : null, [user?.id]);
  const [err, setErr] = useState<string | null>(null);
  async function issue(id: string) {
    setErr(null);
    try { await api(`/v1/fiscal/leases/${encodeURIComponent(id)}/attestations`, { method: 'POST' }); q.reload(); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Démarches fiscales" title="Attestations de bail"
        lead="Après enregistrement d’un bail, le bailleur et le locataire peuvent obtenir une attestation vérifiable par QR. La vérification publique confirme l’enregistrement sans révéler ni les noms ni le loyer." />
      <FiscalTabs />
      <DemoNote />
      {isTaxpayer && q.data && <BauxVisuels baux={q.data} />}
      {!isTaxpayer && <EmptyState title="Réservé au bailleur, au locataire ou à leur mandataire." icon="lock" />}
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {isTaxpayer && q.data && q.data.length === 0 && <EmptyState title="Aucun bail enregistré à votre nom." />}
      <div className="fs-grid">
        {(q.data ?? []).map((l) => (
          <article key={l.id} className="panel">
            <div className="panel-head">
              <div><p className="panel-title">Bail <span className="mono">{l.id}</span></p><p className="panel-sub">Vous êtes {l.role === 'BAILLEUR' ? 'bailleur' : 'locataire'} · <span className="mono">{l.unitIgf}</span></p></div>
              <StatusBadge tone={l.state === 'RESILIE' ? 'neutral' : PROBATIVE[l.probativeStatus]?.tone ?? 'neutral'} label={l.state === 'RESILIE' ? (l.stateLabel ?? 'Résilié') : PROBATIVE[l.probativeStatus]?.label ?? l.probativeStatus} />
            </div>
            <LeaseTermination l={l} onDone={q.reload} />
            {l.attestation ? <Attestation a={l.attestation} /> : (
              <button type="button" className="btn btn-primary" onClick={() => void issue(l.id)}><Icon name="ticket" size={16} /> Obtenir l’attestation</button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
