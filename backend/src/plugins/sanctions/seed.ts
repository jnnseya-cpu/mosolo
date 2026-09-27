/**
 * Données de démonstration du registre des pénalités (fictives, non opposables) — seulement quand le module
 * « sanctions » est chargé avec le stationnement :
 * - une pénalité décidée il y a 35 jours et restée impayée : visible de tout agent de tout module après un contrôle ;
 * - un paiement de stationnement effectué dans l'heure qui suit un contrôle rouge : commission « paiement généré ».
 */
import type { AppContext } from '../../context.js';
import { sha256Hex } from '../../core/crypto.js';
import type { ParkingService } from '../parking/service.js';
import { PARKING_DEMO } from '../parking/seed.js';
import { demoPay } from '../parking/support.js';

export function seedSanctions(ctx: AppContext): void {
  const svc = ctx.ext.parking as ParkingService | undefined;
  const controleur = ctx.users.get('pk-controleur');
  const superviseur = ctx.users.get('pk-superviseur');
  const autorite = ctx.users.get('pk-autorite');
  const owner = ctx.users.get('u-contribuable');
  if (!svc || !controleur || !superviseur || !autorite || !owner) return;
  const v3 = svc.recordViolation(controleur, {
    zoneId: PARKING_DEMO.zoneGombe, plate: PARKING_DEMO.plateOwner, nature: 'STATIONNEMENT_INTERDIT',
    photoSha256: [sha256Hex('demo-photo-constat-4')], lat: -4.3049, lon: 15.3097, gpsAccuracyM: 5,
    observations: 'Stationnement sur passage piéton signalé (démonstration, antidatée de 35 jours).',
  });
  svc.verifyViolation(superviseur, v3.id, { confirm: true, note: 'Photographie nette, marquage au sol visible (démonstration).' });
  svc.decideViolation(autorite, v3.id, { outcome: 'RETENUE', reason: 'Constat probant (démonstration).' });
  const back = (iso: string) => new Date(Date.parse(iso) - 35 * 86_400_000).toISOString();
  const cur = svc.violations.get(v3.id)!;
  svc.violations.update({
    ...cur, createdAt: back(cur.createdAt),
    ...(cur.verification ? { verification: { ...cur.verification, at: back(cur.verification.at) } } : {}),
    ...(cur.decision ? { decision: { ...cur.decision, at: back(cur.decision.at) } } : {}),
  });
  svc.control(controleur, 'KN-0321-DM', PARKING_DEMO.zoneGombe);
  const s3 = svc.startSession(owner, { zoneId: PARKING_DEMO.zoneGombe, plate: 'KN-0321-DM', durationMinutes: 60 });
  demoPay(ctx, owner, s3.obligation.id);
}
