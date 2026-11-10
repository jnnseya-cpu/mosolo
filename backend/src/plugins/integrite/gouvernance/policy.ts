/**
 * Habilitations des risques résiduels (moindre privilège) :
 * - collusion : lecture par l'audit interne et externe (R22, R23), l'anti-fraude (R24), la sécurité (R28) et la
 *   direction de la régie (R06) ; exécution de la détection (levée d'alertes) par R22, R24, R28 ;
 * - registre des seuils : lecture par l'audit, l'anti-fraude, la sécurité, la direction et l'exploitation ;
 *   proposition par l'anti-fraude, la sécurité ou la direction ; approbation par la direction (R06), le ministre
 *   des Finances (R05) ou la sécurité (R28) — toujours une personne distincte de l'auteur ;
 * - santé des clés : administration de la plateforme (R26) et sécurité (R28) seulement.
 */
import { definePolicy, GRANTS } from '../../../core/policy.js';

const { always } = GRANTS;

export function declareGouvernancePolicies(): void {
  definePolicy('integrite:collusion.read', { R22: always, R23: always, R24: always, R28: always, R06: always });
  definePolicy('integrite:collusion.run', { R22: always, R24: always, R28: always });
  definePolicy('integrite:thresholds.read', { R22: always, R23: always, R24: always, R28: always, R06: always, R05: always, R01: always, R02: always, R26: always, R27: always });
  definePolicy('integrite:thresholds.propose', { R24: always, R28: always, R06: always });
  definePolicy('integrite:thresholds.approve', { R06: always, R05: always, R28: always });
  definePolicy('integrite:keys.read', { R26: always, R28: always });
}
