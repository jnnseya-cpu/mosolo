/**
 * Matrice d'habilitations du module terrain (§ 12.4, § 15A ; H.6.1, H.8.5).
 * Non déclaré ⇒ refusé. Le périmètre fin (son sous-traitant, ses missions, son territoire) est contrôlé
 * dans le service. Aucune action n'est ouverte à l'IA.
 */
import { definePolicy, GRANTS } from '../../core/policy.js';

const { always } = GRANTS;

/** Direction de régie (R06) et responsable de module (R07). */
const REGIE = { R06: always, R07: always } as const;
const OVERSIGHT = { R22: always, R23: always, R24: always } as const;

export const TERRAIN_ACTIONS = {
  subcontractorRead: 'terrain:subcontractor.read',
  subcontractorManage: 'terrain:subcontractor.manage',
  subcontractorAccredit: 'terrain:subcontractor.accredit',
  subcontractorDossier: 'terrain:subcontractor.dossier',
  lotManage: 'terrain:lot.manage',
  agentRead: 'terrain:agent.read',
  agentInvite: 'terrain:agent.invite',
  agentHabilitate: 'terrain:agent.habilitate',
  agentSuspend: 'terrain:agent.suspend',
  badgeIssue: 'terrain:badge.issue',
  missionRead: 'terrain:mission.read',
  missionCreate: 'terrain:mission.create',
  missionAssign: 'terrain:mission.assign',
  findingSubmit: 'terrain:finding.submit',
  findingReview: 'terrain:finding.review',
  qualitySample: 'terrain:quality.sample',
  qualityRead: 'terrain:quality.read',
  counterVisitPerform: 'terrain:countervisit.perform',
  mysteryManage: 'terrain:mystery.manage',
  settingsManage: 'terrain:settings.manage',
  remunerationRead: 'terrain:remuneration.read',
} as const;

export function declareTerrainPolicies(): void {
  const A = TERRAIN_ACTIONS;
  definePolicy(A.subcontractorRead, { ...REGIE, R08: always, R09: always, R11: always, ...OVERSIGHT, R35: always });
  definePolicy(A.subcontractorManage, { ...REGIE });
  // Maker-checker : proposition et approbation par deux personnes distinctes de la régie.
  definePolicy(A.subcontractorAccredit, { ...REGIE });
  // Le sous-traitant complète son propre dossier (contrôle du rattachement dans le service).
  definePolicy(A.subcontractorDossier, { ...REGIE, R35: always });
  definePolicy(A.lotManage, { ...REGIE });
  definePolicy(A.agentRead, { ...REGIE, R09: always, R11: always, ...OVERSIGHT, R35: always });
  // Le gestionnaire invite ; l'agent reste inactif jusqu'à l'habilitation par la régie.
  definePolicy(A.agentInvite, { R07: always, R35: always });
  // Habilitation : la régie seulement — jamais le sous-traitant lui-même.
  definePolicy(A.agentHabilitate, { ...REGIE });
  // Suspension conservatoire immédiate sur décision motivée.
  definePolicy(A.agentSuspend, { ...REGIE, R09: always, R35: always });
  definePolicy(A.badgeIssue, { ...REGIE });
  definePolicy(A.missionRead, { ...REGIE, R09: always, R10: always, R11: always, ...OVERSIGHT, R35: always });
  definePolicy(A.missionCreate, { R07: always, R09: always, R35: always });
  definePolicy(A.missionAssign, { R07: always, R09: always, R35: always });
  definePolicy(A.findingSubmit, { R10: always });
  // Validation indépendante par la régie : jamais le sous-traitant, jamais l'auteur.
  definePolicy(A.findingReview, { R09: always, R11: always });
  definePolicy(A.qualitySample, { R09: always, R11: always, R22: always });
  definePolicy(A.qualityRead, { ...REGIE, R09: always, R11: always, ...OVERSIGHT, R35: always });
  definePolicy(A.counterVisitPerform, { R10: always, R11: always });
  definePolicy(A.mysteryManage, { R22: always, R24: always });
  definePolicy(A.settingsManage, { R06: always });
  definePolicy(A.remunerationRead, { ...REGIE, R17: always, R22: always, R23: always, R35: always });
}
