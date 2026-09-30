/**
 * Référentiels du programme — Document maître FR 2 (nouvelle version, reçue le 27/09/2026), chapitres 41 à 48 :
 *  - ch. 41 registre des risques (13 risques, probabilité, impact, traitement) ;
 *  - ch. 42 critères d'acceptation (10) et tests qui les prouvent ;
 *  - ch. 43 carnet de développement (10 récits) et tests de récit ;
 *  - ch. 44 plan de livraison par versions (V0.1 à V3.0) rattaché aux modules de la plateforme ;
 *  - ch. 45 stratégie de tests (9 points) et éléments à exécuter dans le monde réel (suivis, jamais simulés) ;
 *  - ch. 47 plan des 100 premiers jours (6 périodes, actions, responsables) ;
 *  - ch. 48 dix décisions du Gouvernement provincial et synthèse finale (48.2).
 * Textes repris MOT POUR MOT de la source (docs/sources/Document_Maitre_FR_2_nouvelle_version.txt.md). Tout ce que la
 * source ne fixe pas (rôle propriétaire, périodicité de revue, correspondance numérique de l'échelle) est marqué
 * « PAR_DEFAUT — à confirmer par le maître d'ouvrage ». Données pures : l'état (revues, décisions, statuts) vit dans
 * le service.
 */
import type { RoleCode } from '@mosolo/shared';

export const SOURCE_FR2 = 'Document maître FR 2 (nouvelle version, 27/09/2026)';
export const PAR_DEFAUT = 'PAR_DEFAUT — à confirmer par le maître d’ouvrage';

/** Preuve dans le code : fichier et symbole (ou texte) qui doit y figurer. Vérifié par test/programme.test.ts. */
export interface PreuveCode { fichier: string; symbole: string }
/**
 * Preuve par test automatisé : fichier et titre exact du test. Vérifié par test/programme.test.ts.
 * `statut: 'PENDING_MERGE'` : test livré par un autre lot, absent de cette branche — la vérification d'existence le
 * tolère explicitement jusqu'à la fusion (le coordinateur retire le drapeau à la fusion).
 */
export interface PreuveTest { fichier: string; titre: string; statut?: 'PENDING_MERGE'; libelle?: string }

/** Fichier de preuve du lot « postes de décision » (fusionné le 27/09/2026 ; le statut PENDING_MERGE reste admis par le type). */
export const FICHIER_POSTES_DECISION = 'backend/test/postes-decision-acceptation.test.ts';
export const LIBELLE_PREUVE_POSTES = 'preuve : lot postes de décision (fusionné — un test par critère C42-11 à C42-15)';

// ————————————————————————————————————————— ch. 41 — registre des risques —————————————————————————————————————————

/**
 * Échelle qualitative du ch. 41. La source n'emploie que « Moyenne » et « Élevée » (probabilité) et « Moyen »,
 * « Élevé », « Très élevé » (impact) ; les autres paliers servent aux revues. Rangs numériques : PAR_DEFAUT.
 */
export const PROBABILITES = {
  FAIBLE: { libelle: 'Faible', rang: 1 },
  MOYENNE: { libelle: 'Moyenne', rang: 2 },
  ELEVEE: { libelle: 'Élevée', rang: 3 },
  TRES_ELEVEE: { libelle: 'Très élevée', rang: 4 },
} as const;
export const IMPACTS = {
  FAIBLE: { libelle: 'Faible', rang: 1 },
  MOYEN: { libelle: 'Moyen', rang: 2 },
  ELEVE: { libelle: 'Élevé', rang: 3 },
  TRES_ELEVE: { libelle: 'Très élevé', rang: 4 },
} as const;
export type Probabilite = keyof typeof PROBABILITES;
export type Impact = keyof typeof IMPACTS;

/** Criticité = rang P × rang I ; seuils des zones de la carte de chaleur : PAR_DEFAUT. */
export const ZONES_CRITICITE = [
  { zone: 'CRITIQUE', libelle: 'Critique', min: 9 },
  { zone: 'ELEVEE', libelle: 'Élevée', min: 6 },
  { zone: 'MODEREE', libelle: 'Modérée', min: 3 },
  { zone: 'FAIBLE', libelle: 'Faible', min: 0 },
] as const;
export type ZoneCriticite = (typeof ZONES_CRITICITE)[number]['zone'];
export function zoneDe(p: Probabilite, i: Impact): { score: number; zone: ZoneCriticite; libelle: string } {
  const score = PROBABILITES[p].rang * IMPACTS[i].rang;
  const z = ZONES_CRITICITE.find((x) => score >= x.min)!;
  return { score, zone: z.zone, libelle: z.libelle };
}

/** Périodicité de revue d'un risque par une personne (jours) — PAR_DEFAUT. */
export const PERIODICITE_REVUE_JOURS = 90;

export interface MesureTraitement {
  /** Élément du traitement, cité mot pour mot. */
  mesure: string;
  /** CONSTRUIT : contrôle de la plateforme prouvé par code et test ; EXTERNE : action du monde réel, suivie. */
  statut: 'CONSTRUIT' | 'EXTERNE';
  code?: PreuveCode[];
  tests?: PreuveTest[];
  /** Pour EXTERNE : ce que la plateforme offre et ce qui reste à faire hors plateforme. */
  note?: string;
}

export interface RisqueRef {
  code: string;
  risque: string;
  probabilite: Probabilite;
  impact: Impact;
  traitement: string;
  proprietaire: RoleCode;
  mesures: MesureTraitement[];
  /** Risques du registre antérieur (document maître v3.0, § 40) harmonisés avec celui-ci (aucun n'est retiré). */
  registreAnterieur: string[];
}

const T = (fichier: string, titre: string): PreuveTest => ({ fichier: `backend/test/${fichier}`, titre });
const C = (fichier: string, symbole: string): PreuveCode => ({ fichier, symbole });

