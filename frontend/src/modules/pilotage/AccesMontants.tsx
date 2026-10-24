/**
 * « Accès aux montants (autorisation préalable) » — décision du maître d'ouvrage du 29/09/2026 : Trésor, rapprochement,
 * validation financière, contrôle qualité, audit et anti-fraude voient les montants nécessaires à leur travail après
 * l'approbation d'un membre de la direction (R01, R02, R03, R05), distinct du demandeur, sur motif déclaré et pour une
 * durée limitée ; chaque utilisation est journalisée. Le contrôle est fait par le serveur.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api, describeError } from '../../lib/api';
import { Section } from './shared';
import './pilotage.css';

export type Portee = 'MOTEUR' | 'REPARTITION' | 'AGENTS';
/** Rôles qui peuvent demander un accès aux montants (le serveur reste seul juge). */
export const ROLES_DEMANDEURS_MONTANTS = ['R11', 'R15', 'R17', 'R18', 'R22', 'R23', 'R24'];

interface Autorisation {
  id: string; requesterId: string; requesterName: string; portees: Portee[]; motif: string; mission: string | null; dureeJours: number;
  etat: 'DEMANDEE' | 'APPROUVEE' | 'REFUSEE' | 'REVOQUEE' | 'EXPIREE'; requestedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string }; validUntil?: string; utilisations: number; lastUsedAt: string | null;
}
interface Liste {
  items: Autorisation[]; peutDemander: boolean; peutDecider: boolean; portees: Record<Portee, string>; mesPorteesActives: Portee[];
  duree: { parDefautJours: number; maxJours: number; statut: string }; regle: string;
}

const ETAT: Record<Autorisation['etat'], { label: string; tone: Tone }> = {
  DEMANDEE: { label: 'En attente de la direction', tone: 'info' },
  APPROUVEE: { label: 'Approuvée — active', tone: 'good' },
  REFUSEE: { label: 'Refusée', tone: 'critical' },
  REVOQUEE: { label: 'Révoquée', tone: 'neutral' },
  EXPIREE: { label: 'Expirée', tone: 'neutral' },
};
/** Écrans ouverts par chaque portée une fois l'autorisation approuvée. */
const ECRANS: Record<Portee, { to: string; label: string }[]> = {
  MOTEUR: [{ to: '/executive/finance', label: 'Centre de commandement financier' }, { to: '/pilotage/moteur-repartition', label: 'Répartition des recettes et droits' }],
  REPARTITION: [{ to: '/pilotage/repartition', label: 'Répartition des recettes (§ 37A)' }],
  AGENTS: [{ to: '/agents/reserve', label: 'Réserve des agents' }, { to: '/agents/validation-commissions', label: 'Validation des commissions' }],
};

/** Portées actives du compte (pour ouvrir les onglets correspondants) ; aucune requête pour les autres rôles. */
export function usePorteesAutorisees(): Portee[] {
  const { user } = useApp();
  const demandeur = !!user?.roles.some((r) => ROLES_DEMANDEURS_MONTANTS.includes(r));
  const q = useApi(demandeur ? () => api<Liste>('/v1/acces-montants') : null, [user?.id, demandeur]);
  return q.data?.mesPorteesActives ?? [];
}

