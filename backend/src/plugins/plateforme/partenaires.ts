/**
 * Intégration et API partenaires (module 52, § 30.1) — interfaces sécurisées ouvertes aux banques, opérateurs,
 * régulateurs et partenaires de données :
 *  - REGISTRE DES INTERFACES : chaque échange repose sur un contrat (objet, portées, catégories de données, protocole
 *    signé : référence + empreinte SHA-256, consentement requis ou non, période), proposé puis approuvé par une seconde
 *    personne (sécurité ou délégué à la protection des données) — « protocole signé pour chaque échange de données » ;
 *  - CLIENTS OAuth2 « client credentials » : identifiant + secret (montré une seule fois, stocké haché), jetons courts
 *    à portées LIMITÉES à l'objet contracté ; liaison TLS mutuel facultative (empreinte du certificat, RFC 8705) via la
 *    garde mTLS du socle (socle/mtls.ts) ;
 *  - QUOTAS : limites de débit par minute et par jour par client (valeurs PAR DÉFAUT, à confirmer) ;
 *  - JOURNAL DE CHAQUE APPEL (client, route, portée, résultat, latence) ; REJET des appels hors objet contracté ;
 *  - ÉVÉNEMENTS : abonnements à des rappels SIGNÉS (HMAC-SHA256 horodaté) ; livraison HTTP réelle si activée
 *    (MOSOLO_WEBHOOK_DELIVERY=http), sinon journal de bac à sable ; disponibilité des partenaires mesurée sur les livraisons.
 * API versionnée : /v1/partenaires/api/v1/… (REST/JSON). Aucune donnée nominative : statuts et agrégats seulement.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { canonicalJson, hmacSha256Hex, randomSecret, safeEqualHex, sha256Hex } from '../../core/crypto.js';
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { clientFingerprint, normalizeFingerprint, type MtlsConfig } from '../socle/mtls.js';

/** Préfixe des jetons machine (ignorés par la résolution des personnes, voir core/auth.ts). */
export const PARTNER_TOKEN_PREFIX = 'mpt_';
/** Durée de vie d'un jeton d'accès partenaire (secondes) — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const PARTNER_TOKEN_TTL_S = 3600;
/** Quotas PAR DÉFAUT (à confirmer) : appels par minute et par jour, par client. */
export const DEFAULT_QUOTA = { perMinute: 60, perDay: 10_000 };

/** Portées de l'API partenaire : chacune ouvre une ressource précise (objet contracté). */
export const PARTNER_SCOPES = {
  'quittances:verifier': 'Vérifier l’authenticité et le statut d’une quittance (numéro) — sans donnée nominative',
  'paiements:statut': 'Lire le statut d’un ordre de paiement par sa référence (ordres du prestataire contracté seulement)',
  'statistiques:agregees': 'Lire les recettes rapprochées agrégées par commune (aucune donnée individuelle)',
  'evenements:paiements': 'Recevoir les événements signés « paiement confirmé » et « quittance émise » de son périmètre',
} as const;
export type PartnerScope = keyof typeof PARTNER_SCOPES;
export const PARTNER_KINDS = { BANQUE: 'Banque', OPERATEUR: 'Opérateur de monnaie mobile ou télécom', REGULATEUR: 'Régulateur', DONNEES: 'Partenaire de données' } as const;
export type PartnerKind = keyof typeof PARTNER_KINDS;
export const PARTNER_EVENTS = { 'paiement.confirme': 'Paiement confirmé', 'quittance.emise': 'Quittance émise' } as const;
export type PartnerEvent = keyof typeof PARTNER_EVENTS;

export interface InterfaceContract {
  id: string;
  code: string;
  partnerName: string;
  partnerKind: PartnerKind;
  /** Objet contracté (texte du contrat) et portées qu'il couvre. */
  object: string;
  scopes: PartnerScope[];
  dataCategories: string[];
  /** Prestataire de paiement couvert (ordres visibles) — banques et opérateurs. */
  providerId?: string;
  /** Protocole d'échange signé : référence, empreinte du document signé, date de signature. */
  protocol: { reference: string; sha256: string; signedAt: string };
  consentRequired: boolean;
  version: 'v1';
  validFrom: string;
  validTo: string;
  status: 'PROPOSE' | 'ACTIF' | 'SUSPENDU' | 'REFUSE';
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
  history: { at: string; by: string; action: string; motif?: string }[];
}