export const RISQUES_41: RisqueRef[] = [
  {
    code: 'RQ01', risque: 'Référentiel appuyé sur un texte abrogé', probabilite: 'MOYENNE', impact: 'TRES_ELEVE',
    traitement: 'Relevé juridique certifié avant paramétrage, blocage technique sans référence légale valide', proprietaire: 'R16', registreAnterieur: ['R01'],
    mesures: [
      { mesure: 'Relevé juridique certifié avant paramétrage', statut: 'CONSTRUIT', code: [C('backend/src/modules/rules/service.ts', 'SOURCE_NOT_CERTIFIED')], tests: [T('legal.test.ts', 'visas dans l’ordre et par le bon rôle ; source non certifiée bloquée')] },
      {
        mesure: 'blocage technique sans référence légale valide', statut: 'CONSTRUIT',
        code: [C('backend/src/modules/rules/service.ts', 'ABROGATED_INSTRUMENT'), C('backend/src/modules/rules/service.ts', 'INSTRUMENT_NOT_IN_FORCE')],
        tests: [T('legal.test.ts', 'AC-LEG-03 : une règle citant un instrument abrogé ne peut pas être publiée'), T('chaine.test.ts', 'pas de règle sans texte en vigueur : fiche sans référence ou citant un texte inconnu refusée'), T('recette-criteres.test.ts', 'C42-01 — aucune obligation sans règle publiée portant une référence légale valide (test négatif)')],
      },
    ],
  },
  {
    code: 'RQ02', risque: 'Résistance des agents perdant des revenus informels', probabilite: 'ELEVEE', impact: 'ELEVE',
    traitement: 'Primes sur résultats vérifiés, dialogue social préalable, déploiement progressif, rotation des zones', proprietaire: 'R06', registreAnterieur: ['R10'],
    mesures: [
      { mesure: 'Primes sur résultats vérifiés', statut: 'CONSTRUIT', code: [C('backend/src/plugins/sanctions/commissions.ts', 'OBJET_NON_ENREGISTRE')], tests: [T('terrain.test.ts', 'rémunération indicative sur livrables vérifiés, indépendante des paiements des contribuables')], note: 'Versement conditionné au régime légal des primes (point juridique J10, décision 9).' },
      { mesure: 'dialogue social préalable', statut: 'EXTERNE', note: 'Action du monde réel : concertation avec les agents et leurs représentants, hors plateforme.' },
      { mesure: 'déploiement progressif', statut: 'CONSTRUIT', code: [C('backend/src/plugins/pilotage/planification/model.ts', 'PILOT_COMMUNES')], tests: [T('planification.test.ts', 'critères du § 45.3 par groupe ; revues signées aux jalons, vérifiables, immuables')] },
      { mesure: 'rotation des zones', statut: 'CONSTRUIT', code: [C('backend/src/plugins/terrain/qualite-fraude.ts', 'rotation()')], tests: [T('terrain-qualite-detecteurs.test.ts', 'rotation des zones : alerte à l’affectation au-delà de la durée maximale, sans blocage par défaut')] },
    ],
  },
  {
    code: 'RQ03', risque: 'Rejet politique ou social de la pression fiscale', probabilite: 'MOYENNE', impact: 'ELEVE',
    traitement: 'Valeur d’abord (attestation de bail, échéancier, quittance unique), publication des réalisations financées', proprietaire: 'R02', registreAnterieur: ['R03'],
    mesures: [
      { mesure: 'attestation de bail', statut: 'CONSTRUIT', code: [C('backend/src/plugins/fiscal/clearances.ts', 'issueLeaseAttestation')], tests: [T('fiscal.test.ts', 'délivrée aux parties du bail, vérifiable sans nom ni loyer ; refusée à un tiers')] },
      { mesure: 'échéancier', statut: 'CONSTRUIT', code: [C('backend/src/plugins/recouvrement/service.ts', 'échéancier')], tests: [T('recouvrement.test.ts', 'aucun échéancier sans acte l’autorisant')], note: 'Échéancier opposable seulement après acte (décision 7, point J14).' },
      { mesure: 'quittance unique', statut: 'CONSTRUIT', code: [C('backend/src/modules/receipts/service.ts', 'PROVISOIRE')], tests: [T('payments.test.ts', 'AC-PAY-04 : confirmation vérifiée → CONFIRME + quittance provisoire ; définitive au rapprochement')] },
      { mesure: 'publication des réalisations financées', statut: 'CONSTRUIT', code: [C('backend/src/plugins/pilotage/transparency.ts', 'FundedProjectsSection')], tests: [T('planification.test.ts', 'l’IA propose des scénarios classés ; l’autorité décide ; financement sur acte ; publication trimestrielle sans donnée personnelle')] },
    ],
  },
  {
    code: 'RQ04', risque: 'Refus ou retard des protocoles de données', probabilite: 'ELEVEE', impact: 'ELEVE',
    traitement: 'Recensement terrain en parallèle, négociation au niveau du Gouvernement provincial, séquencement par source', proprietaire: 'R03', registreAnterieur: ['R04'],
    mesures: [
      { mesure: 'Recensement terrain en parallèle', statut: 'CONSTRUIT', code: [C('backend/src/plugins/terrain/service.ts', 'submitFinding')], tests: [T('terrain.test.ts', 'constat géolocalisé : écart au point enregistré signalé (jamais rejeté), rejeu idempotent, aucune dette')] },
      { mesure: 'négociation au niveau du Gouvernement provincial', statut: 'EXTERNE', note: 'Décision n° 5 du registre des décisions (ch. 48) ; connecteurs désactivés tant que J13 et J8 ne sont pas tranchés.' },
      { mesure: 'séquencement par source', statut: 'CONSTRUIT', code: [C('backend/src/plugins/juridique/gates.ts', 'recoupementDonneesAutorise'), C('backend/src/plugins/fiscal/census.ts', 'recordProvenance')], tests: [T('juridique.test.ts', 'trancher un point : acte (référence + empreinte), deux personnes distinctes, journalisé ; les fonctions affichent ce qu’elles attendent')] },
    ],
  },
  {
    code: 'RQ05', risque: 'Double imposition province / commune / pouvoir central', probabilite: 'MOYENNE', impact: 'ELEVE',
    traitement: 'Référentiel unique avec autorité compétente, refus des doublons sur un même fait générateur', proprietaire: 'R16', registreAnterieur: [],
    mesures: [
      { mesure: 'Référentiel unique avec autorité compétente', statut: 'CONSTRUIT', code: [C('backend/src/modules/rules/routes.ts', 'competentAuthority: z.string().min(1)')], tests: [T('juridique.test.ts', 'RECETTE_CENTRALE exclue ; RECETTE_ETD non liquidée par la province ; l’espace ETD reste possible')] },
      { mesure: 'refus des doublons sur un même fait générateur', statut: 'CONSTRUIT', code: [C('backend/src/plugins/fiscal/declarations.ts', 'aucune double facturation')], tests: [T('integration.test.ts', 'jamais de double perception : seconde liquidation annuelle refusée ; une autre entité est bloquée et un arbitrage s’ouvre')] },
    ],
  },
  {
    code: 'RQ06', risque: 'Changement institutionnel (nouvelles régies)', probabilite: 'ELEVEE', impact: 'MOYEN',
    traitement: 'Régie paramétrable, rôles reconfigurables sans redéveloppement', proprietaire: 'R08', registreAnterieur: ['R06'],
    mesures: [
      { mesure: 'Régie paramétrable, rôles reconfigurables sans redéveloppement', statut: 'CONSTRUIT', code: [C('backend/src/plugins/acces/service.ts', 'entities')], tests: [T('acces.test.ts', 'sème entités, fiches de module et un arbitrage de compétence ouvert'), T('acces.test.ts', 'AC-INV-02 : pas d’élévation, pas de sortie de périmètre, droit d’inviter explicite, rôles incompatibles refusés')] },
    ],
  },
  {
    code: 'RQ07', risque: 'Dépendance au prestataire', probabilite: 'MOYENNE', impact: 'ELEVE',
    traitement: 'Séquestre du code, formats ouverts, transfert de compétences contractuel, test annuel de réversibilité', proprietaire: 'R05', registreAnterieur: ['R07'],
    mesures: [
      { mesure: 'Séquestre du code', statut: 'EXTERNE', note: 'Clause contractuelle et dépôt chez un tiers (décision n° 10).' },
      { mesure: 'formats ouverts', statut: 'CONSTRUIT', code: [C('backend/src/plugins/pilotage/exports.ts', 'ExportSigner'), C('backend/src/persistence/backup.ts', 'createBackup')], tests: [T('pilotage.test.ts', 'CSV + JSON, empreinte SHA-256, signature HMAC vérifiable ; altération détectée ; export journalisé')] },
      { mesure: 'transfert de compétences contractuel', statut: 'EXTERNE', note: 'Clause contractuelle ; la plateforme fournit l’apprentissage et la certification des utilisateurs (§ 24).' },
      { mesure: 'test annuel de réversibilité', statut: 'EXTERNE', note: 'Exercice annuel par un tiers ; la restauration complète est prouvée par test (sauvegarde signée, restauration, vérification de la chaîne).', tests: [T('socle.test.ts', 'sauvegarde signée : vérification, refus si altérée ou mauvaise clé, restauration puis vérification de la chaîne d’audit')] },
    ],
  },
  {
    code: 'RQ08', risque: 'Incident de sécurité ou fuite de données', probabilite: 'MOYENNE', impact: 'TRES_ELEVE',
    traitement: 'Zéro confiance, chiffrement, tests d’intrusion, plan d’incident, sauvegarde immuable', proprietaire: 'R28', registreAnterieur: ['R05'],
    mesures: [
      { mesure: 'Zéro confiance', statut: 'CONSTRUIT', code: [C('backend/src/core/policy.ts', 'export function authorize')], tests: [T('audit-access.test.ts', 'ABAC : agent de terrain limité à son territoire, accès minimal sans montant')] },
      { mesure: 'chiffrement', statut: 'CONSTRUIT', code: [C('frontend/src/lib/offlineQueue.ts', 'AES-GCM')], tests: [{ fichier: 'frontend/test/securite-acces-audit.test.tsx', titre: 'les données de mission sont chiffrées au repos (AES-GCM) et relues après rechargement' }] },
      { mesure: 'tests d’intrusion', statut: 'EXTERNE', note: 'Test d’intrusion par un tiers indépendant : suivi TEST_INTRUSION_TIERS de la stratégie de tests (ch. 45).' },
      { mesure: 'plan d’incident', statut: 'CONSTRUIT', code: [C('backend/src/plugins/integrite/service.ts', 'incident')], tests: [T('integrite.test.ts', 'déclaration, propriétaire, cycle, DPO obligatoire si données personnelles, clôture avec preuve')] },
      { mesure: 'sauvegarde immuable', statut: 'CONSTRUIT', code: [C('backend/src/persistence/backup.ts', 'verifyBackup')], tests: [T('securite-acces-audit.test.ts', 'copie WORM, racine quotidienne horodatée et publiée, contrôle d’intégrité ; toute divergence alerte')] },
    ],
  },
  {
    code: 'RQ09', risque: 'Fraude interne aux postes sensibles', probabilite: 'MOYENNE', impact: 'TRES_ELEVE',
    traitement: 'Séparation des fonctions, quatre yeux, accès temporaire, audit indépendant', proprietaire: 'R22', registreAnterieur: ['R02', 'R10'],
    mesures: [
      { mesure: 'Séparation des fonctions', statut: 'CONSTRUIT', code: [C('backend/src/core/policy.ts', 'export function assertDistinctPerson'), C('shared/src/domain.ts', 'INCOMPATIBLE_ROLES')], tests: [T('legal.test.ts', 'AC-LEG-02 : la même personne ne peut pas rédiger et publier')] },
      { mesure: 'quatre yeux', statut: 'CONSTRUIT', code: [C('backend/src/plugins/integrite/gouvernance/circuits.ts', 'export const CIRCUITS')], tests: [T('treasury-vault.test.ts', 'AC-BEN-01 : deux approbateurs distincts, vérification hors bande, effet après 72 h')] },
      { mesure: 'accès temporaire', statut: 'CONSTRUIT', code: [C('backend/src/plugins/acces/elevations.ts', 'juste-à-temps')], tests: [T('securite-acces-audit.test.ts', 'demande motivée → approbation par une autre personne → rôle temporaire → session enregistrée → expiration automatique')] },
      { mesure: 'audit indépendant', statut: 'EXTERNE', note: 'Mission d’un auditeur indépendant ; la plateforme lui ouvre un accès en lecture (rôle R23) et la piste d’audit par dossier.', tests: [T('pilotage.test.ts', 'chronologie fusionnée audit + grand livre + quittances + délivrances, contrôles sans trou, accès réservé')] },
    ],
  },
  {
    code: 'RQ10', risque: 'Imprécision GPS et contestations de localisation', probabilite: 'ELEVEE', impact: 'MOYEN',
    traitement: 'Tolérance paramétrée, preuve photographique, validation hiérarchique', proprietaire: 'R09', registreAnterieur: ['R11'],
    mesures: [
      { mesure: 'Tolérance paramétrée', statut: 'CONSTRUIT', code: [C('backend/src/plugins/terrain/service.ts', 'toleranceFor')], tests: [T('terrain.test.ts', 'indicateurs de production et tolérance GPS par commune (paramètre de la régie)')] },
      { mesure: 'preuve photographique', statut: 'CONSTRUIT', code: [C('backend/src/plugins/terrain/service.ts', 'SANS_PHOTO')], tests: [T('carnet-recits.test.ts', 'R43-04 — agent recenseur : objet non enregistré créé hors ligne (GPS, photo, catégorie), sans effet fiscal, synchronisé sans perte')] },
      { mesure: 'validation hiérarchique', statut: 'CONSTRUIT', code: [C('backend/src/plugins/terrain/service.ts', 'reviewFinding')], tests: [T('terrain.test.ts', 'validation indépendante : ni l’auteur, ni sa structure ; constat revu figé')] },
    ],
  },
  {
    code: 'RQ11', risque: 'Connectivité insuffisante sur le terrain', probabilite: 'ELEVEE', impact: 'MOYEN',
    traitement: 'Hors ligne d’abord, synchronisation différée, files locales', proprietaire: 'R27', registreAnterieur: ['R08'],
    mesures: [
      { mesure: 'Hors ligne d’abord', statut: 'CONSTRUIT', code: [C('backend/src/plugins/titres/service.ts', 'offlinePack')], tests: [T('titres.test.ts', 'paquet signé Ed25519 ; lot HMAC du terminal ; reconfirmation ; double usage détecté entre hors ligne et en ligne')] },
      { mesure: 'synchronisation différée', statut: 'CONSTRUIT', code: [C('backend/src/modules/field/routes.ts', '/v1/field-sync/batches')], tests: [T('field-appeals.test.ts', 'lot signé accepté ; terminal révoqué refusé ; signature invalide refusée')] },
      { mesure: 'files locales', statut: 'CONSTRUIT', code: [C('frontend/src/lib/offlineQueue.ts', 'export function updateQueue')], tests: [{ fichier: 'frontend/test/recette-hors-ligne.test.ts', titre: 'journée complète de mission hors réseau : aucune saisie perdue, relue après rechargement, synchronisée une seule fois' }] },
    ],
  },
  {
    code: 'RQ12', risque: 'Surdimensionnement technique', probabilite: 'MOYENNE', impact: 'ELEVE',
    traitement: 'Monolithe modulaire, périmètre pilote restreint, portes de phase', proprietaire: 'R27', registreAnterieur: ['R17'],
    mesures: [
      { mesure: 'Monolithe modulaire', statut: 'CONSTRUIT', code: [C('backend/src/plugins/index.ts', 'DEFAULT_PLUGINS')], tests: [T('integration.test.ts', 'chaque module est construit, semé et exposé ; la chaîne d’audit reste intègre')] },
      { mesure: 'périmètre pilote restreint', statut: 'CONSTRUIT', code: [C('backend/src/plugins/pilotage/planification/model.ts', 'PILOT_COMMUNES')], tests: [T('planification.test.ts', 'critères du § 45.3 par groupe ; revues signées aux jalons, vérifiables, immuables')] },
      { mesure: 'portes de phase', statut: 'CONSTRUIT', code: [C('backend/src/plugins/pilotage/planification/model.ts', 'PILOT_MILESTONES')], tests: [T('planification.test.ts', 'critères du § 45.3 par groupe ; revues signées aux jalons, vérifiables, immuables')], note: 'Revues signées aux jalons du pilote ; les portes de phase de la feuille de route relèvent du plan de phases (ch. 35–37).' },
    ],
  },
  {
    code: 'RQ13', risque: 'Promesses de recettes non tenues', probabilite: 'MOYENNE', impact: 'ELEVE',
    traitement: 'Base de référence mesurée, scénarios, communication prudente', proprietaire: 'R05', registreAnterieur: ['R17'],
    mesures: [
      { mesure: 'Base de référence mesurée', statut: 'CONSTRUIT', code: [C('backend/src/plugins/pilotage/planification/model.ts', 'BASELINE_METRICS')], tests: [T('planification.test.ts', 'RANV « non mesurée » sans base certifiée ; import, certification à deux personnes, puis RANV calculée et ventilée')] },
      { mesure: 'scénarios', statut: 'CONSTRUIT', code: [C('backend/src/plugins/pilotage/planification/model.ts', 'SCENARIOS')], tests: [T('planification.test.ts', 'prudent = conservateur, transformationnel = ambitieux ; hypothèses datées et sourcées ; sensibilité ; exemples marqués')] },
      { mesure: 'communication prudente', statut: 'EXTERNE', note: 'Discipline de communication du Gouvernement ; la plateforme n’affiche que des recettes rapprochées et marque « non mesuré » ce qui ne l’est pas.', tests: [T('pilotage.test.ts', 'onze niveaux, mesurés sur le socle ; potentiel et disponible déclarés non mesurés ; jamais additionnés')] },
    ],
  },
];

