/**
 * Matrice d'habilitations du Document maître FR 2, nouvelle version (ch. 12) — PREUVE VIVANTE : chacun des 16 rôles
 * du Cahier est rapproché des codes de rôle de la plateforme (R01 à R37) ; ses interdits (« Ne peut jamais ») sont
 * traduits en actions du point de décision central et ÉVALUÉS À CHAQUE LECTURE par `evaluate` (refus attendu), ses
 * facultés (« Peut faire ») par au moins une action accordée. Une ligne dont un interdit serait accordé apparaît en
 * écart (`ok: false`) : aucune correction automatique, un test d'intégration en fait un échec bloquant.
 * Contrôles transverses du § 12.1 : paires de rôles incompatibles (séparation des fonctions) et garde de l'IA.
 */
import { hasIncompatibility, ROLES, type RoleCode } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { evaluate, type AnyAction, type Resource } from '../../core/policy.js';

export interface ActionCheck { action: AnyAction; resource?: Resource; label: string }

export interface RoleRow {
  cahierRole: string;
  platformRoles: RoleCode[];
  sees: string;
  can: string;
  never: string;
  /** Au moins une de ces actions doit être accordée (faculté réellement câblée). */
  allowed: ActionCheck[];
  /** Toutes ces actions doivent être refusées (interdits du Cahier). */
  forbidden: ActionCheck[];
  /** Contrôles structurels complémentaires (quatre yeux, incompatibilités) et tests qui les exercent. */
  structural?: { label: string; incompatiblePair?: [RoleCode, RoleCode]; test: string }[];
}

const OTHER_TAXPAYER: Resource = { taxpayerId: 'TP-TIERS-CONTROLE' };
const a = (action: AnyAction, label: string, resource?: Resource): ActionCheck => ({ action, label, ...(resource ? { resource } : {}) });

/** Interdits financiers communs (dette, paiement, bénéficiaire, quittance, journal). */
const FINANCIAL_NEVER = [
  a('obligation.modify', 'Modifier une dette'),
  a('payment.modify', 'Modifier ou supprimer un paiement'),
  a('beneficiary.propose', 'Proposer un changement de compte bénéficiaire'),
  a('beneficiary.approve', 'Approuver un changement de compte bénéficiaire'),
  a('ledger.reverse', 'Contre-passer une écriture (réécrire une quittance)'),
  a('audit.modify', 'Modifier le journal d’audit'),
];

