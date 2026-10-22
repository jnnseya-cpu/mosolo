/**
 * Chemin vers l'acte d'un module sectoriel « acte requis » (29/09/2026) : liste de contrôle lue par le serveur dans les
 * registres existants (points juridiques, règles, fiche du module, titres). Pour chaque étape non accomplie : qui doit
 * agir et, SEULEMENT pour les rôles qui détiennent le droit, un bouton vers l'écran exact où l'étape s'accomplit. Les
 * autres voient qui doit agir. Aucun montant ; aucune bascule manuelle de l'état du module.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ROLES, type RoleCode } from '@mosolo/shared';
import { Icon } from '../../components/Icon';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { useEcranAccessible } from '../../components/LienEcran';

export type EtapeStatut = 'FAIT' | 'EN_COURS' | 'A_FAIRE' | 'BLOQUE' | 'A_QUALIFIER';
export interface EtapeAction { label: string; path: string; roles: string[]; qui: string }
export interface EtapeActe { code: string; kind: string; label: string; statut: EtapeStatut; detail: string; action: EtapeAction | null; automatique?: boolean }
export interface CheminActeView {
  module: string; etat: 'ACTE_REQUIS' | 'ACTE_EN_VIGUEUR'; etatLabel: string; ruleCode: string | null;
  etapes: EtapeActe[]; prochaine: EtapeActe | null; faites: number; total: number; note: string;
}

export const ETAPE_STATUT: Record<EtapeStatut, { label: string; tone: Tone; icon: string }> = {
  FAIT: { label: 'Fait', tone: 'good', icon: 'check' },
  EN_COURS: { label: 'En cours', tone: 'info', icon: 'clock' },
  A_FAIRE: { label: 'À faire', tone: 'warning', icon: 'mark' },
  BLOQUE: { label: 'Bloqué', tone: 'critical', icon: 'x' },
  A_QUALIFIER: { label: 'À rattacher au registre', tone: 'neutral', icon: 'info' },
};

/** Vrai si l'utilisateur détient l'un des rôles habilités pour l'action (même droit que le serveur). */
export function peutAgir(action: { roles: string[] } | null | undefined, roles: readonly string[]): boolean {
  return !!action && action.roles.some((r) => roles.includes(r));
}

/** Libellés des rôles habilités (« Juriste rédacteur ou Juriste vérificateur »). */
export function rolesEnClair(roles: readonly string[]): string {
  return roles.map((r) => ROLES[r as RoleCode] ?? r).join(' ou ');
}

/** Lien interne : ancre de la page (« #sec-declarer ») ou écran de l'application. */
export function LienEcran({ path, children, className = 'btn btn-secondary btn-sm' }: { path: string; children: ReactNode; className?: string }) {
  if (path.startsWith('#')) return <a className={className} href={path}>{children}</a>;
  return <Link className={className} to={path}>{children}</Link>;
}

function ActionEtape({ etape, roles }: { etape: EtapeActe; roles: readonly string[] }) {
  if (etape.statut === 'FAIT') return null;
  if (!etape.action) {
    return <p className="small muted">{etape.automatique ? 'Automatique : aucune action à faire ici.' : 'Conséquence des étapes précédentes.'}</p>;
  }
  return peutAgir(etape.action, roles)
    ? <LienEcran path={etape.action.path}><Icon name="chevronRight" size={14} /> {etape.action.label}</LienEcran>
    : <p className="small"><strong>Qui doit agir :</strong> {etape.action.qui} <span className="muted">({rolesEnClair(etape.action.roles)})</span></p>;
}

export function CheminActe({ chemin, roles }: { chemin: CheminActeView; roles: readonly string[] }) {
  const next = chemin.prochaine;
  return (
    <div className="sec-chemin">
      {next ? (
        <div className="sec-next" aria-label={`Prochaine étape du module ${chemin.module}`}>
          <p className="small"><strong>Prochaine étape</strong> — {next.label} <StatusBadge tone={ETAPE_STATUT[next.statut].tone} label={ETAPE_STATUT[next.statut].label} icon={ETAPE_STATUT[next.statut].icon} /></p>
          <p className="small muted">{next.detail}</p>
          <ActionEtape etape={next} roles={roles} />
        </div>
      ) : <p className="small"><Icon name="check" size={14} /> Toutes les étapes du chemin vers l’acte sont accomplies.</p>}
      <details className="sec-etapes">
        <summary className="small">Chemin vers l’acte — {chemin.faites} étape(s) faite(s) sur {chemin.total}</summary>
        <ol className="sec-checklist">
          {chemin.etapes.map((e) => (
            <li key={e.code} className={`sec-etape sec-${e.statut.toLowerCase()}`}>
              <div className="row-between">
                <span className="small"><strong>{e.label}</strong></span>
                <StatusBadge tone={ETAPE_STATUT[e.statut].tone} label={ETAPE_STATUT[e.statut].label} icon={ETAPE_STATUT[e.statut].icon} />
              </div>
              <p className="small muted">{e.detail}</p>
              <ActionEtape etape={e} roles={roles} />
            </li>
          ))}
        </ol>
        <p className="hint">{chemin.note}</p>
      </details>
    </div>
  );
}

