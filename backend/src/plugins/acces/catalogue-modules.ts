/**
 * Catalogue des MODULES FONCTIONNELS rattachables à une entité (27/09/2026, § 12A) — codes stables :
 *  - `M01` à `M81` : les 81 modules de la Spécification fonctionnelle (titres repris mot pour mot du document source
 *    docs/sources/KINSHASA_MOSOLO_Specification_Fonctionnelle_Modules.docx) ;
 *  - `V-<slug>` : les verticales de la Partie V (catalogue serveur `verticales/catalogue.ts`, repris tel quel).
 *
 * Réutilisation des listes existantes : verticales (`VERTICALS`), fiches de module du module « acces » (reliées par le
 * domaine de compétence `revenueScope`), plan de livraison par versions (`VERSIONS_44`, relié par le nom du module
 * d'extension serveur). Les écrans sont ceux de l'application web (modules/registry.tsx et menu principal).
 *
 * Porteur de recettes (`revenue`) : la compétence d'une entité sur ce domaine passe par le circuit EXISTANT des fiches
 * de module (création, visas, activation, réattribution à deux personnes) — jamais par un simple rattachement.
 * Le domaine de compétence associé à chaque module est PAR DÉFAUT — à confirmer par le maître d'ouvrage.
 */
import { VERSIONS_44 } from '../pilotage/recette-programme/referentiels.js';
import { VERTICALS } from '../verticales/catalogue.js';

export interface CatalogueModule {
  code: string;
  label: string;
  kind: 'MODULE' | 'VERTICALE';
  /** Numéro de la Spécification fonctionnelle (modules) ou modules composant la verticale. */
  numbers: number[];
  revenue: boolean;
  /** Domaine de compétence (fiches de module) — PAR DÉFAUT, à confirmer. */
  revenueScope?: string;
  /** Écrans de l'application web (chemins) concernés par le rattachement. */
  screens: string[];
  /** Modules d'extension serveur (noms de plugin) — reliés au plan de livraison par versions. */
  plugins: string[];
  /** Faux : module d'administration transverse (le rattachement lui-même) — jamais restreint à une entité. */
  linkable: boolean;
}

type Def = [n: number, label: string, screens: string[], opts?: { scope?: string; plugins?: string[]; linkable?: false }];