export const ROLE_MATRIX: RoleRow[] = [
  { cahierRole: 'Gouverneur', platformRoles: ['R01'],
    sees: 'Vision consolidée : recettes, performance, risques, couverture, prévisions, capacité d’affectation',
    can: 'Demander des enquêtes, arbitrer des priorités selon ses pouvoirs, valider des orientations',
    never: 'Supprimer une transaction, réécrire une quittance, changer un compte bénéficiaire, modifier le journal d’audit',
    allowed: [a('dashboard.governor', 'Tableau de bord du Gouverneur')],
    forbidden: [...FINANCIAL_NEVER, a('taxpayer.read', 'Dossier individuel d’un contribuable', OTHER_TAXPAYER)] },
  { cahierRole: 'Directeur de cabinet du Gouverneur', platformRoles: ['R02'],
    sees: 'Vue de coordination déléguée, par finalité', can: 'Suivre l’exécution, coordonner les services',
    never: 'Accéder aux dossiers individuels sans finalité enregistrée',
    allowed: [a('dashboard.governor', 'Vue de coordination')],
    forbidden: [a('taxpayer.read', 'Dossier individuel sans finalité', OTHER_TAXPAYER), a('obligation.read', 'Obligation individuelle sans finalité', OTHER_TAXPAYER), ...FINANCIAL_NEVER],
    structural: [{ label: 'Consultation motivée (finalité enregistrée, bris de glace tracé)', test: 'backend/test/acces.test.ts' }] },
  { cahierRole: 'Secrétaire du Gouvernement provincial', platformRoles: ['R03'],
    sees: 'Décisions, dossiers institutionnels, suivi de mise en œuvre', can: 'Coordonner, documenter, notifier',
    never: 'Agir sur les obligations ou les paiements',
    allowed: [a('comms.read', 'Communications institutionnelles')],
    forbidden: [a('assessment.liquidate', 'Liquider une obligation'), a('payment.create', 'Initier un paiement'), ...FINANCIAL_NEVER] },
  { cahierRole: 'Ministre provincial', platformRoles: ['R04', 'R05'],
    sees: 'Périmètre légal de son ministère uniquement', can: 'Piloter ses services, valider ses actes',
    never: 'Consulter des données fiscales étrangères à sa compétence',
    allowed: [a('rule.read', 'Référentiel de son périmètre')],
    forbidden: [a('taxpayer.read', 'Données fiscales individuelles', OTHER_TAXPAYER), a('obligation.read', 'Obligation individuelle', OTHER_TAXPAYER), ...FINANCIAL_NEVER] },
  { cahierRole: 'Direction de la régie fiscale', platformRoles: ['R06'],
    sees: 'Assiette, liquidation, contentieux, recouvrement', can: 'Diriger les opérations, valider les campagnes',
    never: 'Modifier seule une règle ou un compte bénéficiaire',
    allowed: [a('assessment.liquidate', 'Liquider sur règle ACTIVE')],
    forbidden: [a('rule.create', 'Rédiger une règle'), a('rule.approve', 'Viser une règle'), a('beneficiary.propose', 'Proposer un bénéficiaire'), a('beneficiary.approve', 'Approuver un bénéficiaire'), a('obligation.modify', 'Modifier une dette'), a('audit.modify', 'Modifier le journal')] },
  { cahierRole: 'Direction de la régie des taxes', platformRoles: ['R06', 'R07'],
    sees: 'Droits, taxes et redevances urbaines', can: 'Ordonnancer et suivre la perception',
    never: 'Créer une recette non prévue au référentiel',
    allowed: [a('assessment.liquidate', 'Ordonnancer sur règle ACTIVE')],
    forbidden: [a('rule.create', 'Créer une recette'), a('rule.approve', 'Viser une règle'), a('obligation.modify', 'Modifier une dette')],
    structural: [{ label: 'Aucune obligation sans règle ACTIVE à quatre visas (garde de liquidation)', test: 'backend/test/chaine.test.ts' }] },
  { cahierRole: 'Super-administrateur de la plateforme', platformRoles: ['R26'],
    sees: 'Configuration technique, disponibilité, sécurité, intégrations', can: 'Gérer environnements, versions, comptes techniques',
    never: 'Modifier une dette, un paiement, un bénéficiaire, une quittance ou un journal d’audit',
    allowed: [a('provider.read', 'Console technique des prestataires')],
    forbidden: [...FINANCIAL_NEVER, a('assessment.liquidate', 'Liquider'), a('settlement.import', 'Importer un relevé')],
    structural: [{ label: 'Incompatible avec le Trésor', incompatiblePair: ['R26', 'R17'], test: 'shared/test/shared.test.ts' }, { label: 'Incompatible avec le coffre des bénéficiaires', incompatiblePair: ['R26', 'R19'], test: 'shared/test/shared.test.ts' }] },
  { cahierRole: 'Administrateur ministériel ou départemental', platformRoles: ['R08'],
    sees: 'Personnel, affectations, flux approuvés de son périmètre', can: 'Affecter, habiliter temporairement',
    never: 'Élargir son propre périmètre',
    allowed: [a('comms.read', 'Flux de son périmètre')],
    forbidden: [...FINANCIAL_NEVER, a('assessment.liquidate', 'Liquider')],
    structural: [{ label: 'Invitations sans élévation ni sortie de périmètre (même entité, même territoire)', test: 'backend/test/acces.test.ts' }] },
  { cahierRole: 'Finances et trésorerie', platformRoles: ['R17', 'R18'],
    sees: 'Règlements, rapprochements, exceptions comptables', can: 'Imputer, justifier, clôturer des écarts',
    never: 'Créer l’obligation sous-jacente',
    allowed: [a('reconciliation.read', 'Rapprochements')],
    forbidden: [a('assessment.liquidate', 'Créer une obligation'), a('assessment.simulate', 'Liquider (simulation)'), a('obligation.modify', 'Modifier une dette'), a('audit.modify', 'Modifier le journal')] },
  { cahierRole: 'Juriste et tarificateur', platformRoles: ['R13', 'R14'],
    sees: 'Fiches de recettes et versions', can: 'Rédiger et proposer une règle',
    never: 'Créer, valider et publier seul la même règle',
    allowed: [a('rule.approve', 'Visa de sa fonction')],
    forbidden: [a('obligation.modify', 'Modifier une dette'), a('assessment.liquidate', 'Liquider'), a('audit.modify', 'Modifier le journal')],
    structural: [
      { label: 'Rédacteur ≠ vérificateur', incompatiblePair: ['R13', 'R14'], test: 'backend/test/legal.test.ts' },
      { label: 'Rédacteur ≠ autorité de publication', incompatiblePair: ['R13', 'R16'], test: 'backend/test/legal.test.ts' },
      { label: 'Quatre visas par quatre personnes distinctes', test: 'backend/test/rules-hardening.test.ts' },
    ] },
  { cahierRole: 'Auditeur', platformRoles: ['R22', 'R23'],
    sees: 'Accès complet en lecture aux preuves', can: 'Extraire, tracer, signaler',
    never: 'Modifier une donnée',
    allowed: [a('audit.read', 'Lecture du journal d’audit')],
    forbidden: [...FINANCIAL_NEVER, a('assessment.liquidate', 'Liquider'), a('payment.create', 'Initier un paiement'), a('rule.create', 'Rédiger une règle'), a('settlement.import', 'Importer un relevé')] },
  { cahierRole: 'Enquêteur anti-fraude', platformRoles: ['R24'],
    sees: 'Alertes, dossiers, liens', can: 'Instruire, demander des pièces, saisir l’autorité',
    never: 'Sanctionner sans décision compétente',
    allowed: [a('alerts.read', 'Alertes')],
    forbidden: [a('integrite:case.decide', 'Décider d’un dossier d’enquête'), a('obligation.modify', 'Modifier une dette'), a('assessment.liquidate', 'Liquider')] },
  { cahierRole: 'Agent recenseur', platformRoles: ['R10', 'R35'],
    sees: 'Zone et mission assignées', can: 'Créer un objet provisoire, photographier, géolocaliser',
    never: 'Encaisser, fixer une dette, déterminer la propriété',
    allowed: [a('field.sync', 'Synchronisation de mission'), a('fiscal:nearby', 'Objets autour de moi, dans son secteur')],
    forbidden: [a('payment.create', 'Encaisser / initier un paiement'), a('assessment.liquidate', 'Fixer une dette'), a('fiscal:relation.validate', 'Déterminer la propriété (valider un rattachement)'), a('obligation.modify', 'Modifier une dette')],
    structural: [{ label: 'Incompatible avec l’opérateur de point de paiement (espèces)', incompatiblePair: ['R10', 'R32'], test: 'shared/test/shared.test.ts' }] },
  { cahierRole: 'Agent de constat et contrôleur', platformRoles: ['R11'],
    sees: 'Objets assignés, statut minimal nécessaire', can: 'Constater, notifier, dresser procès-verbal selon ses pouvoirs',
    never: 'Encaisser des espèces, annuler une dette',
    allowed: [a('assessment.simulate', 'Préparer une liquidation')],
    forbidden: [a('payment.create', 'Encaisser'), a('obligation.modify', 'Annuler une dette'), a('ledger.reverse', 'Contre-passer')],
    structural: [{ label: 'Incompatible avec l’opérateur de point de paiement (espèces)', incompatiblePair: ['R11', 'R32'], test: 'shared/test/shared.test.ts' }] },
  { cahierRole: 'Contribuable', platformRoles: ['R30'],
    sees: 'Ses objets, obligations, paiements, recours', can: 'Déclarer, payer, contester, mandater',
    never: 'Voir les données d’un tiers',
    allowed: [a('lease.declare', 'Déclarer un bail')],
    forbidden: [a('taxpayer.read', 'Compte d’un tiers', OTHER_TAXPAYER), a('obligation.read', 'Obligations d’un tiers', OTHER_TAXPAYER), a('payment.create', 'Payer pour un tiers sans mandat', OTHER_TAXPAYER), a('appeal.submit', 'Contester pour un tiers', OTHER_TAXPAYER)] },
  { cahierRole: 'Partenaire externe', platformRoles: ['R33', 'R34'],
    sees: 'Strictement les points d’API contractés', can: 'Confirmer un paiement, transmettre un jeu de données convenu',
    never: 'Interroger le registre au-delà de son objet',
    allowed: [],
    forbidden: [a('taxpayer.read', 'Registre des contribuables', OTHER_TAXPAYER), a('obligation.read', 'Obligations', OTHER_TAXPAYER), a('rule.read', 'Référentiel interne'), a('audit.read', 'Journal d’audit')],
    structural: [{ label: 'Rappels de paiement signés, anti-rejeu, sans session utilisateur', test: 'backend/test/callback-hmac.test.ts' }] },
];