export interface ApiClient {
  id: string;
  contractId: string;
  label: string;
  secretHash: string;
  /** Liaison TLS mutuel : empreinte SHA-256 normalisée du certificat client (facultative). */
  certFingerprint?: string;
  quota: { perMinute: number; perDay: number; status: 'PAR_DEFAUT' | 'CONTRACTUEL' };
  status: 'ACTIF' | 'REVOQUE';
  createdBy: string;
  createdAt: string;
  revoked?: { by: string; at: string; motif: string };
}

interface IssuedToken { id: string; hash: string; clientId: string; scopes: PartnerScope[]; cnf?: string; issuedAt: string; expiresAt: string }

export type CallOutcome = 'OK' | 'NON_AUTHENTIFIE' | 'PORTEE_INSUFFISANTE' | 'HORS_OBJET' | 'QUOTA_DEPASSE' | 'MTLS_REQUIS' | 'INTROUVABLE' | 'ERREUR';
export interface CallLog { id: string; at: string; clientId: string | null; method: string; route: string; scope: string | null; status: number; outcome: CallOutcome; latencyMs: number }

export interface WebhookSubscription { id: string; clientId: string; url: string; events: PartnerEvent[]; secret: string; status: 'ACTIF' | 'ARRETE'; createdAt: string }
export interface WebhookDelivery { id: string; subscriptionId: string; clientId: string; event: PartnerEvent; at: string; payloadSha256: string; signature: string; timestamp: string; status: 'LIVRE' | 'ECHEC' | 'JOURNALISE'; httpStatus?: number; error?: string }

export interface PartnerPrincipal { client: ApiClient; contract: InterfaceContract; scopes: PartnerScope[]; tokenId: string }

/** Transport des rappels : HTTP réel (production) ou journal de bac à sable (démonstration, tests). */
export type WebhookTransport = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;
export const httpTransport: WebhookTransport = async (url, body, headers) => {
  const r = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
  return { status: r.status };
};

export class PartnerApiService {
  readonly contracts = new InMemoryRepository<InterfaceContract>();
  readonly clients = new InMemoryRepository<ApiClient>();
  readonly tokens = new InMemoryRepository<IssuedToken>();
  readonly calls = new InMemoryAppendOnlyRepository<CallLog>();
  readonly subscriptions = new InMemoryRepository<WebhookSubscription>();
  readonly deliveries = new InMemoryAppendOnlyRepository<WebhookDelivery>();
  private readonly ids = new IdGenerator();
  /** Fenêtres de quota : clé client → horodatages (ms) des appels récents. */
  private readonly windows = new Map<string, number[]>();
  transport: WebhookTransport | null = process.env.MOSOLO_WEBHOOK_DELIVERY === 'http' ? httpTransport : null;

  constructor(private readonly ctx: AppContext, private readonly mtls: () => MtlsConfig | undefined) {}

  private now() { return this.ctx.clock.now().toISOString(); }
  private today() { return this.now().slice(0, 10); }

  // ─────────────────────────── registre des interfaces (contrats) ───────────────────────────

