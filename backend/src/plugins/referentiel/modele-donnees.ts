/**
 * Modèle de données conceptuel (Document maître FR 2, nouvelle version, ch. 30) — PREUVE VIVANTE du noyau :
 * pour chaque entité du tableau du ch. 30, la finalité, les relations, la classification de confidentialité, le cycle de
 * vie du Cahier et sa CORRESPONDANCE avec les états réellement portés par le code, avec les effectifs courants par état
 * (lus dans les dépôts, sans donnée personnelle). Les ensembles d'états de la plateforme sont vérifiés à la compilation
 * (exhaustivité par rapport aux types du code) ; un test vérifie que chaque état du Cahier a au moins un état de la
 * plateforme. La durée de conservation détaillée relève du dictionnaire de données (livrable de phase 1) : elle est
 * affichée « par défaut — à confirmer par le maître d'ouvrage » tant qu'elle n'est pas arrêtée.
 */
import {
  REQUIRED_APPROVALS, type LegalInstrumentStatus, type ObligationStatus, type PaymentStatus, type ReceiptStatus, type RuleStatus, type VerificationLevel,
} from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { LEASE_STATES, leaseStateOf, lifecycleOf, OBJECT_LIFECYCLE_STATES, type LeaseState, type ObjectLifecycleState } from '../../modules/objects/service.js';

/** Vérifie à la compilation qu'une liste couvre exactement un type d'états. */
type Exhaustive<T extends string, L extends readonly T[]> = Exclude<T, L[number]> extends never ? L : never;
const exhaustive = <T extends string>() => <const L extends readonly T[]>(l: Exhaustive<T, L>): L => l;

export const OBLIGATION_STATES = exhaustive<ObligationStatus>()(['EMISE', 'EXIGIBLE', 'PARTIELLEMENT_PAYEE', 'SOLDEE', 'EN_RETARD', 'CONTESTEE', 'ANNULEE', 'ADMISE_EN_NON_VALEUR']);
export const PAYMENT_STATES = exhaustive<PaymentStatus>()(['INITIE', 'CONFIRME', 'REGLE', 'RAPPROCHE', 'ECHOUE', 'DOUBLON', 'CONTREPASSE', 'REMBOURSE', 'CONTESTE']);
export const RECEIPT_STATES = exhaustive<ReceiptStatus>()(['PROVISOIRE', 'DEFINITIVE', 'ANNULEE', 'REMPLACEE', 'SUSPECTE', 'CONTREPASSEE', 'REMBOURSEE']);
export const RULE_STATES = exhaustive<RuleStatus>()(['A_VERIFIER', 'BROUILLON', 'REVUE_JURIDIQUE', 'REVUE_FINANCIERE', 'APPROUVEE', 'PUBLIEE', 'ACTIVE', 'SUSPENDUE', 'EXPIREE', 'ABROGEE', 'ARCHIVEE']);
export const LEGAL_TEXT_STATES = exhaustive<LegalInstrumentStatus>()(['A_VERIFIER', 'EN_VIGUEUR', 'MODIFIE', 'ABROGE']);
export const VERIFICATION_LEVELS = exhaustive<VerificationLevel>()(['N0', 'N0A', 'N1', 'N2', 'N3']);
/** États d'un compte de travail (plugin « acces », `AccountStatus`). */
export const ACCOUNT_STATES = ['ATTENTE_VALIDATION', 'ATTENTE_SECRETS', 'ACTIF', 'SUSPENDU', 'REVOQUE', 'EXPIRE'] as const;
/** États d'un contribuable : statut de compte (ACTIF/FUSIONNE) combiné au niveau de vérification. */
export const TAXPAYER_STATES = ['ACTIF', 'FUSIONNE'] as const;
export const PROBATIVE_STATES = ['DECLARE', 'OBSERVE', 'VERIFIE', 'CONTESTE'] as const;
export const APPEAL_STATES = ['DEPOSEE', 'PROPOSITION', 'ACCEPTEE', 'PARTIELLEMENT_ACCEPTEE', 'REJETEE'] as const;

