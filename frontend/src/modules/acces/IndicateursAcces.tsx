/**
 * Indicateurs des modules 72 (modules activés, arbitrages, délais) et 74 (invitations acceptées, délais, révocations),
 * calculés par le serveur dans le périmètre d'entités de la personne qui consulte.
 */
import type { ReactNode } from 'react';
import { useApp } from '../../context';
import { Icon } from '../../components/Icon';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { hasRole } from './common';

interface AccesIndicators {
  generatedAt: string;
  perimetre: string[] | string;
  modules72: {
    entities: number;
    modules: { total: number; actifs: number; parStatut: Record<string, number> };
    delaiActivationHeures: { moyenne: number | null; activations: number; note?: string };
    arbitrages: { total: number; ouverts: number; instruits: number; decides: number; delaiDecisionHeures: number | null };
  };
  acces74: {
    invitations: { envoyees: number; acceptees: number; tauxAcceptationPct: number | null; enAttente: number; expirees: number; refusees: number; revoquees: number; parLien: number; parOperateurAcces: number; delaiAcceptationHeures: number | null };
    comptes: { total: number; actifs: number; revoques: number; suspendus: number; enAttente: number };
    validations: { enAttente: number; approuvees: number; rejetees: number; delaiDecisionHeures: number | null };
  };
}

/** Rôles de supervision des accès (lecture des invitations, § 12A). */
export const ACCESS_OVERSIGHT_ROLES = ['R26', 'R22', 'R23', 'R28', 'R08', 'R06', 'R07', 'R09'];

const hours = (h: number | null) => (h === null ? '—' : h >= 48 ? `${(h / 24).toFixed(1)} j` : `${h.toFixed(1)} h`);

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return <div className="kpi"><span className="kpi-label">{label}</span><span className="kpi-value">{value}</span>{sub && <span className="kpi-sub">{sub}</span>}</div>;
}

export function AccesIndicatorsPanel({ part }: { part: '72' | '74' }) {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, ...ACCESS_OVERSIGHT_ROLES);
  const q = useApi(allowed ? () => api<AccesIndicators>('/v1/acces/indicateurs') : null, [user?.id]);
  if (!allowed) return null;
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d) return null;
  const perimetre = typeof d.perimetre === 'string' ? d.perimetre : d.perimetre.join(', ');
  if (part === '72') {
    const m = d.modules72;
    return (
      <section className="panel" aria-labelledby="acc-ind-72">
        <header className="panel-head"><div><h2 className="panel-title" id="acc-ind-72"><Icon name="gauge" size={18} /> Indicateurs des espaces et des modules</h2><p className="panel-sub">Périmètre : {perimetre}.</p></div></header>
        <div className="kpi-row">
          <Kpi label="Modules activés" value={`${m.modules.actifs} / ${m.modules.total}`} sub={`${m.entities} entité(s)`} />
          <Kpi label="Délai moyen d’activation" value={hours(m.delaiActivationHeures.moyenne)} sub={m.delaiActivationHeures.note ?? `${m.delaiActivationHeures.activations} activation(s) après recette et seconde validation`} />
          <Kpi label="Arbitrages" value={m.arbitrages.total} sub={`${m.arbitrages.ouverts} ouvert(s) · ${m.arbitrages.instruits} instruit(s) · ${m.arbitrages.decides} décidé(s)`} />
          <Kpi label="Délai moyen de décision d’arbitrage" value={hours(m.arbitrages.delaiDecisionHeures)} />
        </div>
      </section>
    );
  }
  const i = d.acces74.invitations;
  const c = d.acces74.comptes;
  const v = d.acces74.validations;
  return (
    <section className="panel" aria-labelledby="acc-ind-74">
      <header className="panel-head"><div><h2 className="panel-title" id="acc-ind-74"><Icon name="gauge" size={18} /> Indicateurs des invitations et des accès</h2><p className="panel-sub">Périmètre : {perimetre}.</p></div></header>
      <div className="kpi-row">
        <Kpi label="Invitations acceptées" value={`${i.acceptees} / ${i.envoyees}`} sub={i.tauxAcceptationPct === null ? 'aucune invitation' : `${i.tauxAcceptationPct} % · ${i.parLien} par lien, ${i.parOperateurAcces} par l’opérateur d’accès`} />
        <Kpi label="Délai moyen d’acceptation" value={hours(i.delaiAcceptationHeures)} sub={`${i.enAttente} en attente · ${i.expirees} expirée(s)`} />
        <Kpi label="Révocations" value={c.revoques} sub={`comptes révoqués · ${i.revoquees} invitation(s) révoquée(s)`} />
        <Kpi label="Secondes validations" value={v.enAttente} sub={`en attente · ${v.approuvees} approuvée(s), ${v.rejetees} rejetée(s) · délai ${hours(v.delaiDecisionHeures)}`} />
      </div>
    </section>
  );
}
