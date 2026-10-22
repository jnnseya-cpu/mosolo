/**
 * Verticales (17 espaces de démarches, AVIA, secteurs, grands redevables) — contribution au compte unique (ch. 9) :
 * démarches, certificats, étals, déclarations sectorielles et AVIA. Tout est déjà rattaché au compte (taxpayerId) ;
 * les signalements protégés (demande d'espèces) ne sont jamais listés.
 */
import type { AppContext } from '../../context.js';
import type { VerticalesService } from './service.js';

export function contribuerCompteUnique(ctx: AppContext, svc: VerticalesService): void {
  ctx.compteUnique.register({
    module: 'verticales', titre: 'Démarches des services (verticales, AVIA, secteurs)', lien: '/services',
    collect: (tp) => [
      ...svc.cases.find((c) => c.taxpayerId === tp && !c.protectedReport).map((c) => ({ rubrique: 'DEMARCHE' as const, id: c.id, libelle: `${c.typeLabel} (${c.vertical})`, nature: c.vertical, statut: c.status, date: c.createdAt, ...(c.objectId ? { objectId: c.objectId } : {}), lien: `/services/${c.vertical}` })),
      ...svc.certificates.find((c) => c.taxpayerId === tp).map((c) => ({ rubrique: 'TITRE' as const, id: c.id, libelle: `${c.label} ${c.code}`, nature: c.kind, statut: c.status, date: c.validFrom, ...(c.validUntil ? { echeance: c.validUntil } : {}), ...(c.objectId ? { objectId: c.objectId } : {}), lien: `/services/${c.vertical}` })),
      ...svc.stalls.find((s) => s.holderTaxpayerId === tp).map((s) => ({ rubrique: 'OBJET' as const, id: s.id, libelle: `Étal ${s.row}-${s.number} (${s.surfaceM2} m²)`, nature: 'ETAL', statut: 'ATTRIBUE', lien: '/services/marches' })),
      ...svc.avia.declarations.find((d) => d.taxpayerId === tp).map((d) => ({ rubrique: 'DEMARCHE' as const, id: d.id, libelle: `Déclaration AVIA ${d.period}`, nature: 'AVIA', statut: d.status, lien: '/services/avia' })),
      ...svc.secteurs.declarations.find((d) => d.taxpayerId === tp).map((d) => ({ rubrique: 'DEMARCHE' as const, id: d.id, libelle: `Déclaration sectorielle ${d.kind} ${d.period}`, nature: d.module, statut: d.status, ...(d.objectId ? { objectId: d.objectId } : {}), lien: '/verticales/secteurs' })),
      ...svc.secteurs.largeTaxpayers.find((l) => l.taxpayerId === tp).map((l) => ({ rubrique: 'ROLE' as const, id: l.id, libelle: `Portefeuille des grands redevables (${l.sectors.join(', ')})`, nature: 'GRAND_REDEVABLE', statut: l.status, lien: '/grands-redevables' })),
    ],
  });
}
