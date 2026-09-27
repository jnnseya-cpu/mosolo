/**
 * Module 9 — Intelligence foncière et locative : retenue et IRL annuel calculés à partir des BAUX VÉRIFIÉS, avec le
 * taux et la retenue de la fiche du rang de localité (IRL 22 % à tous les rangs ; retenue 20 % au 1er rang, 15 % aux
 * rangs 2 à 4 — fiches « à vérifier », illustration non opposable), couverture locative par avenue, quartier et
 * commune. Loyer et identité du locataire visibles des seuls rôles habilités. Aucune dette sur simple signal.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { BlocIndicateurs, Tableau } from './common';
import './citoyen.css';
import { LocatifVisuels } from './visuels';

type M = { amount: string; currency: string } | null;
interface Ligne { bail: string; igf: string | null; commune: string; quartier: string; avenue: string | null; rang: number; statutProbant: string; loyerAnnuel: M; locataire: string | null; retenue: M; irlAnnuel: M; regle: { code: string; version: number; statut: string } | null; nature: string; mention: string }
const m = (x: M) => (x ? `${x.amount} ${x.currency}` : '—');

export default function Locatif() {
  const { user } = useApp();
  const [tous, setTous] = useState(false);
  const [niveau, setNiveau] = useState('commune');
  const calc = useApi(() => api<{ lignes: Ligne[]; masque: boolean; notice: string }>(`/v1/citoyen/locatif/calcul${tous ? '?tous=true' : ''}`), [user?.id, tous]);
  const cov = useApi(() => api<{ lignes: { zone: string; unites: number; avecBail: number; bauxVerifies: number; couverture: string | null; couvertureVerifiee: string | null }[] }>(`/v1/citoyen/locatif/couverture?niveau=${niveau}`), [user?.id, niveau]);
  const kpi = useApi(() => api<Record<string, unknown>>('/v1/citoyen/locatif/indicateurs'), [user?.id]);
  return (
    <div className="stack">
      <PageHead eyebrow="Module 9" title="Intelligence foncière et locative" lead="Registre parcelle → bâtiment → unité → bail. Calcul de la retenue et de l’IRL annuel sur baux vérifiés : proposition, jamais une dette automatique." />
      <p className="small"><Link to="/fiscal/anomalies-locatives">Détection d’anomalies (signal ⇒ dossier de vérification)</Link> · <Link to="/fiscal/assiette-2026">Élargissement 2026</Link> · <Link to="/fiscal/carte">Carte à deux couches</Link> · <Link to="/fiscal/baux">Attestations de bail</Link> · <Link to="/recouvrement/campagnes">Campagne annuelle pré-remplie</Link></p>
      <LocatifVisuels couverture={cov.data?.lignes ?? null} lignes={calc.data?.lignes ?? null} />
      <BlocIndicateurs titre="Indicateurs du module 9" indicateurs={kpi.data} />
      <section className="panel stack-sm" aria-label="Calcul IRL">
        <p className="panel-title">Retenue et IRL annuel par bail</p>
        <label className="small"><input type="checkbox" checked={tous} onChange={(e) => setTous(e.target.checked)} /> Inclure les baux non vérifiés (illustration)</label>
        {calc.loading ? <Loading /> : calc.error ? <ErrorState error={calc.error} onRetry={calc.reload} /> : calc.data && (
          <>
            <p className="small muted">{calc.data.notice}</p>
            <Tableau entetes={['Bail', 'Lieu', 'Rang', 'Preuve', 'Loyer annuel', 'Retenue', 'IRL annuel', 'Règle', 'Nature']} vide="Aucun bail vérifié."
              lignes={calc.data.lignes.map((l) => [l.bail, `${l.commune} › ${l.quartier}${l.avenue ? ` › ${l.avenue}` : ''}`, l.rang, l.statutProbant, m(l.loyerAnnuel), m(l.retenue), m(l.irlAnnuel),
                l.regle ? `${l.regle.code} v${l.regle.version} (${l.regle.statut})` : '—',
                <StatusBadge key="n" tone={l.nature === 'INDICATIF' ? 'good' : 'warning'} label={l.nature === 'INDICATIF' ? 'Indicatif' : l.nature === 'SANS_REGLE' ? 'Sans règle' : 'Non opposable'} title={l.mention} />])} />
          </>
        )}
      </section>
      <section className="panel stack-sm" aria-label="Couverture locative">
        <p className="panel-title">Couverture locative</p>
        <select aria-label="Niveau" value={niveau} onChange={(e) => setNiveau(e.target.value)}><option value="commune">Par commune</option><option value="quartier">Par quartier</option><option value="avenue">Par avenue</option></select>
        {cov.data && <Tableau entetes={['Zone', 'Unités', 'Avec bail', 'Baux vérifiés', 'Couverture', 'Couverture vérifiée']} vide="Aucune unité." lignes={cov.data.lignes.map((l) => [l.zone, l.unites, l.avecBail, l.bauxVerifies, l.couverture ? `${l.couverture} %` : '—', l.couvertureVerifiee ? `${l.couvertureVerifiee} %` : '—'])} />}
        {cov.error ? <ErrorState error={cov.error} onRetry={cov.reload} /> : null}
      </section>
    </div>
  );
}