// ————————————————————————————————————————— ch. 42 — critères d'acceptation —————————————————————————————————————————

export interface CritereAcceptation {
  code: string; critere: string; preuves: PreuveTest[]; obligatoire?: string;
  /** Origine du libellé lorsqu'il ne vient pas du ch. 42 du Document maître FR 2 (critères ajoutés ensuite). */
  origine?: string;
  /** Phrase de la source qui fonde le critère (citée mot pour mot). */
  fondement?: string;
}

const R = (titre: string): PreuveTest => T('recette-criteres.test.ts', titre);

export const CRITERES_42: CritereAcceptation[] = [
  {
    code: 'C42-01', critere: 'Aucune obligation ne peut être créée sans règle publiée portant une référence légale valide : test négatif obligatoire.', obligatoire: 'Test négatif',
    preuves: [R('C42-01 — aucune obligation sans règle publiée portant une référence légale valide (test négatif)'), T('legal.test.ts', 'AC-LEG-01 : une règle A_VERIFIER ne liquide pas (422) et la tentative est journalisée'), T('chaine.test.ts', 'pas d’obligation sans règle validée : liquidation sur une règle non ACTIVE refusée (journalisée)'), T('legal.test.ts', 'AC-LEG-03 : une règle citant un instrument abrogé ne peut pas être publiée')],
  },
  {
    code: 'C42-02', critere: 'Aucune quittance ne peut être générée sans confirmation serveur à serveur d’un prestataire agréé.',
    preuves: [R('C42-02 — aucune quittance sans confirmation serveur à serveur d’un prestataire agréé'), T('payments.test.ts', 'AC-PAY-02 : signature invalide rejetée + alerte'), T('chaine.test.ts', 'pas de quittance sans paiement confirmé : rappel non signé refusé, relevé sans confirmation non apparié')],
  },
  {
    code: 'C42-03', critere: 'Aucun compte bénéficiaire ne peut être modifié par un seul utilisateur, quel que soit son rôle.',
    preuves: [R('C42-03 — aucun compte bénéficiaire modifié par un seul utilisateur, quel que soit son rôle'), T('treasury-vault.test.ts', 'AC-BEN-01 : deux approbateurs distincts, vérification hors bande, effet après 72 h'), T('treasury-vault.test.ts', 'personne d’autre ne peut proposer ni approuver')],
  },
  {
    code: 'C42-04', critere: 'Aucun événement d’audit ne peut être modifié ou supprimé, y compris par le super-administrateur : test d’altération obligatoire.', obligatoire: 'Test d’altération',
    preuves: [R('C42-04 — aucun événement d’audit modifié ou supprimé, même par le super-administrateur (test d’altération)'), T('audit-access.test.ts', 'AC-AUD-01 : chaîne intègre, puis altération « en base » détectée par /v1/audit/verify'), T('audit-access.test.ts', 'suppression d’un enregistrement ou troncature détectée ; aucune route de modification')],
  },
  {
    code: 'C42-05', critere: 'Toute consultation d’un dossier individuel est journalisée avec acteur, motif et horodatage.',
    preuves: [R('C42-05 — toute consultation d’un dossier individuel est journalisée avec acteur, motif et horodatage'), T('acces.test.ts', 'motif de consultation : bris de glace hors périmètre (MFA, alerte, durée limitée), récusation des proches')],
  },
  {
    code: 'C42-06', critere: 'L’application terrain fonctionne sans réseau pendant une journée complète de mission et synchronise sans perte.',
    preuves: [
      { fichier: 'frontend/test/recette-hors-ligne.test.ts', titre: 'journée complète de mission hors réseau : aucune saisie perdue, relue après rechargement, synchronisée une seule fois' },
      R('C42-06 — journée complète hors réseau : constats capturés toute la journée, synchronisés sans perte ni doublon'),
      T('field-appeals.test.ts', 'deux agents divergents sur un même champ : les deux constats conservés, conflit ouvert'),
    ],
  },
  {
    code: 'C42-07', critere: 'Le rapprochement quotidien produit des files d’exception exploitables et traçables.',
    preuves: [R('C42-07 — le rapprochement quotidien produit des files d’exception exploitables et traçables'), T('treasury-vault.test.ts', 'les lignes non appariées deviennent des exceptions (crédit orphelin, mauvais compte, montant)'), T('tresor.test.ts', 'parcours complet : affectation → en cours → justificatif → résolution avec mise en suspens → validation à quatre yeux')],
  },
  {
    code: 'C42-08', critere: 'La vérification publique d’une quittance ne divulgue aucune donnée personnelle au-delà du nécessaire.',
    preuves: [R('C42-08 — la vérification publique d’une quittance ne divulgue aucune donnée personnelle'), T('payments.test.ts', 'AC-RCP-01 : la vérification publique ne renvoie que des données minimales')],
  },
  {
    code: 'C42-09', critere: 'Un recours déposé est horodaté, affecté et suivi jusqu’à décision motivée.',
    preuves: [R('C42-09 — un recours est horodaté, affecté et suivi jusqu’à décision motivée'), T('recouvrement.test.ts', 'délais calculés, accusé horodaté, pièces par empreinte dédoublonnées, historique personnel, effet suspensif décidé par R21'), T('field-appeals.test.ts', 'décideur ≠ instructeur ; décision favorable = obligation rectificative, originale conservée')],
  },
  {
    code: 'C42-10', critere: 'Les tableaux de bord distinguent explicitement potentiel, constaté, encaissé, réglé, rapproché et disponible.',
    preuves: [R('C42-10 — les tableaux de bord distinguent les six états : potentiel, constaté, encaissé, réglé, rapproché, disponible'), T('pilotage.test.ts', 'onze niveaux, mesurés sur le socle ; potentiel et disponible déclarés non mesurés ; jamais additionnés')],
  },
  // Critères 11 à 15 (ch. 42 porté à 15 critères, 27/09/2026) : postes de décision (Cahier nouvelle version, ch. 27), texte
  // du ch. 42 transmis par le maître d'ouvrage. Preuve : backend/test/postes-decision-acceptation.test.ts (lot fusionné —
  // drapeau PENDING_MERGE retiré à la fusion), un test par critère, titré du texte du critère.
  ...([
    { code: 'C42-11', critere: 'Une autorité ouvrant la plateforme sans formation identifie en moins de quatre-vingt-dix secondes ce qui attend sa décision et ce qui ne va pas dans son périmètre.', fondement: 'Une autorité qui ouvre la plateforme pour la première fois, sans formation et sans accompagnement, doit pouvoir dire en moins de quatre-vingt-dix secondes ce qu’on attend d’elle et ce qui ne va pas dans sa ville. (ch. 27.2)', partielles: [] },
    { code: 'C42-12', critere: 'Aucun écran d’accueil d’un poste de décision n’affiche de donnée fiscale individuelle, y compris celui du Gouverneur.', fondement: 'aucune donnée fiscale individuelle sur un écran d’accueil, y compris celui du Gouverneur ; (ch. 27.12)', partielles: [T('pilotage.test.ts', 'tableaux par profil : bons rôles, agrégats sans donnée personnelle')] },
    { code: 'C42-13', critere: 'Aucun poste de décision ne permet de modifier une dette, un paiement, une quittance ou un compte bénéficiaire : test négatif obligatoire pour chaque profil d’autorité.', obligatoire: 'Test négatif par profil d’autorité', fondement: 'aucune action financière directe : on approuve une orientation, on ne modifie ni une dette, ni un paiement, ni un compte bénéficiaire depuis un poste de décision ; (ch. 27.12)', partielles: [T('audit-access.test.ts', 'AC-ACC-02 : le Gouverneur voit les agrégats et ne peut modifier aucune donnée financière'), T('treasury-vault.test.ts', 'personne d’autre ne peut proposer ni approuver')] },
    { code: 'C42-14', critere: 'Tout montant affiché sur un poste de décision porte son état, sa date et, le cas échéant, son taux de conversion, y compris après export.', fondement: 'Les exports reprennent ces mentions ; un chiffre sorti de la plateforme ne doit jamais perdre son état ni sa date. (ch. 27.10)', partielles: [T('pilotage.test.ts', 'CSV + JSON, empreinte SHA-256, signature HMAC vérifiable ; altération détectée ; export journalisé')] },
    { code: 'C42-15', critere: 'Toute décision prise, refusée, déléguée ou différée depuis une corbeille est motivée et enregistrée au journal d’audit avec son auteur.', fondement: 'Approuver · Refuser · Déléguer · Demander un complément | Quatre issues, toutes motivées et journalisées (ch. 27.3)', partielles: [] },
  ] as { code: string; critere: string; obligatoire?: string; fondement: string; partielles: PreuveTest[] }[]).map((c): CritereAcceptation => ({
    code: c.code, critere: c.critere, ...(c.obligatoire ? { obligatoire: c.obligatoire } : {}), fondement: c.fondement,
    origine: 'Critère ajouté au ch. 42 (27/09/2026) par le maître d’ouvrage ; fondé sur le Cahier (nouvelle version), ch. 27 — postes de décision',
    preuves: [{ fichier: FICHIER_POSTES_DECISION, titre: `« ${c.critere} »`, libelle: LIBELLE_PREUVE_POSTES }, ...c.partielles],
  })),
];

