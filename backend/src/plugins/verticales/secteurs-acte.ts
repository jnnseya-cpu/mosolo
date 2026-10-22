/**
 * Chemin vers l'acte des modules sectoriels « acte requis » (§ 11 : 11, 13, 16, 17, 21, 22, 23, 24, 25, 56) — ajout du
 * 29/09/2026, construit PAR-DESSUS l'existant (rien n'est retiré) :
 *
 *  - chaque prérequis déjà affiché (J1, J3, J13, J30…) devient une étape de liste de contrôle dont le statut est LU dans
 *    les registres existants : points juridiques (proposition d'acte par un juriste, décision par une autre personne),
 *    registre des règles (circuit REDACTEUR → VERIFICATEUR_JURIDIQUE → VALIDATEUR_FINANCIER → AUTORITE_PUBLICATION),
 *    configuration de la fiche du module (règle et référence de l'acte, direction de la régie), types de titres (§ 19A.4) ;
 *  - chaque étape non accomplie indique QUI doit agir (rôles habilités) et OÙ (écran exact) ; l'écran n'affiche le
 *    bouton qu'aux rôles qui détiennent le droit, les autres voient qui doit agir ;
 *  - l'état du module (« acte requis » ou « acte en vigueur ») découle de la logique existante : règle ACTIVE retenue
 *    par la fiche du module (FichesService.ruleStatus), clé du registre pour les antennes, type de titre activable pour
 *    les véhicules ; aucune bascule manuelle, aucun montant avant l'acte.
 *
 * Lecture seule : aucune écriture, aucun effet. Aucun taux, tarif ni seuil n'est produit ici.
 */