export default function AccesMontants() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Liste>('/v1/acces-montants'), [user?.id]);
  const [portees, setPortees] = useState<Portee[]>([]);
  const [motif, setMotif] = useState('');
  const [mission, setMission] = useState('');
  const [duree, setDuree] = useState('');
  const [decision, setDecision] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(path: string, body: unknown, ok: string) {
    setBusy(true); setMsg(null);
    try { await api(path, { method: 'POST', body }); setMsg({ ok: true, text: ok }); q.reload(); return true; }
    catch (e) { const d = describeError(e); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); return false; }
    finally { setBusy(false); }
  }

  const d = q.data;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · contrôle des accès" title="Accès aux montants (autorisation préalable)"
        lead="Les gains des autres ne sont visibles que de la direction et de Groupe Nseya. Le Trésor, l’audit et l’anti-fraude y accèdent pour leur travail après l’approbation d’un membre de la direction, sur motif, pour une durée limitée ; chaque consultation est journalisée." />
      {q.loading && !d ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : d && (
        <div className="dash-grid">
          <div className="span-12">
            <div className="callout callout-info" role="note"><Icon name="shieldCheck" size={18} /><span>{d.regle}</span></div>
            {msg && <p className={`small ${msg.ok ? '' : 'error'}`} role="status">{msg.text}</p>}
          </div>

          {d.mesPorteesActives.length > 0 && (
            <Section title="Mes accès actifs" sub="Écrans ouverts par l’autorisation en cours">
              <ul className="plain-list" data-testid="acces-montants-actifs">
                {d.mesPorteesActives.flatMap((p) => ECRANS[p]).map((e) => <li key={e.to}><Link to={e.to}>{e.label}</Link></li>)}
              </ul>
            </Section>
          )}

          {d.peutDemander && (
            <Section title="Demander un accès" sub={`Durée : ${d.duree.parDefautJours} jours par défaut, ${d.duree.maxJours} au plus (${d.duree.statut})`}>
              <form className="form" aria-label="Demander un accès aux montants" onSubmit={(e) => {
                e.preventDefault();
                void run('/v1/acces-montants', { portees, motif, ...(mission.trim() ? { mission: mission.trim() } : {}), ...(duree ? { dureeJours: Number(duree) } : {}) }, 'Demande envoyée : un membre de la direction doit l’approuver.')
                  .then((ok) => { if (ok) { setPortees([]); setMotif(''); setMission(''); setDuree(''); } });
              }}>
                <fieldset className="field"><legend className="label">Montants nécessaires</legend>
                  {(Object.keys(d.portees) as Portee[]).map((p) => (
                    <label key={p} className="small" style={{ display: 'block' }}>
                      <input type="checkbox" checked={portees.includes(p)} onChange={(e) => setPortees(e.target.checked ? [...portees, p] : portees.filter((x) => x !== p))} /> {d.portees[p]}
                    </label>
                  ))}
                </fieldset>
                <div className="field"><label className="label" htmlFor="am-motif">Motif (au moins 10 caractères)</label><textarea id="am-motif" required minLength={10} value={motif} onChange={(e) => setMotif(e.target.value)} /></div>
                <div className="field-row">
                  <div className="field"><label className="label" htmlFor="am-mission">Mission ou référence (facultatif)</label><input id="am-mission" value={mission} onChange={(e) => setMission(e.target.value)} /></div>
                  <div className="field"><label className="label" htmlFor="am-duree">Durée (jours)</label><input id="am-duree" type="number" min={1} max={d.duree.maxJours} placeholder={String(d.duree.parDefautJours)} value={duree} onChange={(e) => setDuree(e.target.value)} /></div>
                </div>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || portees.length === 0 || motif.trim().length < 10}>Envoyer la demande</button>
              </form>
            </Section>
          )}

          <Section title={d.peutDecider ? 'Demandes et autorisations' : 'Mes demandes'} sub={d.peutDecider ? 'Décision motivée, distincte du demandeur, authentification renforcée' : undefined}>
            {d.peutDecider && (
              <div className="field"><label className="label" htmlFor="am-decision">Motif de la décision (au moins 10 caractères)</label><input id="am-decision" value={decision} onChange={(e) => setDecision(e.target.value)} /></div>
            )}
            <DataTable caption="Autorisations d’accès aux montants" rows={d.items} rowKey={(a) => a.id}
              empty={<EmptyState title="Aucune demande" icon="lock">{d.peutDemander ? 'Demandez un accès lorsque votre travail l’exige.' : 'Aucune demande en attente.'}</EmptyState>}
              columns={[
                { key: 'd', label: 'Demandeur', primary: true, render: (a) => <><strong>{a.requesterName}</strong><span className="small muted" style={{ display: 'block' }}>{fmtDate(a.requestedAt)} · {a.id}</span></> },
                { key: 'p', label: 'Montants', render: (a) => <span className="small">{a.portees.map((p) => d.portees[p]).join(' ; ')}</span> },
                { key: 'm', label: 'Motif', render: (a) => <span className="small">{a.motif}{a.mission ? ` — ${a.mission}` : ''}</span> },
                { key: 'e', label: 'État', render: (a) => <><StatusBadge tone={ETAT[a.etat].tone} label={ETAT[a.etat].label} />{a.validUntil && a.etat === 'APPROUVEE' && <span className="small muted" style={{ display: 'block' }}>jusqu’au {fmtDate(a.validUntil)} · {a.utilisations} utilisation(s)</span>}{a.decision && <span className="small muted" style={{ display: 'block' }}>{a.decision.approve ? 'Approuvée' : 'Refusée'} par {a.decision.by} : {a.decision.motif}</span>}</> },
                { key: 'a', label: 'Action', render: (a) => (
                  <>
                    {d.peutDecider && a.etat === 'DEMANDEE' && a.requesterId !== user?.id && (
                      <>
                        <button type="button" className="btn btn-primary btn-sm" disabled={busy || decision.trim().length < 10} onClick={() => void run(`/v1/acces-montants/${a.id}/decision`, { approve: true, motif: decision }, 'Accès approuvé.').then((ok) => ok && setDecision(''))}>Approuver</button>{' '}
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || decision.trim().length < 10} onClick={() => void run(`/v1/acces-montants/${a.id}/decision`, { approve: false, motif: decision }, 'Demande refusée.').then((ok) => ok && setDecision(''))}>Refuser</button>
                      </>
                    )}
                    {(a.etat === 'APPROUVEE' || a.etat === 'DEMANDEE') && (d.peutDecider || a.requesterId === user?.id) && (
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(`/v1/acces-montants/${a.id}/revocation`, { motif: a.requesterId === user?.id ? 'Renonciation du demandeur (fin du besoin).' : (decision.trim().length >= 10 ? decision : 'Révocation par la direction.') }, a.etat === 'DEMANDEE' ? 'Demande retirée.' : 'Accès révoqué.')}>{a.requesterId === user?.id ? (a.etat === 'DEMANDEE' ? 'Retirer' : 'Renoncer') : 'Révoquer'}</button>
                    )}
                  </>
                ) },
              ]} />
          </Section>
        </div>
      )}
    </div>
  );
}
