/** Module d'extension « sanctions » : registre transversal des pénalités impayées, visible après un contrôle. */
import { definePlugin } from '../types.js';
import { SanctionsService } from './service.js';
import { seedSanctions } from './seed.js';

export const sanctionsPlugin = definePlugin<SanctionsService>({
  name: 'sanctions',
  create: (ctx) => new SanctionsService(ctx),
  seed: (ctx) => seedSanctions(ctx),
});

export { SanctionsService } from './service.js';
