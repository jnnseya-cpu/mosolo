/**
 * Module d'extension « citoyen » : compléments des modules 1 à 12 de la Spécification fonctionnelle (identité et
 * contribuable, territoire et immobilier, recettes sectorielles de premier rang). Chaque sous-service s'appuie sur les
 * circuits existants (compte unique, relations datées, IGF, baux, titres, verticales, canaux) — aucun circuit parallèle.
 */
import type { FastifyRequest } from 'fastify';
import { hasAcr, ACR, type User } from '../../core/auth.js';
import { unauthorized } from '../../core/errors.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import type { AppContext } from '../../context.js';
import { ActivitesService } from './activites.js';
import { ApplicationService } from './application.js';
import { CadastreService } from './cadastre.js';
import { accesOf } from './common.js';
import { indicateursModule1, indicateursModule2, indicateursModule3, indicateursModule6, SuiviActivite } from './indicateurs.js';
import { LocatifService } from './locatif.js';
import { PortailPublicService } from './portail.js';
import { ControlePiecesService } from './pieces.js';
import { SituationService } from './situation.js';
import { RelationsSuiviService } from './relations.js';
import { TransportService } from './transport.js';
import { VehiculesService } from './vehicules.js';

const { always } = GRANTS;
definePolicy('citoyen:indicateurs', {
  R01: always, R02: always, R03: always, R04: always, R05: always, R06: always, R07: always, R08: always, R11: always,
  R17: always, R18: always, R22: always, R23: always, R24: always,
});

/**
 * Opérations sensibles d'un contribuable ou d'un mandataire (module 3 « authentification forte ») : désigner ou
 * révoquer un mandataire, clore une relation (vente, mutation). Session réelle : second facteur récent exigé.
 */
export const OPERATIONS_SENSIBLES_CONTRIBUABLE: { method: string; route: RegExp }[] = [
  { method: 'POST', route: /^\/v1\/acces\/mandates$/ },
  { method: 'POST', route: /^\/v1\/acces\/mandates\/[^/]+\/revoke$/ },
  { method: 'POST', route: /^\/v1\/fiscal\/relationships\/[^/]+\/close$/ },
];

export class CitoyenService {
  readonly application: ApplicationService;
  readonly portail: PortailPublicService;
  readonly relations: RelationsSuiviService;
  readonly cadastre: CadastreService;
  readonly locatif: LocatifService;
  readonly transport: TransportService;
  readonly activites: ActivitesService;
  readonly vehicules: VehiculesService;
  readonly pieces: ControlePiecesService;
  readonly situation: SituationService;
  readonly suivi: SuiviActivite;

  constructor(readonly ctx: AppContext) {
    this.application = new ApplicationService(ctx);
    this.portail = new PortailPublicService(ctx);
    this.relations = new RelationsSuiviService(ctx);
    this.cadastre = new CadastreService(ctx);
    this.locatif = new LocatifService(ctx);
    this.transport = new TransportService(ctx);
    this.activites = new ActivitesService(ctx);
    this.vehicules = new VehiculesService(ctx);
    this.pieces = new ControlePiecesService(ctx);
    this.situation = new SituationService(ctx);
    this.suivi = new SuiviActivite(ctx);
    this.relations.brancher();
  }

  /** Authentification forte des opérations sensibles du contribuable (sessions réelles ; démonstration par en-tête exclue). */
  gardeAuthForte(req: FastifyRequest): void {
    const u = req.user;
    if (!u?.auth || !u.roles.some((r) => r === 'R30' || r === 'R31')) return;
    const path = req.url.split('?')[0] ?? '';
    if (!OPERATIONS_SENSIBLES_CONTRIBUABLE.some((o) => o.method === req.method && o.route.test(path))) return;
    if (hasAcr(u, ACR.MFA) || accesOf(this.ctx)?.mfaActiveUntil(u)) return;
    throw unauthorized('MFA_REQUIRED', 'Opération sensible : validez votre second facteur (code reçu) avant de continuer.');
  }

  /** Tableau des indicateurs des modules 1 à 12, calculés sur les données réelles. */
  indicateurs(user: User) {
    authorize(user, 'citoyen:indicateurs');
    return {
      calculeLe: this.ctx.clock.now().toISOString(),
      modules: [
        { module: 1, titre: 'Identité et compte contribuable', indicateurs: indicateursModule1(this.ctx) },
        { module: 2, titre: 'Enrôlement et vérification', indicateurs: indicateursModule2(this.ctx) },
        { module: 3, titre: 'Portail contribuable', indicateurs: indicateursModule3(this.ctx, this.suivi) },
        { module: 4, titre: 'Application citoyenne Android et iOS', indicateurs: this.application.calculIndicateurs() },
        { module: 5, titre: 'Portail web public', indicateurs: this.portail.indicateurs() },
        { module: 6, titre: 'USSD et SMS', indicateurs: indicateursModule6(this.ctx) },
        { module: 7, titre: 'Gestionnaire de relations contribuable–objet', indicateurs: this.relations.indicateurs() },
        { module: 8, titre: 'Cadastre fiscal géospatial', indicateurs: this.cadastre.indicateurs() },
        { module: 9, titre: 'Intelligence foncière et locative', indicateurs: this.locatif.indicateurs() },
        { module: 10, titre: 'Registre des activités et patentes', indicateurs: this.activites.indicateurs() },
        { module: 11, titre: 'Véhicules et circulation', indicateurs: this.vehicules.indicateurs() },
        { module: 12, titre: 'Autorisations de transport', indicateurs: this.transport.indicateurs() },
      ],
      notice: 'Indicateurs calculés sur les données enregistrées ; « non mesuré » signifie qu’une donnée source manque (raison indiquée), jamais une estimation.',
    };
  }
}