export type Confidentiality =
  | 'Personnel' | 'Personnel sensible' | 'Fiscal' | 'Fiscal sensible' | 'Interne' | 'Interne sensible' | 'Public' | 'Public après publication'
  | 'Financier' | 'Financier sensible' | 'Semi-public' | 'Public agrégé' | 'Audit, inaltérable';

export interface LifecycleMapping {
  /** État tel que nommé au Cahier (ch. 30). */
  cahier: string;
  /** États correspondants de la plateforme (codes du code source). */
  platform: string[];
  note?: string;
}

export interface EntityRow {
  code: string;
  entity: string;
  purpose: string;
  relations: string;
  confidentiality: Confidentiality;
  /** Cycle de vie fixé par le Cahier (absent : le Cahier ne fixe que les relations). */
  cahierLifecycle: LifecycleMapping[] | null;
  /** États portés par la plateforme (constantes du code). */
  platformStates: readonly string[];
  /** Où l'entité vit dans le code. */
  source: string;
  /** Actions du journal d'audit qui tracent l'entité (préfixes). */
  audit: string[];
  retention: string;
}

const RETENTION_DEFAULT = 'Par défaut — à confirmer par le maître d’ouvrage (dictionnaire de données, livrable de phase 1)';
const R = (r: Omit<EntityRow, 'retention'> & { retention?: string }): EntityRow => ({ retention: RETENTION_DEFAULT, ...r });

