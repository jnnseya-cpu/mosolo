/** Notifications et communication (module 39) — contribution au compte unique (ch. 9) : préférences et consentements. */
import type { AppContext } from '../../context.js';
import type { CommunicationExtService } from './service.js';

export function contribuerCompteUnique(ctx: AppContext, svc: CommunicationExtService): void {
  ctx.compteUnique.register({
    module: 'communication', titre: 'Préférences de communication et consentements', lien: '/communication/notifications',
    collect: (tp) => {
      const t = ctx.taxpayers.taxpayers.get(tp);
      if (!t) return [];
      const prefs = t.prefs as Record<string, unknown>;
      return [
        {
          rubrique: 'CONSENTEMENT' as const, id: `PREF-${tp}`, libelle: `Langue ${t.language}${prefs.preferredChannel ? ` · canal préféré ${String(prefs.preferredChannel)}` : ''}${prefs.whatsappConsent ? ' · WhatsApp consenti' : ''}${prefs.optedOut ? ' · messages facultatifs refusés' : ''}`,
          nature: 'PREFERENCES', statut: 'EN_VIGUEUR', lien: '/communication/notifications',
        },
        ...svc.consents.find((c) => c.taxpayerId === tp).map((c) => ({ rubrique: 'CONSENTEMENT' as const, id: c.id, libelle: `Changement de préférences (${Object.keys(c.after).join(', ') || '—'})`, nature: 'HISTORIQUE', statut: 'ENREGISTRE', date: c.at, lien: '/communication/notifications' })),
      ];
    },
  });
}