  proposeContract(user: User, input: Omit<InterfaceContract, 'id' | 'status' | 'proposedBy' | 'proposedAt' | 'history' | 'version' | 'decision'>) {
    authorize(user, 'plateforme:partenaires.manage');
    if (this.contracts.findOne((c) => c.code === input.code)) throw conflict('DUPLICATE_CODE', `Contrat ${input.code} déjà inscrit au registre.`);
    if (input.validTo <= input.validFrom) throw badRequest('INVALID_PERIOD', 'La fin de validité doit suivre le début.');
    if (input.scopes.includes('paiements:statut') && !input.providerId) throw badRequest('PROVIDER_REQUIRED', 'La portée « paiements:statut » exige le prestataire couvert par le contrat (objet contracté).');
    const at = this.now();
    const c = this.contracts.insert({ id: this.ids.next('ITF'), ...input, version: 'v1', status: 'PROPOSE', proposedBy: user.id, proposedAt: at, history: [{ at, by: user.id, action: 'PROPOSE' }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'plateforme.partner_contract.proposed', resourceType: 'interface_contract', resourceId: c.id, details: { code: c.code, scopes: c.scopes, protocol: c.protocol } });
    return c;
  }

  decideContract(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'plateforme:partenaires.approve');
    const c = this.contract(id);
    if (c.status !== 'PROPOSE') throw conflict('ALREADY_DECIDED', `Contrat au statut ${c.status}.`);
    assertDistinctPerson(user.id, [c.proposedBy], 'Protocole d’échange : approuvé par une personne distincte de celle qui l’a inscrit.');
    const at = this.now();
    const out = this.contracts.update({ ...c, status: input.approve ? 'ACTIF' : 'REFUSE', decision: { by: user.id, at, ...input }, history: [...c.history, { at, by: user.id, action: input.approve ? 'APPROUVE' : 'REFUSE', motif: input.motif }] });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'plateforme.partner_contract.approved' : 'plateforme.partner_contract.refused', resourceType: 'interface_contract', resourceId: id, details: { proposedBy: c.proposedBy, motif: input.motif } });
    return out;
  }

  suspendContract(user: User, id: string, motif: string) {
    authorize(user, 'plateforme:partenaires.approve');
    const c = this.contract(id);
    if (c.status !== 'ACTIF') throw conflict('INVALID_STATE', `Contrat au statut ${c.status}.`);
    const at = this.now();
    const out = this.contracts.update({ ...c, status: 'SUSPENDU', history: [...c.history, { at, by: user.id, action: 'SUSPENDU', motif }] });
    // Suspension du contrat : tous les jetons en cours de ses clients sont invalidés.
    const clientIds = new Set(this.clients.find((k) => k.contractId === id).map((k) => k.id));
    for (const t of this.tokens.find((x) => clientIds.has(x.clientId) && x.expiresAt > at)) this.tokens.update({ ...t, expiresAt: at });
    this.ctx.audit.append({ actor: actorOf(user), action: 'plateforme.partner_contract.suspended', resourceType: 'interface_contract', resourceId: id, details: { motif } });
    return out;
  }

  private contract(id: string) {
    const c = this.contracts.get(id);
    if (!c) throw notFound('CONTRACT_NOT_FOUND', `Contrat d’interface inconnu : ${id}`);
    return c;
  }

  // ─────────────────────────── clients OAuth2 ───────────────────────────

  /** Création d'un client : le secret n'est montré qu'UNE fois (stocké haché). */
  createClient(user: User, input: { contractId: string; label: string; certFingerprint?: string; quota?: { perMinute: number; perDay: number } }) {
    authorize(user, 'plateforme:partenaires.manage');
    const c = this.contract(input.contractId);
    if (c.status !== 'ACTIF') throw conflict('CONTRACT_NOT_ACTIVE', 'Aucun client sans contrat d’interface ACTIF (protocole signé et approuvé).');
    const id = `cli_${randomBytes(9).toString('hex')}`;
    const secret = randomSecret(32);
    const fp = input.certFingerprint ? normalizeFingerprint(input.certFingerprint) : undefined;
    if (fp !== undefined && fp.length !== 64) throw badRequest('INVALID_FINGERPRINT', 'Empreinte SHA-256 du certificat invalide (64 caractères hexadécimaux).');
    const client = this.clients.insert({
      id, contractId: c.id, label: input.label, secretHash: sha256Hex(`${id}:${secret}`), ...(fp ? { certFingerprint: fp } : {}),
      quota: input.quota ? { ...input.quota, status: 'CONTRACTUEL' } : { ...DEFAULT_QUOTA, status: 'PAR_DEFAUT' }, status: 'ACTIF', createdBy: user.id, createdAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'plateforme.partner_client.created', resourceType: 'api_client', resourceId: id, details: { contractId: c.id, mtlsBound: !!fp, quota: client.quota } });
    return { client: this.clientView(client), clientSecret: secret, notice: 'Secret affiché une seule fois : il est conservé haché et ne peut être relu.' };
  }

  revokeClient(user: User, id: string, motif: string) {
    authorize(user, 'plateforme:partenaires.approve');
    const k = this.clients.get(id);
    if (!k) throw notFound('CLIENT_NOT_FOUND', `Client inconnu : ${id}`);
    if (k.status === 'REVOQUE') throw conflict('ALREADY_REVOKED', 'Client déjà révoqué.');
    const at = this.now();
    const out = this.clients.update({ ...k, status: 'REVOQUE', revoked: { by: user.id, at, motif } });
    for (const t of this.tokens.find((x) => x.clientId === id && x.expiresAt > at)) this.tokens.update({ ...t, expiresAt: at });
    this.ctx.audit.append({ actor: actorOf(user), action: 'plateforme.partner_client.revoked', resourceType: 'api_client', resourceId: id, details: { motif } });
    return this.clientView(out);
  }

  clientView(k: ApiClient) {
    const { secretHash: _h, ...rest } = k;
    return { ...rest, certFingerprint: k.certFingerprint ? `${k.certFingerprint.slice(0, 16)}…` : null };
  }

  /**
   * Jeton OAuth2 (RFC 6749 § 4.4, client credentials). Portées demandées ⊆ portées du contrat, sinon « invalid_scope »
   * (appel HORS OBJET journalisé). Client lié à un certificat : le certificat présenté doit correspondre (RFC 8705).
   */
  issueToken(req: FastifyRequest, body: { grant_type?: string; client_id?: string; client_secret?: string; scope?: string }) {
    const t0 = Date.now();
    const log = (clientId: string | null, status: number, outcome: CallOutcome) => this.log({ clientId, method: 'POST', route: '/v1/oauth/token', scope: body.scope ?? null, status, outcome, latencyMs: Date.now() - t0 });
    let basic: { id: string; secret: string } | null = null;
    const authz = req.headers.authorization;
    if (typeof authz === 'string' && /^Basic\s+/i.test(authz)) {
      const [id, secret] = Buffer.from(authz.replace(/^Basic\s+/i, ''), 'base64').toString('utf8').split(':');
      if (id && secret) basic = { id: decodeURIComponent(id), secret: decodeURIComponent(secret) };
    }
    const clientId = basic?.id ?? body.client_id;
    const secret = basic?.secret ?? body.client_secret;
    if (body.grant_type !== 'client_credentials') { log(clientId ?? null, 400, 'ERREUR'); throw new ApiError(400, 'unsupported_grant_type', 'Seul le type « client_credentials » est accepté.'); }
    const client = clientId ? this.clients.get(clientId) : undefined;
    if (!client || !secret || client.status !== 'ACTIF' || !safeEqualHex(client.secretHash, sha256Hex(`${client.id}:${secret}`))) {
      log(clientId ?? null, 401, 'NON_AUTHENTIFIE');
      throw new ApiError(401, 'invalid_client', 'Client inconnu, révoqué ou secret invalide.');
    }
    const contract = this.contract(client.contractId);
    const today = this.today();
    if (contract.status !== 'ACTIF' || contract.validFrom > today || contract.validTo < today) {
      log(client.id, 403, 'HORS_OBJET');
      throw forbidden('CONTRACT_NOT_ACTIVE', 'Contrat d’interface inactif ou hors de sa période de validité.');
    }
    const requested = (body.scope ?? contract.scopes.join(' ')).split(/\s+/).filter(Boolean);
    const outside = requested.filter((s) => !(contract.scopes as string[]).includes(s));
    if (outside.length) {
      log(client.id, 400, 'HORS_OBJET');
      this.ctx.audit.append({ actor: { kind: 'system', id: `client:${client.id}` }, action: 'plateforme.partner_call.out_of_scope', resourceType: 'api_client', resourceId: client.id, outcome: 'DENIED', details: { requested, outside } });
      throw new ApiError(400, 'invalid_scope', `Portées hors de l’objet contracté : ${outside.join(', ')}.`);
    }
    let cnf: string | undefined;
    if (client.certFingerprint) {
      const cfg = this.mtls();
      const fp = cfg ? clientFingerprint(req, cfg) : null;
      if (!fp || fp !== client.certFingerprint) { log(client.id, 403, 'MTLS_REQUIS'); throw forbidden('MTLS_BINDING_REQUIRED', 'Client lié à un certificat : présentez le certificat enregistré (TLS mutuel).'); }
      cnf = fp;
    }
    const raw = `${PARTNER_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const issuedAt = this.now();
    const tok = this.tokens.insert({ id: this.ids.next('TOK'), hash: sha256Hex(raw), clientId: client.id, scopes: requested as PartnerScope[], ...(cnf ? { cnf } : {}), issuedAt, expiresAt: new Date(Date.parse(issuedAt) + PARTNER_TOKEN_TTL_S * 1000).toISOString() });
    log(client.id, 200, 'OK');
    this.ctx.audit.append({ actor: { kind: 'system', id: `client:${client.id}` }, action: 'plateforme.partner_token.issued', resourceType: 'api_client', resourceId: client.id, details: { tokenId: tok.id, scopes: tok.scopes, mtlsBound: !!cnf } });
    return { access_token: raw, token_type: 'Bearer', expires_in: PARTNER_TOKEN_TTL_S, scope: tok.scopes.join(' ') };
  }

  private log(input: Omit<CallLog, 'id' | 'at'>) {
    return this.calls.append({ id: this.ids.next('APL', 8), at: this.now(), ...input });
  }

  /**
   * Garde d'un appel partenaire : jeton valide, liaison mTLS, portée requise, quota. Chaque appel (admis ou refusé)
   * est journalisé ; `handler` reçoit le principal et renvoie la réponse. Les refus hors objet sont signalés à l'audit.
   */
  async guard<T>(req: FastifyRequest, route: string, scope: PartnerScope, handler: (p: PartnerPrincipal) => T): Promise<T> {
    const t0 = Date.now();
    let clientId: string | null = null;
    const done = (status: number, outcome: CallOutcome) => this.log({ clientId, method: req.method, route, scope, status, outcome, latencyMs: Date.now() - t0 });
    try {
      const m = typeof req.headers.authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization.trim()) : null;
      const tok = m && m[1]!.startsWith(PARTNER_TOKEN_PREFIX) ? this.tokens.findOne((t) => t.hash === sha256Hex(m[1]!)) : undefined;
      if (!tok || tok.expiresAt <= this.now()) throw unauthorized('INVALID_TOKEN', 'Jeton partenaire absent, inconnu ou expiré (POST /v1/oauth/token).');
      clientId = tok.clientId;
      const client = this.clients.get(tok.clientId)!;
      const contract = this.contract(client.contractId);
      if (client.status !== 'ACTIF' || contract.status !== 'ACTIF') throw unauthorized('INVALID_TOKEN', 'Client révoqué ou contrat suspendu.');
      if (tok.cnf) {
        const cfg = this.mtls();
        const fp = cfg ? clientFingerprint(req, cfg) : null;
        if (fp !== tok.cnf) throw Object.assign(forbidden('MTLS_BINDING_REQUIRED', 'Jeton lié à un certificat : présentez le même certificat client.'), { outcome: 'MTLS_REQUIS' as CallOutcome });
      }
      if (!(contract.scopes as string[]).includes(scope)) throw Object.assign(forbidden('OUT_OF_CONTRACTED_OBJECT', `Appel hors de l’objet contracté (${scope}).`), { outcome: 'HORS_OBJET' as CallOutcome });
      if (!tok.scopes.includes(scope)) throw Object.assign(forbidden('INSUFFICIENT_SCOPE', `Portée « ${scope} » absente du jeton.`), { outcome: 'PORTEE_INSUFFISANTE' as CallOutcome });
      this.consumeQuota(client);
      const out = handler({ client, contract, scopes: tok.scopes, tokenId: tok.id });
      done(200, 'OK');
      return out;
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      const outcome: CallOutcome = (e as { outcome?: CallOutcome }).outcome ?? (status === 401 ? 'NON_AUTHENTIFIE' : status === 429 ? 'QUOTA_DEPASSE' : status === 404 ? 'INTROUVABLE' : 'ERREUR');
      done(status, outcome);
      if (outcome === 'HORS_OBJET') this.ctx.audit.append({ actor: { kind: 'system', id: `client:${clientId}` }, action: 'plateforme.partner_call.out_of_scope', resourceType: 'api_client', resourceId: clientId ?? undefined, outcome: 'DENIED', details: { route, scope } });
      throw e;
    }
  }

  /** Signale un refus « hors objet » détecté par la ressource elle-même (ex. ordre d'un autre prestataire). */
  outOfObject(detail: string): never {
    throw Object.assign(forbidden('OUT_OF_CONTRACTED_OBJECT', detail), { outcome: 'HORS_OBJET' as CallOutcome });
  }

  private consumeQuota(client: ApiClient) {
    const now = this.ctx.clock.now().getTime();
    const w = (this.windows.get(client.id) ?? []).filter((t) => now - t < 86_400_000);
    const lastMinute = w.filter((t) => now - t < 60_000).length;
    if (lastMinute >= client.quota.perMinute || w.length >= client.quota.perDay) {
      this.windows.set(client.id, w);
      throw new ApiError(429, 'QUOTA_EXCEEDED', `Quota dépassé (${client.quota.perMinute} appels / minute, ${client.quota.perDay} / jour).`);
    }
    w.push(now);
    this.windows.set(client.id, w);
  }

  // ─────────────────────────── événements signés (rappels) ───────────────────────────

  subscribe(p: PartnerPrincipal, input: { url: string; events: PartnerEvent[] }) {
    if (!/^https:\/\//.test(input.url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(input.url)) throw badRequest('HTTPS_REQUIRED', 'Adresse de rappel HTTPS obligatoire.');
    const secret = randomSecret(32);
    const s = this.subscriptions.insert({ id: this.ids.next('ABO'), clientId: p.client.id, url: input.url, events: input.events, secret, status: 'ACTIF', createdAt: this.now() });
    this.ctx.audit.append({ actor: { kind: 'system', id: `client:${p.client.id}` }, action: 'plateforme.partner_webhook.subscribed', resourceType: 'webhook_subscription', resourceId: s.id, details: { events: s.events, urlSha256: sha256Hex(s.url) } });
    return { id: s.id, url: s.url, events: s.events, signingSecret: secret, signature: 'x-mosolo-signature = HMAC-SHA256(secret, horodatage + "." + corps) ; x-mosolo-timestamp ; x-mosolo-event', notice: 'Secret de signature affiché une seule fois.' };
  }

  /** Signature d'un rappel : HMAC-SHA256(secret, `${horodatage}.${corps}`) — même schéma que les rappels entrants. */
  static sign(secret: string, timestamp: string, body: string): string {
    return hmacSha256Hex(secret, `${timestamp}.${body}`);
  }

  /** Émet un événement vers les abonnés dont le contrat couvre l'objet (prestataire du paiement). */
  async emit(event: PartnerEvent, data: { paymentReference: string; provider?: string; status: string; receiptNumber?: string }) {
    const out: WebhookDelivery[] = [];
    for (const s of this.subscriptions.find((x) => x.status === 'ACTIF' && x.events.includes(event))) {
      const client = this.clients.get(s.clientId);
      if (!client || client.status !== 'ACTIF') continue;
      const contract = this.contracts.get(client.contractId);
      if (!contract || contract.status !== 'ACTIF' || !contract.scopes.includes('evenements:paiements')) continue;
      if (contract.providerId && data.provider !== contract.providerId) continue;
      const timestamp = this.now();
      const body = canonicalJson({ event, at: timestamp, data: { paymentReference: data.paymentReference, status: data.status, ...(data.receiptNumber ? { receiptNumber: data.receiptNumber } : {}) } });
      const signature = PartnerApiService.sign(s.secret, timestamp, body);
      const base = { id: this.ids.next('LIV', 8), subscriptionId: s.id, clientId: s.clientId, event, at: timestamp, payloadSha256: sha256Hex(body), signature, timestamp };
      if (!this.transport) { out.push(this.deliveries.append({ ...base, status: 'JOURNALISE' })); continue; }
      try {
        const r = await this.transport(s.url, body, { 'x-mosolo-signature': signature, 'x-mosolo-timestamp': timestamp, 'x-mosolo-event': event });
        out.push(this.deliveries.append({ ...base, status: r.status >= 200 && r.status < 300 ? 'LIVRE' : 'ECHEC', httpStatus: r.status }));
      } catch (e) {
        out.push(this.deliveries.append({ ...base, status: 'ECHEC', error: (e as Error).message.slice(0, 200) }));
      }
    }
    return out;
  }

  // ─────────────────────────── tableau d'administration ───────────────────────────

  view(user: User) {
    authorize(user, 'plateforme:partenaires.read');
    const calls = this.calls.all();
    const since = new Date(this.ctx.clock.now().getTime() - 30 * 86_400_000).toISOString();
    const recent = calls.filter((c) => c.at >= since);
    const byClient = this.clients.all().map((k) => {
      const mine = recent.filter((c) => c.clientId === k.id);
      const dels = this.deliveries.find((d) => d.clientId === k.id && d.status !== 'JOURNALISE');
      return {
        ...this.clientView(k), contract: this.contracts.get(k.contractId)?.code ?? k.contractId,
        calls: mine.length, errors: mine.filter((c) => c.outcome !== 'OK').length, outOfObject: mine.filter((c) => c.outcome === 'HORS_OBJET').length,
        /** Disponibilité du partenaire : rappels livrés / tentés (null sans livraison HTTP réelle). */
        availabilityPct: dels.length ? ((dels.filter((d) => d.status === 'LIVRE').length * 100) / dels.length).toFixed(1) : null,
      };
    });
    const errors = recent.filter((c) => c.outcome !== 'OK').length;
    const allDel = this.deliveries.all().filter((d) => d.status !== 'JOURNALISE');
    return {
      scopes: PARTNER_SCOPES, kinds: PARTNER_KINDS, events: PARTNER_EVENTS, defaults: { tokenTtlSeconds: PARTNER_TOKEN_TTL_S, quota: DEFAULT_QUOTA, status: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' },
      contracts: this.contracts.all(), clients: byClient,
      subscriptions: this.subscriptions.all().map(({ secret: _s, ...s }) => s),
      deliveries: this.deliveries.all().slice(-50).reverse(),
      calls: calls.slice(-100).reverse(),
      delivery: this.transport ? 'HTTP' : 'JOURNAL (bac à sable : MOSOLO_WEBHOOK_DELIVERY=http pour la livraison réelle)',
      indicators: [
        { code: 'APPELS', label: 'Appels partenaires (30 jours)', measured: true, value: String(recent.length), unit: 'appels' },
        { code: 'ERREURS', label: 'Appels refusés ou en erreur (30 jours)', measured: true, value: String(errors), unit: 'appels', ratePct: recent.length ? ((errors * 100) / recent.length).toFixed(1) : null },
        allDel.length
          ? { code: 'DISPONIBILITE_PARTENAIRES', label: 'Disponibilité des partenaires (rappels livrés)', measured: true, value: ((allDel.filter((d) => d.status === 'LIVRE').length * 100) / allDel.length).toFixed(1), unit: '%' }
          : { code: 'DISPONIBILITE_PARTENAIRES', label: 'Disponibilité des partenaires (rappels livrés)', measured: false, value: null, unit: '%', reason: 'Aucune livraison HTTP réelle de rappel (bac à sable) : disponibilité non mesurable.' },
      ],
    };
  }
}
