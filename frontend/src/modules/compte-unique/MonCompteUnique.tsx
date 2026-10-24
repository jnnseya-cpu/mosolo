/**
 * « Mon compte unique » (Cahier, ch. 9) — section de l'espace contribuable (/espace) : tout ce qui est rattaché au
 * compte, dans TOUS les modules (objets, obligations, titres, quittances, recours, mandats, organisations, documents,
 * consentements, niveau de vérification), avec les graphiques de la trousse partagée et un lien vers chaque module.
 * Données servies par GET /v1/compte-unique/me (ou /:taxpayerId pour un mandataire, dans le périmètre du mandat).
 */
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
// Parcours par rôle (29/09/2026) : liens adaptés au compte — un écran que le rôle n'utilise pas n'est pas proposé.
import { LienEcran } from '../../components/LienEcran';
import { formatMoney } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { BarChartViz, DonutViz, KpiGrid, KpiTile } from '../../components/viz';
import { RUBRIQUE_LABELS, toneOf } from './common';
import type { CompteElement, CompteUniqueView } from './types';
import './compte-unique.css';

const NATURE_LABELS: Record<string, string> = {
  PARCELLE: 'Parcelles', BATIMENT: 'Bâtiments', UNITE_LOCATIVE: 'Unités locatives', ACTIVITE: 'Activités', VEHICULE: 'Véhicules', PANNEAU: 'Panneaux', AUTRE: 'Autres objets',
  PLAQUE: 'Plaques (stationnement)', MOTO_WEWA: 'Motos wewa', ETAL: 'Étals',
};

const OBLIGATION_STATUS: Record<string, string> = {
  EMISE: 'Émise', EXIGIBLE: 'Exigible', EN_RETARD: 'En retard', PARTIELLEMENT_PAYEE: 'Partiellement payée', SOLDEE: 'Soldée', ANNULEE: 'Annulée', CONTESTEE: 'Contestée',
};

/** Groupes de rubriques affichés (ordre de lecture du citoyen). */
const GROUPS: { title: string; rubriques: string[] }[] = [
  { title: 'Mes biens, véhicules et activités', rubriques: ['OBJET', 'RELATION', 'BAIL', 'VEHICULE', 'ENTREPRISE', 'ENSEIGNE'] },
  { title: 'Mes obligations, paiements et quittances', rubriques: ['OBLIGATION', 'PAIEMENT', 'QUITTANCE', 'ARRIERE'] },
  { title: 'Mes titres, pass, sessions et démarches', rubriques: ['TITRE', 'PASS', 'SESSION', 'DEMARCHE', 'RECOURS', 'CARTE'] },
  { title: 'Mandats, organisations et rôles', rubriques: ['MANDAT_DONNE', 'MANDAT_RECU', 'ORGANISATION', 'ROLE', 'FICHE_METIER'] },
  { title: 'Documents, consentements et notifications', rubriques: ['DOCUMENT', 'CONSENTEMENT', 'NOTIFICATION'] },
];

