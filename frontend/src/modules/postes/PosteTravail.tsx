/**
 * Postes de travail des opérateurs (Cahier nouvelle version, § 27.13 ; catalogue n° 42 « Poste de travail — régie
 * fiscale » et n° 43 « Poste de travail — régie des taxes », anciens « Tableau de bord régie fiscale / des taxes ») :
 * logique de file de travail (« Que dois-je traiter aujourd'hui ? »), séparée à l'écran de la corbeille de décision.
 * La file relit les éléments que la personne peut traiter selon les modules sources ; chaque élément ouvre l'écran de
 * la source, où la décision est prise (mêmes gardes, mêmes quatre yeux).
 */
// Parcours par rôle (29/09/2026) : liens adaptés au compte — un écran que le rôle n'utilise pas affiche « Réalisé par : … ».
import { selonRattachement } from '../../components/Shell';
import { useApp } from '../../context';
import { LienEcran as Link } from '../../components/LienEcran';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { BandeauHorsLigne, Bloc, usePosteApi } from './common';
import { VisuelsFile } from './visuels';
// Parcours par rôle (29/09/2026) : un écran vide propose la prochaine action utile du travail du jour.
import { SuiteDuTravail } from '../../components/SuiteDuTravail';

export interface Travail {
  famille: string; question: string; enAttente: number;
  postes: { code: string; utilisateur: string; ecranEntree: string; indicateurDominant: string; liens: { libelle: string; chemin: string }[]; indicateur: { code: string; libelle: string; valeur: string | null; unite: string; statut: string }[] }[];
  file: { id: string; module: string; objet: string; demandeur: string; depose: string; echeance: string | null; enRetard: boolean; ecran: string; categorie: string | null; individuel: boolean }[];
  corbeille: { lien: string; note: string } | null;
}

export function TravailVue({ t }: { t: Travail }) {
  const { user } = useApp();
  return (
    <>
      {t.postes.map((p) => (
        <Bloc key={p.code} titre={p.utilisateur} sous={p.ecranEntree}>
          <div className="ps-grille">{p.indicateur.map((k) => (
            <div key={k.code} className="ps-chiffre"><span className="ps-valeur ps-valeur-grand">{k.valeur ?? 'non mesuré'}{k.valeur !== null && <small> {k.unite}</small>}</span><span className="ps-libelle">{k.libelle}</span>
              <span className="ps-small">Indicateur dominant : {p.indicateurDominant} · <StatusBadge tone={k.statut === 'ATTEINTE' ? 'good' : k.statut === 'NON_ATTEINTE' ? 'critical' : 'neutral'} label={k.statut} /></span></div>
          ))}</div>
          <nav className="ps-menu" aria-label={`Écrans : ${p.utilisateur}`}>{selonRattachement(p.liens.map((l) => ({ ...l, to: l.chemin })), user).map((l) => <Link key={l.chemin} to={l.chemin}>{l.libelle}</Link>)}</nav>
        </Bloc>
      ))}
      <Bloc titre="File de travail — en graphiques" sous="Éléments à traiter, retards et échéances">
        <VisuelsFile file={t.file} enAttente={t.enAttente} />
      </Bloc>
      <Bloc titre="File de travail" sous={`${t.enAttente} élément(s) à traiter`}>
        {t.file.length ? (
          <ul className="ps-liste">{t.file.map((w) => (
            <li key={w.id}><Link to={w.ecran}><strong>{w.objet}</strong></Link> {w.enRetard && <StatusBadge tone="critical" label="En retard" />}
              <span className="ps-small"> {w.module} · déposé le {w.depose.slice(0, 10)}{w.echeance ? ` · échéance ${w.echeance}` : ''} · {w.demandeur}</span></li>
          ))}</ul>
        ) : <EmptyState title="Rien à traiter aujourd’hui" icon="check"><SuiteDuTravail /></EmptyState>}
      </Bloc>
      {t.corbeille && <Bloc titre="Corbeille de décision (séparée)"><p className="ps-small">{t.corbeille.note}</p><Link className="btn btn-secondary btn-sm" to={t.corbeille.lien}>Ouvrir le poste de décision</Link></Bloc>}
    </>
  );
}

export default function PosteTravail() {
  const t = usePosteApi<Travail>('/v1/postes/travail', 'travail');
  return (
    <div className="page page-wide ps-page">
      <PageHead eyebrow="Postes de travail des opérateurs · § 27.13" title="Poste de travail" lead="« Que dois-je traiter aujourd’hui ? » — files de travail, dossiers et outils de saisie ; la décision qui engage reste dans la corbeille, séparée à l’écran." />
      <BandeauHorsLigne depuis={t.horsLigne} />
      {t.loading && !t.data ? <Loading /> : t.error ? <ErrorState error={t.error} onRetry={t.reload} /> : t.data ? <TravailVue t={t.data} /> : null}
    </div>
  );
}
