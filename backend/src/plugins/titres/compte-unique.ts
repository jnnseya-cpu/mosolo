/** Titres (module 19A) — contribution au compte unique (ch. 9) : titres, pass et tickets du titulaire ou payés par lui. */
import type { AppContext } from '../../context.js';
import type { TitresService } from './service.js';

/** Modules dont les titres sont des pass ou tickets (RakaPay : billetterie 76, pass wewa 81). */
const PASS_MODULES = new Set(['76', '81']);

export function contribuerCompteUnique(ctx: AppContext, svc: TitresService): void {
  ctx.compteUnique.register({
    module: 'titres', titre: 'Titres, autorisations, pass et tickets', lien: '/titres/catalogue',
    collect: (tp) => { svc.sync(); return svc.byHolder(tp).map((c) => {
      const t = svc.types.findOne((x) => x.code === c.typeCode && x.version === c.typeVersion);
      return {
        rubrique: PASS_MODULES.has(c.module) ? 'PASS' as const : 'TITRE' as const, id: c.id, libelle: `${t?.label ?? c.typeCode} ${c.number}${c.subject.label ? ` — ${c.subject.label}` : ''}`,
        nature: c.module, statut: c.state, date: c.issuedAt, echeance: c.validUntil, ...(c.amount ? { montant: c.amount } : {}),
        lien: PASS_MODULES.has(c.module) ? '/services/rakapay' : '/titres/catalogue',
      };
    }); },
  });
}