// ————————————————————————————————————————— ch. 43 — carnet de développement —————————————————————————————————————————

export interface Recit { code: string; recit: string; criteres: string; preuves: PreuveTest[]; construitIci?: string }
const K = (titre: string): PreuveTest => T('carnet-recits.test.ts', titre);

export const RECITS_43: Recit[] = [
  { code: 'R43-01', recit: 'En tant que Kinois, je veux créer un compte avec mon téléphone pour voir ce que je dois', criteres: 'Code à usage unique ; pièce d’identité facultative au niveau N0 ; aucune obligation affichée sans objet rattaché', preuves: [K('R43-01 — Kinois : compte par téléphone et code à usage unique, N0 sans pièce, aucune obligation sans objet rattaché')] },
  { code: 'R43-02', recit: 'En tant que bailleur, je veux déclarer mes unités louées pour régulariser mon IRL', criteres: 'Une unité par déclaration ; calcul affiché avec taux, retenue et référence de l’arrêté ; pièce justificative optionnelle', preuves: [K('R43-02 — bailleur : déclaration IRL d’une unité, calcul avec taux, retenue et référence de l’arrêté, pièce facultative')], construitIci: 'Bloc « calcul » (taux, retenue, arrêté) et pièce justificative facultative ajoutés à la déclaration.' },
  { code: 'R43-03', recit: 'En tant que locataire, je veux enregistrer mon bail et obtenir une attestation', criteres: 'Attestation générée avec QR ; notification au bailleur ; aucune donnée sensible exposée', preuves: [K('R43-03 — locataire : bail enregistré, bailleur notifié, attestation avec QR sans donnée sensible')] },
  { code: 'R43-04', recit: 'En tant qu’agent recenseur, je veux créer un objet non enregistré hors ligne', criteres: 'Objet provisoire avec GPS, photo, catégorie ; aucun effet fiscal avant qualification ; synchronisation sans perte', preuves: [K('R43-04 — agent recenseur : objet non enregistré créé hors ligne (GPS, photo, catégorie), sans effet fiscal, synchronisé sans perte')], construitIci: 'Catégorie de l’objet non enregistré ajoutée au constat terrain (scellée).' },
  { code: 'R43-05', recit: 'En tant que contrôleur, je veux vérifier une plaque et connaître la situation', criteres: 'Réponse en moins de 3 secondes en ligne ; statut minimal hors ligne ; journalisation de la consultation', preuves: [K('R43-05 — contrôleur : plaque vérifiée en moins de 3 s en ligne, statut minimal hors ligne, consultation journalisée')] },
  { code: 'R43-06', recit: 'En tant que juriste, je veux publier une règle après validation', criteres: 'Impossible de créer, valider et publier par la même personne ; version et dates obligatoires', preuves: [K('R43-06 — juriste : ni création, ni validation, ni publication par la même personne ; version et dates obligatoires')] },
  { code: 'R43-07', recit: 'En tant que comptable public, je veux rapprocher les règlements du jour', criteres: 'Import de relevé ; appariement automatique ; file d’exception ; aucune modification silencieuse', preuves: [K('R43-07 — comptable public : import de relevé, appariement automatique, file d’exception, aucune modification silencieuse')] },
  { code: 'R43-08', recit: 'En tant que Gouverneur, je veux voir l’écart entre assignation et rapproché par commune', criteres: 'Carte et tableau ; distinction des six états ; exportation signée', preuves: [K('R43-08 — Gouverneur : écart assignation / rapproché par commune, six états distingués, exportation signée vérifiable')], construitIci: 'Exportation signée de la carte des écarts (avec les six états par commune) et carte schématique des 24 communes.' },
  { code: 'R43-09', recit: 'En tant qu’auditeur, je veux reconstituer une chaîne complète pour un objet', criteres: 'De la création de l’objet à la comptabilisation, avec acteurs, horodatages et preuves', preuves: [K('R43-09 — auditeur : chaîne complète d’un objet, de la création à la comptabilisation, avec acteurs, horodatages et preuves')] },
  { code: 'R43-10', recit: 'En tant que contribuable, je veux contester une donnée erronée', criteres: 'Formulaire typé ; accusé horodaté ; suivi du délai légal ; décision motivée', preuves: [K('R43-10 — contribuable : contestation typée, accusé horodaté, délai légal suivi, décision motivée')], construitIci: 'Affectation du recours à la file d’instruction de l’entité administratrice dès le dépôt.' },
];

