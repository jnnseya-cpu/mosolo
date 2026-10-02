/**
 * Module 4 — Application citoyenne Android et iOS (Spécification fonctionnelle ; § 19A.5, § 15.4, § 31).
 *
 * L'application est la PWA MOSOLO enveloppée par Capacitor (dossier `mobile/`) : mêmes écrans, mêmes routes, même
 * circuit de paiement. Ce service apporte ce qui est propre à l'application installée :
 *  - registre des installations (identifiant d'installation ALÉATOIRE, jamais l'identifiant matériel ni le numéro) ;
 *  - verdict d'intégrité de l'appareil (appareil modifié : racine « root », « jailbreak », émulateur, débogage) remonté
 *    par le module natif ; un appareil COMPROMIS est refusé pour les fonctions sensibles (QR dynamique, paiement,
 *    prolongation de titre) — contrôle serveur, pas seulement dans l'interface ;
 *  - avis des usagers (note de l'application, 1 à 5) ;
 *  - transactions mobiles : chaque paiement ou prolongation portant l'en-tête d'installation est compté.
 * Aucune validité n'est calculée sur l'horloge du téléphone : les titres portent l'heure serveur (§ 19A.6).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { forbidden, notFound } from '../../core/errors.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { DAY_MS } from '../../core/clock.js';
import { parDefaut, pct } from './common.js';

const { always } = GRANTS;
definePolicy('citoyen:application.indicateurs', { R01: always, R02: always, R05: always, R06: always, R22: always, R23: always, R26: always, R27: always, R28: always });

export const PLATEFORMES = ['ANDROID', 'IOS', 'WEB'] as const;
export type Plateforme = (typeof PLATEFORMES)[number];

/** En-tête porté par l'application installée (identifiant d'installation aléatoire). */
export const INSTALLATION_HEADER = 'x-mosolo-installation';

/** Fenêtre d'activité d'une installation — valeur par défaut à confirmer (indicateur « installations actives »). */
export const FENETRE_ACTIVITE_JOURS = parDefaut(30, 'Spécification fonctionnelle, module 4 — indicateur « installations actives »');

export interface Installation {
  id: string;
  plateforme: Plateforme;
  versionApp: string;
  langue: string;
  premiereOuverture: string;
  derniereActivite: string;
  /** Dernier verdict d'intégrité (appareil modifié ?). */
  integrite: { statut: 'NON_EVALUE' | 'CONFORME' | 'COMPROMIS'; signaux: string[]; source: 'MODULE_NATIF' | 'NAVIGATEUR' | 'AUCUNE'; at?: string };
  /** Contribuable connecté la dernière fois (jamais exposé dans les indicateurs). */
  taxpayerId?: string;
}

export interface AvisApplication { id: string; installationId: string; note: number; commentaire?: string; at: string }
export interface TransactionMobile { id: string; installationId: string; plateforme: Plateforme; route: string; statusCode: number; at: string; paymentReference?: string }

/** Routes sensibles refusées à un appareil déclaré compromis (§ 31, module 4 « détection d'appareil modifié »). */
const SENSIBLES: RegExp[] = [
  /^\/v1\/titres\/[^/]+\/qr$/,
  /^\/v1\/titres\/[^/]+\/prolongations$/,
  /^\/v1\/obligations\/[^/]+\/payment-orders$/,
  /^\/v1\/rakapay\/tickets$/,
];
/** Routes comptées comme transactions mobiles (paiement, prolongation, achat de titre). */
const TRANSACTIONS: RegExp[] = [
  /^\/v1\/obligations\/[^/]+\/payment-orders$/,
  /^\/v1\/titres\/[^/]+\/prolongations$/,
  /^\/v1\/rakapay\/tickets$/,
];

export class ApplicationService {
  readonly installations = new InMemoryRepository<Installation>();
  readonly avis = new InMemoryAppendOnlyRepository<AvisApplication>();
  readonly transactions = new InMemoryAppendOnlyRepository<TransactionMobile>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now() { return this.ctx.clock.now().toISOString(); }