const MODULES: Def[] = [
  [1, 'Identité et compte contribuable', ['/acces/identite', '/mon-espace/profils', '/recuperation-compte'], { plugins: ['acces', 'socle'] }],
  [2, 'Enrôlement et vérification', ['/citoyen/pieces', '/canaux/enrolement'], { plugins: ['citoyen', 'canaux'] }],
  [3, 'Portail contribuable', ['/espace', '/mes-arrieres', '/mon-espace/situation'], { plugins: ['citoyen'] }],
  [4, 'Application citoyenne Android et iOS', ['/application'], { plugins: ['titres'] }],
  [5, 'Portail web public', ['/simulateurs'], { plugins: ['citoyen'] }],
  [6, 'USSD et SMS', ['/canaux/ussd', '/canaux/whatsapp-sms'], { plugins: ['canaux'] }],
  [7, 'Gestionnaire de relations contribuable–objet', ['/citoyen/relations', '/fiscal/biens'], { plugins: ['citoyen', 'fiscal'] }],
  [8, 'Cadastre fiscal géospatial', ['/citoyen/cadastre', '/fiscal/carte'], { plugins: ['citoyen', 'fiscal'] }],
  [9, 'Intelligence foncière et locative', ['/citoyen/locatif', '/fiscal/anomalies-locatives'], { scope: 'REVENU_LOCATIF', plugins: ['citoyen', 'fiscal'] }],
  [10, 'Registre des activités et patentes', ['/citoyen/activites'], { scope: 'ACTIVITE_COMMERCIALE', plugins: ['citoyen'] }],
  [11, 'Véhicules et circulation', ['/citoyen/vehicules'], { scope: 'VEHICULE', plugins: ['citoyen', 'vehicules-controle'] }],
  [12, 'Autorisations de transport', ['/citoyen/transport'], { scope: 'TRANSPORT_PUBLIC', plugins: ['citoyen'] }],
  [13, 'Embarquement et débarquement', [], { scope: 'EMBARQUEMENT', plugins: ['verticales'] }],
  [14, 'Stationnement public', ['/stationnement', '/stationnement/controle', '/stationnement/regie', '/stationnement/tableau-de-bord'], { scope: 'STATIONNEMENT', plugins: ['parking'] }],
  [15, 'Publicité extérieure', ['/publicite/regie', '/publicite/inspection', '/publicite/tableau-de-bord', '/publicite/contrats'], { scope: 'AFFICHAGE_PUBLICITAIRE', plugins: ['publicite'] }],
  [16, 'Antennes et infrastructures télécoms', [], { scope: 'ANTENNES_TELECOM', plugins: ['verticales'] }],
  [17, 'Boissons, alcools et tabac', [], { scope: 'BOISSONS_TABAC', plugins: ['verticales'] }],
  [18, 'Contribution plastique et environnement', ['/verticales/environnement'], { scope: 'ENVIRONNEMENT', plugins: ['verticales'] }],
  [19, 'Assainissement, voirie et drainage', [], { scope: 'ASSAINISSEMENT_VOIRIE', plugins: ['verticales'] }],
  [20, 'Marchés et domaine public', [], { scope: 'OCCUPATION_DOMAINE_PUBLIC', plugins: ['verticales'] }],
  [21, 'Spectacles et événements', [], { scope: 'SPECTACLES_EVENEMENTS', plugins: ['verticales'] }],
  [22, 'Carrières et recettes minières', [], { scope: 'CARRIERES', plugins: ['verticales'] }],
  [23, 'Recettes forestières', [], { scope: 'RECETTES_FORESTIERES', plugins: ['verticales'] }],
  [24, 'Ports, embarcations et accostage', [], { scope: 'PORTS_ACCOSTAGE', plugins: ['verticales'] }],
  [25, 'Péage provincial', [], { scope: 'PEAGE', plugins: ['verticales'] }],
  [26, 'Moteur de règles juridiques et tarifaires', ['/registre'], { plugins: ['juridique', 'referentiel'], linkable: false }],
  [27, 'Déclaration et liquidation', ['/fiscal/declarations', '/liquidation/derogations', '/fiscal/assiette-2026'], { plugins: ['fiscal'] }],
  [28, 'Orchestration des paiements', ['/tresor/prestataires'], { plugins: ['tresor'] }],
  [29, 'Règlement en trésorerie', ['/tresor'], { plugins: ['tresor'] }],
  [30, 'Rapprochement', ['/tresor/appariements'], { plugins: ['tresor'] }],
  [31, 'Quittances électroniques', ['/preuve'], { plugins: ['preuves'] }],
  [32, 'Arriérés et créances', ['/recouvrement', '/recouvrement/non-valeurs', '/recouvrement/remises'], { plugins: ['recouvrement'] }],
  [33, 'Campagnes de recouvrement', ['/recouvrement/campagnes', '/recouvrement/rendement'], { plugins: ['campagnes', 'recouvrement'] }],
  [34, 'Recensement terrain', ['/fiscal/recensement', '/terrain'], { plugins: ['terrain', 'fiscal'] }],
  [35, 'Inspection et constat', ['/terrain/inspection', '/mes-proces-verbaux'], { plugins: ['terrain'] }],
  [36, 'Gestion des dossiers d’exécution', [], { plugins: ['recouvrement'] }],
  [37, 'Réclamations et recours', ['/recours'], { plugins: ['recouvrement'] }],
  [38, 'Gestion documentaire', ['/documents'], { plugins: ['documents'] }],
  [39, 'Notifications et communication', ['/communication/notifications', '/communications', '/mes-preferences'], { plugins: ['communication'] }],
  [40, 'Renseignement anti-fraude', ['/integrite/renseignement', '/integrite/enquetes'], { plugins: ['integrite', 'integrite-enquetes'] }],
  [41, 'Centre de commandement exécutif', ['/decision/commandement', '/poste-de-decision'], { plugins: ['decision', 'postes'] }],
  [42, 'Tableau de bord régie fiscale', ['/pilotage/tableaux'], { plugins: ['pilotage'] }],
  [43, 'Tableau de bord régie des taxes', [], { plugins: ['pilotage'] }],
  [44, 'Tableaux de bord ministériels', [], { plugins: ['pilotage'] }],
  [45, 'Salle de contrôle finances et trésorerie', [], { plugins: ['tresor'] }],
  [46, 'Audit et investigation', ['/decision/audit', '/audit'], { plugins: ['decision'] }],
  [47, 'Prévision des recettes', ['/pilotage/scenarios'], { plugins: ['planification'] }],
  [48, 'Recommandation d’investissement public', ['/pilotage/projets'], { plugins: ['planification'] }],
  [49, 'Gestion des agents IA', ['/ia', '/ia/journal', '/ia/modeles'], { plugins: ['ia', 'ia-modeles'] }],
  [50, 'Apprentissage et connaissance', ['/apprentissage', '/apprentissage/certifications', '/apprentissage/procedures'], { plugins: ['apprentissage'] }],
  [51, 'Accès et délégations', ['/acces/delegations', '/acces/elevations'], { plugins: ['acces'], linkable: false }],
  [52, 'Intégration et API', [], { plugins: ['catalogue-api'] }],
  [53, 'Administration de la plateforme', [], { plugins: ['plateforme'], linkable: false }],
  [54, 'Transparence publique', ['/transparence'], { plugins: ['pilotage'] }],
  [55, 'Supervision et santé du système', [], { plugins: ['plateforme'], linkable: false }],
  [56, 'Grands redevables', ['/grands-redevables'], { plugins: ['verticales'] }],
  [57, 'Registre des exonérations', ['/fiscal/exonerations'], { plugins: ['fiscal'] }],
  [58, 'Gestion des équipements terrain', ['/terrain/equipements'], { plugins: ['equipements'] }],
  [59, 'Grand livre public', [], { plugins: ['tresor'] }],
  [60, 'Coffre des comptes bénéficiaires', [], { plugins: ['tresor'], linkable: false }],
  [61, 'Moteur de découverte des recettes', ['/opportunites', '/opportunites/recoupement', '/opportunites/maximisation'], { plugins: ['opportunites'] }],
  [62, 'Rapprochement aérien', [], { scope: 'AVIATION', plugins: ['verticales'] }],
  [63, 'Enrôlement assisté et guichets MOSOLO', ['/canaux/contestation'], { plugins: ['canaux'] }],
  [64, 'Serveur vocal interactif multilingue', [], { plugins: ['canaux'] }],
  [65, 'Carte MOSOLO', [], { plugins: ['canaux'] }],
  [66, 'Réseau des points de paiement agréés', ['/canaux/points-supervision', '/canaux/jour-de-caisse', '/canaux/point-agree'], { plugins: ['canaux'] }],
  [67, 'Portail des partenaires et gestion des équipes terrain', ['/terrain/sous-traitants', '/terrain/qualite', '/agents/reserve'], { plugins: ['terrain', 'sanctions'] }],
  [68, 'Vérification publique par code court', ['/verifier'], { plugins: ['preuves'] }],
  [69, 'Ligne de signalement et contrôles mystère', ['/integrite/controles-mystere', '/signaler'], { plugins: ['integrite'] }],
  [70, 'Moteur de titres et de validité', ['/titres/catalogue'], { plugins: ['titres'] }],
  [71, 'Contrôle des titres', ['/titres/controle'], { plugins: ['titres'] }],
  [72, 'Espaces d’entité et configuration des modules', ['/acces/entites'], { plugins: ['acces'], linkable: false }],
  [73, 'Répartition des recettes', ['/pilotage/repartition', '/pilotage/partage-legal'], { plugins: ['repartition', 'partage-legal'] }],
  [74, 'Invitations et gestion des accès', ['/acces/invitations'], { plugins: ['acces'], linkable: false }],
  [75, 'Stationnement intelligent (ParkSmart)', ['/stationnement/parksmart'], { scope: 'STATIONNEMENT', plugins: ['parking'] }],
  [76, 'Billetterie multi-opérateurs (RakaPay)', ['/rakapay/pilotage', '/rakapay/operateurs'], { scope: 'BILLETTERIE_TRANSPORT', plugins: ['rakapay'] }],
  [77, 'Publicité extérieure augmentée (KIN PUB CONTROL)', ['/publicite/carte'], { scope: 'AFFICHAGE_PUBLICITAIRE', plugins: ['publicite'] }],
  [78, 'Hub de réconciliation aérienne (KIN-AVIA FISCUS)', [], { scope: 'AVIATION', plugins: ['verticales'] }],
  [79, 'Plaque fiscale immobilière (NFIU)', [], { scope: 'IMPOT_FONCIER', plugins: ['verticales'] }],
  [80, 'Contrôle de la dépense publique (CALCU)', ['/controle/calcu', '/controle/calcu/organe'], { plugins: ['verticales'] }],
  [81, 'Pass moto-taxis (wewa) — extension de la billetterie RakaPay', ['/rakapay/cooperative'], { scope: 'BILLETTERIE_TRANSPORT', plugins: ['rakapay'] }],
];

