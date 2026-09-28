/** Recouvrement (modules 31 à 33) — contribution au compte unique (ch. 9) : dossiers d'arriérés et échéanciers. */
import type { AppContext } from '../../context.js';
import type { RecoveryService } from './service.js';

export function contribuerCompteUnique(ctx: AppContext, svc: RecoveryService): void {
  ctx.compteUnique.register({
    module: 'recouvrement', titre: 'Arriérés, avis et échéanciers', lien: '/recouvrement',
    collect: (tp) => {
      const objectOf = (obligationId: string) => { try { return ctx.assessment.get(obligationId).objectId; } catch { return undefined; } };
      return [
        ...svc.cases.find((c) => c.taxpayerId === tp).map((c) => {
          const objectId = objectOf(c.obligationId);
          return { rubrique: 'ARRIERE' as const, id: c.id, libelle: `Dossier de recouvrement — obligation ${c.obligationId}`, nature: 'RECOUVREMENT', statut: c.status, date: c.openedAt, ...(objectId ? { objectId } : {}), lien: '/recouvrement' };
        }),
        ...svc.plans.find((p) => p.taxpayerId === tp).map((p) => {
          const objectId = objectOf(p.obligationId);
          return { rubrique: 'DEMARCHE' as const, id: p.id, libelle: `Échéancier (${p.requestedCount} échéances) — obligation ${p.obligationId}`, nature: 'ECHEANCIER', statut: p.status, date: p.requestedAt, ...(objectId ? { objectId } : {}), lien: '/recouvrement' };
        }),
      ];
    },
  });
}
