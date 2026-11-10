/**
 * MOSOLO AVIA — Pôle de rapprochement des recettes (Revenue Reconciliation Hub, RRH) et identifiant fiscal aérien (IFA)
 * — Cahier v2.9, § 11C.2 à 11C.4. Construit PAR-DESSUS `avia.ts` (déclarations mensuelles, données RVA/DGM, procédure
 * contradictoire, facturation humaine sur règle ACTIVE) : aucun circuit parallèle, aucune facturation automatique.
 *
 * Trois flux convergent vers le RRH, plus les montants reversés :
 *  1. Billetterie (billets vendus au départ de Kinshasa avec la taxe urbaine portée par le billet) :
 *     - connecteurs BSP / GDS / TTBS de l'IATA (interface ; seul le bac à sable [EXEMPLE] est raccordé — accords requis) ;
 *     - API des compagnies structurées (ventes GDS, système de contrôle des départs DCS) ;
 *     - portail sécurisé des agences locales et opérateurs partiels : comptes CERTIFIÉS (quatre yeux), déclarations structurées.
 *  2. Embarquements (scans RVA du QR fiscal de la carte d'embarquement).
 *  3. Sorties du territoire (validations DGM).
 *  + Reversements : montants réglés par le BSP (taxe) et montants crédités au compte de la Ville (banques collectrices).
 *  + Fret aérien : taxe d'embarquement sur le fret — déclarations (compagnie, agent de fret certifié) ↔ manifestes RVA.
 *
 * Le rapprochement mensuel (automatique au calendrier ou relancé par un analyste) calcule par compagnie et par vol :
 * vendus ↔ embarqués ↔ sortis ↔ reversés, passagers ET fret. Il PROPOSE un traitement (facturation de l'écart,
 * compensation, constat d'un mois non déclaré) ; seul un analyste le soumet à la procédure contradictoire d'`avia.ts`,
 * puis une personne distincte valide et décide (facturation sur règle ACTIVE, ou compensation motivée).
 *
 * IFA : unique par vol et par passager, généré à partir des données du billet ; encodé dans le QR fiscal de la carte
 * d'embarquement sous la forme d'un jeton statique signé Ed25519 (même signataire et même format `MT1.` que les titres :
 * vérifiable hors ligne avec la clé publique). Aucune donnée nominative : la référence passager est conservée hachée.
 * Montants : chaînes décimales en USD, calcul en centimes entiers (jamais de flottant).
 */
import { createHash } from 'node:crypto';
import type { MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { checkChar } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, evaluate } from '../../core/policy.js';
import { pct } from '../../core/percent.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { TitresService } from '../titres/service.js';
import { TokenSigner } from '../titres/tokens.js';
import type { AviaRrhFigures, AviaService } from './avia.js';
import { P } from './policies.js';

// ------------------------------------------------------------------------------------------------ montants (centimes)