/** Domaine de compétence des verticales porteuses de recettes (PAR DÉFAUT — à confirmer). */
const VERTICAL_SCOPE: Record<string, string | undefined> = {
  rakapay: 'BILLETTERIE_TRANSPORT', propriete: 'IMPOT_FONCIER', locatif: 'REVENU_LOCATIF', entreprises: 'ACTIVITE_COMMERCIALE', mobilite: 'VEHICULE',
  stationnement: 'STATIONNEMENT', publicite: 'AFFICHAGE_PUBLICITAIRE', telecom: 'ANTENNES_TELECOM', marches: 'OCCUPATION_DOMAINE_PUBLIC',
  'domaine-public': 'OCCUPATION_DOMAINE_PUBLIC', environnement: 'ENVIRONNEMENT', ports: 'PORTS_ACCOSTAGE', evenements: 'SPECTACLES_EVENEMENTS',
  construction: 'CARRIERES', actifs: 'PATRIMOINE_PROVINCIAL', avia: 'AVIATION', recouvrement: undefined,
};

export const MODULE_CATALOGUE: CatalogueModule[] = [
  ...MODULES.map(([n, label, screens, o = {}]): CatalogueModule => ({
    code: `M${String(n).padStart(2, '0')}`, label, kind: 'MODULE', numbers: [n], revenue: !!o.scope, ...(o.scope ? { revenueScope: o.scope } : {}),
    screens, plugins: o.plugins ?? [], linkable: o.linkable !== false,
  })),
  ...VERTICALS.map((v): CatalogueModule => {
    const scope = VERTICAL_SCOPE[v.slug];
    return {
      code: `V-${v.slug}`, label: v.name, kind: 'VERTICALE', numbers: [...v.modules], revenue: !!scope, ...(scope ? { revenueScope: scope } : {}),
      screens: [`/services/${v.slug}`], plugins: ['verticales'], linkable: true,
    };
  }),
];

