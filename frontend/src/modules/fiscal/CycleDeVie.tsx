/**
 * Cycle de vie d'un objet fiscal (Document maître FR 2, nouvelle version, § 30 et § 17.3) : provisoire, actif,
 * suspendu (litige de limites, contestation, habitat informel à qualifier), clos (démolition, cessation, doublon,
 * fusion). Suspension et levée motivées ; clôture proposée puis approuvée par une seconde personne. Aucune nouvelle
 * liquidation sur un objet suspendu ou clos ; l'objet et son identifiant ne sont jamais supprimés ni réattribués.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { ReasonAction } from './common';
import type { ObjectLifecycle } from './types';

export const LIFECYCLE_TONE: Record<ObjectLifecycle['state'], Tone> = { PROVISOIRE: 'neutral', ACTIF: 'good', SUSPENDU: 'warning', CLOS: 'neutral' };
export const SUSPENSION_MOTIFS: { code: string; label: string }[] = [
  { code: 'LITIGE_LIMITES', label: 'Litige de limites — renvoi au service foncier' },
  { code: 'CONTESTATION_EXISTENCE', label: 'Existence ou consistance de l’objet contestée' },
  { code: 'HABITAT_INFORMEL_A_QUALIFIER', label: 'Habitat informel en attente de qualification juridique' },
  { code: 'AUTRE', label: 'Autre motif' },
];
export const CLOSURE_MOTIFS: { code: string; label: string }[] = [
  { code: 'DEMOLITION', label: 'Démolition ou disparition du bien' },
  { code: 'CESSATION_ACTIVITE', label: 'Cessation de l’activité' },
  { code: 'DOUBLON', label: 'Doublon d’un autre objet' },
  { code: 'FUSION_OBJETS', label: 'Fusion d’objets' },
  { code: 'AUTRE', label: 'Autre motif' },
];

export function LifecyclePanel({ objectId, lifecycle, canAct, canApprove, onDone }: {
  objectId: string; lifecycle: ObjectLifecycle; canAct: boolean; canApprove: boolean; onDone: () => void;
}) {
  const { fmtDate } = useApp();
  const [motif, setMotif] = useState('LITIGE_LIMITES');
  const [closeMotif, setCloseMotif] = useState('DEMOLITION');
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const url = (p: string) => `/v1/fiscal/objects/${encodeURIComponent(objectId)}/${p}`;
  const s = lifecycle.state;
  const pending = lifecycle.pendingClosureId;
  const decide = async (approve: boolean, reason: string) => {
    await api(`/v1/fiscal/object-closures/${encodeURIComponent(pending ?? '')}/decision`, { method: 'POST', body: { approve, reason } });
    onDone();
  };
  return (
    <section className="panel" aria-label="Cycle de vie de l’objet">
      <div className="panel-head">
        <div className="min0"><p className="panel-title">Cycle de vie</p><p className="panel-sub">Provisoire, actif, suspendu, clos — décisions motivées, historique conservé.</p></div>
        <StatusBadge tone={LIFECYCLE_TONE[s]} label={lifecycle.label} />
      </div>
      {lifecycle.since && <p className="small">Depuis le {fmtDate(lifecycle.since, true)} · motif {lifecycle.motif} — {lifecycle.reason}</p>}
      {!lifecycle.liquidationAllowed && <p className="small muted">Aucune nouvelle liquidation tant que cet état dure ; les obligations déjà émises ne sont pas modifiées d’office.</p>}
      {canAct && (s === 'ACTIF' || s === 'PROVISOIRE') && (
        <div className="btn-row">
          <ReasonAction label="Suspendre" confirmLabel="Suspendre l’objet" tone="secondary" minLength={10} onSubmit={async (reason) => { await api(url('suspension'), { method: 'POST', body: { motif, reason } }); onDone(); }}>
            <label className="label" htmlFor={`sm-${objectId}`}>Motif de suspension</label>
            <select id={`sm-${objectId}`} value={motif} onChange={(e) => setMotif(e.target.value)}>{SUSPENSION_MOTIFS.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}</select>
          </ReasonAction>
          {!pending && (
            <ReasonAction label="Proposer la clôture" confirmLabel="Proposer (seconde approbation requise)" tone="secondary" minLength={10} onSubmit={async (reason) => { await api(url('closure'), { method: 'POST', body: { motif: closeMotif, reason, effectiveDate } }); onDone(); }}>
              <label className="label" htmlFor={`cm-${objectId}`}>Motif de clôture</label>
              <select id={`cm-${objectId}`} value={closeMotif} onChange={(e) => setCloseMotif(e.target.value)}>{CLOSURE_MOTIFS.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}</select>
              <label className="label" htmlFor={`cd-${objectId}`}>Date d’effet</label>
              <input id={`cd-${objectId}`} type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
            </ReasonAction>
          )}
        </div>
      )}
      {canAct && s === 'SUSPENDU' && (
        <ReasonAction label="Lever la suspension" confirmLabel="Lever la suspension" minLength={3} onSubmit={async (reason) => { await api(url('reactivation'), { method: 'POST', body: { reason } }); onDone(); }} />
      )}
      {pending && (
        <div className="stack-sm">
          <p className="small">Clôture proposée <span className="mono">{pending}</span> : seconde approbation attendue (une autre personne que le proposant).</p>
          {canApprove && (
            <div className="btn-row">
              <ReasonAction label="Approuver la clôture" confirmLabel="Approuver" minLength={5} onSubmit={(reason) => decide(true, reason)} />
              <ReasonAction label="Rejeter" confirmLabel="Rejeter la proposition" tone="secondary" minLength={5} onSubmit={(reason) => decide(false, reason)} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