  /** Première ouverture ou reprise : l'application reçoit (ou confirme) son identifiant d'installation. */
  enregistrer(input: { installationId?: string; plateforme: Plateforme; versionApp: string; langue: string }, user?: User) {
    const at = this.now();
    const existing = input.installationId ? this.installations.get(input.installationId) : undefined;
    const inst = existing
      ? this.installations.update({ ...existing, plateforme: input.plateforme, versionApp: input.versionApp, langue: input.langue, derniereActivite: at, ...(user?.taxpayerId ? { taxpayerId: user.taxpayerId } : {}) })
      : this.installations.insert({
        id: `APP-${randomUUID()}`, plateforme: input.plateforme, versionApp: input.versionApp, langue: input.langue, premiereOuverture: at, derniereActivite: at,
        integrite: { statut: 'NON_EVALUE', signaux: [], source: 'AUCUNE' }, ...(user?.taxpayerId ? { taxpayerId: user.taxpayerId } : {}),
      });
    if (!existing) {
      this.ctx.audit.append({ actor: { kind: 'public', id: 'application-citoyenne' }, action: 'application.installation.registered', resourceType: 'app_installation', resourceId: inst.id, details: { plateforme: inst.plateforme, versionApp: inst.versionApp } });
    }
    return this.vue(inst);
  }

  installation(id: string): Installation {
    const i = this.installations.get(id);
    if (!i) throw notFound('INSTALLATION_INCONNUE', 'Installation inconnue : relancez l’application.');
    return i;
  }

  vue(i: Installation) {
    return { id: i.id, plateforme: i.plateforme, versionApp: i.versionApp, integrite: i.integrite, derniereActivite: i.derniereActivite, heureServeur: this.now() };
  }

  /**
   * Verdict d'intégrité remonté par le module natif (racine, jailbreak, émulateur, débogueur, signature altérée).
   * Un seul signal suffit à déclarer l'appareil COMPROMIS pour les fonctions sensibles ; une alerte est levée pour la
   * sécurité (aucune sanction : l'usager garde l'accès à la consultation, au guichet, à l'USSD).
   */
  integrite(installationId: string, input: { racine: boolean; jailbreak: boolean; emulateur: boolean; debogage: boolean; signatureAlteree?: boolean; source: 'MODULE_NATIF' | 'NAVIGATEUR' }) {
    const i = this.installation(installationId);
    const signaux = [
      input.racine ? 'RACINE' : null, input.jailbreak ? 'JAILBREAK' : null, input.emulateur ? 'EMULATEUR' : null,
      input.debogage ? 'DEBOGAGE' : null, input.signatureAlteree ? 'SIGNATURE_ALTEREE' : null,
    ].filter((x): x is string => !!x);
    const statut = signaux.length ? 'COMPROMIS' as const : 'CONFORME' as const;
    const at = this.now();
    const out = this.installations.update({ ...i, derniereActivite: at, integrite: { statut, signaux, source: input.source, at } });
    this.ctx.audit.append({
      actor: { kind: 'device', id: i.id }, action: 'application.integrity.reported', resourceType: 'app_installation', resourceId: i.id,
      details: { statut, signaux, source: input.source }, before: i.integrite, after: out.integrite,
    });
    if (statut === 'COMPROMIS' && i.integrite.statut !== 'COMPROMIS') {
      this.ctx.alerts.raiseOnce(`APPLICATION:APPAREIL_MODIFIE:${i.id}:${at}`, {
        type: 'APPAREIL_MODIFIE', severity: 'MEDIUM', source: 'application-citoyenne',
        detail: `Installation ${i.id} (${i.plateforme}) : appareil modifié (${signaux.join(', ')}). Fonctions sensibles refusées ; consultation maintenue.`,
        context: { installationId: i.id, signaux },
      });
    }
    return this.vue(out);
  }

  avisDonne(installationId: string, input: { note: number; commentaire?: string }) {
    const i = this.installation(installationId);
    const a = this.avis.append({ id: this.ids.next('AVI'), installationId: i.id, note: input.note, ...(input.commentaire ? { commentaire: input.commentaire } : {}), at: this.now() });
    this.ctx.audit.append({ actor: { kind: 'public', id: 'application-citoyenne' }, action: 'application.rating.given', resourceType: 'app_installation', resourceId: i.id, details: { note: input.note } });
    return { id: a.id, note: a.note, at: a.at };
  }