/** Noyau du ch. 30 : 29 lignes (une par ligne du tableau du Cahier). */
export const DATA_MODEL: EntityRow[] = [
  R({ code: 'UTILISATEUR', entity: 'Utilisateur', purpose: 'Accès au système', relations: 'Lié à Identité, Rôles, Appareils', confidentiality: 'Personnel',
    cahierLifecycle: [
      { cahier: 'actif', platform: ['ACTIF'] },
      { cahier: 'suspendu', platform: ['SUSPENDU'] },
      { cahier: 'clos', platform: ['REVOQUE', 'EXPIRE'] },
    ], platformStates: ACCOUNT_STATES, source: 'backend/src/plugins/acces/model.ts (AccountStatus)', audit: ['acces.account.'] }),
  R({ code: 'CONTRIBUABLE', entity: 'Contribuable', purpose: 'Sujet fiscal unique', relations: 'Lié à Identité, Objets, Obligations', confidentiality: 'Fiscal sensible',
    cahierLifecycle: [
      { cahier: 'provisoire', platform: ['ACTIF (N0, N0A ou N1)'], note: 'Compte actif dont l’identité n’est pas encore vérifiée (N2).' },
      { cahier: 'vérifié', platform: ['ACTIF (N2 ou N3)'] },
      { cahier: 'fusionné', platform: ['FUSIONNE'], note: 'Fusion prouvée, à trois personnes, réversible (§ 9.1).' },
    ], platformStates: TAXPAYER_STATES, source: 'backend/src/modules/identity/service.ts (Taxpayer.status, verificationLevel)', audit: ['taxpayer.', 'account.'] }),
  R({ code: 'IDENTITE', entity: 'Identité', purpose: 'Preuve d’identité', relations: 'Pièces, niveau de vérification', confidentiality: 'Personnel sensible',
    cahierLifecycle: [
      { cahier: 'N0', platform: ['N0', 'N0A'], note: 'N0-A : enrôlement assisté (ajout de la plateforme).' },
      { cahier: 'N1', platform: ['N1'] }, { cahier: 'N2', platform: ['N2'] }, { cahier: 'N3', platform: ['N3'] },
    ], platformStates: VERIFICATION_LEVELS, source: 'shared/src/domain.ts (VerificationLevel) ; backend/src/plugins/acces (preuves)', audit: ['acces.identity.', 'account.verification.'] }),
  R({ code: 'ORGANISATION', entity: 'Organisation', purpose: 'Personne morale', relations: 'NIF, registre, mandataires, établissements', confidentiality: 'Fiscal',
    cahierLifecycle: null, platformStates: ['PERSONNE_MORALE'], source: 'backend/src/modules/identity/service.ts (TaxpayerKind) ; backend/src/plugins/acces (organisations)', audit: ['acces.organisation.'] }),
  R({ code: 'ADRESSE', entity: 'Adresse', purpose: 'Localisation administrative', relations: 'Commune, quartier, avenue', confidentiality: 'Personnel',
    cahierLifecycle: [
      { cahier: 'déclarée', platform: ['DECLARE', 'OBSERVE'], note: 'Adresse de l’objet déclarée par le contribuable ou observée par un agent, non encore vérifiée.' },
      { cahier: 'vérifiée', platform: ['VERIFIE'] },
    ], platformStates: PROBATIVE_STATES, source: 'backend/src/modules/objects/service.ts (commune, quartier, avenue, probativeStatus)', audit: ['object.'] }),
  R({ code: 'GEOLOCALISATION', entity: 'Géolocalisation', purpose: 'Point et emprise', relations: 'Objet, précision, source', confidentiality: 'Interne',
    cahierLifecycle: null, platformStates: ['MISSION_TERRAIN', 'AUTO_DECLARATION', 'DONNEES_ADMINISTRATIVES', 'PARTENAIRE_AUTORISE', 'OBSERVATION_GEOSPATIALE', 'E_DGRK'],
    source: 'backend/src/modules/objects/service.ts (lat, lon, provenance) ; backend/src/plugins/fiscal/geo.ts (IGF)', audit: ['object.validated'] }),
  R({ code: 'OBJET_FISCAL', entity: 'ObjetFiscal', purpose: 'Toute chose imposable', relations: 'Parent de Parcelle, Unité, Activité, Véhicule, Panneau, Antenne, Embarcation, Concession', confidentiality: 'Fiscal',
    cahierLifecycle: [
      { cahier: 'provisoire', platform: ['PROVISOIRE'] }, { cahier: 'actif', platform: ['ACTIF'] },
      { cahier: 'suspendu', platform: ['SUSPENDU'] }, { cahier: 'clos', platform: ['CLOS'] },
    ], platformStates: OBJECT_LIFECYCLE_STATES, source: 'backend/src/modules/objects/service.ts (lifecycleOf) ; backend/src/plugins/fiscal/lifecycle.ts', audit: ['object.lifecycle.', 'object.declared', 'object.validated'] }),
  R({ code: 'PARCELLE_BATIMENT_UNITE', entity: 'Parcelle / Bâtiment / UnitéLocative', purpose: 'Assiette foncière et locative', relations: 'Hiérarchie parcelle → bâtiment → unité', confidentiality: 'Fiscal',
    cahierLifecycle: null, platformStates: ['PARCELLE', 'BATIMENT', 'UNITE_LOCATIVE'], source: 'backend/src/modules/objects/service.ts (category, parentObjectId)', audit: ['object.'] }),
  R({ code: 'BAIL', entity: 'Bail', purpose: 'Base de l’IRL', relations: 'Bailleur, locataire, unité, loyer, période', confidentiality: 'Fiscal sensible',
    cahierLifecycle: [
      { cahier: 'déclaré', platform: ['DECLARE', 'OBSERVE'] }, { cahier: 'vérifié', platform: ['VERIFIE'] },
      { cahier: 'résilié', platform: ['RESILIE'] }, { cahier: 'contesté', platform: ['CONTESTE'] },
    ], platformStates: [...LEASE_STATES, 'OBSERVE'], source: 'backend/src/modules/objects/service.ts (leaseStateOf, terminateLease)', audit: ['lease.'] }),
  R({ code: 'ACTIVITE', entity: 'Activité / Établissement', purpose: 'Base de la patente et des autorisations', relations: 'Contribuable, localisation, catégorie', confidentiality: 'Fiscal',
    cahierLifecycle: null, platformStates: ['ACTIVITE'], source: 'backend/src/modules/objects/service.ts (category ACTIVITE) ; backend/src/plugins/verticales', audit: ['object.'] }),
  R({ code: 'VEHICULE', entity: 'Véhicule', purpose: 'Base vignette et circulation', relations: 'Plaque, propriétaire, mutations', confidentiality: 'Fiscal',
    cahierLifecycle: null, platformStates: ['VEHICULE'], source: 'backend/src/modules/objects/service.ts (category VEHICULE) ; shared/src/plates.ts', audit: ['object.'] }),
  R({ code: 'OBJETS_SPECIFIQUES', entity: 'Panneau / Antenne / Embarcation / Concession', purpose: 'Objets spécifiques', relations: 'Opérateur, surface, site, titre', confidentiality: 'Fiscal',
    cahierLifecycle: null, platformStates: ['PANNEAU', 'AUTRE (objectType : antenne, embarcation, concession…)'], source: 'backend/src/plugins/publicite ; backend/src/plugins/verticales', audit: ['object.', 'publicite.'] }),
  R({ code: 'LICENCE', entity: 'Licence / Permis', purpose: 'Autorisation administrative', relations: 'Objet, validité, conditions', confidentiality: 'Fiscal',
    cahierLifecycle: null, platformStates: ['VALIDE', 'REVOQUE'], source: 'backend/src/plugins/verticales/service.ts (Certificate.status, validUntil) ; backend/src/plugins/titres (titres à durée)', audit: ['verticales.certificate.'] }),
  R({ code: 'TEXTE_LEGAL', entity: 'TexteLégal', purpose: 'Fondement juridique', relations: 'Lié aux Règles', confidentiality: 'Public',
    cahierLifecycle: [
      { cahier: 'en vigueur', platform: ['EN_VIGUEUR'] }, { cahier: 'modifié', platform: ['MODIFIE'] }, { cahier: 'abrogé', platform: ['ABROGE'] },
    ], platformStates: LEGAL_TEXT_STATES, source: 'shared/src/domain.ts (LegalInstrumentStatus) ; backend/src/modules/rules/textes.ts', audit: ['rule.instrument.', 'legal.'] }),
  R({ code: 'REGLE', entity: 'TypeDeRecette / RègleTarifaire', purpose: 'Paramètre de liquidation', relations: `Version, approbateur (${REQUIRED_APPROVALS.length} visas), dates, compte bénéficiaire`, confidentiality: 'Public après publication',
    cahierLifecycle: null, platformStates: RULE_STATES, source: 'backend/src/modules/rules/service.ts (RuleStatus)', audit: ['rule.'] }),
  R({ code: 'EXONERATION', entity: 'Exonération', purpose: 'Dérogation légale', relations: 'Bénéficiaire, preuve, durée, révision', confidentiality: 'Fiscal sensible',
    cahierLifecycle: null, platformStates: ['DEMANDEE', 'INSTRUITE', 'VISA_JURIDIQUE', 'APPROUVEE', 'REFUSEE', 'REVOQUEE'], source: 'backend/src/plugins/fiscal/exemptions.ts (ExemptionStatus)', audit: ['exemption.', 'fiscal.exemption.'] }),
  R({ code: 'DECLARATION', entity: 'Déclaration', purpose: 'Fait déclaré', relations: 'Contribuable, objet, période, pièces', confidentiality: 'Fiscal',
    cahierLifecycle: null, platformStates: ['DEPOSEE', 'LIQUIDEE', 'A_INSTRUIRE', 'CORRECTION_REJETEE', 'REMPLACEE'], source: 'backend/src/plugins/fiscal/declarations.ts', audit: ['declaration.', 'fiscal.declaration.'] }),
  R({ code: 'OBLIGATION', entity: 'Liquidation / Obligation', purpose: 'Dette liquidée', relations: 'Règle, objet, période, montant', confidentiality: 'Fiscal sensible',
    cahierLifecycle: [
      { cahier: 'calculée', platform: ['EMISE', 'EXIGIBLE', 'EN_RETARD'], note: 'Liquidée (trace de calcul jointe), sans avis d’imposition opposable enregistré.' },
      { cahier: 'notifiée', platform: ['EMISE', 'EXIGIBLE', 'EN_RETARD'], note: 'Avec avis d’imposition opposable (module Recouvrement : AVIS_IMPOSITION).' },
      { cahier: 'payée', platform: ['SOLDEE', 'PARTIELLEMENT_PAYEE'] },
      { cahier: 'contestée', platform: ['CONTESTEE'] },
      { cahier: 'annulée', platform: ['ANNULEE', 'ADMISE_EN_NON_VALEUR'], note: 'Toujours par écriture contraire motivée, jamais par effacement.' },
    ], platformStates: OBLIGATION_STATES, source: 'shared/src/domain.ts (ObligationStatus) ; backend/src/modules/assessment/service.ts', audit: ['assessment.'] }),
  R({ code: 'AVIS', entity: 'AvisDePaiement', purpose: 'Document de paiement', relations: 'Référence unique, échéance', confidentiality: 'Fiscal',
    cahierLifecycle: null, platformStates: ['INITIE (référence active jusqu’à expiresAt)', 'ECHOUE (référence fermée ou expirée)'], source: 'backend/src/modules/payments/service.ts (PaymentOrder.paymentReference, expiresAt, closedAt) ; backend/src/plugins/recouvrement (avis)', audit: ['payment.order.', 'recovery.notice.'] }),
  R({ code: 'PAIEMENT', entity: 'OrdreDePaiement / ÉvénementDePaiement', purpose: 'Suivi du paiement', relations: 'Canal, prestataire, statut, horodatage', confidentiality: 'Financier',
    cahierLifecycle: null, platformStates: PAYMENT_STATES, source: 'shared/src/domain.ts (PaymentStatus, PAYMENT_TRANSITIONS)', audit: ['payment.'] }),
  R({ code: 'REGLEMENT', entity: 'Règlement / Rapprochement', purpose: 'Arrivée et appariement des fonds', relations: 'Compte public, relevé, écarts', confidentiality: 'Financier sensible',
    cahierLifecycle: null, platformStates: ['OUVERTE', 'EN_COURS', 'RESOLUE', 'CLASSEE'], source: 'backend/src/modules/treasury/service.ts (relevés, exceptions)', audit: ['treasury.', 'reconciliation.'] }),
  R({ code: 'QUITTANCE', entity: 'Quittance', purpose: 'Preuve de paiement', relations: 'Signature, QR, statut', confidentiality: 'Semi-public',
    cahierLifecycle: null, platformStates: RECEIPT_STATES, source: 'shared/src/domain.ts (ReceiptStatus) ; backend/src/modules/receipts/service.ts', audit: ['receipt.'] }),
  R({ code: 'INSPECTION', entity: 'Inspection / MissionTerrain / Preuve', purpose: 'Contrôle et preuve', relations: 'Agent, zone, objet, photos, GPS', confidentiality: 'Interne sensible',
    cahierLifecycle: null, platformStates: ['A_AFFECTER', 'AFFECTEE', 'EN_COURS', 'TERMINEE', 'ANNULEE'], source: 'backend/src/plugins/terrain/model.ts (MissionStatus, FindingStatus) ; backend/src/modules/field', audit: ['field.', 'terrain.'] }),
  R({ code: 'NOTIFICATION', entity: 'Notification', purpose: 'Communication opposable', relations: 'Canal, contenu, accusé', confidentiality: 'Fiscal',
    cahierLifecycle: null, platformStates: ['en_file', 'envoye', 'delivre', 'lu', 'echoue', 'journalise', 'supprime_par_preference'], source: 'backend/src/modules/communications/service.ts (Delivery) ; backend/src/plugins/recouvrement (avis opposables)', audit: ['recovery.notice.'] }),
  R({ code: 'CONTENTIEUX', entity: 'Recours / Pénalité / DossierExécution', purpose: 'Contentieux et recouvrement', relations: 'Décision, délai, voie de recours', confidentiality: 'Fiscal sensible',
    cahierLifecycle: null, platformStates: APPEAL_STATES, source: 'backend/src/modules/appeals/service.ts ; backend/src/plugins/recouvrement', audit: ['appeal.', 'recovery.'] }),
  R({ code: 'AFFECTATION', entity: 'RègleAffectation / RecommandationBudgétaire / ProjetPublic', purpose: 'Emploi des fonds', relations: 'Budget voté, projet, autorité', confidentiality: 'Public agrégé',
    cahierLifecycle: null, platformStates: ['IMPORTEE', 'CERTIFIEE', 'REJETEE', 'REMPLACEE'], source: 'backend/src/plugins/pilotage/partage-legal ; backend/src/plugins/pilotage/planification', audit: ['pilotage.'] }),
  R({ code: 'HABILITATION', entity: 'Rôle / Permission / Délégation / Appareil', purpose: 'Habilitations', relations: 'Portée, durée, expiration', confidentiality: 'Interne sensible',
    cahierLifecycle: null, platformStates: ['EN_ATTENTE', 'ACTIF', 'REVOQUE'], source: 'backend/src/core/policy.ts (matrice) ; backend/src/plugins/acces (délégations) ; backend/src/modules/field (appareils)', audit: ['acces.', 'device.'] }),
  R({ code: 'IA', entity: 'RecommandationIA / AlerteFraude', purpose: 'Aide à la décision', relations: 'Modèle, version, entrée, sortie, décideur humain', confidentiality: 'Interne sensible',
    cahierLifecycle: null, platformStates: ['EMISE', 'TRAITEE_AUTO', 'ACCEPTEE', 'MODIFIEE', 'REJETEE', 'ANNULEE', 'A_EXAMINER', 'EN_EXAMEN', 'CLOTURE_PROPOSEE', 'CLASSEE', 'DOSSIER_OUVERT'], source: 'backend/src/plugins/ia/types.ts (IaStatus) ; backend/src/plugins/integrite/types.ts (AlertStatus)', audit: ['ai.', 'ia.', 'integrite.'] }),
  R({ code: 'AUDIT', entity: 'ÉvénementAudit', purpose: 'Preuve d’action', relations: 'Acteur, action, objet, horodatage, appareil, position', confidentiality: 'Audit, inaltérable',
    cahierLifecycle: [{ cahier: 'ajout seul', platform: ['APPEND_ONLY'], note: 'Journal chaîné par empreintes ; aucune modification ni suppression (action « audit.modify » refusée à tous).' }],
    platformStates: ['APPEND_ONLY'], source: 'backend/src/core/audit.ts', audit: ['*'] }),
];

