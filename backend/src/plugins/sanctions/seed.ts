/**
 * Données de démonstration du registre des pénalités (fictives, non opposables) — seulement quand le module
 * « sanctions » est chargé avec le stationnement :
 * - une pénalité décidée il y a 35 jours et restée impayée : visible de tout agent de tout module après un contrôle ;
 * - un paiement de stationnement effectué dans l'heure qui suit un contrôle rouge : commission « paiement généré » ;
 * - un autre module : scan d'une plaque d'étal par un agent de terrain, puis dette de l'étal payée par le titulaire
 *   (commission de 10 % pour l'agent des verticales, même règle que pour le stationnement).
 */
import type { AppContext } from '../../context.js';
import type { ParkingService } from '../parking/service.js';
import { demoEvidencePhotos, PARKING_DEMO } from '../parking/seed.js';
import { demoPay } from '../parking/support.js';
import type { VerticalesService } from '../verticales/service.js';

export function seedSanctions(ctx: AppContext): void {
  const svc = ctx.ext.parking as ParkingService | undefined;
  const controleur = ctx.users.get('pk-controleur');
  const superviseur = ctx.users.get('pk-superviseur');
  const autorite = ctx.users.get('pk-autorite');
  const owner = ctx.users.get('u-contribuable');
  if (!svc || !controleur || !superviseur || !autorite || !owner) return;
  // Contrôle rouge sur le boulevard Lumumba (la session payée de la plaque est à Gombe), photo, puis constat.
  const red = svc.control(controleur, PARKING_DEMO.plateOwner, PARKING_DEMO.zoneLimete);
  const at = { lat: -4.3721, lon: 15.3462, place: 'Boulevard Lumumba, passage piéton (démonstration)' };
  const v3 = svc.recordViolation(controleur, {
    zoneId: PARKING_DEMO.zoneLimete, plate: PARKING_DEMO.plateOwner, nature: 'STATIONNEMENT_INTERDIT', checkId: red.checkId,
    photoIds: demoEvidencePhotos(svc, controleur, red.checkId, ['constat-4'], at), lat: at.lat, lon: at.lon, gpsAccuracyM: 5,
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

  // Verticales : scan d'une plaque par un agent habilité du périmètre, puis paiement d'une dette de l'objet.
  const vx = ctx.ext.verticales as VerticalesService | undefined;
  if (vx) {
    const agents = ctx.users.all().filter((u) => u.roles.some((r) => r === 'R10') && u.territory?.length);
    for (const p of vx.plates.all()) {
      const agent = agents.find((a) => a.territory!.includes(p.commune));
      // Dette ÉCHUE (situation rouge au scan) : seul un scan qui révèle un défaut fonde une commission.
      const today = ctx.clock.now().toISOString().slice(0, 10);
      const ob = ctx.assessment.obligations.find((o) => o.objectId === p.objectId && o.status !== 'SOLDEE' && o.status !== 'ANNULEE' && o.status !== 'CONTESTEE' && (o.dueDate < today || o.status === 'EN_RETARD'))[0];
      const payer = ob ? ctx.users.all().find((u) => u.taxpayerId === ob.taxpayerId) : undefined;
      if (!agent || !ob || !payer) continue;
      vx.scanPlate(agent, p.code);
      demoPay(ctx, payer, ob.id);
      break;
    }
  }
}