/** Rôles des écrans cibles (mêmes listes que le menu) : un lien n'est proposé qu'à qui peut ouvrir l'écran. */
const TAXPAYER = ['R30', 'R31'];
const FIELD = ['R09', 'R10', 'R11', 'R35'];
const DECIDERS = ['R06', 'R07', 'R11', 'R22', 'R24'];
const FICHES = ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24', 'R30', 'R31', 'R34', 'R35'];
const GRANDS_REDEVABLES = ['R06', 'R07', 'R11', 'R01', 'R02', 'R05', 'R22', 'R23', 'R24'];

export interface Travail { label: string; path: string; roles: string[] }

/**
 * Travaux utiles AVANT l'acte, par module, dans les circuits existants (mêmes circuits, jamais en parallèle) :
 * déclaration du redevable, relevé de terrain, registres de la fiche, démarches de la verticale.
 */
export const TRAVAUX_AVANT_ACTE: Record<string, Travail[]> = {
  '11': [
    { label: 'Contrôler un véhicule par plaque', path: '#sec-terrain', roles: FIELD },
    { label: 'Déclarer une mutation de véhicule (démarches Mobilité)', path: '/services/mobilite', roles: TAXPAYER },
    { label: 'Mes véhicules', path: '/vehicules/mes-vehicules', roles: TAXPAYER },
  ],
  '13': [
    { label: 'Enregistrer un relevé d’embarquement', path: '#sec-terrain', roles: FIELD },
    { label: 'Départs et manifestes (fiche 13)', path: '/verticales/fiches?onglet=13', roles: FICHES },
  ],
  '16': [{ label: 'Sites télécoms et import des listes (fiche 16)', path: '/verticales/fiches?onglet=16', roles: FICHES }],
  '17': [
    { label: 'Déclarer les volumes du mois', path: '#sec-declarer', roles: TAXPAYER },
    { label: 'Rapprocher et décider les déclarations', path: '#sec-declarations', roles: DECIDERS },
    { label: 'Points de livraison (fiche 17)', path: '/verticales/fiches?onglet=17', roles: FICHES },
  ],
  '21': [
    { label: 'Déclarer la billetterie (démarches Événements)', path: '/services/evenements', roles: TAXPAYER },
    { label: 'Recettes par événement (fiche 21)', path: '/verticales/fiches?onglet=21', roles: FICHES },
  ],
  '22': [
    { label: 'Déclarer les sorties de carrière', path: '#sec-declarer', roles: TAXPAYER },
    { label: 'Compter les sorties de camions', path: '#sec-terrain', roles: FIELD },
    { label: 'Rapprocher et décider les déclarations', path: '#sec-declarations', roles: DECIDERS },
    { label: 'Sites de carrière (fiche 22)', path: '/verticales/fiches?onglet=22', roles: FICHES },
  ],
  '23': [
    { label: 'Déclarer des produits forestiers non ligneux', path: '#sec-declarer', roles: TAXPAYER },
    { label: 'Relevé au point de contrôle', path: '#sec-terrain', roles: FIELD },
    { label: 'Rapprocher et décider les déclarations', path: '#sec-declarations', roles: DECIDERS },
    { label: 'Concessions et points de contrôle (fiche 23)', path: '/verticales/fiches?onglet=23', roles: FICHES },
  ],
  '24': [
    { label: 'Enregistrer un relevé d’accostage', path: '#sec-terrain', roles: FIELD },
    { label: 'Embarcations et quais (fiche 24)', path: '/verticales/fiches?onglet=24', roles: FICHES },
  ],
  '25': [
    { label: 'Enregistrer des passages au péage', path: '#sec-terrain', roles: FIELD },
    { label: 'Axes et points de péage (fiche 25)', path: '/verticales/fiches?onglet=25', roles: FICHES },
  ],
  '56': [{ label: 'Cellule des grands redevables', path: '/grands-redevables', roles: GRANDS_REDEVABLES }],
};

export function TravauxAvantActe({ module, roles }: { module: string; roles: readonly string[] }) {
  // 30/09/2026 : un lien n'apparaît que si l'écran est lisible par la personne (rôle ET entité), jamais vers « accès réservé ».
  const accessible = useEcranAccessible();
  const items = (TRAVAUX_AVANT_ACTE[module] ?? []).filter((t) => t.roles.some((r) => roles.includes(r)) && (t.path.startsWith('#') || accessible(t.path)));
  if (!items.length) return null;
  return (
    <div className="sec-travaux">
      <p className="small"><strong>Travail possible dès maintenant (sans montant)</strong></p>
      <div className="row-wrap">{items.map((t) => <LienEcran key={t.label} path={t.path} className="btn btn-ghost btn-sm">{t.label}</LienEcran>)}</div>
    </div>
  );
}
