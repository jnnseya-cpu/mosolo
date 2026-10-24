/**
 * Régie de la publicité (R06/R07) — KIN PUB CONTROL : instruction des demandes d'autorisation (complément,
 * proposition), décision motivée par une personne distincte, décisions sur les dossiers de constat vérifiés,
 * accréditation et révocation des inspecteurs.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { ErrorLine, hasRole, Money, ReasonForm, useAction } from '../parking/shared';
import { AD_TYPE, CASE_STATUS, FINDING, PIECE, REQUEST_STATUS, type AuthRequest, type Case } from './types';
import '../parking/parking.css';
import { RegieVisuels } from './visuels';

type Tab = 'requests' | 'cases' | 'accreditations';

export default function AdRegie() {
  const { user } = useApp();
  const [tab, setTab] = useState<Tab>('requests');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  if (!hasRole(user?.roles, 'R06', 'R07')) {
    return (
      <div className="page">
        <PageHead eyebrow="KIN PUB CONTROL" title="Régie de la publicité" />
        <EmptyState title="Écran réservé à la régie" icon="lock">Choisissez « Instructeur des autorisations publicitaires » ou « Autorité de décision publicité » dans l’en-tête.</EmptyState>
      </div>
    );
  }
  return (
    <div className="page page-wide">
      <PageHead eyebrow="KIN PUB CONTROL · régie DGTK" title="Autorisations et décisions"
        lead="Instruction et décision sont confiées à deux personnes distinctes. La liquidation applique la règle publiée au registre ; sans règle active, aucun montant n’est exigible.">
        <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      <RegieVisuels tick={tick} />
      <div className="seg seg-wrap pk-tabs" role="tablist" aria-label="Rubriques">
        {([['requests', 'Demandes d’autorisation'], ['cases', 'Dossiers de constat'], ['accreditations', 'Accréditations']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-pressed={tab === k} aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'requests' && <PendingLiquidations tick={tick} onChange={refresh} />}
      {tab === 'requests' && <Requests tick={tick} onChange={refresh} />}
      {tab === 'cases' && <Cases tick={tick} onChange={refresh} />}
      {tab === 'accreditations' && <Accreditations tick={tick} onChange={refresh} />}
    </div>
  );
}

/**
 * Autorisations accordées sous « acte requis » dont le barème est désormais actif : droits à liquider en quatre yeux
 * (proposition par un instructeur, approbation par une autre personne habilitée).
 */
function PendingLiquidations({ tick, onChange }: { tick: number; onChange: () => void }) {
  const { fmtDate, user } = useApp();
  const list = useApi(() => api<{ items: AuthRequest[] }>('/v1/publicite/liquidations/pending').then((r) => r.items), [tick, user?.id]);
  if (list.loading && !list.data) return null;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  const items = list.data ?? [];
  if (items.length === 0) return null;
  const canPropose = hasRole(user?.roles, 'R07');
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="scale" size={18} /> Liquidations en attente</h2><p className="panel-sub">Autorisations accordées avant la publication du barème, désormais actif. Proposition et approbation : deux personnes distinctes.</p></div></header>
      <div className="pk-cards pk-cards-2">
        {items.map((r) => (
          <article key={r.id} className="pk-card">
            <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{r.reference}</p><p className="pk-sub">{r.device ? `${r.device.reference} · ${AD_TYPE[r.device.type]} · ${r.device.surfaceM2.replace('.', ',')} m² × ${r.device.faces} · ${r.device.commune}` : ''}</p></div>
              <StatusBadge tone={r.liquidationProposal ? 'warning' : 'neutral'} label={r.liquidationProposal ? 'Proposée' : 'À proposer'} /></div>
            {r.liquidation?.note && <p className="small muted">{r.liquidation.note}</p>}
            {r.liquidationProposal ? (
              <>
                <p className="small"><strong>Proposition ({r.liquidationProposal.by}, {fmtDate(r.liquidationProposal.at, true)}) :</strong> {r.liquidationProposal.note} — règle {r.liquidationProposal.ruleCode} v{r.liquidationProposal.ruleVersion}</p>
                {r.liquidationProposal.by === user?.id ? <p className="small muted">Vous avez proposé cette liquidation : l’approbation revient à une autre personne.</p> : (
                  <ReasonForm confirmLabel="Approuver la liquidation" placeholder="Motif de l’approbation" onSubmit={(reason) => api(`/v1/publicite/authorizations/${r.id}/liquidation/approve`, { method: 'POST', body: { reason } }).then(onChange)} />
                )}
              </>
            ) : canPropose ? (
              <ReasonForm confirmLabel="Proposer la liquidation" placeholder="Note de proposition (base, période)" onSubmit={(note) => api(`/v1/publicite/authorizations/${r.id}/liquidation/propose`, { method: 'POST', body: { note } }).then(onChange)} />
            ) : <p className="small muted">En attente de proposition par un instructeur.</p>}
          </article>
        ))}
      </div>
    </section>
  );
}