const MONEY_RE = /^\d{1,15}(\.\d{1,2})?$/;
export function usdToCents(amount: string): bigint {
  if (!MONEY_RE.test(amount)) throw unprocessable('INVALID_AMOUNT', `Montant invalide : ${amount}`);
  const [i, f = ''] = amount.split('.');
  return BigInt(i!) * 100n + BigInt((f + '00').slice(0, 2));
}
/** Centimes d'une chaîne décimale signée produite par `centsToUsd`. */
export const signedCents = (amount: string): bigint => (amount.startsWith('-') ? -usdToCents(amount.slice(1)) : usdToCents(amount));
export function centsToUsd(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

// ------------------------------------------------------------------------------------------------ modèle

export type AviaTicketSource = 'BSP' | 'GDS' | 'TTBS' | 'API_COMPAGNIE' | 'PORTAIL_AGENCE';
export const AVIA_TICKET_SOURCE_LABEL: Record<AviaTicketSource, string> = {
  BSP: 'Plan de facturation et de règlement de l’IATA (Billing and Settlement Plan, BSP)',
  GDS: 'Système de distribution (Global Distribution System, GDS)',
  TTBS: 'Base des taxes de l’IATA (Ticket Tax Box Service, TTBS)',
  API_COMPAGNIE: 'Interface de la compagnie (API — ventes GDS, contrôle des départs DCS)',
  PORTAIL_AGENCE: 'Portail sécurisé des agences locales et opérateurs partiels',
};

/** Billet au départ de Kinshasa (FIH), tel que transmis par une source : aucune donnée nominative. */
export interface AviaTicketInput {
  ticketNumber: string;
  flightNumber: string;
  /** Date du vol AAAA-MM-JJ. */
  flightDate: string;
  destination: string;
  /** Référence passager pseudonyme de la source (PNR + rang, par ex.) — conservée hachée uniquement. */
  passengerRef: string;
  /** Taxe urbaine portée par le billet (calculée par GDS/TTBS) : donnée de billetterie, pas un tarif de MOSOLO. */
  urbanTax: { amount: string; currency: 'USD' };
}

export interface AviaTicket {
  id: string;
  ticketNumber: string;
  airlineTaxpayerId: string;
  period: string;
  flightNumber: string;
  flightDate: string;
  origin: 'FIH';
  destination: string;
  passengerRefHash: string;
  urbanTax: { amount: string; currency: 'USD' };
  source: AviaTicketSource;
  batchId: string;
  agencyId?: string;
  /** Identifiant fiscal aérien (IFA) — unique par vol et par passager. */
  ifa: string;
  /** Contenu du QR fiscal de la carte d'embarquement (jeton statique signé `MT1.`). */
  ifaToken: string;
  issuedAt: string;
}

export interface AviaTicketBatch {
  id: string;
  source: AviaTicketSource;
  connector?: string;
  airlineTaxpayerId: string;
  period: string;
  accepted: number;
  rejected: { ticketNumber: string; reason: string }[];
  fileSha256?: string;
  agencyId?: string;
  by: string;
  at: string;
}

export type AviaAgencyStatus = 'EN_ATTENTE' | 'CERTIFIEE' | 'REFUSEE' | 'SUSPENDUE';
export const AVIA_AGENCY_STATUS_LABEL: Record<AviaAgencyStatus, string> = {
  EN_ATTENTE: 'Demande de certification en attente', CERTIFIEE: 'Compte certifié', REFUSEE: 'Certification refusée', SUSPENDUE: 'Compte suspendu (décision motivée)',
};
export interface AviaAgency {
  id: string;
  name: string;
  kind: 'AGENCE_VOYAGES' | 'OPERATEUR_PARTIEL' | 'AGENT_FRET';
  iataCode?: string;
  taxpayerId: string;
  status: AviaAgencyStatus;
  requestedBy: string;
  requestedAt: string;
  decisions: { by: string; at: string; decision: AviaAgencyStatus; reason: string }[];
}

export type AviaPassengerEventSource = 'RVA_EMBARQUEMENT' | 'DGM_SORTIE';
export type AviaIfaStatus = 'VALIDE' | 'SANS_IFA' | 'FALSIFIE' | 'INCONNU' | 'AUTRE_VOL' | 'DOUBLON';
export const AVIA_IFA_STATUS_LABEL: Record<AviaIfaStatus, string> = {
  VALIDE: 'IFA authentique et rapproché du billet', SANS_IFA: 'Passager sans IFA (billet non transmis)', FALSIFIE: 'QR fiscal non authentique',
  INCONNU: 'IFA inconnu du pôle de rapprochement', AUTRE_VOL: 'IFA d’un autre vol', DOUBLON: 'IFA déjà scanné (doublon, non recompté)',
};
export interface AviaPassengerEvent {
  id: string;
  source: AviaPassengerEventSource;
  airlineTaxpayerId: string;
  period: string;
  flightNumber: string;
  flightDate: string;
  ifa: string | null;
  ifaStatus: AviaIfaStatus;
  by: string;
  at: string;
}

export type AviaFreightSource = 'COMPAGNIE' | 'AGENT_FRET' | 'RVA_MANIFESTE';
export const AVIA_FREIGHT_SOURCE_LABEL: Record<AviaFreightSource, string> = {
  COMPAGNIE: 'Déclaration de la compagnie', AGENT_FRET: 'Déclaration d’un agent de fret certifié', RVA_MANIFESTE: 'Manifeste de fret constaté (RVA)',
};
export interface AviaFreightRecord {
  id: string;
  source: AviaFreightSource;
  airlineTaxpayerId: string;
  period: string;
  flightNumber: string;
  flightDate: string;
  /** Numéro de lettre de transport aérien (LTA, air waybill). */
  awbNumber: string;
  weightKg: number;
  /** Taxe d'embarquement portée par la LTA, si la source la transmet (donnée, pas un tarif de MOSOLO). */
  embarkationTax?: { amount: string; currency: 'USD' };
  agencyId?: string;
  by: string;
  at: string;
}

export type AviaRemittanceSource = 'BSP' | 'BANQUE_COLLECTRICE';
export interface AviaRemittance {
  id: string;
  source: AviaRemittanceSource;
  airlineTaxpayerId: string;
  period: string;
  amount: { amount: string; currency: 'USD' };
  reference: string;
  bank?: string;
  /** COURANT : reversement du mois ; RATTRAPAGE : montant récupéré après constat d'écart (base de la clé alternative). */
  nature: 'COURANT' | 'RATTRAPAGE';
  by: string;
  at: string;
}

export type RrhProposalKind = 'AUCUNE' | 'FACTURATION_ECART' | 'COMPENSATION' | 'CONSTAT_MOIS_NON_DECLARE';
export const RRH_PROPOSAL_LABEL: Record<RrhProposalKind, string> = {
  AUCUNE: 'Aucun écart : rien à proposer',
  FACTURATION_ECART: 'Proposition : facturer l’écart après procédure contradictoire (règle ACTIVE requise — acte requis)',
  COMPENSATION: 'Proposition : compenser le trop-reversé après procédure contradictoire (décision motivée)',
  CONSTAT_MOIS_NON_DECLARE: 'Proposition : ouvrir un constat sur un mois non déclaré, puis procédure contradictoire',
};

export interface RrhFlightLine {
  flightNumber: string;
  flightDate: string;
  destinations: string[];
  sold: number;
  boarded: number;
  boardedWithIfa: number;
  boardedWithoutIfa: number;
  exited: number;
  verified: number;
  soldNotBoarded: number;
  boardedNotExited: number;
  taxInTickets: string;
  taxOnBoarded: string;
  freightDeclaredKg: number;
  freightManifestKg: number;
}

export interface RrhAirlineLine {
  airlineTaxpayerId: string;
  airlineName: string;
  ticketingConnected: boolean;
  ticketSources: AviaTicketSource[];
  declarationId: string | null;
  declarationStatus: string | null;
  declaredPassengers: number | null;
  /** Agrégat d'embarquement transmis par l'exploitant dans le circuit d'origine (s'il existe). */
  aggregateBoarded: number | null;
  flights: number;
  sold: number;
  boarded: number;
  boardedWithIfa: number;
  boardedWithoutIfa: number;
  exited: number;
  verified: number;
  soldNotBoarded: number;
  boardedNotExited: number;
  taxInTickets: string;
  taxOnBoarded: string;
  bspSettled: string;
  remitted: string;
  /** Taxe portée par les billets des embarqués − montants crédités à la Ville (positif : non reversé). */
  remittanceGap: string;
  /** Réglé par le BSP − crédité à la Ville (positif : encaissé par la compagnie, non reversé). */
  bspGap: string;
  freight: { declaredKg: number; manifestKg: number; gapKg: number; awbDeclared: number; awbManifest: number; declaredTax: string };
  flightLines: RrhFlightLine[];
  hasGap: boolean;
  gapLabels: string[];
  proposal: { kind: RrhProposalKind; label: string; status: 'PROPOSEE' | 'SOUMISE' | 'SANS_OBJET' };
  submission?: { by: string; at: string; declarationId: string; declarationStatus: string };
}

export interface RrhReconciliation {
  id: string;
  period: string;
  trigger: 'AUTOMATIQUE_MENSUEL' | 'ANALYSTE';
  by: string;
  at: string;
  lines: RrhAirlineLine[];
  totals: { sold: number; boarded: number; boardedWithoutIfa: number; exited: number; verified: number; taxOnBoarded: string; remitted: string; remittanceGap: string; freightDeclaredKg: number; freightManifestKg: number };
}

export interface AviaIfaControl {
  id: string;
  ifa: string | null;
  result: AviaIfaStatus;
  flightNumber: string | null;
  place: string;
  by: string;
  at: string;
}

/** Connecteur de billetterie (IATA BSP, GDS, TTBS) : extraction des ventes au départ de Kinshasa pour un mois. */
export interface TicketingConnector {
  readonly code: string;
  readonly label: string;
  readonly source: 'BSP' | 'GDS' | 'TTBS';
  /** RACCORDE (bac à sable) ou ACCORD_REQUIS (accord d'accès aux données non signé : aucun appel). */
  readonly state: 'RACCORDE' | 'ACCORD_REQUIS';
  readonly example: boolean;
  fetchSales(q: { airlineTaxpayerId: string; period: string }): AviaTicketInput[];
}

/** Adaptateur de démonstration [EXEMPLE] : billets fictifs chargés par le jeu de démonstration, non contractuels. */
export class SandboxTicketingConnector implements TicketingConnector {
  readonly code = 'BSP-BAC-A-SABLE';
  readonly label = 'Bac à sable BSP / GDS / TTBS [EXEMPLE] — billets fictifs, non contractuels';
  readonly source = 'BSP' as const;
  readonly state = 'RACCORDE' as const;
  readonly example = true;
  private readonly data = new Map<string, AviaTicketInput[]>();
  load(airlineTaxpayerId: string, period: string, tickets: AviaTicketInput[]): void {
    this.data.set(`${airlineTaxpayerId}|${period}`, tickets);
  }
  fetchSales(q: { airlineTaxpayerId: string; period: string }): AviaTicketInput[] {
    return this.data.get(`${q.airlineTaxpayerId}|${q.period}`) ?? [];
  }
}

/** Connecteur réel déclaré mais non raccordé : tout appel est refusé tant que l'accord d'accès n'est pas signé. */
class PendingConnector implements TicketingConnector {
  readonly state = 'ACCORD_REQUIS' as const;
  readonly example = false;
  constructor(readonly code: string, readonly label: string, readonly source: 'BSP' | 'GDS' | 'TTBS') {}
  fetchSales(): AviaTicketInput[] {
    throw unprocessable('CONNECTOR_AGREEMENT_REQUIRED', `${this.label} : accord d’accès aux données requis (IATA / compagnies) avant tout raccordement.`);
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const periodOf = (date: string) => date.slice(0, 7);

// ------------------------------------------------------------------------------------------------ service

export class AviaRrhService {
  readonly tickets = new InMemoryRepository<AviaTicket>();
  readonly batches = new InMemoryAppendOnlyRepository<AviaTicketBatch>();
  readonly agencies = new InMemoryRepository<AviaAgency>();
  readonly events = new InMemoryAppendOnlyRepository<AviaPassengerEvent>();
  readonly freight = new InMemoryAppendOnlyRepository<AviaFreightRecord>();
  readonly remittances = new InMemoryAppendOnlyRepository<AviaRemittance>();
  readonly reconciliations = new InMemoryRepository<RrhReconciliation>();
  readonly controls = new InMemoryAppendOnlyRepository<AviaIfaControl>();
  readonly sandbox = new SandboxTicketingConnector();
  readonly connectors: TicketingConnector[] = [
    this.sandbox,
    new PendingConnector('IATA-BSP', 'Plan de facturation et de règlement de l’IATA (Billing and Settlement Plan, BSP)', 'BSP'),
    new PendingConnector('GDS', 'Systèmes de distribution (Global Distribution Systems, GDS)', 'GDS'),
    new PendingConnector('IATA-TTBS', 'Base des taxes de l’IATA (Ticket Tax Box Service, TTBS)', 'TTBS'),
  ];
  private readonly ids = new IdGenerator();
  private fallbackSigner?: TokenSigner;
  /** Branchement du cadre des mesures (avia-cadre.ts) : la mesure « billet sans IFA non validable » est-elle ouverte ? */
  measureStatus?: () => { available: boolean; reason: string };
  readonly system: User = { kind: 'user', id: 'svc-avia-rrh', name: 'Pôle de rapprochement des recettes AVIA (calendrier mensuel)', roles: ['R11'], entity: 'DGTK' };

  constructor(private readonly ctx: AppContext, private readonly avia: AviaService) {
    avia.rrhLookup = (airline, period) => this.figuresFor(airline, period);
  }

  /** Même signataire que les titres (clé publique /v1/titres/cle-publique) ; clé locale si le module est absent. */
  get signer(): TokenSigner {
    const titres = this.ctx.ext.titres as TitresService | undefined;
    if (titres?.signer) return titres.signer;
    this.fallbackSigner ??= new TokenSigner();
    return this.fallbackSigner;
  }

  private now() {
    return this.ctx.clock.now().toISOString();
  }

  private agent(user: User) {
    authorize(user, P.aviaRead, { entity: 'DGTK' });
  }

  private airlineName(id: string): string {
    try { return this.ctx.taxpayers.get(id).fullName; } catch { return id; }
  }

  // ---------------------------------------------------------------------------------------------- IFA

  /** IFA : `IFA-AAMMJJ-XXXXXXXX-C` dérivé du vol, de la date, de la compagnie et de la référence passager hachée. */
  static ifaFor(airline: string, flightNumber: string, flightDate: string, passengerRefHash: string): string {
    let n = BigInt(`0x${sha(`${airline}|${flightNumber}|${flightDate}|${passengerRefHash}`).slice(0, 10)}`);
    let body = '';
    for (let i = 0; i < 8; i++) { body = CROCKFORD[Number(n % 32n)]! + body; n /= 32n; }
    const d = flightDate.replace(/-/g, '').slice(2);
    return `IFA-${d}-${body}-${checkChar(`${d}${body}`)}`;
  }

  /** Lecture d'un QR fiscal : jeton signé → IFA, ou code IFA saisi. */
  private readQr(input: { qr?: string; ifa?: string }): { ifa: string | null; authentic: boolean; flight?: string } {
    if (input.qr) {
      const p = this.signer.verifyStatic(input.qr);
      if (!p || p.k !== 'IFA' || typeof p.c !== 'string') return { ifa: null, authentic: false };
      return { ifa: p.c, authentic: true, flight: typeof p.v === 'string' ? p.v : undefined };
    }
    if (input.ifa) return { ifa: input.ifa.trim().toUpperCase(), authentic: true };
    return { ifa: null, authentic: true };
  }

  private ingest(user: User, meta: { source: AviaTicketSource; airlineTaxpayerId: string; period: string; connector?: string; agencyId?: string; fileSha256?: string }, tickets: AviaTicketInput[]) {
    this.ctx.taxpayers.get(meta.airlineTaxpayerId);
    if (meta.period >= kinshasaDate(this.ctx.clock.now()).slice(0, 7) && meta.source !== 'API_COMPAGNIE' && meta.source !== 'PORTAIL_AGENCE') {
      // Les flux BSP sont mensuels : mois échu seulement (les ventes du mois courant arrivent par API ou portail).
      throw unprocessable('PERIOD_NOT_CLOSED', 'Le relevé BSP/GDS/TTBS porte sur un mois échu.');
    }
    const batchId = this.ids.next(`AVIA-BIL-${meta.period}`);
    const rejected: AviaTicketBatch['rejected'] = [];
    const accepted: AviaTicket[] = [];
    for (const t of tickets) {
      const reject = (reason: string) => rejected.push({ ticketNumber: t.ticketNumber, reason });
      if (periodOf(t.flightDate) !== meta.period) { reject('Vol hors du mois déclaré'); continue; }
      if (t.urbanTax.currency !== 'USD' || !MONEY_RE.test(t.urbanTax.amount)) { reject('Montant de taxe invalide'); continue; }
      if (this.tickets.findOne((x) => x.ticketNumber === t.ticketNumber)) { reject('Billet déjà reçu (doublon)'); continue; }
      const passengerRefHash = sha(`avia-passager|${t.passengerRef}`);
      const ifa = AviaRrhService.ifaFor(meta.airlineTaxpayerId, t.flightNumber, t.flightDate, passengerRefHash);
      if (this.tickets.findOne((x) => x.ifa === ifa)) { reject('IFA déjà émis pour ce passager sur ce vol'); continue; }
      const ifaToken = this.signer.signStatic({ k: 'IFA', c: ifa, v: t.flightNumber, d: t.flightDate, o: 'FIH', a: meta.airlineTaxpayerId });
      accepted.push(this.tickets.insert({
        id: this.ids.next('AVIA-TKT'), ticketNumber: t.ticketNumber, airlineTaxpayerId: meta.airlineTaxpayerId, period: meta.period,
        flightNumber: t.flightNumber, flightDate: t.flightDate, origin: 'FIH', destination: t.destination, passengerRefHash,
        urbanTax: { amount: centsToUsd(usdToCents(t.urbanTax.amount)), currency: 'USD' }, source: meta.source, batchId,
        ...(meta.agencyId ? { agencyId: meta.agencyId } : {}), ifa, ifaToken, issuedAt: this.now(),
      }));
    }
    const batch = this.batches.append({
      id: batchId, source: meta.source, airlineTaxpayerId: meta.airlineTaxpayerId, period: meta.period, accepted: accepted.length, rejected,
      ...(meta.connector ? { connector: meta.connector } : {}), ...(meta.agencyId ? { agencyId: meta.agencyId } : {}), ...(meta.fileSha256 ? { fileSha256: meta.fileSha256 } : {}),
      by: user.id, at: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.rrh.tickets.received', resourceType: 'avia_ticket_batch', resourceId: batchId, details: { source: meta.source, airline: meta.airlineTaxpayerId, period: meta.period, accepted: accepted.length, rejected: rejected.length } });
    return { batch, ifas: accepted.map((t) => ({ ticketNumber: t.ticketNumber, ifa: t.ifa, qr: t.ifaToken })) };
  }

  /** Flux BSP / GDS / TTBS transmis par un partenaire de données (fichier ou appel). */
  receiveTickets(user: User, input: { source: 'BSP' | 'GDS' | 'TTBS' | 'API_COMPAGNIE'; airlineTaxpayerId: string; period: string; tickets: AviaTicketInput[]; fileSha256?: string }) {
    if (input.source === 'API_COMPAGNIE') authorize(user, P.aviaDeclare, { taxpayerId: input.airlineTaxpayerId });
    else authorize(user, P.aviaOperatorData, {});
    return this.ingest(user, input, input.tickets);
  }

  /** Extraction par connecteur (seul le bac à sable [EXEMPLE] est raccordé). */
  pullConnector(user: User, code: string, input: { airlineTaxpayerId: string; period: string }) {
    authorize(user, P.aviaOperatorData, {});
    const c = this.connectors.find((x) => x.code === code);
    if (!c) throw notFound('CONNECTOR_NOT_FOUND', `Connecteur inconnu : ${code}`);
    const sales = c.fetchSales(input);
    return this.ingest(user, { source: c.source, airlineTaxpayerId: input.airlineTaxpayerId, period: input.period, connector: c.code }, sales);
  }

  connectorsView() {
    return this.connectors.map((c) => ({ code: c.code, label: c.label, source: c.source, sourceLabel: AVIA_TICKET_SOURCE_LABEL[c.source], state: c.state, example: c.example }));
  }

  // ---------------------------------------------------------------------------------------------- agences certifiées

  requestAgency(user: User, input: { name: string; kind: AviaAgency['kind']; iataCode?: string; taxpayerId: string }) {
    this.ctx.taxpayers.get(input.taxpayerId);
    if (!evaluate(user, P.aviaAgencyPortal, { taxpayerId: input.taxpayerId }) && !evaluate(user, P.aviaReconcile, { entity: 'DGTK' })) {
      throw forbidden('FORBIDDEN', 'Demande réservée à l’agence elle-même ou à un contrôleur de la régie.');
    }
    if (this.agencies.findOne((a) => a.taxpayerId === input.taxpayerId && a.status !== 'REFUSEE')) throw conflict('AGENCY_ALREADY_REGISTERED', 'Compte d’agence déjà demandé ou certifié.');
    const a = this.agencies.insert({
      id: this.ids.next('AVIA-AGC'), name: input.name, kind: input.kind, ...(input.iataCode ? { iataCode: input.iataCode } : {}), taxpayerId: input.taxpayerId,
      status: 'EN_ATTENTE', requestedBy: user.id, requestedAt: this.now(), decisions: [],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.rrh.agency.requested', resourceType: 'avia_agency', resourceId: a.id, details: { kind: a.kind } });
    return this.agencyView(a);
  }

  /** Certification (ou refus, suspension) par une personne habilitée distincte du demandeur, motivée. */
  decideAgency(user: User, id: string, input: { decision: 'CERTIFIEE' | 'REFUSEE' | 'SUSPENDUE'; reason: string }) {
    const a = this.agencies.get(id);
    if (!a) throw notFound('AGENCY_NOT_FOUND', `Agence inconnue : ${id}`);
    authorize(user, P.aviaAgencyCertify, { entity: 'DGTK' });
    assertDistinctPerson(user.id, [a.requestedBy], 'La certification est décidée par une personne distincte du demandeur.');
    if (input.decision === 'SUSPENDUE' ? a.status !== 'CERTIFIEE' : a.status !== 'EN_ATTENTE') throw conflict('INVALID_AGENCY_STATE', `Décision impossible : ${AVIA_AGENCY_STATUS_LABEL[a.status]}.`);
    const saved = this.agencies.update({ ...a, status: input.decision, decisions: [...a.decisions, { by: user.id, at: this.now(), decision: input.decision, reason: input.reason }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.rrh.agency.decided', resourceType: 'avia_agency', resourceId: id, details: { decision: input.decision, reason: input.reason } });
    return this.agencyView(saved);
  }

  private certifiedAgency(user: User, id: string): AviaAgency {
    const a = this.agencies.get(id);
    if (!a) throw notFound('AGENCY_NOT_FOUND', `Agence inconnue : ${id}`);
    authorize(user, P.aviaAgencyPortal, { taxpayerId: a.taxpayerId });
    if (a.status !== 'CERTIFIEE') throw forbidden('AGENCY_NOT_CERTIFIED', 'Compte d’agence non certifié : déclarations refusées.');
    return a;
  }

  /** Déclaration structurée des billets vendus par une agence certifiée (portail sécurisé). */
  agencyDeclareTickets(user: User, agencyId: string, input: { airlineTaxpayerId: string; period: string; tickets: AviaTicketInput[] }) {
    const a = this.certifiedAgency(user, agencyId);
    return this.ingest(user, { source: 'PORTAIL_AGENCE', airlineTaxpayerId: input.airlineTaxpayerId, period: input.period, agencyId: a.id }, input.tickets);
  }

  agencyView(a: AviaAgency) {
    return { ...a, statusLabel: AVIA_AGENCY_STATUS_LABEL[a.status] };
  }

  listAgencies(user: User) {
    return this.agencies.all()
      .filter((a) => evaluate(user, P.aviaRead, { entity: 'DGTK' }) || evaluate(user, P.aviaAgencyPortal, { taxpayerId: a.taxpayerId }))
      .map((a) => this.agencyView(a));
  }

  // ---------------------------------------------------------------------------------------------- embarquements, sorties

  /** Scans RVA (embarquement) ou validations DGM (sortie) d'un vol : QR fiscaux lus et passagers sans IFA. */
  recordPassengerEvents(user: User, input: { source: AviaPassengerEventSource; airlineTaxpayerId: string; flightNumber: string; flightDate: string; scans: { qr?: string; ifa?: string }[]; withoutIfa: number }) {
    authorize(user, P.aviaOperatorData, {});
    this.ctx.taxpayers.get(input.airlineTaxpayerId);
    const period = periodOf(input.flightDate);
    const at = this.now();
    const out: AviaPassengerEvent[] = [];
    const push = (ifa: string | null, ifaStatus: AviaIfaStatus) => out.push(this.events.append({
      id: this.ids.next(input.source === 'RVA_EMBARQUEMENT' ? 'AVIA-EMB' : 'AVIA-SOR'), source: input.source, airlineTaxpayerId: input.airlineTaxpayerId, period,
      flightNumber: input.flightNumber, flightDate: input.flightDate, ifa, ifaStatus, by: user.id, at,
    }));
    for (const s of input.scans) {
      const r = this.readQr(s);
      if (!r.authentic) { push(null, 'FALSIFIE'); continue; }
      if (!r.ifa) { push(null, 'SANS_IFA'); continue; }
      const t = this.tickets.findOne((x) => x.ifa === r.ifa);
      if (!t) { push(r.ifa, 'INCONNU'); continue; }
      if (t.flightNumber !== input.flightNumber || t.flightDate !== input.flightDate || t.airlineTaxpayerId !== input.airlineTaxpayerId) { push(r.ifa, 'AUTRE_VOL'); continue; }
      const dup = this.events.findOne((e) => e.source === input.source && e.ifa === r.ifa && e.ifaStatus === 'VALIDE') ?? out.find((e) => e.ifa === r.ifa && e.ifaStatus === 'VALIDE');
      push(r.ifa, dup ? 'DOUBLON' : 'VALIDE');
    }
    for (let i = 0; i < input.withoutIfa; i++) push(null, 'SANS_IFA');
    const tally = out.reduce<Record<string, number>>((m, e) => ({ ...m, [e.ifaStatus]: (m[e.ifaStatus] ?? 0) + 1 }), {});
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.rrh.passenger_events.received', resourceType: 'avia_flight', resourceId: `${input.flightNumber}|${input.flightDate}`, details: { source: input.source, ...tally } });
    return { flightNumber: input.flightNumber, flightDate: input.flightDate, source: input.source, recorded: out.length, tally };
  }

  // ---------------------------------------------------------------------------------------------- fret

  recordFreight(user: User, input: { source: AviaFreightSource; airlineTaxpayerId: string; flightNumber: string; flightDate: string; awbNumber: string; weightKg: number; embarkationTax?: { amount: string; currency: 'USD' }; agencyId?: string }) {
    let agencyId: string | undefined;
    if (input.source === 'COMPAGNIE') authorize(user, P.aviaDeclare, { taxpayerId: input.airlineTaxpayerId });
    else if (input.source === 'RVA_MANIFESTE') authorize(user, P.aviaOperatorData, {});
    else {
      if (!input.agencyId) throw badRequest('AGENCY_REQUIRED', 'Agent de fret certifié requis.');
      const a = this.certifiedAgency(user, input.agencyId);
      if (a.kind !== 'AGENT_FRET') throw forbidden('AGENCY_NOT_FREIGHT', 'Seul un agent de fret certifié déclare du fret.');
      agencyId = a.id;
    }
    this.ctx.taxpayers.get(input.airlineTaxpayerId);
    if (input.embarkationTax && (input.embarkationTax.currency !== 'USD' || !MONEY_RE.test(input.embarkationTax.amount))) throw unprocessable('INVALID_AMOUNT', 'Montant de taxe invalide.');
    if (this.freight.findOne((f) => f.source === input.source && f.awbNumber === input.awbNumber)) throw conflict('AWB_ALREADY_RECORDED', `LTA ${input.awbNumber} déjà transmise par cette source.`);
    const rec = this.freight.append({
      id: this.ids.next('AVIA-FRT'), source: input.source, airlineTaxpayerId: input.airlineTaxpayerId, period: periodOf(input.flightDate), flightNumber: input.flightNumber,
      flightDate: input.flightDate, awbNumber: input.awbNumber, weightKg: input.weightKg, ...(input.embarkationTax ? { embarkationTax: input.embarkationTax } : {}),
      ...(agencyId ? { agencyId } : {}), by: user.id, at: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.rrh.freight.received', resourceType: 'avia_freight', resourceId: rec.id, details: { source: rec.source, weightKg: rec.weightKg } });
    return rec;
  }

  // ---------------------------------------------------------------------------------------------- reversements

  /** Montants réglés par le BSP (partenaire de données) ou crédités au compte de la Ville (banque collectrice). */
  recordRemittance(user: User, input: { source: AviaRemittanceSource; airlineTaxpayerId: string; period: string; amount: { amount: string; currency: 'USD' }; reference: string; bank?: string; nature: 'COURANT' | 'RATTRAPAGE' }) {
    authorize(user, P.aviaRemittance, {});
    const needed = input.source === 'BSP' ? 'R34' : 'R33';
    if (!user.roles.includes(needed)) throw forbidden('REMITTANCE_SOURCE_MISMATCH', input.source === 'BSP' ? 'Le relevé BSP est transmis par le partenaire de données.' : 'Le relevé bancaire est transmis par la banque collectrice.');
    this.ctx.taxpayers.get(input.airlineTaxpayerId);
    if (input.amount.currency !== 'USD') throw unprocessable('CURRENCY_NOT_SUPPORTED', 'Taxe aérienne libellée en USD.');
    usdToCents(input.amount.amount);
    if (this.remittances.findOne((r) => r.source === input.source && r.reference === input.reference)) throw conflict('REMITTANCE_ALREADY_RECORDED', `Référence ${input.reference} déjà reçue.`);
    const rec = this.remittances.append({ ...input, id: this.ids.next('AVIA-REV'), by: user.id, at: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.rrh.remittance.received', resourceType: 'avia_remittance', resourceId: rec.id, details: { source: rec.source, period: rec.period, amount: rec.amount.amount, nature: rec.nature } });
    return rec;
  }

  // ---------------------------------------------------------------------------------------------- rapprochement mensuel

  private computeLine(airline: string, period: string): RrhAirlineLine {
    const tickets = this.tickets.find((t) => t.airlineTaxpayerId === airline && t.period === period);
    const evts = this.events.find((e) => e.airlineTaxpayerId === airline && e.period === period && e.ifaStatus !== 'DOUBLON');
    const fr = this.freight.find((f) => f.airlineTaxpayerId === airline && f.period === period);
    const rem = this.remittances.find((r) => r.airlineTaxpayerId === airline && r.period === period);
    const decl = this.avia.declarations.findOne((d) => d.taxpayerId === airline && d.period === period);
    const agg = this.avia.operatorData.findOne((o) => o.airlineTaxpayerId === airline && o.period === period && (o.source === 'RVA' || o.source === 'EXPLOITANT'));

    const flightKeys = [...new Set([...tickets.map((t) => `${t.flightNumber}|${t.flightDate}`), ...evts.map((e) => `${e.flightNumber}|${e.flightDate}`), ...fr.map((f) => `${f.flightNumber}|${f.flightDate}`)])].sort();
    const byIfa = new Map(tickets.map((t) => [t.ifa, t]));
    const flightLines: RrhFlightLine[] = flightKeys.map((k) => {
      const [flightNumber, flightDate] = k.split('|') as [string, string];
      const tk = tickets.filter((t) => t.flightNumber === flightNumber && t.flightDate === flightDate);
      const board = evts.filter((e) => e.source === 'RVA_EMBARQUEMENT' && e.flightNumber === flightNumber && e.flightDate === flightDate);
      const exit = evts.filter((e) => e.source === 'DGM_SORTIE' && e.flightNumber === flightNumber && e.flightDate === flightDate);
      const boardedIfa = new Set(board.filter((e) => e.ifaStatus === 'VALIDE').map((e) => e.ifa!));
      const exitedIfa = new Set(exit.filter((e) => e.ifaStatus === 'VALIDE').map((e) => e.ifa!));
      const f = fr.filter((x) => x.flightNumber === flightNumber && x.flightDate === flightDate);
      return {
        flightNumber, flightDate, destinations: [...new Set(tk.map((t) => t.destination))],
        sold: tk.length, boarded: board.length, boardedWithIfa: boardedIfa.size, boardedWithoutIfa: board.length - boardedIfa.size, exited: exit.length,
        verified: [...boardedIfa].filter((i) => exitedIfa.has(i)).length,
        soldNotBoarded: tk.filter((t) => !boardedIfa.has(t.ifa)).length,
        boardedNotExited: [...boardedIfa].filter((i) => !exitedIfa.has(i)).length,
        taxInTickets: centsToUsd(tk.reduce((s, t) => s + usdToCents(t.urbanTax.amount), 0n)),
        taxOnBoarded: centsToUsd([...boardedIfa].reduce((s, i) => s + usdToCents(byIfa.get(i)?.urbanTax.amount ?? '0'), 0n)),
        freightDeclaredKg: f.filter((x) => x.source !== 'RVA_MANIFESTE').reduce((s, x) => s + x.weightKg, 0),
        freightManifestKg: f.filter((x) => x.source === 'RVA_MANIFESTE').reduce((s, x) => s + x.weightKg, 0),
      };
    });
    const sum = (k: keyof RrhFlightLine) => flightLines.reduce((s, l) => s + (l[k] as number), 0);
    const sumC = (k: 'taxInTickets' | 'taxOnBoarded') => flightLines.reduce((s, l) => s + usdToCents(l[k]), 0n);
    const bsp = rem.filter((r) => r.source === 'BSP').reduce((s, r) => s + usdToCents(r.amount.amount), 0n);
    const bank = rem.filter((r) => r.source === 'BANQUE_COLLECTRICE').reduce((s, r) => s + usdToCents(r.amount.amount), 0n);
    const taxOnBoarded = sumC('taxOnBoarded');
    const remittanceGap = taxOnBoarded - bank;
    const declaredFr = fr.filter((x) => x.source !== 'RVA_MANIFESTE');
    const manifestFr = fr.filter((x) => x.source === 'RVA_MANIFESTE');
    const freight = {
      declaredKg: declaredFr.reduce((s, x) => s + x.weightKg, 0), manifestKg: manifestFr.reduce((s, x) => s + x.weightKg, 0), gapKg: 0,
      awbDeclared: new Set(declaredFr.map((x) => x.awbNumber)).size, awbManifest: new Set(manifestFr.map((x) => x.awbNumber)).size,
      declaredTax: centsToUsd(declaredFr.reduce((s, x) => s + (x.embarkationTax ? usdToCents(x.embarkationTax.amount) : 0n), 0n)),
    };
    freight.gapKg = freight.manifestKg - freight.declaredKg;
    const boarded = sum('boarded');
    const boardedWithoutIfa = sum('boardedWithoutIfa');
    const boardedNotExited = sum('boardedNotExited');
    const ticketingConnected = tickets.length > 0;
    const gapLabels: string[] = [];
    if (boardedWithoutIfa > 0) gapLabels.push(`${boardedWithoutIfa} passager(s) embarqué(s) sans IFA rapproché d’un billet`);
    if (boardedNotExited > 0 && evts.some((e) => e.source === 'DGM_SORTIE')) gapLabels.push(`${boardedNotExited} passager(s) embarqué(s) sans sortie DGM correspondante`);
    if (remittanceGap > 0n) gapLabels.push(`Taxe portée par les billets des embarqués non créditée à la Ville : ${centsToUsd(remittanceGap)} USD`);
    if (remittanceGap < 0n) gapLabels.push(`Montant crédité supérieur à la taxe des embarqués : ${centsToUsd(-remittanceGap)} USD`);
    if (bsp - bank > 0n) gapLabels.push(`Réglé par le BSP mais non crédité à la Ville : ${centsToUsd(bsp - bank)} USD`);
    if (freight.gapKg !== 0) gapLabels.push(`Fret : ${freight.gapKg > 0 ? '+' : ''}${freight.gapKg} kg entre manifestes et déclarations`);
    if (!ticketingConnected && boarded > 0) gapLabels.push('Billetterie non transmise pour des passagers embarqués');
    if (decl && decl.origin !== 'CONSTAT_RRH' && decl.declared.passengersDeparting !== boarded && boarded > 0) gapLabels.push(`Déclaration mensuelle : ${decl.declared.passengersDeparting} passagers déclarés pour ${boarded} embarqués scannés`);
    const hasGap = gapLabels.length > 0;
    const kind: RrhProposalKind = !hasGap ? 'AUCUNE'
      : !decl ? 'CONSTAT_MOIS_NON_DECLARE'
      : remittanceGap < 0n && boardedWithoutIfa === 0 && freight.gapKg <= 0 ? 'COMPENSATION'
      : 'FACTURATION_ECART';
    return {
      airlineTaxpayerId: airline, airlineName: this.airlineName(airline), ticketingConnected, ticketSources: [...new Set(tickets.map((t) => t.source))],
      declarationId: decl?.id ?? null, declarationStatus: decl?.status ?? null, declaredPassengers: decl?.declared.passengersDeparting ?? null,
      aggregateBoarded: agg?.passengersBoarded ?? null, flights: flightLines.length,
      sold: sum('sold'), boarded, boardedWithIfa: sum('boardedWithIfa'), boardedWithoutIfa, exited: sum('exited'), verified: sum('verified'),
      soldNotBoarded: sum('soldNotBoarded'), boardedNotExited,
      taxInTickets: centsToUsd(sumC('taxInTickets')), taxOnBoarded: centsToUsd(taxOnBoarded), bspSettled: centsToUsd(bsp), remitted: centsToUsd(bank),
      remittanceGap: centsToUsd(remittanceGap), bspGap: centsToUsd(bsp - bank), freight, flightLines, hasGap, gapLabels,
      proposal: { kind, label: RRH_PROPOSAL_LABEL[kind], status: hasGap ? 'PROPOSEE' : 'SANS_OBJET' },
    };
  }

  /**
   * Rapprochement mensuel : vendus ↔ embarqués ↔ sortis ↔ reversés, par compagnie et par vol, passagers et fret.
   * Constate et PROPOSE ; n'ouvre aucune procédure, n'émet aucun avis, ne sanctionne rien.
   */
  runMonthly(user: User, period: string, trigger: RrhReconciliation['trigger'] = 'ANALYSTE') {
    authorize(user, P.aviaReconcile, { entity: 'DGTK' });
    if (period >= kinshasaDate(this.ctx.clock.now()).slice(0, 7)) throw unprocessable('PERIOD_NOT_CLOSED', 'Le rapprochement porte sur un mois échu.');
    const airlines = [...new Set([
      ...this.tickets.find((t) => t.period === period).map((t) => t.airlineTaxpayerId),
      ...this.events.find((e) => e.period === period).map((e) => e.airlineTaxpayerId),
      ...this.freight.find((f) => f.period === period).map((f) => f.airlineTaxpayerId),
      ...this.remittances.find((r) => r.period === period).map((r) => r.airlineTaxpayerId),
    ])].sort();
    if (airlines.length === 0) throw unprocessable('RRH_NO_DATA', `Aucun flux reçu pour ${period}.`);
    const lines = airlines.map((a) => this.computeLine(a, period));
    const tot = (k: 'sold' | 'boarded' | 'boardedWithoutIfa' | 'exited' | 'verified') => lines.reduce((s, l) => s + l[k], 0);
    const totC = (k: 'taxOnBoarded' | 'remitted' | 'remittanceGap') => centsToUsd(lines.reduce((s, l) => s + signedCents(l[k]), 0n));
    const rec = this.reconciliations.insert({
      id: this.ids.next(`AVIA-RRH-${period}`), period, trigger, by: user.id, at: this.now(), lines,
      totals: {
        sold: tot('sold'), boarded: tot('boarded'), boardedWithoutIfa: tot('boardedWithoutIfa'), exited: tot('exited'), verified: tot('verified'),
        taxOnBoarded: totC('taxOnBoarded'), remitted: totC('remitted'), remittanceGap: totC('remittanceGap'),
        freightDeclaredKg: lines.reduce((s, l) => s + l.freight.declaredKg, 0), freightManifestKg: lines.reduce((s, l) => s + l.freight.manifestKg, 0),
      },
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.rrh.reconciliation.run', resourceType: 'avia_rrh_reconciliation', resourceId: rec.id, details: { period, trigger, airlines: airlines.length, withGap: lines.filter((l) => l.hasGap).length } });
    return rec;
  }

  /** Déclenchement automatique du calendrier : mois précédent, s'il n'a pas encore été rapproché. */
  runDueMonthly() {
    const now = this.ctx.clock.now();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    if (this.latest(prev)) return null;
    try { return this.runMonthly(this.system, prev, 'AUTOMATIQUE_MENSUEL'); } catch { return null; }
  }

  latest(period: string): RrhReconciliation | undefined {
    return this.reconciliations.find((r) => r.period === period).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0];
  }

  figuresFor(airline: string, period: string): AviaRrhFigures | undefined {
    const r = this.latest(period);
    const l = r?.lines.find((x) => x.airlineTaxpayerId === airline);
    if (!r || !l) return undefined;
    return {
      reconciliationId: r.id, flights: l.flights, sold: l.sold, boarded: l.boarded, boardedWithoutIfa: l.boardedWithoutIfa, exited: l.exited,
      taxOnBoarded: l.taxOnBoarded, remitted: l.remitted, remittanceGap: l.remittanceGap, freightDeclaredKg: l.freight.declaredKg, freightManifestKg: l.freight.manifestKg,
      hasGap: l.hasGap, gapLabels: l.gapLabels,
    };
  }

  /**
   * Un analyste soumet l'écart proposé à la procédure contradictoire EXISTANTE (avia.ts) : rapprochement d'une
   * déclaration reçue, réouverture d'un mois « sans écart », ou constat d'un mois non déclaré. Jamais automatique.
   */
  submitLine(user: User, reconciliationId: string, airlineTaxpayerId: string) {
    const r = this.reconciliations.get(reconciliationId);
    if (!r) throw notFound('RRH_NOT_FOUND', `Rapprochement inconnu : ${reconciliationId}`);
    authorize(user, P.aviaReconcile, { entity: 'DGTK' });
    if (this.latest(r.period)?.id !== r.id) throw conflict('RRH_SUPERSEDED', 'Un rapprochement plus récent existe pour ce mois.');
    const line = r.lines.find((l) => l.airlineTaxpayerId === airlineTaxpayerId);
    if (!line) throw notFound('RRH_LINE_NOT_FOUND', 'Compagnie absente de ce rapprochement.');
    if (!line.hasGap) throw conflict('RRH_NO_GAP', 'Aucun écart : rien à soumettre.');
    if (line.submission) throw conflict('RRH_ALREADY_SUBMITTED', 'Écart déjà soumis à la procédure contradictoire.');
    const decl = this.avia.declarations.findOne((d) => d.taxpayerId === airlineTaxpayerId && d.period === r.period);
    let result;
    if (!decl) result = this.avia.openRrhFinding(user, airlineTaxpayerId, r.period);
    else if (decl.status === 'DECLAREE') result = this.avia.reconcile(user, decl.id);
    else if (decl.status === 'RAPPROCHEE') result = this.avia.reopenForRrh(user, decl.id);
    else throw conflict('AVIA_PROCEDURE_ALREADY_ENGAGED', `La déclaration ${decl.id} est déjà au statut « ${this.avia.view(decl).statusLabel} ».`);
    const submission = { by: user.id, at: this.now(), declarationId: result.id, declarationStatus: result.status };
    this.reconciliations.update({ ...r, lines: r.lines.map((l) => (l === line ? { ...l, submission, proposal: { ...l.proposal, status: 'SOUMISE' as const } } : l)) });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.rrh.gap.submitted', resourceType: 'avia_rrh_reconciliation', resourceId: r.id, details: { airline: airlineTaxpayerId, declarationId: result.id, proposal: line.proposal.kind } });
    if (!decl) this.ctx.comms.publish('appeal.info_requested', [taxpayerRecipient(this.ctx.taxpayers.get(airlineTaxpayerId))], { reference: result.id }, { entity: 'DGTK' });
    return { reconciliationId: r.id, airlineTaxpayerId, declaration: result };
  }

  listReconciliations(user: User, period?: string) {
    this.agent(user);
    return this.reconciliations.find((r) => !period || r.period === period).sort((a, b) => b.period.localeCompare(a.period) || b.at.localeCompare(a.at));
  }

  readReconciliation(user: User, id: string) {
    this.agent(user);
    const r = this.reconciliations.get(id);
    if (!r) throw notFound('RRH_NOT_FOUND', `Rapprochement inconnu : ${id}`);
    return r;
  }

  // ---------------------------------------------------------------------------------------------- IFA : carte, contrôle

  /** Carte d'embarquement fiscale : IFA et contenu du QR (compagnie titulaire, agence émettrice ou agents). */
  boardingPass(user: User, ifa: string) {
    const t = this.tickets.findOne((x) => x.ifa === ifa.trim().toUpperCase());
    if (!t) throw notFound('IFA_NOT_FOUND', 'IFA inconnu.');
    const agency = t.agencyId ? this.agencies.get(t.agencyId) : undefined;
    const allowed = evaluate(user, P.aviaRead, { entity: 'DGTK' }) || evaluate(user, P.aviaDeclare, { taxpayerId: t.airlineTaxpayerId }) || (agency ? evaluate(user, P.aviaAgencyPortal, { taxpayerId: agency.taxpayerId }) : false);
    if (!allowed) throw forbidden('FORBIDDEN', 'Carte réservée à la compagnie, à l’agence émettrice et aux agents habilités.');
    return {
      ifa: t.ifa, qr: t.ifaToken, flightNumber: t.flightNumber, flightDate: t.flightDate, origin: t.origin, destination: t.destination,
      ticketNumber: `${t.ticketNumber.slice(0, 3)}•••${t.ticketNumber.slice(-3)}`, airlineTaxpayerId: t.airlineTaxpayerId, urbanTax: t.urbanTax, source: t.source,
      notice: 'QR fiscal signé (Ed25519), vérifiable hors ligne avec la clé publique des titres. Aucune donnée nominative.',
    };
  }

  private classify(input: { qr?: string; ifa?: string }, flightNumber?: string): { ifa: string | null; result: AviaIfaStatus; ticket?: AviaTicket } {
    const r = this.readQr(input);
    if (!r.authentic) return { ifa: null, result: 'FALSIFIE' };
    if (!r.ifa) return { ifa: null, result: 'SANS_IFA' };
    const t = this.tickets.findOne((x) => x.ifa === r.ifa);
    if (!t) return { ifa: r.ifa, result: 'INCONNU' };
    if (flightNumber && t.flightNumber !== flightNumber) return { ifa: r.ifa, result: 'AUTRE_VOL', ticket: t };
    return { ifa: r.ifa, result: 'VALIDE', ticket: t };
  }

  /** Contrôle terrain par lecteur QR : constate et journalise ; aucune mesure n'est appliquée par le système. */
  controlIfa(user: User, input: { qr?: string; ifa?: string; flightNumber?: string; place: string }) {
    authorize(user, P.aviaIfaControl, {});
    const c = this.classify(input, input.flightNumber);
    const rec = this.controls.append({ id: this.ids.next('AVIA-CTL'), ifa: c.ifa, result: c.result, flightNumber: input.flightNumber ?? c.ticket?.flightNumber ?? null, place: input.place, by: user.id, at: this.now() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'avia.ifa.controlled', resourceType: 'avia_ifa', resourceId: c.ifa ?? 'SANS-IFA', details: { result: c.result, place: input.place } });
    const measure = this.measureStatus?.() ?? { available: false, reason: 'Arrêté provincial non enregistré.' };
    return {
      id: rec.id, result: c.result, resultLabel: AVIA_IFA_STATUS_LABEL[c.result], ifa: c.ifa,
      flight: c.ticket ? { flightNumber: c.ticket.flightNumber, flightDate: c.ticket.flightDate, destination: c.ticket.destination } : null,
      boarded: c.ifa ? this.events.find((e) => e.ifa === c.ifa && e.source === 'RVA_EMBARQUEMENT' && e.ifaStatus === 'VALIDE').length > 0 : false,
      exited: c.ifa ? this.events.find((e) => e.ifa === c.ifa && e.source === 'DGM_SORTIE' && e.ifaStatus === 'VALIDE').length > 0 : false,
      measure: c.result === 'VALIDE' ? null : {
        code: 'BILLET_SANS_IFA_NON_VALIDABLE', available: measure.available,
        notice: measure.available
          ? 'Constat enregistré. La mesure prévue par l’arrêté n’est appliquée que sur décision de l’autorité compétente, au cas par cas.'
          : `Constat enregistré. Mesure « billet sans IFA non validable » non applicable : ${measure.reason}`,
      },
    };
  }

  /** Vérification publique (hors ligne possible avec la clé publique) : authenticité et vol — rien de nominatif. */
  publicVerify(qr: string) {
    const p = this.signer.verifyStatic(qr);
    if (!p || p.k !== 'IFA' || typeof p.c !== 'string') return { authentique: false, message: 'QR fiscal non authentique.' };
    const known = !!this.tickets.findOne((t) => t.ifa === p.c);
    return {
      authentique: true, ifa: p.c, vol: p.v ?? null, date: p.d ?? null, origine: p.o ?? 'FIH', connu: known,
      message: known ? 'IFA authentique, rapproché d’un billet transmis.' : 'Signature authentique, IFA absent du registre consulté.',
    };
  }

  publicKey() {
    return { algorithm: 'Ed25519', format: 'MT1.<charge utile base64url>.<signature base64url>', publicKeyPem: this.signer.publicKeyPem(), payload: { k: 'IFA', c: 'IFA', v: 'vol', d: 'date', o: 'origine', a: 'compagnie' } };
  }

  // ---------------------------------------------------------------------------------------------- indicateurs

  /**
   * Indicateurs « chaque départ connu, compté, vérifié, compensé » (§ 11C.5) — constatés par MOSOLO :
   *  connu = billet transmis avec IFA ; compté = embarquement scanné (RVA) ; vérifié = embarquement ET sortie DGM du
   *  même IFA ; compensé = embarqué avec IFA d'une compagnie dont la taxe est intégralement créditée à la Ville ou dont
   *  l'écart a fait l'objet d'une décision humaine (avis sur règle active, compensation).
   */
  departuresKpi(period: string) {
    const r = this.latest(period);
    if (!r) return null;
    const compensated = r.lines.reduce((s, l) => {
      const d = this.avia.declarations.findOne((x) => x.taxpayerId === l.airlineTaxpayerId && x.period === period);
      const decided = !!d && (d.status === 'FACTUREE' || d.status === 'COMPENSEE');
      const fullyRemitted = l.boardedWithIfa > 0 && signedCents(l.remittanceGap) <= 0n;
      return s + (decided || fullyRemitted ? l.boardedWithIfa : 0);
    }, 0);
    const known = r.totals.sold;
    const counted = r.totals.boarded;
    return {
      period, reconciliationId: r.id, known, counted, verified: r.totals.verified, compensated,
      rates: { countedWithIfa: pct(counted - r.totals.boardedWithoutIfa, counted), verified: pct(r.totals.verified, counted), compensated: pct(compensated, counted) },
    };
  }

  overview(user: User) {
    this.agent(user);
    const periods = [...new Set(this.reconciliations.all().map((r) => r.period))].sort().reverse();
    return {
      notice: 'Pôle de rapprochement des recettes (Revenue Reconciliation Hub, RRH) : constats et propositions seulement. Aucune facturation ni compensation automatique ; taxes aériennes provinciales « acte requis » (J23).',
      connectors: this.connectorsView(),
      agencies: this.agencies.all().map((a) => this.agencyView(a)),
      kpis: periods.map((p) => this.departuresKpi(p)).filter((k) => k !== null),
      reconciliations: periods.map((p) => this.latest(p)!).map((r) => ({ id: r.id, period: r.period, trigger: r.trigger, at: r.at, totals: r.totals, airlines: r.lines.length, withGap: r.lines.filter((l) => l.hasGap).length })),
      controls: { total: this.controls.count(), byResult: this.controls.all().reduce<Record<string, number>>((m, c) => ({ ...m, [c.result]: (m[c.result] ?? 0) + 1 }), {}) },
    };
  }
}

/** Monnaie USD (MoneyJSON) d'une chaîne décimale — pour les vues. */
export const usd = (amount: string): MoneyJSON => ({ amount, currency: 'USD' });