/** Utilisateur fictif d'évaluation (aucun compte réel, aucun territoire restreint). */
function probe(role: RoleCode): User {
  return { kind: 'user', id: `controle-matrice-${role}`, name: `Contrôle ${ROLES[role]}`, roles: [role], entity: 'CONTROLE', taxpayerId: role === 'R30' ? 'TP-CONTROLE' : undefined } as User;
}

export interface RoleRowView extends RoleRow {
  checks: { role: RoleCode; allowedOk: boolean; forbiddenBreaches: string[]; structuralBreaches: string[] }[];
  ok: boolean;
}

export function roleMatrixView(): { notice: string; transverse: string[]; rows: RoleRowView[]; ok: boolean } {
  const rows = ROLE_MATRIX.map((r) => {
    const checks = r.platformRoles.map((role) => {
      const u = probe(role);
      const allowedOk = r.allowed.length === 0 || r.allowed.some((c) => !!evaluate(u, c.action, c.resource ?? {}));
      const forbiddenBreaches = r.forbidden.filter((c) => !!evaluate(u, c.action, c.resource ?? {})).map((c) => c.action);
      const structuralBreaches = (r.structural ?? []).filter((s) => s.incompatiblePair && s.incompatiblePair.includes(role) && !hasIncompatibility(s.incompatiblePair)).map((s) => s.label);
      return { role, allowedOk, forbiddenBreaches, structuralBreaches };
    });
    return { ...r, checks, ok: checks.every((c) => c.allowedOk && !c.forbiddenBreaches.length && !c.structuralBreaches.length) };
  });
  return {
    notice: 'Matrice du ch. 12 évaluée en direct par le point de décision central (refus par défaut). Toute action financière sensible exige en outre deux personnes distinctes, une authentification renforcée et une justification enregistrée.',
    transverse: [
      'Moindre privilège et séparation des fonctions par conception (matrice déclarative, action non déclarée ⇒ refusée) — backend/src/core/policy.ts',
      'Quatre yeux : publication de règle, bénéficiaire, annulation, remboursement, exonération, fusion d’identités, extraction massive',
      'Élévation juste-à-temps motivée, tracée, expirant seule — backend/src/plugins/acces/elevations.ts',
      'MFA pour tout compte interne (mot de passe + TOTP) ; clés d’accès FIDO2 pour les rôles sensibles [À RACCORDER] — backend/src/plugins/socle',
      'Liaison appareil–utilisateur et révocation à distance des terminaux de terrain — backend/src/modules/field',
      'Revue trimestrielle des habilitations et détection des conflits d’intérêts — backend/src/plugins/integrite (revues d’accès)',
      'Journalisation intégrale, y compris des consultations de dossiers individuels — backend/src/plugins/acces (consultations motivées)',
      'Aucune action de ce tableau n’est jamais permise à l’IA (garde assertAiMay, dix interdits absolus)',
    ],
    rows,
    ok: rows.every((r) => r.ok),
  };
}
