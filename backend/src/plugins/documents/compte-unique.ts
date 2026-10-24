/** Gestion documentaire (module 38) — contribution au compte unique (ch. 9) : pièces déposées sur le compte (métadonnées). */
import type { AppContext } from '../../context.js';
import type { DocumentService } from './service.js';

export function contribuerCompteUnique(ctx: AppContext, svc: DocumentService): void {
  ctx.compteUnique.register({
    module: 'documents', titre: 'Documents du compte', lien: '/documents',
    collect: (tp) => svc.documents.find((d) => d.taxpayerId === tp && d.status === 'ACTIF').map((d) => ({
      rubrique: 'DOCUMENT' as const, id: d.id, libelle: d.title, nature: d.category, statut: d.classification.status, date: d.createdAt, lien: '/documents',
    })),
  });
}
