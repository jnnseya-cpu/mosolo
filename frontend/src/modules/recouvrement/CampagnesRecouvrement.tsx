/**
 * Campagnes de RECOUVREMENT (spécification fonctionnelle, module 33 ; Cahier § 21.2) : segments (conforme, retard,
 * difficulté, litige, non-déclarant, fraude, grand débiteur), canaux (SMS, appel, visite d'information), séquence
 * J-15, J-3, J+1, J+15, J+30, phase de TEST comparée à un groupe témoin, mesure (taux de régularisation, coût par franc
 * récupéré), arrêt PROPOSÉ au coût disproportionné et décidé par une personne. Aucune contrainte : actions d'information seulement.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ReasonAction } from '../fiscal/common';

interface GroupMeasure { targets: number; regularised: number; regularisationRate: string | null; paying: number; gross: Record<string, string> }
interface Measure {
  at: string; test: GroupMeasure; control: GroupMeasure; generalised?: GroupMeasure; cost: Record<string, string>; costMeasured: boolean; gross: Record<string, string>;
  net: Record<string, string> | 'NON_MESURE'; costPerFranc: { byCurrency: Record<string, string | null>; cdfEquivalent: string | null; statut: string; detail: string };
  stopSignals: { code: string; detail: string }[];
}
export interface RecoveryCampaignView {
  id: string; code: string; label: string; entity: string; communes: string[]; segments: string[]; channels: string[]; status: string; createdBy: string;
  sequence: { code: string; offsetDays: number; action: string; channels: string[]; segments: string[]; label: string }[]; sequenceStatus: string;
  testSharePct: number; controlSharePct: number;
  targets: { ref: string; segment: string; group: string; dueDate: string; generalised?: boolean }[];
  excluded: { ref: string; segment: string; reason: string }[];
  contacts: { id: string; ref: string; step: string; channel: string; outcome: string; at: string }[];
  visits: { id: string; ref: string; step: string; status: string; outcome?: string }[];
  measures: Measure[];
  launch?: { proposedBy: string; approvedBy?: string }; generalisation?: { proposedBy: string; approvedBy?: string; reason: string };
  stopProposal?: { reasons: string[]; decision?: { stop: boolean; reason: string } }; stop?: { reason: string };
  summary: { targets: number; bySegment: Record<string, number>; byGroup: Record<string, number>; excluded: number; contacts: number; visitsToDo: number };
}

export const SEGMENT_LABEL: Record<string, string> = {
  CONFORME: 'Conforme', RETARD: 'Retard occasionnel', DIFFICULTE: 'Difficulté réelle', LITIGE: 'Erreur ou litige',
  NON_DECLARANT: 'Non-déclarant probable', FRAUDE: 'Fraude présumée', GRAND_DEBITEUR: 'Grand débiteur',
};
const CHANNEL_LABEL: Record<string, string> = { SMS: 'SMS', APPEL: 'Appel', VISITE_INFORMATION: 'Visite d’information' };
const STATUS: Record<string, { label: string; tone: Tone }> = {
  BROUILLON: { label: 'Brouillon', tone: 'neutral' }, SIMULEE: { label: 'Simulée', tone: 'info' }, LANCEMENT_PROPOSE: { label: 'Test proposé — seconde personne', tone: 'warning' },
  EN_TEST: { label: 'Phase de test', tone: 'info' }, GENERALISATION_PROPOSEE: { label: 'Généralisation proposée', tone: 'warning' }, GENERALISEE: { label: 'Généralisée', tone: 'good' },
  ARRETEE: { label: 'Arrêtée', tone: 'critical' }, CLOTUREE: { label: 'Clôturée', tone: 'neutral' },
};
const OUTCOME: Record<string, string> = { ENVOYE: 'envoyé', DEJA_FAIT_PARCOURS_STANDARD: 'déjà fait (parcours standard)', VISITE_A_FAIRE: 'visite à faire', ORIENTE_AGENT: 'orienté vers un agent habilité', DIFFERE_SANS_CONTACT_AMIABLE: 'différé : aucun contact amiable préalable' };
const totals = (t: Record<string, string>) => Object.entries(t).map(([c, v]) => `${v} ${c}`).join(' + ') || '0';

function MeasureView({ m }: { m: Measure }) {
  return (
    <div className="stack-sm" data-testid="campaign-measure">
      <p className="small">Taux de régularisation — test : <strong>{m.test.regularisationRate ?? 'non mesuré'}</strong> ({m.test.regularised}/{m.test.targets}) · témoin : <strong>{m.control.regularisationRate ?? 'non mesuré'}</strong> ({m.control.regularised}/{m.control.targets}){m.generalised ? ` · généralisation : ${m.generalised.regularisationRate ?? 'non mesuré'}` : ''}</p>
      <p className="small">Récupération brute : {totals(m.gross)} · coûts saisis : {m.costMeasured ? totals(m.cost) : 'aucun'} · net : {m.net === 'NON_MESURE' ? 'non mesuré' : totals(m.net)}</p>
      <p className="small">Coût par franc récupéré : <strong>{m.costPerFranc.cdfEquivalent ?? (Object.entries(m.costPerFranc.byCurrency).filter(([, v]) => v !== null).map(([c, v]) => `${v} (${c})`).join(', ') || 'non mesuré')}</strong> — {m.costPerFranc.detail}</p>
      {m.stopSignals.map((s) => <p key={s.detail} className="notice notice-warn small" role="note">{s.detail}</p>)}
    </div>
  );
}

function CostForm({ campaignId, currency, onDone }: { campaignId: string; currency: string; onDone: () => void }) {
  const [f, setF] = useState({ kind: 'SMS', quantity: '1', amount: '', currency, evidenceSha256: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      await api('/v1/recouvrement/couts', { method: 'POST', body: { campaignId, kind: f.kind, quantity: Number(f.quantity), amount: { amount: f.amount, currency: f.currency }, evidenceSha256: f.evidenceSha256.trim().toLowerCase(), note: f.note } });
      setF({ ...f, amount: '', evidenceSha256: '', note: '' }); onDone();
    } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <form className="stack-sm" onSubmit={(e) => void go(e)} aria-label="Saisir un coût de campagne">
      <div className="field-row">
        <div className="field"><label className="label" htmlFor={`ck-${campaignId}`}>Nature</label>
          <select id={`ck-${campaignId}`} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['SMS', 'APPEL', 'VISITE', 'HEURE_AGENT', 'DEPLACEMENT', 'AUTRE'].map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
        <div className="field"><label className="label" htmlFor={`cq-${campaignId}`}>Quantité</label><input id={`cq-${campaignId}`} inputMode="numeric" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor={`ca-${campaignId}`}>Montant ({f.currency})</label><input id={`ca-${campaignId}`} required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
      </div>
      <div className="field"><label className="label" htmlFor={`ch-${campaignId}`}>Empreinte SHA-256 de la pièce justificative</label><input id={`ch-${campaignId}`} required pattern="[0-9a-fA-F]{64}" value={f.evidenceSha256} onChange={(e) => setF({ ...f, evidenceSha256: e.target.value })} /></div>
      <div className="field"><label className="label" htmlFor={`cn-${campaignId}`}>Note</label><input id={`cn-${campaignId}`} required minLength={5} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-secondary btn-sm">Enregistrer le coût</button>
    </form>
  );
}

function RecoveryCampaignCard({ c, onChanged }: { c: RecoveryCampaignView; onChanged: () => void }) {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const manage = roles.some((r) => r === 'R06' || r === 'R07');
  const approve = roles.some((r) => ['R01', 'R02', 'R05', 'R06'].includes(r));
  const visitor = roles.some((r) => ['R09', 'R10', 'R20'].includes(r));
  const coster = roles.some((r) => ['R06', 'R07', 'R20'].includes(r));
  const [err, setErr] = useState<string | null>(null);
  const post = async (path: string, body?: unknown) => { setErr(null); try { await api(`/v1/campagnes-recouvrement/${c.id}/${path}`, { method: 'POST', ...(body ? { body } : {}) }); onChanged(); } catch (x) { setErr(describeError(x).message); } };
  const st = STATUS[c.status] ?? { label: c.status, tone: 'neutral' as Tone };
  const last = c.measures.at(-1);
  const active = ['EN_TEST', 'GENERALISATION_PROPOSEE', 'GENERALISEE'].includes(c.status);
  return (
    <li className="panel stack-sm">
      <div className="panel-head">
        <div className="min0"><p className="panel-title">{c.label}</p><p className="panel-sub"><span className="mono">{c.code}</span> · {c.entity} · {c.communes.join(', ')} · test {c.testSharePct} % / témoin {c.controlSharePct} %</p></div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <p className="small">Segments : {c.segments.map((s) => SEGMENT_LABEL[s] ?? s).join(', ')} · canaux : {c.channels.map((k) => CHANNEL_LABEL[k] ?? k).join(', ')}</p>
      <p className="small muted">Séquence : {c.sequence.map((s) => `${s.code} ${s.channels.map((k) => CHANNEL_LABEL[k] ?? k).join('+') || 'agent habilité'}`).join(' → ')} — {c.sequenceStatus}. Aucune contrainte : actions d’information seulement.</p>
      {c.summary.targets > 0 && <p className="small">Cibles : <strong>{c.summary.targets}</strong> ({Object.entries(c.summary.bySegment).map(([k, v]) => `${SEGMENT_LABEL[k] ?? k} ${v}`).join(', ')}) · groupes : test {c.summary.byGroup.TEST ?? 0}, témoin {c.summary.byGroup.TEMOIN ?? 0}, réserve {c.summary.byGroup.RESERVE ?? 0} · {c.summary.excluded} sans contact (litige, fraude présumée) · {c.summary.contacts} envoi(s) · {c.summary.visitsToDo} visite(s) à faire</p>}
      {c.contacts.length > 0 && (
        <details><summary className="small">Contacts ({c.contacts.length})</summary>
          <ul className="plain-list small">{c.contacts.slice(-20).map((x) => <li key={x.id}><span className="mono">{x.ref}</span> · {x.step} · {CHANNEL_LABEL[x.channel] ?? x.channel} · {OUTCOME[x.outcome] ?? x.outcome}</li>)}</ul>
        </details>
      )}
      {visitor && c.visits.filter((v) => v.status === 'A_FAIRE').map((v) => (
        <div key={v.id} className="btn-row"><span className="small">Visite {v.step} <span className="mono">{v.ref}</span></span>
          <ReasonAction label="Rapporter la visite" confirmLabel="Contribuable informé" onSubmit={(note) => api(`/v1/campagnes-recouvrement/${c.id}/visites/${v.id}`, { method: 'POST', body: { outcome: 'RENCONTRE_INFORME', note } }).then(onChanged)} />
          <ReasonAction label="Absent" confirmLabel="Absent" tone="secondary" onSubmit={(note) => api(`/v1/campagnes-recouvrement/${c.id}/visites/${v.id}`, { method: 'POST', body: { outcome: 'ABSENT', note } }).then(onChanged)} />
        </div>
      ))}
      {last && <MeasureView m={last} />}
      {c.stopProposal && !c.stopProposal.decision && (
        <div className="notice notice-warn stack-sm" role="alert">
          <p className="small"><strong>Arrêt proposé par le système</strong> (jamais automatique) : {c.stopProposal.reasons.join(' ')}</p>
          {approve && <div className="btn-row">
            <ReasonAction label="Arrêter la campagne" confirmLabel="Arrêter" onSubmit={(reason) => api(`/v1/campagnes-recouvrement/${c.id}/arret/decision`, { method: 'POST', body: { stop: true, reason } }).then(onChanged)} />
            <ReasonAction label="Poursuivre (motivé)" confirmLabel="Poursuivre" tone="secondary" onSubmit={(reason) => api(`/v1/campagnes-recouvrement/${c.id}/arret/decision`, { method: 'POST', body: { stop: false, reason } }).then(onChanged)} />
          </div>}
        </div>
      )}
      {c.stop && <p className="small">Arrêt : {c.stop.reason}</p>}
      <div className="btn-row">
        {manage && ['BROUILLON', 'SIMULEE'].includes(c.status) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void post('simulation')}>Simuler sur les données réelles</button>}
        {manage && c.status === 'SIMULEE' && <button type="button" className="btn btn-primary btn-sm" onClick={() => void post('lancement')}>Proposer la phase de test</button>}
        {approve && c.status === 'LANCEMENT_PROPOSE' && user?.id !== c.launch?.proposedBy && user?.id !== c.createdBy && (
          <>
            <ReasonAction label="Lancer le test" confirmLabel="Lancer la phase de test" onSubmit={(reason) => api(`/v1/campagnes-recouvrement/${c.id}/lancement/decision`, { method: 'POST', body: { approve: true, reason } }).then(onChanged)} />
            <ReasonAction label="Refuser" confirmLabel="Refuser" tone="secondary" onSubmit={(reason) => api(`/v1/campagnes-recouvrement/${c.id}/lancement/decision`, { method: 'POST', body: { approve: false, reason } }).then(onChanged)} />
          </>
        )}
        {manage && active && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void post('execution')}>Exécuter les étapes dues</button>}
        {active && roles.some((r) => ['R06', 'R07', 'R11', 'R17', 'R20', 'R21', 'R22', 'R23'].includes(r)) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void post('mesure')}>Mesurer</button>}
        {manage && c.status === 'EN_TEST' && c.measures.length > 0 && <ReasonAction label="Proposer la généralisation" confirmLabel="Proposer" onSubmit={(reason) => post('generalisation', { reason })} />}
        {approve && c.status === 'GENERALISATION_PROPOSEE' && user?.id !== c.generalisation?.proposedBy && (
          <>
            <ReasonAction label="Généraliser" confirmLabel="Généraliser (témoin maintenu)" onSubmit={(reason) => api(`/v1/campagnes-recouvrement/${c.id}/generalisation/decision`, { method: 'POST', body: { approve: true, reason } }).then(onChanged)} />
            <ReasonAction label="Refuser la généralisation" confirmLabel="Refuser" tone="secondary" onSubmit={(reason) => api(`/v1/campagnes-recouvrement/${c.id}/generalisation/decision`, { method: 'POST', body: { approve: false, reason } }).then(onChanged)} />
          </>
        )}
        {approve && !['ARRETEE', 'CLOTUREE'].includes(c.status) && <ReasonAction label="Arrêter (erreurs, impact social)" confirmLabel="Arrêter la campagne" tone="secondary" onSubmit={(reason) => api(`/v1/campagnes-recouvrement/${c.id}/arret`, { method: 'POST', body: { reason } }).then(onChanged)} />}
      </div>
      {coster && active && <details><summary className="small">Saisir un coût de la campagne (pièce justificative par empreinte)</summary><CostForm campaignId={c.id} currency="USD" onDone={onChanged} /></details>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </li>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({ code: '', label: '', entity: 'DGIPK', communes: 'Lemba', segments: ['CONFORME', 'RETARD', 'DIFFICULTE', 'NON_DECLARANT', 'GRAND_DEBITEUR'], channels: ['SMS', 'APPEL', 'VISITE_INFORMATION'], testSharePct: '', controlSharePct: '' });
  const [err, setErr] = useState<string | null>(null);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      await api('/v1/campagnes-recouvrement', { method: 'POST', body: { code: f.code, label: f.label, entity: f.entity, communes: f.communes.split(',').map((x) => x.trim()).filter(Boolean), segments: f.segments, channels: f.channels, testSharePct: Number(f.testSharePct), controlSharePct: Number(f.controlSharePct) } });
      onCreated();
    } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <form className="panel stack-sm" onSubmit={(e) => void go(e)} aria-label="Nouvelle campagne de recouvrement">
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="cr-code">Code</label><input id="cr-code" required pattern="[A-Z0-9-]{4,60}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></div>
        <div className="field"><label className="label" htmlFor="cr-label">Intitulé</label><input id="cr-label" required minLength={5} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="cr-communes">Communes (séparées par des virgules)</label><input id="cr-communes" required value={f.communes} onChange={(e) => setF({ ...f, communes: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor="cr-test">Groupe test (%)</label><input id="cr-test" required inputMode="numeric" value={f.testSharePct} onChange={(e) => setF({ ...f, testSharePct: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor="cr-ctl">Groupe témoin (%)</label><input id="cr-ctl" required inputMode="numeric" value={f.controlSharePct} onChange={(e) => setF({ ...f, controlSharePct: e.target.value })} /></div>
      </div>
      <fieldset className="stack-sm"><legend className="label">Segments (§ 21.2)</legend>
        <div className="btn-row">{Object.entries(SEGMENT_LABEL).map(([k, v]) => <label key={k} className="small"><input type="checkbox" checked={f.segments.includes(k)} onChange={() => setF({ ...f, segments: toggle(f.segments, k) })} /> {v}</label>)}</div>
      </fieldset>
      <fieldset className="stack-sm"><legend className="label">Canaux</legend>
        <div className="btn-row">{Object.entries(CHANNEL_LABEL).map(([k, v]) => <label key={k} className="small"><input type="checkbox" checked={f.channels.includes(k)} onChange={() => setF({ ...f, channels: toggle(f.channels, k) })} /> {v}</label>)}</div>
      </fieldset>
      <p className="small muted">Séquence J-15, J-3, J+1, J+15, J+30 du Cahier (§ 21), décalages PAR DÉFAUT à confirmer. Les parts des groupes test et témoin sont fixées par vous : aucune valeur n’est supposée.</p>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary btn-sm">Créer la campagne</button>
    </form>
  );
}

export default function CampagnesRecouvrement() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const q = useApi(() => api<RecoveryCampaignView[]>('/v1/campagnes-recouvrement'), [user?.id]);
  const [creating, setCreating] = useState(false);
  return (
    <section className="stack-sm" aria-labelledby="crec-title">
      <h2 className="h-sub" id="crec-title">Campagnes de recouvrement (relances graduées et mesurées)</h2>
      <p className="small muted">Segmentation équitable du § 21.2 ; la campagne commence par un test comparé à un groupe témoin, est mesurée (taux de régularisation, coût par franc récupéré) et peut être arrêtée : l’arrêt est proposé par le système, décidé par une personne.</p>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && <EmptyState title="Aucune campagne de recouvrement." />}
      <ul className="stack">{(q.data ?? []).map((c) => <RecoveryCampaignCard key={c.id} c={c} onChanged={q.reload} />)}</ul>
      {roles.some((r) => r === 'R06' || r === 'R07') && (creating
        ? <CreateForm onCreated={() => { setCreating(false); q.reload(); }} />
        : <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreating(true)}>Nouvelle campagne de recouvrement</button>)}
    </section>
  );
}