type Counter = Record<string, number>;
const inc = (c: Counter, k: string) => { c[k] = (c[k] ?? 0) + 1; };

/** Effectifs courants par état du Cahier (null : dépôt du module absent de cette instance). */
function cahierCounts(ctx: AppContext, code: string): Counter | null {
  const c: Counter = {};
  switch (code) {
    case 'UTILISATEUR': {
      // Comptes de travail gérés par le module « acces » (cycle complet) ; les autres comptes de l'annuaire (contribuables,
      // comptes semés hors invitation) sont actifs tant qu'ils y figurent (la révocation les retire de l'annuaire).
      const acces = ctx.ext['acces'] as { accounts?: { all(): { id: string; status: string }[] } } | undefined;
      const accounts = acces?.accounts?.all() ?? [];
      const managed = new Set(accounts.map((a) => a.id));
      for (const a of accounts) {
        if (a.status === 'ACTIF') inc(c, 'actif');
        else if (a.status === 'SUSPENDU') inc(c, 'suspendu');
        else if (a.status === 'REVOQUE' || a.status === 'EXPIRE') inc(c, 'clos');
        else inc(c, '(en attente d’activation)');
      }
      for (const u of ctx.users.all()) if (!managed.has(u.id)) inc(c, 'actif');
      return c;
    }
    case 'CONTRIBUABLE':
      for (const t of ctx.taxpayers.taxpayers.all()) inc(c, t.status === 'FUSIONNE' ? 'fusionné' : t.verificationLevel === 'N2' || t.verificationLevel === 'N3' ? 'vérifié' : 'provisoire');
      return c;
    case 'IDENTITE':
      for (const t of ctx.taxpayers.taxpayers.all()) inc(c, t.verificationLevel === 'N0A' ? 'N0' : t.verificationLevel);
      return c;
    case 'ADRESSE':
      for (const o of ctx.objects.objects.all()) inc(c, o.probativeStatus === 'VERIFIE' ? 'vérifiée' : o.probativeStatus === 'CONTESTE' ? '(contestée)' : 'déclarée');
      return c;
    case 'OBJET_FISCAL': {
      const label: Record<ObjectLifecycleState, string> = { PROVISOIRE: 'provisoire', ACTIF: 'actif', SUSPENDU: 'suspendu', CLOS: 'clos' };
      for (const o of ctx.objects.objects.all()) inc(c, label[lifecycleOf(o)]);
      return c;
    }
    case 'BAIL': {
      const label: Record<LeaseState | 'OBSERVE', string> = { DECLARE: 'déclaré', OBSERVE: 'déclaré', VERIFIE: 'vérifié', RESILIE: 'résilié', CONTESTE: 'contesté' };
      for (const l of ctx.objects.leases.all()) inc(c, label[leaseStateOf(l)]);
      return c;
    }
    case 'TEXTE_LEGAL':
      for (const i of ctx.rules.instruments.all()) inc(c, i.status === 'EN_VIGUEUR' ? 'en vigueur' : i.status === 'MODIFIE' ? 'modifié' : i.status === 'ABROGE' ? 'abrogé' : '(à vérifier)');
      return c;
    case 'OBLIGATION': {
      const rec = ctx.ext['recouvrement'] as { notices?: { all(): { obligationId: string; kind: string }[] } } | undefined;
      const noticed = new Set((rec?.notices?.all() ?? []).filter((n) => n.kind === 'AVIS_IMPOSITION').map((n) => n.obligationId));
      for (const o of ctx.assessment.obligations.all()) {
        if (o.status === 'SOLDEE' || o.status === 'PARTIELLEMENT_PAYEE') inc(c, 'payée');
        else if (o.status === 'CONTESTEE') inc(c, 'contestée');
        else if (o.status === 'ANNULEE' || o.status === 'ADMISE_EN_NON_VALEUR') inc(c, 'annulée');
        else inc(c, noticed.has(o.id) ? 'notifiée' : 'calculée');
      }
      return c;
    }
    case 'AUDIT':
      c['ajout seul'] = ctx.audit.length;
      return c;
    default:
      return null;
  }
}

