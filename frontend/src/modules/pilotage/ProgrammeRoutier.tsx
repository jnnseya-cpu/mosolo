/**
 * Programme routier du Gouvernorat (30/09/2026, annonce du Cabinet du Gouverneur) : kilomètres livrés et en cours,
 * chiffres annoncés « à confirmer » ; recettes liées à la route (péage provincial, droits de voirie, taxe de circulation)
 * mises en regard, agrégées, sans affectation automatique aux travaux (l'affectation relève du budget et de l'acte).
 */
import type { MoneyJSON } from '@mosolo/shared';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { MoneyText } from '../../components/MoneyText';
import { api } from '../../lib/api';
import { Section } from './shared';
import { Tuiles } from './visuels';
import { fmtNombre, KpiTile } from '../../components/viz';
import './pilotage.css';

interface Ligne { code: string; libelle: string; modules: string[]; obligations: number; paiementsRapproches: number; liquide: MoneyJSON[]; rapproche: MoneyJSON[]; regie: { regie: string; motif: string } }
interface Vue {
  code: string; intitule: string; source: string; statut: string; generatedAt: string;
  indicateurs: { code: string; libelle: string; valeur: number; unite: string; qualificatif: string }[];
  kmTotalAnnonce: number; partLivreePct: number; avertissement: string;
  recettes: { lignes: Ligne[]; totalRapproche: MoneyJSON[]; base: string; donneesDisponibles: boolean };
}

const REGIE: Record<string, string> = { DGIPK: 'DGIPK (impôts provinciaux)', DGTK: 'DGTK (droits, taxes et redevances)', A_ARBITRER: 'À arbitrer' };
const montants = (xs: MoneyJSON[]) => xs.length ? <>{xs.map((m) => <span key={m.currency} style={{ display: 'block' }}><MoneyText money={m} showIndicative={false} /></span>)}</> : <span className="muted">0</span>;

export default function ProgrammeRoutier() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Vue>('/v1/pilotage/programme/routes'), [user?.id]);
  const d = q.data;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · programme du Gouvernorat" title="Programme routier du Gouvernorat"
        lead="Routes livrées et en cours, et recettes liées à la route (péage provincial, droits de voirie, taxe de circulation) mises en regard." />
      {q.loading && !d ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : d && (
        <div className="grid-12">
          <p className="callout callout-warn span-12" role="note"><strong>{d.statut}.</strong> Source : {d.source}.</p>
          <Tuiles label="Programme routier — kilomètres" max={3}>
            {d.indicateurs.map((i, k) => (
              <KpiTile key={i.code} hero={k === 0} label={i.libelle} value={i.valeur} unit={i.unite} format={(v) => fmtNombre(v, 0)} state={{ label: i.qualificatif, tone: i.code === 'KM_LIVRES' ? 'good' : 'warning' }} />
            ))}
            <KpiTile label="Part livrée du total annoncé" value={d.partLivreePct} unit="%" format={(v) => fmtNombre(v, 1)} state={{ label: `sur ${fmtNombre(d.kmTotalAnnonce, 0)} km annoncés`, tone: 'info' }} />
          </Tuiles>
          <Section title="Recettes liées à la route" sub={d.recettes.base}>
            <DataTable caption="Recettes liées à la route" rows={d.recettes.lignes} rowKey={(l) => l.code} columns={[
              { key: 'l', label: 'Ligne de recette', primary: true, render: (l) => <><strong>{l.libelle}</strong><span className="small muted" style={{ display: 'block' }}>{l.obligations} obligation(s) · {l.paiementsRapproches} paiement(s) rapproché(s)</span></> },
              { key: 'q', label: 'Liquidé', render: (l) => montants(l.liquide) },
              { key: 'r', label: 'Rapproché', render: (l) => montants(l.rapproche) },
              { key: 'g', label: 'Régie compétente (proposée)', render: (l) => <><StatusBadge tone={l.regie.regie === 'A_ARBITRER' ? 'warning' : 'info'} label={REGIE[l.regie.regie] ?? l.regie.regie} /><span className="small muted" style={{ display: 'block' }}>{l.regie.motif}</span></> },
            ]} />
            <p className="small"><strong>Total rapproché :</strong> {montants(d.recettes.totalRapproche)}</p>
            <p className="small muted">{d.avertissement} Arrêté au {fmtDate(d.generatedAt, true)}. Voir aussi <Link to="/pilotage/projets">Projets publics et emploi des fonds</Link>.</p>
          </Section>
        </div>
      )}
    </div>
  );
}