export function MonCompteUnique({ taxpayerId, self }: { taxpayerId: string | null; self: boolean }) {
  const { user, fmtDate } = useApp();
  const q = useApi<CompteUniqueView>(taxpayerId ? () => api<CompteUniqueView>(self ? '/v1/compte-unique/me' : `/v1/compte-unique/${encodeURIComponent(taxpayerId)}`) : null, [taxpayerId, self, user?.id]);
  const [filtre, setFiltre] = useState<string | null>(null);
  const v = q.data;
  const elements = useMemo(() => (v?.sections ?? []).flatMap((s) => s.elements.map((e) => ({ ...e, module: s.module, moduleLien: s.lien, moduleTitre: s.titre }))), [v]);

  if (!taxpayerId) return null;
  // Rechargement (changement d'utilisateur) : la vue précédente reste affichée pendant le chargement.
  if (q.loading && !v) return <section className="section"><Loading /></section>;
  if (q.error !== null) return <section className="section"><ErrorState error={q.error} onRetry={q.reload} /></section>;
  if (!v) return null;
  const s = v.synthese;
  const natures = Object.entries(s.objetsParNature).map(([k, n]) => ({ key: k, label: NATURE_LABELS[k] ?? k, value: n }));
  const parStatut = new Map<string, number>();
  for (const o of s.obligationsParStatutEtDevise) parStatut.set(o.statut, (parStatut.get(o.statut) ?? 0) + o.nombre);
  const rubriqueRows = Object.entries(s.parRubrique).filter(([, n]) => n > 0).map(([k, n]) => ({ key: k, label: RUBRIQUE_LABELS[k] ?? k, values: { n } }));
  const shown = filtre ? elements.filter((e) => e.rubrique === filtre) : elements;

  return (
    <section className="section cu" aria-labelledby="sec-cu">
      <div className="section-head">
        <h2 id="sec-cu">Mon compte unique</h2>
        <span className="count">{elements.length}</span>
      </div>
      <p className="small muted">{v.principe}</p>
      {v.viewer === 'mandataire' && (
        <p className="notice" role="note"><Icon name="users" size={16} /> Vue de mandataire : seuls les éléments couverts par le mandat sont affichés{v.mandat && v.mandat.objets !== 'TOUS' ? ` (${v.mandat.objets.length} objet(s))` : ''}.</p>
      )}

      <div className="cu-identity panel">
        <dl className="kv">
          <div><dt>Titulaire</dt><dd>{v.compte.nom} <span className="small muted">({v.compte.nature === 'PERSONNE_MORALE' ? 'personne morale' : 'personne physique'})</span></dd></div>
          <div><dt>Identifiant unique (IUC)</dt><dd className="mono">{v.compte.iuc}</dd></div>
          <div><dt>Téléphone</dt><dd>{v.compte.telephone ?? '—'} {v.compte.telephoneVerifie && <StatusBadge tone="good" label="Vérifié par code" />}</dd></div>
          <div><dt>Niveau de vérification</dt><dd><StatusBadge tone="info" label={v.compte.niveau} /></dd></div>
        </dl>
        {v.identite.niveaux && (
          <ol className="cu-levels" aria-label="Niveaux de vérification et droits ouverts">
            {v.identite.niveaux.map((n) => (
              <li key={n.code} className={n.atteint ? 'cu-level cu-level-on' : 'cu-level'}>
                <StatusBadge tone={n.atteint ? 'good' : 'neutral'} label={n.atteint ? `${n.code} atteint` : n.code} />
                <span className="small"><strong>{n.label}</strong> — {n.rights}</span>
                {!n.atteint && <span className="small muted">Preuve : {n.proof}</span>}
              </li>
            ))}
          </ol>
        )}
        {v.identite.prochainesEtapes && v.identite.prochainesEtapes.length > 0 && (
          <details className="small"><summary>Prochaines étapes pour élever le niveau</summary><ul className="plain-list">{v.identite.prochainesEtapes.map((x) => <li key={x}>{x}</li>)}</ul></details>
        )}
        {v.identite.reutilisation && <p className="small muted"><Icon name="info" size={14} /> {v.identite.reutilisation}</p>}
      </div>

      <KpiGrid max={4} label="Synthèse du compte">
        <KpiTile label="Biens, véhicules et activités" value={(s.parRubrique.OBJET ?? 0) + (s.parRubrique.VEHICULE ?? 0) + (s.parRubrique.ENTREPRISE ?? 0) + (s.parRubrique.ENSEIGNE ?? 0)} />
        <KpiTile label="Obligations" value={s.parRubrique.OBLIGATION ?? 0} sub={s.resteDuParDevise.length ? `Reste dû : ${s.resteDuParDevise.map((m) => m.affichage).join(' · ')}` : 'Rien d’exigible'} />
        <KpiTile label="Titres et pass valides" value={s.titres.valides} sub={`${s.titres.expires} expiré(s) sur ${s.titres.total}`} />
        <KpiTile label="Quittances" value={s.parRubrique.QUITTANCE ?? 0} sub={`${s.parRubrique.RECOURS ?? 0} recours`} />
      </KpiGrid>

      <div className="cu-charts">
        <DonutViz title="Mes objets par nature" centerLabel="objets" slices={natures} emptyText="Aucun objet rattaché" />
        <BarChartViz title="Obligations par statut" orientation="horizontal" series={[{ key: 'n', label: 'Obligations' }]}
          rows={[...parStatut.entries()].map(([k, n]) => ({ key: k, label: OBLIGATION_STATUS[k] ?? k, values: { n } }))} emptyText="Aucune obligation" />
        <BarChartViz title="Éléments du compte par rubrique" orientation="horizontal" series={[{ key: 'n', label: 'Éléments' }]} rows={rubriqueRows} emptyText="Aucun élément" />
      </div>

      {s.obligationsParStatutEtDevise.length > 0 && (
        <table className="data-table compact cu-currency">
          <caption>Obligations par statut et par devise (jamais additionnées entre devises)</caption>
          <thead><tr><th scope="col">Statut</th><th scope="col">Devise</th><th scope="col" className="num">Nombre</th><th scope="col" className="num">Total</th></tr></thead>
          <tbody>{s.obligationsParStatutEtDevise.map((o) => <tr key={`${o.statut}-${o.devise}`}><td>{OBLIGATION_STATUS[o.statut] ?? o.statut}</td><td>{o.devise}</td><td className="num">{o.nombre}</td><td className="num">{formatMoney(o.total)}</td></tr>)}</tbody>
        </table>
      )}

      {s.prochainesEcheances.length > 0 && (
        <div>
          <h3 className="h-sub">Prochaines échéances</h3>
          <ul className="list-rows">{s.prochainesEcheances.map((x) => <li key={x.id} className="list-row"><span>{x.libelle}</span><span className="row-side">{x.montant && formatMoney(x.montant)} <span className="small muted">{fmtDate(x.echeance)}</span></span></li>)}</ul>
        </div>
      )}

      <div className="cu-filters" role="group" aria-label="Filtrer par rubrique">
        <button type="button" className={`chip ${filtre === null ? 'chip-on' : ''}`} aria-pressed={filtre === null} onClick={() => setFiltre(null)}>Tout ({elements.length})</button>
        {rubriqueRows.map((r) => (
          <button key={r.key} type="button" className={`chip ${filtre === r.key ? 'chip-on' : ''}`} aria-pressed={filtre === r.key} onClick={() => setFiltre(filtre === r.key ? null : r.key)}>{r.label} ({r.values.n})</button>
        ))}
      </div>

      {elements.length === 0 ? <EmptyState title="Aucun élément rattaché pour l’instant" /> : (
        GROUPS.map((g) => {
          const items = shown.filter((e) => g.rubriques.includes(e.rubrique));
          if (!items.length) return null;
          return (
            <div key={g.title} className="cu-group">
              <h3 className="h-sub">{g.title} <span className="count">{items.length}</span></h3>
              <ul className="list-rows">
                {items.slice(0, 60).map((e) => <ElementRow key={`${e.module}-${e.rubrique}-${e.id}`} e={e} />)}
              </ul>
              {items.length > 60 && <p className="small muted">{items.length - 60} élément(s) de plus : ouvrir le module concerné.</p>}
            </div>
          );
        })
      )}

      <nav className="cu-modules" aria-label="Modules rattachés au compte">
        {v.sections.filter((x) => x.elements.length > 0 || x.erreur).map((x) => (
          <LienEcran masquer key={x.module} className="chip" to={x.lien}>{x.titre} ({x.elements.length}){x.erreur ? ' — section indisponible' : ''}</LienEcran>
        ))}
        <Link className="chip" to="/espace/biens-relations"><Icon name="building" size={14} /> Mes biens et relations</Link>
      </nav>
    </section>
  );
}

function ElementRow({ e }: { e: CompteElement & { moduleTitre: string; moduleLien: string } }) {
  const { fmtDate } = useApp();
  const loc = useLocation();
  return (
    <li className="list-row cu-row">
      <div className="min0">
        <p className="row-title">{e.libelle}</p>
        <p className="small muted">{RUBRIQUE_LABELS[e.rubrique] ?? e.rubrique} · {e.moduleTitre}{e.date ? ` · ${fmtDate(e.date)}` : ''}{e.echeance ? ` · échéance ${fmtDate(e.echeance)}` : ''}</p>
      </div>
      <div className="row-side">
        {e.montant && <span className="mono small">{formatMoney(e.montant)}</span>}
        {e.statut && <StatusBadge tone={toneOf(e.statut)} label={e.statut} />}
        {/* Aucun bouton quand il ne mènerait qu'à la page déjà ouverte (30/09/2026 : liens « Ouvrir » sans effet). */}
        {(e.lien ?? e.moduleLien) !== loc.pathname && <LienEcran className="btn btn-ghost btn-sm" to={e.lien ?? e.moduleLien} aria-label={`Ouvrir — ${e.libelle}`}>Ouvrir</LienEcran>}
      </div>
    </li>
  );
}