// ————————————————————————————————————————— ch. 44 — plan de livraison par versions —————————————————————————————————————————

/** Preuve de construction vérifiée à l'exécution : services du socle et modules d'extension chargés. */
export interface ContenuVersion { contenu: string; socle?: string[]; modules?: string[]; note?: string }
export interface VersionRef { code: string; version: string; public: string; /** Cellule « Contenu » citée mot pour mot. */ contenuSource: string; contenus: ContenuVersion[] }

export const VERSIONS_44: VersionRef[] = [
  {
    code: 'V0.1', version: 'V0.1 socle interne', public: 'Équipes internes',
    contenuSource: 'Identité, objets, référentiel, audit',
    contenus: [
      { contenu: 'Identité', socle: ['taxpayers', 'users'], modules: ['acces', 'socle'] },
      { contenu: 'objets', socle: ['objects'], modules: ['fiscal'] },
      { contenu: 'référentiel', socle: ['rules'], modules: ['juridique', 'referentiel'] },
      { contenu: 'audit', socle: ['audit'], modules: ['integrite-securite', 'chaine'] },
    ],
  },
  {
    code: 'V0.5', version: 'V0.5 pilote restreint', public: 'Une commune pilote',
    contenuSource: 'Déclaration, liquidation, paiement mobile, quittance, application terrain',
    contenus: [
      { contenu: 'Déclaration', modules: ['fiscal'] },
      { contenu: 'liquidation', socle: ['assessment'] },
      { contenu: 'paiement mobile', socle: ['payments'], modules: ['canaux'] },
      { contenu: 'quittance', socle: ['receipts'] },
      { contenu: 'application terrain', socle: ['field'], modules: ['terrain'] },
    ],
  },
  {
    code: 'V1.0', version: 'V1.0 pilote complet', public: 'Régies et Gouvernement provincial',
    contenuSource: 'Quatre communes, tableaux de bord, rapprochement, recours',
    contenus: [
      { contenu: 'Quatre communes', modules: ['planification'], note: 'Pilote de 180 jours : Gombe, Limete, Kalamu, Ngaliema.' },
      { contenu: 'tableaux de bord', modules: ['pilotage'] },
      { contenu: 'rapprochement', socle: ['treasury'], modules: ['tresor'] },
      { contenu: 'recours', socle: ['appeals'] },
    ],
  },
  {
    code: 'V1.5', version: 'V1.5 campagne', public: 'Contribuables des communes pilotes',
    contenuSource: 'Déclarations pré-remplies, relances, quitus numérique',
    contenus: [
      { contenu: 'Déclarations pré-remplies', modules: ['fiscal', 'campagnes'] },
      { contenu: 'relances', modules: ['recouvrement'] },
      { contenu: 'quitus numérique', modules: ['fiscal'], note: 'Quitus informatif tant que l’acte de conditionnalité (J6, décision 8) n’est pas certifié.' },
    ],
  },
  {
    code: 'V2.0', version: 'V2.0 extension', public: 'Ville',
    contenuSource: 'Nouvelles communes, grands redevables, publicité, antennes, domaine public',
    contenus: [
      { contenu: 'Nouvelles communes', modules: ['planification'], note: 'Les 24 communes sont au référentiel territorial ; l’extension est une décision humaine après évaluation.' },
      { contenu: 'grands redevables', modules: ['verticales'] },
      { contenu: 'publicité', modules: ['publicite'] },
      { contenu: 'antennes', modules: ['verticales'] },
      { contenu: 'domaine public', modules: ['verticales'] },
    ],
  },
  {
    code: 'V2.5', version: 'V2.5 intelligence', public: 'Régies et audit',
    contenuSource: 'Agents IA de priorisation, prévision, détection de fraude',
    contenus: [
      { contenu: 'Agents IA de priorisation', modules: ['ia', 'opportunites'] },
      { contenu: 'prévision', modules: ['planification', 'ia'] },
      { contenu: 'détection de fraude', modules: ['integrite', 'integrite-detecteurs'] },
    ],
  },
  {
    code: 'V3.0', version: 'V3.0 généralisation', public: 'Ville et public',
    contenuSource: '24 communes, affectation et transparence publique',
    contenus: [
      { contenu: '24 communes', modules: ['pilotage'] },
      { contenu: 'affectation', modules: ['planification', 'repartition'] },
      { contenu: 'transparence publique', modules: ['pilotage'] },
    ],
  },
];

