/**
 * Politiques PROPRES au module des postes (présentation). Elles n'ouvrent aucun droit sur les actions des autres
 * modules : décider un élément d'un module source reste soumis à la politique de ce module (relais vers sa route).
 * Non déclaré ⇒ refusé ; jamais permis à l'IA.
 */
import type { RoleCode } from '@mosolo/shared';
import { allAgentRoles, definePolicy, GRANTS } from '../../core/policy.js';
import { ROLES_POSTE_DECISION } from './model.js';

const { always } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));

export function registerPostesPolicies(): void {
  // Poste de décision : Gouverneur, Directeur de cabinet, Secrétaire exécutif, ministres, direction de régie (§ 27.13).
  definePolicy('postes:decision.read', g(ROLES_POSTE_DECISION));
  definePolicy('postes:decision.act', g(ROLES_POSTE_DECISION));
  definePolicy('postes:delegation.create', g(ROLES_POSTE_DECISION));
  // Services instructeurs d'un dossier d'orientation (fiche à neuf blocs) : cabinet, secrétariat, ministre des Finances,
  // régies, administration d'entité, juristes, validation financière, Trésor, audit et anti-fraude.
  definePolicy('postes:dossier.submit', g(['R02', 'R03', 'R05', 'R06', 'R07', 'R08', 'R13', 'R14', 'R15', 'R17', 'R22', 'R24']));
  definePolicy('postes:cabinet.prepare', g(['R02']));
  // L'état d'exécution est déclaré par le service responsable (contrôle fin dans le service).
  definePolicy('postes:execution.update', allAgentRoles(always));
  definePolicy('postes:execution.relance', g(['R01', 'R02', 'R03', 'R04', 'R05']));
  // Déclaration de la portée d'une habilitation de consultation (§ 27.9), à l'ouverture des droits.
  definePolicy('postes:habilitation.declare', g(['R02', 'R03', 'R26']));
  // Consultation par une autre autorité habilitée : l'habilitation active et datée est vérifiée par le service.
  definePolicy('postes:consultation.read', { ...allAgentRoles(always), R36: always });
  // Poste de travail (§ 27.13) : tout utilisateur connu.
  definePolicy('postes:travail.read', { ...allAgentRoles(always), ...g(['R30', 'R31', 'R32', 'R33', 'R34', 'R35', 'R36', 'R37']) });
  definePolicy('postes:indicateurs.read', g(['R01', 'R02', 'R03', 'R22', 'R23']));
}
