/**
 * Campagnes (§ 8, § 10A.2, § 21.4, § 45) : calendrier par entité, campagne de février 2027, simulation avant lancement
 * (avis attendus, canaux, volumes — données réelles uniquement), lot de déclarations pré-remplies, lancement décidé
 * par une seconde personne, relances, arrêt motivé. Prorogations d'échéance (§ 6.2) : acte daté, quatre yeux.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ReasonAction } from '../fiscal/common';
import CampagnesRecouvrement from './CampagnesRecouvrement';
import { CampagnesVisuel } from './visuels';
import './recouvrement.css';

interface Simulation {
  at: string; targets: number; taxpayers: number; expectedNotices: number; totalMessages: number; unreachable: number;
  excluded: { withoutHolder: number; alreadyFiled: number; notApplicable: number }; channels: Record<string, number>;
  reminders: { offsetDays: number; date: string; expectedMessages: number }[]; warnings: string[];
  rules: { kind: string; code: string | null; status: string; executable: boolean; note: string }[];
  observedFilingRate: { period: string; eligible: number; filed: number; pct: number } | null;
}
interface Campaign {
  id: string; code: string; label: string; entity: string; kinds: string[]; period: string; communes: string[]; dueDate: string; dueDateStatus: string; dueDateSource: string;
  reminders: { offsetDays: number; label: string }[]; remindersStatus: string; stopCriteria: string[]; status: string; createdBy: string;
  simulation?: Simulation; prefill?: { items: unknown[]; errors: { objectId: string; error: string }[] };
  launch?: { proposedBy: string; approvedBy?: string; notified?: number }; remindersSent: { offsetDays: number; at: string; count: number }[]; stop?: { reason: string };
}
interface Extension { id: string; ruleCode: string; appliesFrom: string; appliesTo: string; extendedTo: string; actReference: string; actDate: string; reason: string; status: string; proposedBy: string; notified?: number }

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: Tone }> = {
  BROUILLON: { label: 'Brouillon', tone: 'neutral' }, SIMULEE: { label: 'Simulée', tone: 'info' }, LANCEMENT_PROPOSE: { label: 'Lancement proposé — seconde personne', tone: 'warning' },
  LANCEE: { label: 'Lancée', tone: 'good' }, ARRETEE: { label: 'Arrêtée', tone: 'critical' }, CLOTUREE: { label: 'Clôturée', tone: 'neutral' },
};
const CHANNEL: Record<string, string> = { sms: 'SMS', email: 'Courriel', 'in-app': 'Application', ussd: 'USSD', svi: 'SVI', whatsapp: 'WhatsApp' };

function SimulationView({ s }: { s: Simulation }) {
  return (
    <div className="stack-sm">
      <p className="small"><strong>{s.expectedNotices}</strong> avis attendus pour <strong>{s.taxpayers}</strong> contribuable(s) · <strong>{s.totalMessages}</strong> messages au total (avis + relances) · {s.unreachable} sans téléphone ni courriel.</p>
      <p className="small">Canaux : {Object.entries(s.channels).map(([k, v]) => `${CHANNEL[k] ?? k} ${v}`).join(' · ') || '—'}</p>
      <p className="small">Exclus : {s.excluded.withoutHolder} sans redevable rattaché · {s.excluded.alreadyFiled} déjà déposés · {s.excluded.notApplicable} non concernés.</p>
      <p className="small">Relances : {s.reminders.map((r) => `J-${r.offsetDays} (${r.date}) : ${r.expectedMessages} messages`).join(' · ')}</p>
      <p className="small">Taux de dépôt observé l’an passé : {s.observedFilingRate ? `${s.observedFilingRate.pct} % (${s.observedFilingRate.filed}/${s.observedFilingRate.eligible}, exercice ${s.observedFilingRate.period})` : 'données insuffisantes — aucun taux supposé'}.</p>
      <ul className="plain-list small">{s.rules.map((r) => <li key={r.kind}>{r.kind} : {r.code ?? '—'} ({r.status}) — {r.note}</li>)}</ul>
      {s.warnings.map((w) => <p key={w} className="notice small" role="note">{w}</p>)}
    </div>
  );
}

function CampaignCard({ c, onChanged }: { c: Campaign; onChanged: () => void }) {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const manage = roles.some((r) => r === 'R06' || r === 'R07');
  const approve = roles.some((r) => ['R01', 'R02', 'R05', 'R06'].includes(r));
  const [err, setErr] = useState<string | null>(null);
  const post = async (path: string) => { setErr(null); try { await api(`/v1/campagnes/${c.id}/${path}`, { method: 'POST' }); onChanged(); } catch (x) { setErr(describeError(x).message); } };
  const st = CAMPAIGN_STATUS[c.status] ?? { label: c.status, tone: 'neutral' as Tone };
  return (
    <li className="panel stack-sm">
      <div className="panel-head">
        <div className="min0"><p className="panel-title">{c.label}</p><p className="panel-sub"><span className="mono">{c.code}</span> · {c.entity} · {c.kinds.join(' + ')} · exercice {c.period} · {c.communes.join(', ')}</p></div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <p className="small">Échéance : <strong>{c.dueDate}</strong> {c.dueDateStatus === 'A_VERIFIER' ? '[À VÉRIFIER]' : ''} — {c.dueDateSource}</p>
      <p className="small muted">Relances : {c.reminders.map((r) => r.label).join(', ')} — {c.remindersStatus}. Critères d’arrêt : {c.stopCriteria.join(' ; ')}.</p>
      {c.simulation && <SimulationView s={c.simulation} />}
      {c.prefill && <p className="small">Lot pré-rempli : {c.prefill.items.length} déclaration(s) prête(s){c.prefill.errors.length ? `, ${c.prefill.errors.length} à régulariser` : ''} — aucune obligation créée.</p>}
      {c.remindersSent.length > 0 && <p className="small">Relances envoyées : {c.remindersSent.map((r) => `J-${r.offsetDays} → ${r.count}`).join(' · ')}</p>}
      {c.stop && <p className="small">Arrêt : {c.stop.reason}</p>}
      <div className="btn-row">
        {manage && ['BROUILLON', 'SIMULEE'].includes(c.status) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void post('simulation')}>Simuler</button>}
        {manage && c.status === 'SIMULEE' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void post('pre-remplissage')}>Préparer le lot pré-rempli</button>}
        {manage && c.status === 'SIMULEE' && c.prefill && <button type="button" className="btn btn-primary btn-sm" onClick={() => void post('lancement')}>Proposer le lancement</button>}
        {approve && c.status === 'LANCEMENT_PROPOSE' && user?.id !== c.launch?.proposedBy && user?.id !== c.createdBy && (
          <>
            <ReasonAction label="Approuver le lancement" confirmLabel="Lancer la campagne" onSubmit={(reason) => api(`/v1/campagnes/${c.id}/lancement/decision`, { method: 'POST', body: { approve: true, reason } }).then(onChanged)} />
            <ReasonAction label="Refuser" confirmLabel="Refuser" tone="secondary" onSubmit={(reason) => api(`/v1/campagnes/${c.id}/lancement/decision`, { method: 'POST', body: { approve: false, reason } }).then(onChanged)} />
          </>
        )}
        {manage && c.status === 'LANCEE' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void post('relances')}>Envoyer les relances dues</button>}
        {approve && !['ARRETEE', 'CLOTUREE'].includes(c.status) && <ReasonAction label="Arrêter" confirmLabel="Arrêter la campagne" tone="secondary" onSubmit={(reason) => api(`/v1/campagnes/${c.id}/arret`, { method: 'POST', body: { reason } }).then(onChanged)} />}
      </div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </li>
  );
}

function Prorogations() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const q = useApi(() => api<Extension[]>('/v1/prorogations'), [user?.id]);
  const [f, setF] = useState({ ruleCode: '', appliesFrom: '', appliesTo: '', extendedTo: '', actReference: '', actDate: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  async function propose(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api('/v1/prorogations', { method: 'POST', body: f }); q.reload(); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <section className="stack-sm">
      <h2 className="h-sub">Prorogations d’échéance (acte daté, sans nouvelle version de règle)</h2>
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      <ul className="stack-sm">{(q.data ?? []).map((x) => (
        <li key={x.id} className="panel stack-sm">
          <p className="small"><span className="mono">{x.ruleCode}</span> : échéances du {x.appliesFrom} au {x.appliesTo} reportées au <strong>{x.extendedTo}</strong> — {x.actReference} du {x.actDate} — {x.status === 'PROPOSEE' ? 'proposée' : x.status === 'ENREGISTREE' ? `enregistrée (${x.notified ?? 0} redevable(s) informé(s))` : 'rejetée'}</p>
          {x.status === 'PROPOSEE' && roles.some((r) => ['R05', 'R06', 'R16'].includes(r)) && user?.id !== x.proposedBy && (
            <div className="btn-row">
              <ReasonAction label="Enregistrer" confirmLabel="Enregistrer la prorogation" onSubmit={(reason) => api(`/v1/prorogations/${x.id}/decision`, { method: 'POST', body: { approve: true, reason } }).then(q.reload)} />
              <ReasonAction label="Rejeter" confirmLabel="Rejeter" tone="secondary" onSubmit={(reason) => api(`/v1/prorogations/${x.id}/decision`, { method: 'POST', body: { approve: false, reason } }).then(q.reload)} />
            </div>
          )}
        </li>))}</ul>
      {roles.some((r) => ['R06', 'R07', 'R13'].includes(r)) && (
        <form className="panel stack-sm" onSubmit={(e) => void propose(e)}>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="pr-rule">Code de la règle</label><input id="pr-rule" required value={f.ruleCode} onChange={(e) => setF({ ...f, ruleCode: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="pr-act">Acte (référence)</label><input id="pr-act" required value={f.actReference} onChange={(e) => setF({ ...f, actReference: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="pr-from">Échéances du</label><input id="pr-from" type="date" required value={f.appliesFrom} onChange={(e) => setF({ ...f, appliesFrom: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="pr-to">au</label><input id="pr-to" type="date" required value={f.appliesTo} onChange={(e) => setF({ ...f, appliesTo: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="pr-new">Nouvelle échéance</label><input id="pr-new" type="date" required value={f.extendedTo} onChange={(e) => setF({ ...f, extendedTo: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="pr-date">Date de l’acte</label><input id="pr-date" type="date" required value={f.actDate} onChange={(e) => setF({ ...f, actDate: e.target.value })} /></div>
          </div>
          <div className="field"><label className="label" htmlFor="pr-rs">Motif</label><input id="pr-rs" required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></div>
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-primary btn-sm rc-btn-wrap">Proposer (enregistrement par une seconde personne)</button>
        </form>
      )}
    </section>
  );
}

export default function Campagnes() {
  const { user } = useApp();
  const list = useApi(() => api<Campaign[]>('/v1/campagnes'), [user?.id]);
  const cal = useApi(() => api<{ entity: string; campaigns: { code: string; label: string; status: string; dueDate: string; dueDateStatus: string; reminders: { label: string; date: string }[] }[] }[]>('/v1/campagnes/calendrier'), [user?.id]);
  const reload = () => { list.reload(); cal.reload(); };
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Recouvrement" title="Campagnes et calendrier"
        lead="Le calendrier commande : chaque entité planifie ses campagnes (pré-remplissage, relances), simule avant de lancer — sur les seules données du registre — puis une seconde personne décide du lancement. Une campagne peut être arrêtée si son coût, ses erreurs ou son impact social sont disproportionnés." />
      {(list.loading || cal.loading) && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={reload} />}
      {list.data && cal.data && <CampagnesVisuel campaigns={list.data} calendar={cal.data} />}
      {cal.data && (
        <section className="stack-sm">
          <h2 className="h-sub">Calendrier par entité</h2>
          {cal.data.length === 0 && <EmptyState title="Aucune campagne planifiée." />}
          <div className="rtable-wrap"><table className="data-table rtable compact">
            <thead><tr><th>Entité</th><th>Campagne</th><th>Échéance</th><th>Relances</th><th>Statut</th></tr></thead>
            <tbody>{cal.data.flatMap((e) => e.campaigns.map((c) => (
              <tr key={c.code}><td data-label="Entité">{e.entity}</td><td data-label="Campagne" className="cell-primary">{c.label}</td><td data-label="Échéance">{c.dueDate}{c.dueDateStatus === 'A_VERIFIER' ? ' [À VÉRIFIER]' : ''}</td>
                <td data-label="Relances">{c.reminders.map((r) => `${r.label} (${r.date})`).join(', ')}</td><td data-label="Statut">{CAMPAIGN_STATUS[c.status]?.label ?? c.status}</td></tr>)))}</tbody>
          </table></div>
        </section>
      )}
      <ul className="stack">{(list.data ?? []).map((c) => <CampaignCard key={c.id} c={c} onChanged={reload} />)}</ul>
      {/* Module 33 : campagnes de recouvrement (segments § 21.2, test / témoin, mesure, arrêt proposé). */}
      <CampagnesRecouvrement />
      <Prorogations />
    </div>
  );
}