  /** Garde des fonctions sensibles : appelée avant chaque requête portant l'en-tête d'installation. */
  garde(req: FastifyRequest): void {
    const id = header(req);
    if (!id) return;
    const route = (req.url.split('?')[0] ?? '');
    if (!SENSIBLES.some((r) => r.test(route))) return;
    const i = this.installations.get(id);
    if (i?.integrite.statut === 'COMPROMIS') {
      this.ctx.audit.append({ actor: { kind: 'device', id }, action: 'application.sensitive.refused', resourceType: 'app_installation', resourceId: id, outcome: 'DENIED', details: { route, signaux: i.integrite.signaux } });
      throw forbidden('APPAREIL_MODIFIE', 'Appareil modifié détecté : cette fonction sensible est refusée sur cet appareil. Utilisez un autre appareil, le guichet ou le code USSD.', { signaux: i.integrite.signaux });
    }
  }

  /** Comptage des transactions mobiles (réponse envoyée). */
  compter(req: FastifyRequest, statusCode: number, body?: unknown): void {
    const id = header(req);
    if (!id || req.method !== 'POST') return;
    const route = req.url.split('?')[0] ?? '';
    if (!TRANSACTIONS.some((r) => r.test(route))) return;
    const i = this.installations.get(id);
    if (!i) return;
    const ref = body && typeof body === 'object' && 'paymentReference' in body ? String((body as { paymentReference: unknown }).paymentReference) : undefined;
    this.transactions.append({ id: this.ids.next('TRM', 8), installationId: id, plateforme: i.plateforme, route, statusCode, at: this.now(), ...(ref ? { paymentReference: ref } : {}) });
    this.installations.update({ ...i, derniereActivite: this.now() });
  }

  /** Indicateurs du module 4 : installations actives, transactions mobiles, taux d'échec de paiement, note. */
  indicateurs(user: User) {
    authorize(user, 'citoyen:application.indicateurs');
    return this.calculIndicateurs();
  }

  calculIndicateurs() {
    const now = this.ctx.clock.now().getTime();
    const fenetre = FENETRE_ACTIVITE_JOURS.valeur * DAY_MS;
    const all = this.installations.all();
    const actives = all.filter((i) => now - new Date(i.derniereActivite).getTime() <= fenetre);
    const tx = this.transactions.all();
    const refs = tx.filter((t) => t.paymentReference).map((t) => t.paymentReference!);
    const orders = refs.map((r) => this.ctx.payments.orders.findOne((o) => o.paymentReference === r)).filter((o): o is NonNullable<typeof o> => !!o);
    const echecs = orders.filter((o) => o.status === 'ECHOUE').length + tx.filter((t) => t.statusCode >= 400).length;
    const notes = this.avis.all();
    const moyenne = notes.length ? (Math.round((notes.reduce((s, a) => s + a.note, 0) / notes.length) * 10) / 10).toFixed(1) : null;
    return {
      installationsActives: { valeur: actives.length, total: all.length, parPlateforme: Object.fromEntries(['ANDROID', 'IOS', 'WEB'].map((p) => [p, actives.filter((i) => i.plateforme === p).length])), fenetre: FENETRE_ACTIVITE_JOURS },
      transactionsMobiles: { valeur: tx.length, reussies: tx.filter((t) => t.statusCode < 400).length },
      tauxEchecPaiement: { valeur: pct(echecs, tx.length), numerateur: echecs, denominateur: tx.length, definition: 'Transactions mobiles refusées ou références closes sans paiement (ECHOUE) / transactions mobiles.', ...(tx.length ? {} : { raison: 'Aucune transaction depuis l’application installée : taux non mesuré.' }) },
      noteApplication: { valeur: moyenne, avis: notes.length, echelle: '1 à 5', ...(notes.length ? {} : { raison: 'Aucun avis donné dans l’application.' }) },
      appareilsCompromis: all.filter((i) => i.integrite.statut === 'COMPROMIS').length,
    };
  }
}

function header(req: FastifyRequest): string | undefined {
  const v = req.headers[INSTALLATION_HEADER];
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^APP-[0-9a-f-]{36}$/.test(s) ? s : undefined;
}