function Requests({ tick, onChange }: { tick: number; onChange: () => void }) {
  const { fmtDate, user } = useApp();
  const list = useApi(() => api<{ items: AuthRequest[] }>('/v1/publicite/authorizations').then((r) => r.items), [tick, user?.id]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  const items = list.data ?? [];
  const open = items.filter((r) => ['DEPOSEE', 'PROPOSEE', 'COMPLEMENT_DEMANDE'].includes(r.status));
  const closed = items.filter((r) => !open.includes(r));
  const canInstruct = hasRole(user?.roles, 'R07');
  return (
    <div className="stack">
      {open.length === 0 ? <EmptyState title="Aucune demande en cours" icon="check" /> : (
        <div className="pk-cards pk-cards-2">
          {open.map((r) => (
            <article key={r.id} className="pk-card">
              <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{r.reference}</p><p className="pk-sub">{r.device ? `${r.device.reference} · ${AD_TYPE[r.device.type]} · ${r.device.surfaceM2.replace('.', ',')} m² × ${r.device.faces} · ${r.device.commune}` : ''}</p></div>
                <StatusBadge tone={REQUEST_STATUS[r.status].tone} label={REQUEST_STATUS[r.status].label} /></div>
              <p className="small">Période : {fmtDate(r.periodFrom)} → {fmtDate(r.periodTo)} · déposée le {fmtDate(r.submittedAt, true)}</p>
              <ul className="pk-hashes">{r.pieces.map((p, i) => <li key={p.sha256 + i}><Icon name="file" size={14} /> {PIECE[p.kind] ?? p.kind} — {p.name} <span className="mono muted">{p.sha256.slice(0, 12)}…</span></li>)}</ul>
              {r.instruction && <p className="small"><strong>Proposition ({r.instruction.by}) :</strong> {r.instruction.proposal === 'ACCORDER' ? 'accorder' : 'refuser'} — {r.instruction.analysis}</p>}
              {r.status === 'DEPOSEE' && canInstruct && (
                <div className="pk-grid pk-grid-even">
                  <ReasonForm confirmLabel="Proposer d’accorder" placeholder="Analyse d’instruction" onSubmit={(analysis) => api(`/v1/publicite/authorizations/${r.id}/instruct`, { method: 'POST', body: { action: 'PROPOSER', proposal: 'ACCORDER', analysis } }).then(onChange)} />
                  <ReasonForm confirmLabel="Demander un complément" danger placeholder="Pièce ou précision attendue" onSubmit={(analysis) => api(`/v1/publicite/authorizations/${r.id}/instruct`, { method: 'POST', body: { action: 'COMPLEMENT', analysis } }).then(onChange)} />
                </div>
              )}
              {r.status === 'DEPOSEE' && !canInstruct && <p className="small muted">En attente d’instruction par le chef de service.</p>}
              {r.status === 'PROPOSEE' && (
                r.instruction?.by === user?.id ? <p className="small muted">Vous avez instruit ce dossier : la décision revient à une autre personne.</p> : (
                  <div className="pk-grid pk-grid-even">
                    <ReasonForm confirmLabel="Accorder" onSubmit={(reason) => api(`/v1/publicite/authorizations/${r.id}/decide`, { method: 'POST', body: { outcome: 'ACCORDEE', reason } }).then(onChange)} />
                    <ReasonForm confirmLabel="Refuser" danger onSubmit={(reason) => api(`/v1/publicite/authorizations/${r.id}/decide`, { method: 'POST', body: { outcome: 'REFUSEE', reason } }).then(onChange)} />
                  </div>
                )
              )}
            </article>
          ))}
        </div>
      )}
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="history" size={18} /> Demandes traitées</h2></div></header>
        <ul className="list-rows">
          {closed.map((r) => (
            <li key={r.id} className="list-row">
              <div className="min0"><p className="pk-row-title">{r.reference} · {r.device?.reference}</p><p className="pk-sub">{r.decision?.reason} {r.liquidation ? `— ${r.liquidation.status === 'EMISE' ? 'avis émis' : r.liquidation.note}` : ''}</p></div>
              <div className="row-side">{r.obligation && <Money items={r.obligation.amount} />}<StatusBadge tone={REQUEST_STATUS[r.status].tone} label={REQUEST_STATUS[r.status].label} /></div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Cases({ tick, onChange }: { tick: number; onChange: () => void }) {
  const list = useApi(() => api<{ items: Case[] }>('/v1/publicite/cases').then((r) => r.items), [tick]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  const pending = (list.data ?? []).filter((c) => c.status === 'VERIFIE');
  const others = (list.data ?? []).filter((c) => c.status !== 'VERIFIE');
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="scale" size={18} /><p className="small">La décision n’émet aucune pénalité : aucun barème de pénalité n’est publié. Elle peut rattacher l’exploitant identifié, constater un retrait et, si vous le demandez, liquider les droits dus selon la règle publiée. L’exploitant est notifié (référence, preuves, démarches, délais, voies de contestation, paiement officiel).</p></div>
      {pending.length === 0 ? <EmptyState title="Aucun dossier vérifié en attente" icon="check" /> : (
        <div className="pk-cards pk-cards-2">{pending.map((c) => <CaseDecision key={c.id} c={c} onChange={onChange} />)}</div>
      )}
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="history" size={18} /> Autres dossiers</h2></div></header>
        <ul className="list-rows">
          {others.map((c) => (
            <li key={c.id} className="list-row">
              <div className="min0"><p className="pk-row-title">{FINDING[c.finding]} · {c.device?.reference}</p><p className="pk-sub">{c.reference} · {c.decision ? `${c.decision.reason} — ${c.decision.effect}` : c.verification?.note ?? 'en attente de vérification'}</p></div>
              <div className="row-side">{c.contests.length > 0 && <StatusBadge tone="warning" label={`${c.contests.length} contestation(s)`} />}<StatusBadge tone={CASE_STATUS[c.status].tone} label={CASE_STATUS[c.status].label} /></div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CaseDecision({ c, onChange }: { c: Case; onChange: () => void }) {
  const [owner, setOwner] = useState('');
  // Décision explicite sur les droits (jamais laissée au défaut du serveur) : cochée d'office pour un support non
  // déclaré dont l'exploitant est identifié.
  const [liquidate, setLiquidate] = useState(c.finding === 'NON_DECLARE' && !!c.device?.ownerIdentified);
  const liquidateDues = c.finding !== 'RETIRE' && liquidate;
  return (
    <article className="pk-card">
      <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{FINDING[c.finding]} · {c.device?.reference}</p><p className="pk-sub">{c.reference} · {c.device?.address} ({c.commune})</p></div>
        <StatusBadge tone={CASE_STATUS[c.status].tone} label={CASE_STATUS[c.status].label} /></div>
      <p className="pk-steps"><span className="on">Constat <b>{c.inspection?.inspectorId}</b></span><span className="on">Vérification <b>{c.verification?.by}</b></span><span>Décision : vous</span></p>
      {c.inspection && <div className="pk-evidence"><span><Icon name="camera" size={14} /> {c.inspection.photos.length} photo(s) scellée(s)</span><span>{c.inspection.observations}</span>{c.inspection.presumedOperator && <span>Exploitant présumé : {c.inspection.presumedOperator}</span>}</div>}
      {c.contests.length > 0 && <div className="pk-evidence"><strong>Observations de l’exploitant</strong>{c.contests.map((x) => <span key={x.id}>« {x.grounds} »</span>)}</div>}
      <ReasonForm confirmLabel="Retenir le constat"
        onSubmit={(reason) => api(`/v1/publicite/cases/${c.id}/decide`, { method: 'POST', body: { outcome: 'RETENU', reason, ...(owner.trim() ? { ownerTaxpayerId: owner.trim() } : {}), liquidateDues } }).then(onChange)}>
        {!c.device?.ownerIdentified && <label className="field"><span className="label">Identifiant de l’exploitant (si identifié)</span><input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="ex. TP-PUB-0001 (fictif)" /></label>}
        {c.finding !== 'RETIRE' && <label className="check"><input type="checkbox" checked={liquidate} onChange={(e) => setLiquidate(e.target.checked)} /> Liquider les droits dus selon la règle publiée</label>}
      </ReasonForm>
      <ReasonForm confirmLabel="Classer sans suite" danger onSubmit={(reason) => api(`/v1/publicite/cases/${c.id}/decide`, { method: 'POST', body: { outcome: 'CLASSE', reason, liquidateDues: false } }).then(onChange)} />
    </article>
  );
}

interface Accreditation { id: string; userId: string; name: string; communes: string[]; validFrom: string; validUntil: string; status: string; valid: boolean; revocation?: { reason: string } }

function Accreditations({ tick, onChange }: { tick: number; onChange: () => void }) {
  const { fmtDate } = useApp();
  const list = useApi(() => api<{ items: Accreditation[] }>('/v1/publicite/accreditations').then((r) => r.items), [tick]);
  const [f, setF] = useState({ userId: 'pb-inspecteur-2', communes: 'Gombe', validFrom: new Date().toISOString().slice(0, 10), validUntil: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10) });
  const act = useAction();
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  return (
    <div className="pk-grid pk-grid-2">
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="shieldCheck" size={18} /> Inspecteurs accrédités</h2><p className="panel-sub">Badge vérifiable publiquement par les exploitants. Révocation immédiate, motivée.</p></div></header>
        <div className="pk-cards">
          {(list.data ?? []).map((a) => (
            <article key={a.id} className="pk-card">
              <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{a.name}</p><p className="pk-sub">{a.userId} · {a.communes.join(', ')} · du {fmtDate(a.validFrom)} au {fmtDate(a.validUntil)}</p><ValidityCountdown compact from={a.validFrom} until={a.validUntil} blocked={a.status === 'REVOQUEE' ? 'Révoquée' : null} /></div>
                <StatusBadge tone={a.valid ? 'good' : 'critical'} label={a.valid ? 'Valide' : a.status === 'REVOQUEE' ? 'Révoquée' : 'Hors validité'} /></div>
              {a.revocation && <p className="small muted">Motif : {a.revocation.reason}</p>}
              {a.status === 'ACTIVE' && <ReasonForm confirmLabel="Révoquer" danger placeholder="Motif de révocation" onSubmit={(reason) => api(`/v1/publicite/accreditations/${encodeURIComponent(a.userId)}/revoke`, { method: 'POST', body: { reason } }).then(onChange)} />}
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title">Accréditer un contrôleur</h2><p className="panel-sub">Après formation ; seul un contrôleur (R11) peut être accrédité.</p></div></header>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(() => api('/v1/publicite/accreditations', { method: 'POST', body: { userId: f.userId.trim(), communes: f.communes.split(',').map((s) => s.trim()).filter(Boolean), validFrom: f.validFrom, validUntil: f.validUntil } }), onChange); }}>
          <label className="field"><span className="label">Identifiant de l’agent</span><input value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} /></label>
          <label className="field"><span className="label">Communes (séparées par des virgules)</span><input value={f.communes} onChange={(e) => setF({ ...f, communes: e.target.value })} /></label>
          <div className="field-row">
            <label className="field"><span className="label">Du</span><input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></label>
            <label className="field"><span className="label">Au</span><input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></label>
          </div>
          <ErrorLine error={act.error} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={act.busy}>Accréditer</button>
        </form>
      </section>
    </div>
  );
}
