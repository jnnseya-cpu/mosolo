/** Publicité (module 16) — contribution au compte unique (ch. 9) : enseignes et supports, autorisations. */
import type { AppContext } from '../../context.js';
import type { PubliciteService } from './service.js';

export function contribuerCompteUnique(ctx: AppContext, svc: PubliciteService): void {
  ctx.compteUnique.register({
    module: 'publicite', titre: 'Publicité et enseignes', lien: '/publicite',
    collect: (tp) => [
      ...svc.devices.find((d) => d.ownerTaxpayerId === tp).map((d) => ({
        rubrique: 'ENSEIGNE' as const, id: d.id, libelle: `${d.businessName ?? 'Support'} ${d.type} ${d.surfaceM2} m² — ${d.commune}`, nature: d.type, statut: d.registration, date: d.createdAt,
        ...(d.objectId ? { objectId: d.objectId } : {}), lien: '/publicite',
      })),
      ...svc.requests.find((r) => r.taxpayerId === tp).map((r) => {
        const objectId = svc.devices.get(r.deviceId)?.objectId;
        return {
          rubrique: 'DEMARCHE' as const, id: r.id, libelle: `Autorisation d’affichage ${r.reference} (${r.periodFrom} → ${r.periodTo})`, nature: 'AUTORISATION', statut: r.status, date: r.submittedAt, echeance: r.periodTo,
          ...(objectId ? { objectId } : {}), lien: '/publicite',
        };
      }),
    ],
  });
}
