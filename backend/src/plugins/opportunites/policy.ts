/**
 * Matrice d'habilitations du module « opportunités » (§ 8.4 – § 8.7). Non déclaré ⇒ refusé (moindre privilège).
 * Aucune de ces actions n'est ouverte à un agent d'IA : la garde centrale (`assertAiMay`) refuse toute action
 * d'extension à l'IA — « aucune opportunité ne devient une taxe par simple décision algorithmique ».
 */
import type { RoleCode } from '@mosolo/shared';
import { definePolicy, GRANTS, type Grant } from '../../core/policy.js';
import { PIPELINE } from './model.js';

const { always, inTerritory } = GRANTS;
const grant = (roles: RoleCode[], g: Grant = always): Partial<Record<RoleCode, Grant>> => Object.fromEntries(roles.map((r) => [r, g]));

export const OPP_ACTIONS = {
  read: 'opportunites:read',
  signal: 'opportunites:step.1',
  grid: 'opportunites:grid.write',
  hypothesis: 'opportunites:hypothesis.write',
  decide: 'opportunites:step.8',
  maxRead: 'opportunites:max.read',
  maxWrite: 'opportunites:max.write',
  simulate: 'opportunites:simulate',
  sourceRead: 'opportunites:source.read',
  sourceCreate: 'opportunites:source.create',
  sourceProtocol: 'opportunites:source.protocol',
  sourceCompliance: 'opportunites:source.compliance',
  sourceSuspend: 'opportunites:source.suspend',
  ingest: 'opportunites:source.ingest',
  worklistRead: 'opportunites:worklist.read',
  worklistReview: 'opportunites:worklist.review',
  worklistMission: 'opportunites:worklist.mission',
  plateStatus: 'opportunites:plate.status',
  blockRead: 'opportunites:block.read',
  blockRecheck: 'opportunites:block.recheck',
  params: 'opportunites:params.write',
} as const;

/** Lecture du registre : autorités, régie, juristes, validation financière, contrôle interne, audit, protection des données. */
export const READ_ROLES: RoleCode[] = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R09', 'R11', 'R13', 'R14', 'R15', 'R22', 'R23', 'R24', 'R25'];

export function declareOpportunitesPolicies(): void {
  const A = OPP_ACTIONS;
  definePolicy(A.read, grant(READ_ROLES));
  // Une étape du pipeline = une action ; seules les personnes du rôle responsable (§ 8.4) la complètent.
  for (const s of PIPELINE) definePolicy(`opportunites:step.${s.n}`, grant(s.roles));
  // Rubriques de la grille : le rôle fin par rubrique est contrôlé par le service (GRID_FIELD_ROLES).
  definePolicy(A.grid, grant(['R02', 'R05', 'R06', 'R07', 'R13', 'R14', 'R15', 'R22', 'R24']));
  definePolicy(A.hypothesis, grant(['R06', 'R07', 'R13', 'R14', 'R15']));
  definePolicy(A.maxRead, grant([...READ_ROLES, 'R17', 'R18']));
  definePolicy(A.maxWrite, grant(['R06', 'R07', 'R15']));
  definePolicy(A.simulate, grant(['R05', 'R06', 'R07', 'R15']));
  definePolicy(A.sourceRead, grant(['R05', 'R06', 'R07', 'R08', 'R22', 'R23', 'R25', 'R34']));
  definePolicy(A.sourceCreate, grant(['R06', 'R07']));
  // Protocole signé : direction de régie ou ministre des Finances ; conformité : délégué à la protection des données.
  definePolicy(A.sourceProtocol, grant(['R05', 'R06']));
  definePolicy(A.sourceCompliance, grant(['R25']));
  definePolicy(A.sourceSuspend, grant(['R06', 'R25']));
  definePolicy(A.ingest, grant(['R06', 'R07', 'R34']));
  definePolicy(A.worklistRead, { ...grant(['R06', 'R07', 'R11', 'R22', 'R24']), R09: inTerritory('full'), R10: inTerritory('minimal') });
  definePolicy(A.worklistReview, grant(['R06', 'R07', 'R11']));
  definePolicy(A.worklistMission, grant(['R07', 'R09']));
  definePolicy(A.plateStatus, { R11: always, R10: inTerritory('minimal') });
  definePolicy(A.blockRead, grant(['R06', 'R07', 'R12', 'R22', 'R37']));
  definePolicy(A.blockRecheck, grant(['R06', 'R07', 'R12', 'R37']));
  definePolicy(A.params, grant(['R06']));
}
