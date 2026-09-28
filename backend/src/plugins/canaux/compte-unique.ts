/**
 * Canaux (USSD, SVI, carte MOSOLO, points agréés, enrôlement assisté) — contribution au compte unique (ch. 9) : cartes
 * MOSOLO du compte. Les canaux résolvent toujours le MÊME compte (téléphone ; compte fusionné ⇒ compte conservé) et ne
 * créent jamais de doublon (gardes anti-doublon du compte unique).
 */
import type { AppContext } from '../../context.js';
import type { CanauxService } from './service.js';

export function contribuerCompteUnique(ctx: AppContext, svc: CanauxService): void {
  ctx.compteUnique.register({
    module: 'canaux', titre: 'Cartes MOSOLO et canaux', lien: '/canaux/ussd',
    collect: (tp) => svc.cards.cards.find((c) => c.taxpayerId === tp).map((c) => ({
      rubrique: 'CARTE' as const, id: c.id, libelle: `Carte MOSOLO ••••${c.number.slice(-4)}`, nature: 'CARTE', statut: c.status, date: c.issuedAt, lien: `/canaux/carte/${encodeURIComponent(c.number)}`,
    })),
  });
}
