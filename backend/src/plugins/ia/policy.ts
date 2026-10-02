/** Politiques d'accès du module « ia » (déclarées une fois ; non déclaré ⇒ refusé). */
import type { RoleCode } from '@mosolo/shared';
import { allAgentRoles, definePolicy, GRANTS, type Grant } from '../../core/policy.js';
import { AGENTS } from './catalogue.js';
import { LEVEL_A_ACTIONS } from './types.js';

const grant = (roles: RoleCode[], g: Grant = GRANTS.always): Partial<Record<RoleCode, Grant>> => Object.fromEntries(roles.map((r) => [r, g]));

/** Grants des agents « personnels » (compte du contribuable) : contribuable propre, mandataire, guichet. */
const personal = (roles: RoleCode[]): Partial<Record<RoleCode, Grant>> => ({
  ...(roles.includes('R30') ? { R30: GRANTS.ownTaxpayer } : {}),
  ...(roles.includes('R31') ? { R31: GRANTS.mandant } : {}),
  ...grant(roles.filter((r) => r !== 'R30' && r !== 'R31')),
});

export function registerIaPolicies(): void {
  for (const a of Object.values(AGENTS)) {
    definePolicy(`ia:run.${a.code}`, a.personal ? personal(a.runners) : grant(a.runners));
    definePolicy(`ia:decide.${a.code}`, a.personal ? personal(a.validators) : grant(a.validators));
  }
  // Actions de niveau A exécutées à la main (autonomie désactivée) ou annulées.
  for (const t of LEVEL_A_ACTIONS) {
    definePolicy(`ia:action.${t}`, { ...allAgentRoles(GRANTS.sameEntity), R22: GRANTS.always, R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant, R12: GRANTS.always });
  }
  // Actions de niveau B : exécutées au nom de l'agent public qui valide.
  definePolicy('ia:action.DEMANDER_PIECES', grant(['R06', 'R07', 'R09', 'R11']));
  definePolicy('ia:action.OUVRIR_MISSION', grant(['R06', 'R09']));
  definePolicy('ia:action.RELANCE_OBLIGATOIRE', grant(['R06', 'R07', 'R08'], GRANTS.sameEntity));
  definePolicy('ia:action.OUVRIR_DOSSIER_VERIFICATION', grant(['R24']));

  definePolicy('ia:agents.read', { ...allAgentRoles(GRANTS.always), R30: GRANTS.always, R31: GRANTS.always });
  definePolicy('ia:agent.kill', grant(['R28', 'R29']));
  definePolicy('ia:sweep', grant(['R22', 'R26', 'R29']));
  definePolicy('ia:inbox.read', { ...allAgentRoles(GRANTS.always), R30: GRANTS.always, R31: GRANTS.always });
  definePolicy('ia:autonomy.read', allAgentRoles(GRANTS.always));
  definePolicy('ia:autonomy.write', grant(['R06', 'R08'], GRANTS.sameEntity));
  definePolicy('ia:journal.read', { ...grant(['R22', 'R23', 'R25', 'R29']), ...grant(['R01', 'R06', 'R08', 'R17', 'R24'], GRANTS.sameEntity) });
  definePolicy('ia:journal.all', grant(['R22', 'R23', 'R25', 'R29']));
  definePolicy('ia:effects.all', grant(['R22', 'R23']));

  definePolicy('ia:memory.user', { ...allAgentRoles(GRANTS.always), R30: GRANTS.always, R31: GRANTS.always });
  definePolicy('ia:memory.process', { ...allAgentRoles(GRANTS.always), R30: GRANTS.always, R31: GRANTS.always });
  definePolicy('ia:memory.entity.read', { ...allAgentRoles(GRANTS.sameEntity), R22: GRANTS.always, R23: GRANTS.always });
  definePolicy('ia:memory.entity.write', grant(['R06', 'R08'], GRANTS.sameEntity));
  definePolicy('ia:memory.entity.erase', { ...grant(['R08'], GRANTS.sameEntity), R25: GRANTS.always });
  definePolicy('ia:memory.intelligence.read', allAgentRoles(GRANTS.always));
  definePolicy('ia:memory.intelligence.erase', grant(['R25', 'R29']));
  definePolicy('ia:memory.register', grant(['R22', 'R25']));
  definePolicy('ia:memory.purge', grant(['R25', 'R26']));
}
