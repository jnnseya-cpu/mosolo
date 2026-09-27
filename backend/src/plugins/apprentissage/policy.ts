/**
 * Matrice d'habilitations du module d'apprentissage (§ 24). Non déclaré ⇒ refusé. Aucune action n'est ouverte à
 * l'IA (elle peut proposer un brouillon ailleurs ; ici un humain rédige, un autre publie).
 */
import { allAgentRoles, definePolicy, GRANTS } from '../../core/policy.js';

const { always } = GRANTS;
/** Rédaction et publication des contenus : régie, entité, supervision, Trésor et sécurité (quatre yeux entre eux). */
const REDACTION = { R06: always, R07: always, R08: always, R09: always, R17: always, R28: always } as const;
/** Évaluateurs et gestion des certificats (le périmètre par public est contrôlé dans le service). */
const CERTIF = { R06: always, R07: always, R08: always, R09: always, R17: always, R26: always, R28: always } as const;
const CONTROLE = { R22: always, R23: always } as const;

export const APPRENTISSAGE_ACTIONS = {
  espaceRead: 'apprentissage:espace.read',
  epreuveSubmit: 'apprentissage:epreuve.submit',
  contenuWrite: 'apprentissage:contenu.write',
  contenuApprove: 'apprentissage:contenu.approve',
  certificationRead: 'apprentissage:certification.read',
  certificationManage: 'apprentissage:certification.manage',
  indicateursRead: 'apprentissage:indicateurs.read',
} as const;

export function declareApprentissagePolicies(): void {
  const A = APPRENTISSAGE_ACTIONS;
  // Espace personnel : chaque agent, sous-traitant terrain, contribuable ou mandataire voit SES contenus et SES certificats.
  definePolicy(A.espaceRead, { ...allAgentRoles(always), R30: always, R31: always, R35: always });
  definePolicy(A.epreuveSubmit, { ...allAgentRoles(always), R35: always });
  definePolicy(A.contenuWrite, { ...REDACTION });
  // Publication : une seconde personne, distincte de l'auteur et du proposant (contrôlé dans le service).
  definePolicy(A.contenuApprove, { ...REDACTION });
  definePolicy(A.certificationRead, { ...CERTIF, ...CONTROLE, R24: always });
  definePolicy(A.certificationManage, { ...CERTIF });
  definePolicy(A.indicateursRead, { R01: always, R02: always, R03: always, R05: always, ...CERTIF, ...CONTROLE });
}
