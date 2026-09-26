/**
 * Attestation de bail enregistré (bailleur ou locataire) : délivrée avec QR vérifiable après enregistrement du
 * bail ; la vérification publique n'affiche ni nom ni loyer. Valeur juridique [À VÉRIFIER — J7].
 */
import { useState } from 'react';
import { formatMoney } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { DemoNote, FiscalTabs, PERIODICITY, PROBATIVE, useViewer, VerifyQr } from './common';
import type { LeaseAttestationView, LeaseRow } from './types';
import './fiscal.css';

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
        <p className="small muted">{a.legalNote}</p>
      </div>
      <VerifyQr path={a.verifyPath} code={a.shortCodeDisplay} caption={a.number} size={112} />
    </div>
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
              <StatusBadge tone={PROBATIVE[l.probativeStatus]?.tone ?? 'neutral'} label={PROBATIVE[l.probativeStatus]?.label ?? l.probativeStatus} />
            </div>
            {l.attestation ? <Attestation a={l.attestation} /> : (
              <button type="button" className="btn btn-primary" onClick={() => void issue(l.id)}><Icon name="ticket" size={16} /> Obtenir l’attestation</button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