import { REQUIRED_APPROVALS, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { RuleRecord } from '../../modules/rules/service.js';
import { APPROVAL_ROLE } from '../../modules/rules/service.js';
import type { JuridiqueService } from '../juridique/service.js';
import { latestRule } from '../parking/support.js';
import type { SectorModuleDef } from './secteurs.js';
import { ruleCodeFor, type VerticalesService } from './service.js';

export type EtapeStatut = 'FAIT' | 'EN_COURS' | 'A_FAIRE' | 'BLOQUE' | 'A_QUALIFIER';
export type EtapeKind = 'POINT_JURIDIQUE' | 'PREREQUIS' | 'REGLE' | 'CONFIGURATION' | 'TITRE';

export interface EtapeAction {
  /** Libellé du bouton (« Enregistrer l'acte », « Rédiger la règle », « Viser la règle », « Activer après acte »…). */
  label: string;
  /** Écran exact où la personne habilitée accomplit l'étape. */
  path: string;
  /** Rôles qui détiennent le droit (le bouton n'est affiché qu'à eux). */
  roles: RoleCode[];
  /** Qui doit agir, en clair. */
  qui: string;
}

export interface EtapeActe {
  code: string;
  kind: EtapeKind;
  label: string;
  statut: EtapeStatut;
  detail: string;
  action: EtapeAction | null;
  /** Vrai si l'étape s'accomplit sans intervention (entrée en vigueur à la date d'effet, conséquence d'une autre étape). */
  automatique?: boolean;
}

export interface CheminActe {
  module: string;
  etat: 'ACTE_REQUIS' | 'ACTE_EN_VIGUEUR';
  etatLabel: string;
  ruleCode: string | null;
  etapes: EtapeActe[];
  /** Première étape non accomplie (celle sur laquelle agir maintenant). */
  prochaine: EtapeActe | null;
  faites: number;
  total: number;
  note: string;
}

export const ETAPE_STATUT_LABEL: Record<EtapeStatut, string> = {
  FAIT: 'Fait', EN_COURS: 'En cours', A_FAIRE: 'À faire', BLOQUE: 'Bloqué', A_QUALIFIER: 'À rattacher au registre',
};

const VISA_LABEL: Record<(typeof REQUIRED_APPROVALS)[number], string> = {
  REDACTEUR: 'visa de rédaction', VERIFICATEUR_JURIDIQUE: 'visa juridique', VALIDATEUR_FINANCIER: 'visa financier', AUTORITE_PUBLICATION: 'publication',
};
const VISA_QUI: Record<(typeof REQUIRED_APPROVALS)[number], string> = {
  REDACTEUR: 'Juriste rédacteur', VERIFICATEUR_JURIDIQUE: 'Juriste vérificateur (personne distincte du rédacteur)',
  VALIDATEUR_FINANCIER: 'Validateur financier (personne distincte)', AUTORITE_PUBLICATION: 'Autorité de publication (personne distincte)',
};

/** Modules du catalogue « acte requis » qui ont une fiche (FICHE_MODULES de fiches.ts, sans import circulaire). */
const FICHE_SECTEURS = ['13', '16', '17', '21', '22', '23', '24', '25'];

/** Rôles du circuit des points juridiques (mêmes droits que juridique:points.propose / .decide). */
export const POINT_PROPOSE_ROLES: RoleCode[] = ['R13', 'R14'];
export const POINT_DECIDE_ROLES: RoleCode[] = ['R16', 'R05', 'R01'];
/** Configuration de la fiche d'un module (même droit que verticales:sector.configure). */
export const CONFIGURE_ROLES: RoleCode[] = ['R06'];
/** Rédaction d'une règle (même droit que rule.create). */
export const DRAFT_ROLES: RoleCode[] = ['R13'];

/** Codes des points juridiques cités par un prérequis (« J1, J3 — … » → J1, J3). */
export function pointsCites(prerequis: string): string[] {
  return [...new Set([...prerequis.matchAll(/\bJ(\d{1,2})\b/g)].map((m) => `J${m[1]}`))];
}

/** Statut d'étape d'un point juridique (registre existant : proposition motivée puis décision d'une autre personne). */
export function etapePointJuridique(code: string, prerequis: string, state: { statut: string; proposition?: { acte: { reference: string } } | undefined; decision?: { acte: { reference: string } } | undefined } | undefined, question: string | undefined): EtapeActe {
  const path = `/juridique/points?point=${encodeURIComponent(code)}`;
  const label = `${code} — ${question ?? prerequis}`;
  if (state?.statut === 'TRANCHE') {
    return { code, kind: 'POINT_JURIDIQUE', label, statut: 'FAIT', detail: `Tranché sur acte ${state.decision?.acte.reference ?? ''} (proposition et décision par deux personnes distinctes).`.replace(' ()', ''), action: null };
  }
  if (state?.proposition) {
    return {
      code, kind: 'POINT_JURIDIQUE', label, statut: 'EN_COURS',
      detail: `Acte proposé (${state.proposition.acte.reference}) : en attente de la décision d’une autre personne habilitée.`,
      action: { label: 'Trancher le point', path, roles: POINT_DECIDE_ROLES, qui: 'Autorité de publication, ministre provincial des Finances ou Gouverneur — personne distincte du proposant' },
    };
  }
  return {
    code, kind: 'POINT_JURIDIQUE', label, statut: 'A_FAIRE',
    detail: `Prérequis du module : ${prerequis}. Point ouvert : l’hypothèse intérimaire sûre s’applique (aucun montant).`,
    action: { label: 'Enregistrer l’acte', path, roles: POINT_PROPOSE_ROLES, qui: 'Juriste rédacteur ou vérificateur (proposition avec la référence et l’empreinte de l’acte)' },
  };
}

/** Étape « règle du registre » : statut lu au registre, prochain visa du circuit des quatre personnes. */
export function etapeRegle(code: string | null, rule: RuleRecord | null, today: string): EtapeActe {
  const base = { code: 'REGLE', kind: 'REGLE' as const, label: code ? `Règle du registre ${code}` : 'Règle du registre (code à fixer par le juriste rédacteur)' };
  if (!rule) {
    return {
      ...base, statut: 'A_FAIRE',
      detail: code ? `Aucune règle ${code} au registre : aucun montant, aucun taux par défaut.` : 'Aucune règle retenue pour ce module : le juriste rédacteur rédige la fiche de règle à partir de l’acte (aucun taux par défaut).',
      action: { label: 'Rédiger la règle', path: code ? `/registre?nouvelle=${encodeURIComponent(code)}` : '/registre?nouvelle=1', roles: DRAFT_ROLES, qui: 'Juriste rédacteur' },
    };
  }
  const demo = rule.demo === true ? ' — règle FICTIVE de démonstration, non opposable' : '';
  if (rule.status === 'ACTIVE') return { ...base, statut: 'FAIT', detail: `${rule.code} v${rule.version} ACTIVE${demo}.`, action: null };
  if (['SUSPENDUE', 'EXPIREE', 'ABROGEE', 'ARCHIVEE', 'A_VERIFIER'].includes(rule.status)) {
    return {
      ...base, statut: 'BLOQUE', detail: `${rule.code} v${rule.version} au statut ${rule.status}${demo} : nouvelle version nécessaire (quatre visas).`,
      action: { label: 'Préparer une nouvelle version', path: `/registre?code=${encodeURIComponent(rule.code)}`, roles: DRAFT_ROLES, qui: 'Juriste rédacteur' },
    };
  }
  const done = new Set(rule.approvals.map((a) => a.role));
  const next = REQUIRED_APPROVALS.find((r) => !done.has(r));
  if (next) {
    return {
      ...base, statut: 'EN_COURS', detail: `${rule.code} v${rule.version} au statut ${rule.status} — ${done.size} visa(s) sur 4${demo}. Prochain : ${VISA_LABEL[next]}.`,
      action: { label: `Viser la règle (${VISA_LABEL[next]})`, path: `/registre?code=${encodeURIComponent(rule.code)}`, roles: [APPROVAL_ROLE[next]], qui: VISA_QUI[next] },
    };
  }
  return {
    ...base, statut: 'EN_COURS', automatique: true,
    detail: `${rule.code} v${rule.version} publiée (quatre visas)${demo} : entrée en vigueur automatique à la date d’effet ${rule.effectiveFrom}${rule.effectiveFrom <= today ? ' (contrôle au prochain passage du moteur)' : ''}.`,
    action: null,
  };
}

/** Étapes « chemin vers l'acte » d'un module, lues dans les registres existants. */
export function cheminActe(ctx: AppContext, vx: VerticalesService, m: SectorModuleDef, credentialTypes: { code: string; label: string; activable: boolean; reason: string | null }[]): CheminActe {
  const jur = ctx.ext.juridique as JuridiqueService | undefined;
  const etapes: EtapeActe[] = [];
  const seen = new Set<string>();
  for (const p of m.prerequisites) {
    const codes = pointsCites(p);
    if (!codes.length) {
      etapes.push({
        code: `PREREQUIS-${etapes.length + 1}`, kind: 'PREREQUIS', label: p, statut: 'A_QUALIFIER',
        detail: 'Prérequis sans point juridique rattaché au registre (J1–J35) : rattachement à confirmer par le maître d’ouvrage ; en attendant, aucun montant.',
        action: { label: 'Rattacher au registre juridique', path: '/juridique/points', roles: POINT_PROPOSE_ROLES, qui: 'Juriste rédacteur ou vérificateur' },
      });
      continue;
    }
    for (const c of codes) {
      if (seen.has(c)) continue;
      seen.add(c);
      let question: string | undefined;
      try { question = jur?.definition(c).question; } catch { question = undefined; }
      etapes.push(etapePointJuridique(c, p, jur?.states.get(c), question));
    }
  }

  const fiche = FICHE_SECTEURS.includes(m.module) ? vx.fiches : undefined;
  const config = fiche?.config(m.module);
  // Règle retenue : celle de la fiche du module ; à défaut, la clé du registre de la verticale quand elle existe (antennes :
  // VX-TEL-SITES), jamais une règle fictive de démonstration d'une autre verticale.
  const registryKey = m.module === '16' ? ruleCodeFor('telecom') ?? null : null;
  const ruleCode = config?.ruleCode ?? registryKey;
  const today = ctx.clock.now().toISOString().slice(0, 10);
  const hasLevy = m.module !== '56';
  if (hasLevy) etapes.push(etapeRegle(ruleCode, latestRule(ctx, ruleCode), today));
  const ruleActive = hasLevy && etapes.at(-1)!.statut === 'FAIT';

  if (fiche && config) {
    const configured = !!config.ruleCode && config.actReference.trim().length > 0;
    const path = `/verticales/fiches?onglet=configuration&module=${m.module}`;
    etapes.push(configured
      ? {
          code: 'CONFIGURATION', kind: 'CONFIGURATION', label: 'Fiche du module : règle et référence de l’acte', statut: ruleActive ? 'FAIT' : 'EN_COURS', automatique: !ruleActive,
          detail: `Fiche configurée : règle ${config.ruleCode}, acte ${config.actReference}.${ruleActive ? '' : ' En attente de la règle ACTIVE : le module quitte « acte requis » automatiquement dès qu’elle l’est.'}`,
          action: null,
        }
      : {
          code: 'CONFIGURATION', kind: 'CONFIGURATION', label: 'Fiche du module : règle et référence de l’acte', statut: 'A_FAIRE',
          detail: 'La direction de la régie retient la règle du registre et la référence de l’acte dans la fiche du module (tracé, motivé) ; sans règle ACTIVE, le module reste en « acte requis ».',
          action: { label: 'Activer après acte', path, roles: CONFIGURE_ROLES, qui: 'Directeur général de la régie (DGTK)' },
        });
  }

  if (credentialTypes.length) {
    const ok = credentialTypes.filter((t) => t.activable);
    const catalogueModule = ['13', '22', '24', '25'].includes(m.module);
    etapes.push(ok.length
      ? { code: 'TITRE', kind: 'TITRE', label: 'Types de titres (§ 19A.4)', statut: 'FAIT', detail: `Activable(s) : ${ok.map((t) => t.label).join(', ')}.`, action: null }
      : {
          code: 'TITRE', kind: 'TITRE', label: 'Types de titres (§ 19A.4)', statut: 'A_FAIRE', automatique: !catalogueModule,
          detail: `Non activables : ${credentialTypes.map((t) => `${t.label} (${t.reason ?? 'acte requis'})`).join(' ; ')}. Un type devient activable avec la référence de l’acte et une règle de tarif ACTIVE.`,
          action: catalogueModule ? { label: 'Retenir le type de titre', path: `/verticales/fiches?onglet=configuration&module=${m.module}`, roles: CONFIGURE_ROLES, qui: 'Directeur général de la régie (DGTK)' } : null,
        });
  }

  // État du module : logique existante (règle ACTIVE de la fiche ; clé du registre pour les antennes ; type de titre
  // activable pour les véhicules ; conventions tranchées pour le suivi des grands redevables, sans montant propre).
  let enVigueur: boolean;
  if (m.module === '56') enVigueur = etapes.filter((e) => e.kind === 'POINT_JURIDIQUE').every((e) => e.statut === 'FAIT');
  else if (m.module === '11') enVigueur = credentialTypes.some((t) => t.activable);
  else if (m.module === '16') enVigueur = !!fiche?.ruleStatus('16').active || !!vx.activeRuleFor('telecom');
  else enVigueur = !!fiche?.ruleStatus(m.module).active;

  const faites = etapes.filter((e) => e.statut === 'FAIT').length;
  const prochaine = etapes.find((e) => e.statut !== 'FAIT') ?? null;
  return {
    module: m.module, etat: enVigueur ? 'ACTE_EN_VIGUEUR' : 'ACTE_REQUIS',
    etatLabel: enVigueur ? 'Acte en vigueur — règle ACTIVE' : 'Acte requis avant tout paiement',
    ruleCode, etapes, prochaine, faites, total: etapes.length,
    note: enVigueur
      ? 'Règle ACTIVE : la liquidation suit la fiche du module (automatique là où l’acte et la décision du maître d’ouvrage le prévoient) ; écarts et sanctions restent décidés par une personne.'
      : 'Avant l’acte : déclarations, relevés et rapprochements sont enregistrés, aucun montant n’est émis. Le module quitte « acte requis » automatiquement quand la règle retenue devient ACTIVE.',
  };
}