/** États de mise en service d'une version (décision d'une personne, sur preuve) — distincts de la construction. */
export const ETATS_VERSION = { PREVUE: 'Prévue', EN_RECETTE: 'En recette', EN_SERVICE: 'En service' } as const;
export type EtatVersion = keyof typeof ETATS_VERSION;

// ————————————————————————————————————————— ch. 45 — stratégie de tests —————————————————————————————————————————

export interface SuiviExterneRef { code: string; libelle: string; responsable: string }
export interface PointStrategie { code: string; point: string; statut: 'CONSTRUIT' | 'PARTIEL' | 'EXTERNE'; preuves: (PreuveTest | PreuveCode)[]; suivis: string[]; note: string }

/** Éléments qui exigent une exécution dans le monde réel : suivis par statut, jamais simulés. */
export const SUIVIS_EXTERNES: SuiviExterneRef[] = [
  { code: 'VALIDATION_JEUX_JURIDIQUES', libelle: 'Validation des jeux de cas juridiques par les juristes provinciaux', responsable: 'Service juridique provincial' },
  { code: 'COMPARAISON_DOSSIERS_REELS', libelle: 'Liquidation comparée à des dossiers réels anonymisés des campagnes précédentes', responsable: 'Régies et programme' },
  { code: 'RECETTE_PRESTATAIRES', libelle: 'Tests de bout en bout du paiement avec chaque prestataire, en environnement de recette', responsable: 'Trésor et prestataires de paiement' },
  { code: 'CHARGE_PIC_FIN_JANVIER', libelle: 'Exécution du test de charge sur l’infrastructure cible, calé sur le pic de fin janvier', responsable: 'Exploitation' },
  { code: 'TEST_INTRUSION_TIERS', libelle: 'Test d’intrusion externe par un tiers indépendant', responsable: 'Responsable sécurité' },
  { code: 'ACCESSIBILITE_TERMINAUX', libelle: 'Tests d’accessibilité et d’usage sur terminaux d’entrée de gamme et connexions lentes', responsable: 'Programme' },
  { code: 'RECETTE_UTILISATEUR_AGENTS', libelle: 'Recette utilisateur avec agents réels dans une commune, avant toute mise en production', responsable: 'Programme et régie' },
  { code: 'REPETITION_REPRISE_SINISTRE', libelle: 'Répétition de la reprise après sinistre sur l’infrastructure réelle', responsable: 'Exploitation' },
];
export const ETATS_SUIVI = { A_PLANIFIER: 'À planifier', PLANIFIE: 'Planifié', REALISE: 'Réalisé', ECHEC: 'En échec — à reprendre' } as const;
export type EtatSuivi = keyof typeof ETATS_SUIVI;

export const STRATEGIE_45: PointStrategie[] = [
  { code: 'S45-1', point: 'Tests unitaires et d’intégration sur le moteur de règles, avec jeux de cas juridiques validés par les juristes provinciaux.', statut: 'PARTIEL', suivis: ['VALIDATION_JEUX_JURIDIQUES'],
    preuves: [T('juridique.test.ts', 'publication bloquée sans cas, cas non validé, cas en échec ou sans échantillon ; résultats conservés avec la version'), T('legal.test.ts', 'respecte priorités, parenthèses, max/min et décimaux exacts'), C('backend/src/modules/rules/legal-tests.ts', 'export')],
    note: 'Le circuit des cas juridiques (validation par un juriste avant publication) est construit et testé ; la validation effective des jeux par les juristes provinciaux est un acte réel, suivi.' },
  { code: 'S45-2', point: 'Tests de liquidation comparés à des dossiers réels anonymisés des campagnes précédentes.', statut: 'EXTERNE', suivis: ['COMPARAISON_DOSSIERS_REELS'],
    preuves: [T('misc.test.ts', 'liquidation déterministe d’une règle certifiée avec entrées décimales')],
    note: 'Aucun dossier réel n’est disponible dans le dépôt : la liquidation déterministe est prouvée ; la comparaison aux dossiers anonymisés exige les données des campagnes précédentes.' },
  { code: 'S45-3', point: 'Tests de bout en bout du paiement avec chaque prestataire, en environnement de recette, y compris scénarios d’échec, de doublon et de rappel frauduleux.', statut: 'PARTIEL', suivis: ['RECETTE_PRESTATAIRES'],
    preuves: [T('payments.test.ts', 'AC-PAY-02 : signature invalide rejetée + alerte'), T('payments.test.ts', 'montant ou référence incohérents → rejet + alerte, aucune quittance ; second paiement → DOUBLON'), T('titres.test.ts', 'référence expirée sans paiement ⇒ commande close et obligation annulée (contre-écriture) ; paiement échoué idem'), T('recette-criteres.test.ts', 'S45-3 — paiement de bout en bout : échec, doublon et rappel frauduleux, sans quittance indue')],
    note: 'Scénarios d’échec, de doublon et de rappel frauduleux construits et testés contre le simulateur signé ; la recette avec chaque prestataire réel est suivie.' },
  { code: 'S45-4', point: 'Tests de charge calés sur les pics de campagne de fin janvier.', statut: 'PARTIEL', suivis: ['CHARGE_PIC_FIN_JANVIER'],
    preuves: [C('tools/charge/pic-fin-janvier.mjs', 'PIC_FACTEUR'), C('tools/charge/pic-fevrier.k6.js', 'pic_fevrier')],
    note: 'Scripts de charge (Node seul et k6) exécutables contre un serveur local ; jamais lancés en intégration continue. L’exécution sur l’infrastructure cible est suivie.' },
  { code: 'S45-5', point: 'Tests hors ligne : journée complète sans réseau, perte d’appareil, conflit de synchronisation.', statut: 'CONSTRUIT', suivis: [],
    preuves: [{ fichier: 'frontend/test/recette-hors-ligne.test.ts', titre: 'journée complète de mission hors réseau : aucune saisie perdue, relue après rechargement, synchronisée une seule fois' }, T('field-appeals.test.ts', 'lot signé accepté ; terminal révoqué refusé ; signature invalide refusée'), T('field-appeals.test.ts', 'deux agents divergents sur un même champ : les deux constats conservés, conflit ouvert')],
    note: 'Journée complète, terminal perdu (révoqué) et conflit de synchronisation couverts.' },
  { code: 'S45-6', point: 'Tests de sécurité : intrusion externe, élévation de privilèges, tentative d’altération du journal d’audit, exfiltration massive.', statut: 'PARTIEL', suivis: ['TEST_INTRUSION_TIERS'],
    preuves: [T('acces.test.ts', 'AC-INV-02 : pas d’élévation, pas de sortie de périmètre, droit d’inviter explicite, rôles incompatibles refusés'), T('recette-criteres.test.ts', 'C42-04 — aucun événement d’audit modifié ou supprimé, même par le super-administrateur (test d’altération)'), T('securite-acces-audit.test.ts', 'lecture massive de données personnelles : alerte DLP au-delà du seuil'), T('securite-acces-audit.test.ts', 'petit périmètre : export signé historique, filigrané ; au-delà du seuil : trois visas, paquet chiffré, filigrané, expirant'), T('recette-criteres.test.ts', 'S45-6 — élévation de privilèges refusée : un rôle ne s’attribue ni ne s’accorde de droits')],
    note: 'Élévation, altération et exfiltration testées ; l’intrusion externe relève d’un tiers indépendant (suivi).' },
  { code: 'S45-7', point: 'Tests d’accessibilité et d’usage sur terminaux d’entrée de gamme et connexions lentes.', statut: 'PARTIEL', suivis: ['ACCESSIBILITE_TERMINAUX'],
    preuves: [{ fichier: 'frontend/test/recette-programme.test.tsx', titre: 'accessibilité : chaque écran du programme a un titre, des tableaux légendés et des commandes étiquetées' }, { fichier: 'frontend/test/autosave-status.test.tsx', titre: 'annonce « Enregistré à HH:MM » (aria-live polite)' }],
    note: 'Contrôles automatiques d’accessibilité (titres, légendes, étiquettes, annonces) ; l’essai sur terminaux d’entrée de gamme et connexions lentes est un acte réel, suivi.' },
  { code: 'S45-8', point: 'Recette utilisateur avec agents réels dans une commune, avant toute mise en production.', statut: 'EXTERNE', suivis: ['RECETTE_UTILISATEUR_AGENTS'], preuves: [],
    note: 'Ne peut être simulée : suivie jusqu’à sa réalisation, preuve (procès-verbal) enregistrée par empreinte.' },
  { code: 'S45-9', point: 'Répétition de la reprise après sinistre avec restauration complète et vérification d’intégrité.', statut: 'PARTIEL', suivis: ['REPETITION_REPRISE_SINISTRE'],
    preuves: [T('socle.test.ts', 'sauvegarde signée : vérification, refus si altérée ou mauvaise clé, restauration puis vérification de la chaîne d’audit'), C('backend/src/persistence/backup-cli.ts', 'restore')],
    note: 'Sauvegarde signée, restauration complète et vérification de la chaîne d’audit construites et testées (npm run db:backup / db:restore / db:verify) ; la répétition sur l’infrastructure réelle est suivie.' },
];

