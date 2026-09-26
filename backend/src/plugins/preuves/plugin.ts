/**
 * Module d'extension « preuves » : vérification universelle de toute preuve par son code, sur tous les canaux —
 * application, pages légères sans JavaScript (/l), SMS, WhatsApp (assistant officiel sur consentement), USSD/SVI
 * (via « canaux ») et papier imprimé. Règle de couleur unique 50 % / 1 % à l'heure du serveur.
 */
import { definePlugin } from '../types.js';
import { registerPreuvesRoutes } from './routes.js';
import { PreuvesService } from './service.js';
import { WhatsAppAssistant } from './whatsapp.js';

export interface PreuvesModule { svc: PreuvesService; whatsapp: WhatsAppAssistant; resolve: PreuvesService['resolve'] }

export const preuvesPlugin = definePlugin<PreuvesModule>({
  name: 'preuves',
  create: (ctx) => {
    const svc = new PreuvesService(ctx);
    return { svc, whatsapp: new WhatsAppAssistant(ctx, svc), resolve: svc.resolve.bind(svc) };
  },
  routes: (app, ctx, m) => registerPreuvesRoutes(app, ctx, m.svc, m.whatsapp),
});

export { PreuvesService } from './service.js';
