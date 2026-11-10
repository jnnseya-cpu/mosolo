/** Stationnement (modules 14, 75) — contribution au compte unique (ch. 9) : sessions, réservations, véhicules, constats. */
import type { AppContext } from '../../context.js';
import type { ParkingService } from './service.js';

export function contribuerCompteUnique(ctx: AppContext, svc: ParkingService): void {
  ctx.compteUnique.register({
    module: 'stationnement', titre: 'Stationnement intelligent (ParkSmart)', lien: '/stationnement',
    collect: (tp) => {
      const now = ctx.clock.now();
      return [
        ...svc.sessions.find((s) => s.payerTaxpayerId === tp).map((s) => {
          const d = svc.sessionDerived(s, now);
          const z = svc.zones.get(s.zoneId);
          return { rubrique: 'SESSION' as const, id: s.id, libelle: `Session ${s.plate} — ${z?.name ?? s.zoneId}`, nature: 'SESSION', statut: d.status, date: s.createdAt, objectId: s.objectId, lien: '/stationnement' };
        }),
        ...svc.reservations.find((r) => r.taxpayerId === tp).map((r) => ({ rubrique: 'DEMARCHE' as const, id: r.id, libelle: `Réservation de voirie ${r.reference} (${r.purpose})`, nature: 'RESERVATION', statut: r.status, date: r.startAt, echeance: r.endAt, ...(r.objectId ? { objectId: r.objectId } : {}), lien: '/stationnement' })),
        ...svc.vehicles.find((v) => v.taxpayerId === tp).map((v) => ({ rubrique: 'VEHICULE' as const, id: v.id, libelle: `Véhicule ${v.plate} (stationnement)`, nature: 'PLAQUE', statut: v.probativeStatus, date: v.declaredAt, lien: '/stationnement' })),
        ...svc.violations.find((v) => v.holderTaxpayerId === tp).map((v) => ({ rubrique: 'ARRIERE' as const, id: v.id, libelle: `Constat de stationnement ${v.reference} (${v.nature})`, nature: 'CONSTAT', statut: v.status, date: v.createdAt, lien: '/stationnement', ...(v.decision?.obligationId ? { obligationId: v.decision.obligationId } : {}) })),
      ];
    },
  });
}