// ————————————————————————————————————————— ch. 47 — plan des 100 premiers jours —————————————————————————————————————————

export interface ActionCentJours { id: string; action: string; lien?: string }
export interface PeriodeCentJours { code: string; jours: string; debut: number; fin: number; responsable: string; /** Cellule « Actions » citée mot pour mot. */ actionsSource: string; actions: ActionCentJours[] }

/** Actions citées mot pour mot : la cellule « Actions » de la source (actionsSource) est découpée à ses séparateurs. */
export const PLAN_100_JOURS_47: PeriodeCentJours[] = [
  { code: 'J001-015', jours: '1 à 15', debut: 1, fin: 15, responsable: 'Gouverneur et ministre provincial des Finances', actionsSource: 'Décision provinciale, nomination du directeur de programme et du comité de pilotage, lettre de mission', actions: [
    { id: 'J001-015.a', action: 'Décision provinciale', lien: 'Registre des décisions (ch. 48), décisions 1 et 2' },
    { id: 'J001-015.b', action: 'nomination du directeur de programme et du comité de pilotage', lien: 'Gouvernance du programme (ch. 35–37)' },
    { id: 'J001-015.c', action: 'lettre de mission' },
  ] },
  { code: 'J016-030', jours: '16 à 30', debut: 16, fin: 30, responsable: 'Services juridiques, régies, programme', actionsSource: 'Relevé juridique certifié sur la base de l’Ordonnance-loi n° 18/004 et de l’édit en vigueur ; inventaire des systèmes et bases existants ; base de référence des recettes', actions: [
    { id: 'J016-030.a', action: 'Relevé juridique certifié sur la base de l’Ordonnance-loi n° 18/004 et de l’édit en vigueur', lien: 'Registre juridique et points J1–J35' },
    { id: 'J016-030.b', action: 'inventaire des systèmes et bases existants' },
    { id: 'J016-030.c', action: 'base de référence des recettes', lien: 'Base de référence auditée (§ 38.1)' },
  ] },
  { code: 'J031-045', jours: '31 à 45', debut: 31, fin: 45, responsable: 'Comité de pilotage', actionsSource: 'Signature des protocoles de données prioritaires ; sélection des communes pilotes ; cadrage de l’architecture et de la sécurité', actions: [
    { id: 'J031-045.a', action: 'Signature des protocoles de données prioritaires', lien: 'Points J13 et J8 ; décision 5' },
    { id: 'J031-045.b', action: 'sélection des communes pilotes', lien: 'Pilote de 180 jours ; décision 6' },
    { id: 'J031-045.c', action: 'cadrage de l’architecture et de la sécurité' },
  ] },
  { code: 'J046-060', jours: '46 à 60', debut: 46, fin: 60, responsable: 'Programme et régies', actionsSource: 'Paramétrage des premières fiches de recettes ; conventions avec les prestataires de paiement ; recrutement des agents', actions: [
    { id: 'J046-060.a', action: 'Paramétrage des premières fiches de recettes', lien: 'Registre des règles (quatre visas)' },
    { id: 'J046-060.b', action: 'conventions avec les prestataires de paiement', lien: 'Point J9 ; stratégie de tests S45-3' },
    { id: 'J046-060.c', action: 'recrutement des agents' },
  ] },
  { code: 'J061-080', jours: '61 à 80', debut: 61, fin: 80, responsable: 'Programme', actionsSource: 'Développement du socle ; formation et certification des agents recenseurs ; préparation des terminaux', actions: [
    { id: 'J061-080.a', action: 'Développement du socle' },
    { id: 'J061-080.b', action: 'formation et certification des agents recenseurs', lien: 'Apprentissage et certification (§ 24)' },
    { id: 'J061-080.c', action: 'préparation des terminaux' },
  ] },
  { code: 'J081-100', jours: '81 à 100', debut: 81, fin: 100, responsable: 'Programme, sécurité, régie', actionsSource: 'Recette technique et test d’intrusion ; démarrage du recensement dans la première commune ; premier tableau de bord en service', actions: [
    { id: 'J081-100.a', action: 'Recette technique et test d’intrusion', lien: 'Stratégie de tests : TEST_INTRUSION_TIERS' },
    { id: 'J081-100.b', action: 'démarrage du recensement dans la première commune', lien: 'Missions de terrain' },
    { id: 'J081-100.c', action: 'premier tableau de bord en service', lien: 'Tableaux par profil' },
  ] },
];
export const ETATS_ACTION = { A_FAIRE: 'À faire', EN_COURS: 'En cours', FAITE: 'Faite', BLOQUEE: 'Bloquée' } as const;
export type EtatAction = keyof typeof ETATS_ACTION;

// ————————————————————————————————————————— ch. 48 — décisions requises —————————————————————————————————————————

export interface LienDeblocage {
  /** Ce que la décision débloque ou conditionne dans la plateforme. */
  libelle: string;
  /** Contrôle vérifié à l'exécution par le service (état calculé, jamais forcé par la décision). */
  controle: 'OL_13_001_REFUSEE' | 'IRL_TAUX_CERTIFIES' | 'RECOUPEMENT_DONNEES' | 'PILOTE_COMMUNES' | 'ECHEANCIERS_MOBILE_MONEY' | 'QUITUS_CONDITIONNE' | 'ESPECES_AGENTS_ZERO' | 'COMMISSIONS_VERSEMENT' | 'CLE_37A_ACTE_REQUIS' | 'AUCUN';
}
export interface DecisionRef { numero: number; decision: string; debloque: LienDeblocage[]; contradiction?: { avec: string; texte: string; comportement: string } }

export const CONTRADICTION_SIGNALEE = 'Contradiction signalée au maître d’ouvrage — arbitrage attendu';

