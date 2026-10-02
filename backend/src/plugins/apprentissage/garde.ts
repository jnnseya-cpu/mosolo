/**
 * Garde de certification réutilisable par les autres modules (§ 24), sans dépendance à l'exécution envers le service :
 * si le module d'apprentissage n'est pas chargé (déploiement ou test sans lui), la garde est inactive et les contrôles
 * existants du module appelant restent seuls en vigueur.
 */
import type { AppContext } from '../../context.js';
import type { ProfilCertifie } from './model.js';
import type { ApprentissageService, EtatCertification } from './service.js';

export function certificationValide(ctx: AppContext, userId: string, profil: ProfilCertifie): EtatCertification {
  const svc = ctx.ext.apprentissage as ApprentissageService | undefined;
  if (!svc) return { applicable: false, valide: true, profil, certificat: null, manquants: [], exigences: [] };
  return svc.certificationValide(userId, profil);
}
