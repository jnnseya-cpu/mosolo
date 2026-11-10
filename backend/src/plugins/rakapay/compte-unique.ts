/**
 * RakaPay (modules 76 et 81) — compte unique (ch. 9). Le conducteur wewa et la coopérative ne sont pas des comptes à
 * part : la fiche « conducteur » est une fiche de MÉTIER (gilet, permis, moto) rattachée au compte unique de la personne.
 *  - fiches : conducteurs et motos, rattachés ou non (une fiche non rattachée est signalée, jamais fusionnée d'office) ;
 *  - rattachement EXACT : quand une personne vérifie par code le téléphone porté par une fiche, la fiche lui est
 *    rattachée (journalisé) ; jamais sur un nom ;
 *  - contributions : fiche de conducteur, motos dont la personne est propriétaire, coopérative gérée.
 */
import type { AppContext } from '../../context.js';
import type { RakaPayService } from './service.js';

const norm = (p: string | undefined) => (p ?? '').replace(/[\s-]/g, '');

export function contribuerCompteUnique(ctx: AppContext, svc: RakaPayService): void {
  ctx.compteUnique.register({
    module: 'rakapay', titre: 'Transport : conducteur wewa, motos, coopérative (RakaPay)', lien: '/services/rakapay',
    collect: (tp) => [
      ...svc.drivers.find((d) => d.taxpayerId === tp).map((d) => ({ rubrique: 'FICHE_METIER' as const, id: d.id, libelle: `Conducteur wewa — gilet ${d.vestNumber}`, nature: 'CONDUCTEUR_WEWA', statut: d.status, date: d.registeredAt, lien: '/services/rakapay' })),
      ...svc.motos.find((m) => m.ownerTaxpayerId === tp).map((m) => ({ rubrique: 'VEHICULE' as const, id: m.id, libelle: `Moto ${m.plate} (n° d’ordre ${m.orderNumber})`, nature: 'MOTO_WEWA', statut: m.status, date: m.registeredAt, lien: '/services/rakapay' })),
      ...svc.operators.find((o) => o.taxpayerId === tp).map((o) => ({ rubrique: 'ORGANISATION' as const, id: o.id, libelle: `${o.name} (${o.kind === 'COOPERATIVE' ? 'coopérative' : 'opérateur'})`, nature: o.kind, statut: o.status, date: o.createdAt, lien: o.kind === 'COOPERATIVE' ? '/rakapay/cooperative' : '/rakapay/operateurs' })),
    ],
    fiches: () => [
      ...svc.drivers.all().map((d) => ({ module: 'rakapay', type: 'CONDUCTEUR_WEWA', id: d.id, libelle: `Gilet ${d.vestNumber}`, ...(d.taxpayerId ? { taxpayerId: d.taxpayerId } : {}), ...(d.phone ? { phone: norm(d.phone) } : {}) })),
      ...svc.operators.all().map((o) => ({ module: 'rakapay', type: o.kind === 'COOPERATIVE' ? 'COOPERATIVE' : 'OPERATEUR', id: o.id, libelle: o.name, ...(o.taxpayerId ? { taxpayerId: o.taxpayerId } : {}) })),
    ],
    rattacher: (taxpayerId, phone) => {
      let n = 0;
      for (const d of svc.drivers.find((x) => !x.taxpayerId && !!x.phone && norm(x.phone) === norm(phone))) {
        if (svc.drivers.findOne((x) => x.taxpayerId === taxpayerId)) break; // un compte = une fiche de conducteur
        svc.drivers.update({ ...d, taxpayerId });
        ctx.audit.append({ actor: { kind: 'system', id: 'compte-unique' }, action: 'rakapay.driver.linked_to_account', resourceType: 'driver', resourceId: d.id, details: { taxpayerId, basis: 'TELEPHONE_VERIFIE_PAR_CODE' } });
        n += 1;
      }
      return n;
    },
  });
}