/** Nombre total d'enregistrements d'une entité quand il est lisible sans donnée personnelle. */
function total(ctx: AppContext, code: string): number | null {
  switch (code) {
    case 'ORGANISATION': return ctx.taxpayers.taxpayers.find((t) => t.kind === 'PERSONNE_MORALE').length;
    case 'GEOLOCALISATION': return ctx.objects.objects.count();
    case 'PARCELLE_BATIMENT_UNITE': return ctx.objects.objects.find((o) => ['PARCELLE', 'BATIMENT', 'UNITE_LOCATIVE'].includes(o.category)).length;
    case 'ACTIVITE': return ctx.objects.objects.find((o) => o.category === 'ACTIVITE').length;
    case 'VEHICULE': return ctx.objects.objects.find((o) => o.category === 'VEHICULE').length;
    case 'REGLE': return ctx.rules.rules.count();
    case 'PAIEMENT': return ctx.payments.orders.count();
    case 'QUITTANCE': return ctx.receipts.receipts.count();
    case 'REGLEMENT': return ctx.treasury.statements.count();
    case 'CONTENTIEUX': return ctx.appeals.appeals.count();
    default: return null;
  }
}

export interface EntityView extends EntityRow {
  counts: Counter | null;
  total: number | null;
}

export function dataModelView(ctx: AppContext): { notice: string; entities: EntityView[] } {
  return {
    notice: 'Noyau du modèle de données conceptuel (ch. 30) : correspondance entre les cycles de vie du Cahier et les états du code, effectifs courants sans donnée personnelle. Le dictionnaire détaillé est un livrable de la phase 1.',
    entities: DATA_MODEL.map((e) => {
      const counts = cahierCounts(ctx, e.code);
      return { ...e, counts, total: counts ? Object.values(counts).reduce((a, b) => a + b, 0) : total(ctx, e.code) };
    }),
  };
}