export const DECISIONS_48: DecisionRef[] = [
  { numero: 1, decision: 'Approuver KINSHASA MOSOLO comme système unique de recensement, de liquidation, de paiement, de contrôle et d’audit des recettes provinciales.', debloque: [{ libelle: 'Désignation de la plateforme comme système de référence (aucun effet technique automatique)', controle: 'AUCUN' }] },
  { numero: 2, decision: 'Désigner l’autorité porteuse et installer le comité de pilotage, avec un mandat écrit.', debloque: [{ libelle: 'Gouvernance du programme et comités (ch. 35–37) ; actions J1–15 du plan des 100 jours', controle: 'AUCUN' }] },
  { numero: 3, decision: 'Ordonner la refondation du référentiel sur l’Ordonnance-loi n° 18/004 du 13 mars 2018 et sur l’édit budgétaire en vigueur, en écartant expressément l’Ordonnance-loi n° 13/001 abrogée.', debloque: [{ libelle: 'Le référentiel des règles refuse toute règle citant l’OL 13/001 (instrument ABROGÉ, publication bloquée)', controle: 'OL_13_001_REFUSEE' }] },
  { numero: 4, decision: 'Faire certifier par les services juridiques les taux applicables, notamment le taux de l’impôt sur les revenus locatifs et la retenue par rang de localité.', debloque: [{ libelle: 'Fiches IRL (22 % ; retenue 20 % / 15 %) au statut À VÉRIFIER : simulation non opposable jusqu’à certification (point J3)', controle: 'IRL_TAUX_CERTIFIES' }] },
  { numero: 5, decision: 'Autoriser la signature des protocoles d’échange de données avec les distributeurs d’énergie et d’eau, le registre des immatriculations, les opérateurs télécoms et les brasseries.', debloque: [{ libelle: 'Recoupement avec les données des partenaires (points J13 et J8)', controle: 'RECOUPEMENT_DONNEES' }] },
  { numero: 6, decision: 'Approuver les quatre communes pilotes et l’objectif de campagne de février 2027.', debloque: [{ libelle: 'Pilote de 180 jours : Gombe, Limete, Kalamu, Ngaliema et communes témoins', controle: 'PILOTE_COMMUNES' }] },
  { numero: 7, decision: 'Adopter l’acte autorisant le paiement fractionné par voie mobile pour l’impôt foncier et l’impôt sur les revenus locatifs.', debloque: [{ libelle: 'Paiement fractionné par monnaie mobile : reste « acte requis » (point J14) jusqu’à l’acte', controle: 'ECHEANCIERS_MOBILE_MONEY' }] },
  { numero: 8, decision: 'Étendre l’exigence du quitus fiscal numérique aux permis de bâtir, aux mutations foncières et aux mutations de véhicules.', debloque: [{ libelle: 'Quitus : informatif tant que l’acte de conditionnalité n’est pas certifié (point J6)', controle: 'QUITUS_CONDITIONNE' }] },
  { numero: 9, decision: 'Interdire formellement toute manipulation d’espèces par les agents dans les circuits couverts par la plateforme et fixer le régime légal des primes de performance.', debloque: [{ libelle: 'Indicateur « Manipulations d’espèces par les agents » (cible zéro)', controle: 'ESPECES_AGENTS_ZERO' }, { libelle: 'Versement des primes en attente du régime légal (point J10)', controle: 'COMMISSIONS_VERSEMENT' }] },
  {
    numero: 10, decision: 'Retenir un modèle contractuel hybride, sans pourcentage automatique sur les recettes publiques, et exiger le séquestre du code source et la réversibilité.',
    debloque: [{ libelle: 'Clé de répartition du § 37A : acte requis, simulation seulement avant l’acte (comportement inchangé)', controle: 'CLE_37A_ACTE_REQUIS' }],
    contradiction: {
      avec: '§ 37A (modèle du maître d’ouvrage : 10 % promoteur, 10 % tutelle, 10 % agents, 70 % Gouvernement provincial, exécution automatique après acte)',
      texte: CONTRADICTION_SIGNALEE,
      comportement: 'Le comportement du § 37A n’est pas modifié : clé ACTE_REQUIS, simulation avant l’acte, exécution automatique après l’acte et la convention. La décision 10 est enregistrée telle quelle ; l’arbitrage appartient au maître d’ouvrage.',
    },
  },
];

export const STATUTS_DECISION = { A_PRENDRE: 'À prendre', PRISE: 'Prise', REFUSEE: 'Refusée' } as const;
export type StatutDecision = keyof typeof STATUTS_DECISION;

/** Synthèse finale (48.2), citée mot pour mot. */
export const SYNTHESE_48_2: { objet: string; position: string }[] = [
  { objet: 'Pilote', position: '180 jours à Gombe, Limete, Kalamu et Ngaliema, calé sur la campagne de février' },
  { objet: 'Gouvernance', position: 'Comité de pilotage présidé par le ministère provincial des Finances, contrôle indépendant trimestriel, comité juridique permanent' },
  { objet: 'Catégories budgétaires initiales', position: 'Cadrage et juridique ; développement du socle ; hébergement souverain ; équipements terrain ; formation ; communication ; cybersécurité et tests ; audit indépendant ; exploitation' },
  { objet: 'Gisements les plus élevés', position: 'Revenus locatifs ; impôt foncier ; taxe de consommation sur les boissons et le tabac ; véhicules ; publicité et antennes ; domaine public et marchés' },
  { objet: 'Contrôles anti-fraude les plus forts', position: 'Zéro espèces pour les agents ; comptes bénéficiaires verrouillés à double validation ; quittance vérifiable publiquement ; journal d’audit en ajout seul avec sauvegarde indépendante' },
  { objet: 'Validations juridiques critiques', position: 'Nomenclature en vigueur ; taux et retenues ; valeur de la quittance électronique ; base des échéanciers ; partage de données ; habilitation des agrégateurs ; régime des primes' },
  { objet: 'Prochaine action', position: 'Signer la décision de lancement et convoquer le comité de pilotage dans les quinze jours, afin d’engager le relevé juridique et le recensement avant la campagne de février' },
];

export const DEVISE_FR2 = 'KINSHASA MOSOLO — chaque contribuable identifié, chaque activité localisée, chaque obligation légalement calculée, chaque paiement vérifiable et chaque franc public traçable.';

// ——————————————————————— Programme routier du Gouvernorat (30/09/2026, annonce du Cabinet du Gouverneur) ———————————————————————

/**
 * Programme routier annoncé par le Gouvernorat le 30/09/2026 (communiqué transmis par le maître d'ouvrage) : 160 km de
 * routes livrés, plus de 600 km en cours. Chiffres ANNONCÉS, repris tels quels — à confirmer par le maître d'ouvrage
 * (rapport technique ou acte) ; aucune donnée inventée. Les recettes liées à la route (péage provincial, droits de voirie,
 * taxe de circulation) sont MISES EN REGARD du programme, à titre indicatif : aucune affectation automatique de
 * recettes aux travaux (l'affectation relève du budget et de l'acte).
 */
export interface IndicateurRoutier { code: string; libelle: string; valeur: number; unite: 'km'; qualificatif: string }
export interface LigneRecetteRoutiere { code: string; libelle: string; /** Mots du code ou du libellé de la fiche de règle (insensible à la casse). */ motsCles: string; /** Modules dont les titres (reçus, passages) sont rattachés à la ligne. */ modules: string[] }
export const PROGRAMME_ROUTIER = {
  code: 'GOUV-ROUTES',
  intitule: 'Programme routier du Gouvernorat (construction et réhabilitation de routes)',
  source: 'Annonce du Cabinet du Gouverneur, 30/09/2026 (transmise par le maître d’ouvrage)',
  statut: 'Chiffres annoncés — à confirmer par le maître d’ouvrage (rapport technique ou acte)',
  indicateurs: [
    { code: 'KM_LIVRES', libelle: 'Routes livrées', valeur: 160, unite: 'km', qualificatif: 'annoncé' },
    { code: 'KM_EN_COURS', libelle: 'Routes en cours de travaux', valeur: 600, unite: 'km', qualificatif: 'plus de 600 km (annoncé)' },
  ] as IndicateurRoutier[],
  lignesRecettes: [
    { code: 'PEAGE', libelle: 'Péage provincial (module 25)', motsCles: 'péage|peage', modules: ['25'] },
    { code: 'VOIRIE', libelle: 'Droits de voirie (réservations, chantiers, occupation)', motsCles: 'voirie', modules: [] },
    { code: 'CIRCULATION', libelle: 'Taxe spéciale de circulation routière (module 11)', motsCles: 'circulation', modules: ['11'] },
  ] as LigneRecetteRoutiere[],
  avertissement: 'Mise en regard indicative : les recettes routières ne sont pas affectées automatiquement aux travaux ; l’affectation relève du budget provincial et de l’acte.',
} as const;