export function catalogueModule(code: string): CatalogueModule | undefined {
  return MODULE_CATALOGUE.find((m) => m.code === code);
}

/** Versions du plan de livraison (ch. 44) qui livrent au moins un des modules d'extension du module fonctionnel. */
export function versionsOf(m: CatalogueModule): string[] {
  return VERSIONS_44.filter((v) => v.contenus.some((c) => (c.modules ?? []).some((p) => m.plugins.includes(p)))).map((v) => v.code);
}

/**
 * Ministère de tutelle PAR DÉFAUT de chaque module — à confirmer par le maître d'ouvrage (28/09/2026).
 * Sert UNIQUEMENT au menu des ministres (R04, R05), qui ne voient que les modules de leur ministère et des départements de
 * sa tutelle (régies dirigées par un directeur général, trésor, services) : un rattachement explicite d'un module à une
 * entité (écran « Départements, modules et variables ») l'emporte toujours sur cette valeur par défaut. Les modules
 * transverses (identité, plateforme, IA, audit, intégrité, terrain) n'ont pas de tutelle ministérielle par défaut.
 */
const TUTELLE_FINANCES = [1, 2, 3, 7, 8, 9, 15, 16, 17, 18, 19, 22, 23, 26, 27, 28, 29, 30, 31, 32, 33, 36, 37, 42, 43, 44, 45, 47, 48, 54, 56, 57, 59, 60, 61, 63, 64, 65, 66, 68, 70, 72, 73, 77, 79, 80];
const TUTELLE_TRANSPORTS = [11, 12, 13, 14, 24, 25, 62, 75, 76, 78, 81];
const TUTELLE_ECONOMIE = [10, 20, 21];
const VERTICALES_TUTELLE: Record<string, string> = {
  rakapay: 'MIN-TRANSPORTS', mobilite: 'MIN-TRANSPORTS', stationnement: 'MIN-TRANSPORTS', ports: 'MIN-TRANSPORTS', avia: 'MIN-TRANSPORTS',
  entreprises: 'MIN-ECONOMIE', marches: 'MIN-ECONOMIE', evenements: 'MIN-ECONOMIE',
  propriete: 'MINFIN', locatif: 'MINFIN', publicite: 'MINFIN', telecom: 'MINFIN', 'domaine-public': 'MINFIN', environnement: 'MINFIN',
  construction: 'MINFIN', actifs: 'MINFIN', recouvrement: 'MINFIN',
};
const code = (n: number) => `M${String(n).padStart(2, '0')}`;
export const TUTELLE_PAR_DEFAUT: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(TUTELLE_FINANCES.map((n) => [code(n), 'MINFIN'])),
  ...Object.fromEntries(TUTELLE_TRANSPORTS.map((n) => [code(n), 'MIN-TRANSPORTS'])),
  ...Object.fromEntries(TUTELLE_ECONOMIE.map((n) => [code(n), 'MIN-ECONOMIE'])),
  ...Object.fromEntries(Object.entries(VERTICALES_TUTELLE).map(([s, e]) => [`V-${s}`, e])),
});
