/**
 * Moteur de détection d'anomalies locatives (§ 16.4, § 8.5) : six signaux de rapprochement sur données de partenaires
 * + le signal interne « unités locatives sans bail ». Chaque règle produit une LISTE DE TRAVAIL priorisée pour une
 * vérification humaine ; jamais un avis, une obligation ni une dette.
 *
 * Garde « protocole requis » : aucune donnée de partenaire n'est ingérée sans protocole d'échange de données actif
 * (J13). Si un module « opportunites » expose sa propre vérification de protocole, elle est réutilisée ; à défaut, le
 * registre local des protocoles ci-dessous s'applique (proposition, puis approbation par une seconde personne — le
 * délégué à la protection des données ou la direction).
 */
import { isRealCalendarDate } from '../../core/http.js';
import { z } from 'zod';
import type { User } from '../../core/auth.js';
import { sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, assertNotRelated, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { actorOf, parentIdOf, type FiscalDeps } from './common.js';

const { always, inTerritory } = GRANTS;
definePolicy('fiscal:anomaly.read', { R06: always, R07: always, R11: always, R22: always, R24: always, R09: inTerritory('minimal') });
definePolicy('fiscal:anomaly.detect', { R06: always, R07: always, R11: always });
definePolicy('fiscal:anomaly.review', { R06: always, R07: always, R11: always });
definePolicy('fiscal:data-protocol.read', { R06: always, R07: always, R11: always, R22: always, R24: always, R25: always, R34: always });
definePolicy('fiscal:data-protocol.propose', { R06: always, R07: always });
definePolicy('fiscal:data-protocol.approve', { R25: always, R06: always });
definePolicy('fiscal:partner-data.ingest', { R34: always, R06: always, R07: always });

/** Sources de données de partenaires (protocole J13 requis pour chacune). */
export const PARTNER_SOURCES = ['COMPTEURS', 'PAIE_EMPLOYEURS', 'ANNONCES_AGENCES', 'BAUX_IMPOT_PROFESSIONNEL', 'PERMIS_IMAGERIE', 'RECEPTION_IMMEUBLES'] as const;
export type PartnerSource = (typeof PARTNER_SOURCES)[number];

export const SOURCE_LABELS: Record<PartnerSource, string> = {
  COMPTEURS: 'Compteurs d’électricité et d’eau (distributeurs)',
  PAIE_EMPLOYEURS: 'Paie des entreprises (indemnités de logement)',
  ANNONCES_AGENCES: 'Annonces et mandats d’agences immobilières',
  BAUX_IMPOT_PROFESSIONNEL: 'Baux d’entreprise déclarés à l’impôt professionnel',
  PERMIS_IMAGERIE: 'Permis de construire et imagerie',
  RECEPTION_IMMEUBLES: 'Réceptions d’immeubles neufs',
};

export const SIGNALS = [
  'COMPTEURS_MULTIPLES', 'INDEMNITES_SANS_RETENUE', 'ANNONCE_BIEN_NON_RATTACHE', 'BAIL_ENTREPRISE_BAILLEUR_INCONNU',
  'PARCELLE_NON_BATIE_CONSTRUITE', 'IMMEUBLE_NEUF_SANS_UNITE', 'UNITES_SANS_BAIL',
] as const;
export type Signal = (typeof SIGNALS)[number];

/** Nombre de compteurs à partir duquel « plusieurs compteurs » est constaté (§ 16.4 : « plusieurs »). */
export const MULTIPLE_METERS_MIN = 2;
/** Délai après réception d'un immeuble neuf sans unité locative déclarée (§ 16.4 : « après douze mois »). */
export const NEW_BUILDING_NO_UNIT_MONTHS = 12;

/** Catalogue des signaux (tableau du § 16.4) : signal, règle de rapprochement, sortie. */
export const SIGNAL_CATALOGUE: Record<Signal, { label: string; rule: string; output: string; source: PartnerSource | null }> = {
  COMPTEURS_MULTIPLES: { label: 'Plusieurs compteurs d’électricité ou d’eau sur une parcelle', rule: 'Aucune déclaration locative associée', output: 'Probable bien loué : visite de vérification', source: 'COMPTEURS' },
  INDEMNITES_SANS_RETENUE: { label: 'Indemnités de logement en paie d’entreprise', rule: 'Aucune retenue IRL correspondante', output: 'Notification à l’employeur (projet ; envoi décidé par une personne habilitée)', source: 'PAIE_EMPLOYEURS' },
  ANNONCE_BIEN_NON_RATTACHE: { label: 'Annonce ou mandat d’agence immobilière', rule: 'Bien non rattaché à un compte', output: 'Enquête documentaire', source: 'ANNONCES_AGENCES' },
  BAIL_ENTREPRISE_BAILLEUR_INCONNU: { label: 'Bail d’entreprise déclaré à l’impôt professionnel', rule: 'Bailleur inconnu du registre provincial', output: 'Rapprochement inter-administrations', source: 'BAUX_IMPOT_PROFESSIONNEL' },
  PARCELLE_NON_BATIE_CONSTRUITE: { label: 'Parcelle déclarée non bâtie', rule: 'Image ou permis montrant une construction', output: 'Requalification contrôlée', source: 'PERMIS_IMAGERIE' },
  IMMEUBLE_NEUF_SANS_UNITE: { label: 'Immeuble neuf réceptionné', rule: `Aucune unité locative déclarée après ${NEW_BUILDING_NO_UNIT_MONTHS} mois`, output: 'Visite de recensement', source: 'RECEPTION_IMMEUBLES' },
  UNITES_SANS_BAIL: { label: 'Unité locative recensée sans bail déclaré', rule: 'Aucun bail ni déclaration IRL', output: 'Situation d’occupation à qualifier (visite)', source: null },
};

const ref = z.string().trim().min(1).max(120);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDate, 'date inexistante au calendrier');
/** Forme attendue d'un enregistrement par source (validation stricte ; aucune donnée superflue n'est conservée). */
export const RECORD_SCHEMAS: Record<PartnerSource, z.ZodTypeAny> = {
  COMPTEURS: z.object({ objectRef: ref, meters: z.number().int().min(0).max(500), utility: z.enum(['ELECTRICITE', 'EAU']), period: z.string().max(20) }).strict(),
  PAIE_EMPLOYEURS: z.object({ employerRef: ref, period: z.string().max(20), employeesWithHousingAllowance: z.number().int().min(0).max(1_000_000), irlWithheld: z.boolean() }).strict(),
  ANNONCES_AGENCES: z.object({ agency: ref, objectRef: ref.optional(), commune: ref, quartier: ref.optional(), address: z.string().trim().min(3).max(200), listedAt: day }).strict(),
  BAUX_IMPOT_PROFESSIONNEL: z.object({ lesseeRef: ref, lessorName: ref, lessorNif: ref.optional(), objectRef: ref.optional(), commune: ref.optional(), period: z.string().max(20) }).strict(),
  PERMIS_IMAGERIE: z.object({ objectRef: ref, evidence: z.enum(['PERMIS', 'IMAGE']), reference: ref, observedAt: day }).strict(),
  RECEPTION_IMMEUBLES: z.object({ objectRef: ref, receptionDate: day }).strict(),
};

export interface DataProtocol {
  id: string;
  source: PartnerSource;
  partner: string;
  actReference: string;
  purpose: string;
  validFrom: string;
  validTo: string;
  status: 'PROPOSE' | 'ACTIF' | 'REJETE';
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; approve: boolean; reason: string };
}

export interface PartnerLot {
  id: string;
  source: PartnerSource;
  protocolRef: string;
  receivedBy: string;
  receivedAt: string;
  accepted: number;
  rejected: { index: number; error: string }[];
  contentHash: string;
}

export interface PartnerRecord { id: string; lotId: string; source: PartnerSource; data: Record<string, unknown>; receivedAt: string }

export type AnomalyStatus = 'A_EXAMINER' | 'EN_VERIFICATION' | 'CONFIRMEE' | 'ECARTEE';

export interface AnomalyCase {
  id: string;
  key: string;
  signal: Signal;
  objectId?: string;
  objectRef?: string;
  taxpayerId?: string;
  commune?: string;
  summary: string;
  evidence: string[];
  priority: number;
  status: AnomalyStatus;
  detectedAt: string;
  detectionRunId: string;
  /** Nature : liste de travail, jamais une dette ni un avis. */
  nature: 'LISTE_DE_TRAVAIL';
  reviews: { by: string; at: string; decision: AnomalyStatus; reason: string; missionRef?: string }[];
}

/** Vérification d'un protocole exposée par le module « opportunites » (réutilisée si présente). */
interface ExternalProtocolCheck { protocolFor?(source: string): { active: boolean; reference?: string } | undefined }

const NOT_BUILT = new Set(['non', 'NON', 'false', 'NON_BATIE', 'non_batie', 'non bâtie']);

export class AnomalyService {
  readonly protocols = new InMemoryRepository<DataProtocol>();
  readonly lots = new InMemoryRepository<PartnerLot>();
  readonly records = new InMemoryAppendOnlyRepository<PartnerRecord>();
  readonly cases = new InMemoryRepository<AnomalyCase>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps) {}

  // ——— Protocoles de données (garde « protocole requis ») ———

  /** Protocole actif pour une source : module « opportunites » s'il le fournit, sinon registre local. */
  protocolStatus(source: PartnerSource): { active: boolean; reference: string | null; origin: 'OPPORTUNITES' | 'LOCAL'; notice: string } {
    const ext = this.d.ctx.ext['opportunites'] as ExternalProtocolCheck | undefined;
    const r = ext?.protocolFor?.(source);
    if (r) return { active: r.active, reference: r.reference ?? null, origin: 'OPPORTUNITES', notice: r.active ? 'Protocole actif (module Opportunités).' : 'Protocole requis (J13).' };
    const today = this.d.today();
    const p = this.protocols.find((x) => x.source === source && x.status === 'ACTIF' && x.validFrom <= today && today <= x.validTo)[0];
    return p
      ? { active: true, reference: p.actReference, origin: 'LOCAL', notice: `Protocole actif avec ${p.partner} jusqu’au ${p.validTo}.` }
      : { active: false, reference: null, origin: 'LOCAL', notice: 'Protocole requis (J13) : aucune donnée de cette source ne peut être ingérée.' };
  }

  proposeProtocol(user: User, input: { source: PartnerSource; partner: string; actReference: string; purpose: string; validFrom: string; validTo: string }): DataProtocol {
    authorize(user, 'fiscal:data-protocol.propose');
    if (input.validTo < input.validFrom) throw badRequest('INVALID_PERIOD', 'La fin de validité précède le début.');
    const p = this.protocols.insert({ id: this.ids.next('PDD'), ...input, status: 'PROPOSE', proposedBy: user.id, proposedAt: this.d.nowIso() });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.data_protocol.proposed', resourceType: 'data_protocol', resourceId: p.id, details: { source: p.source, partner: p.partner, actReference: p.actReference } });
    return p;
  }

  decideProtocol(user: User, id: string, input: { approve: boolean; reason: string }): DataProtocol {
    authorize(user, 'fiscal:data-protocol.approve');
    const p = this.protocols.get(id);
    if (!p) throw notFound('PROTOCOL_NOT_FOUND', `Protocole inconnu : ${id}`);
    if (p.status !== 'PROPOSE') throw conflict('PROTOCOL_BAD_STATE', `Protocole au statut ${p.status}.`);
    assertDistinctPerson(user.id, [p.proposedBy], 'L’activation d’un protocole de données est décidée par une personne distincte de celle qui l’a proposé.');
    const out = this.protocols.update({ ...p, status: input.approve ? 'ACTIF' : 'REJETE', decision: { by: user.id, at: this.d.nowIso(), approve: input.approve, reason: input.reason } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'fiscal.data_protocol.activated' : 'fiscal.data_protocol.rejected', resourceType: 'data_protocol', resourceId: id, details: { source: p.source, proposedBy: p.proposedBy, reason: input.reason } });
    return out;
  }

  /** Lot de données d'un partenaire : refusé (422 PROTOCOLE_REQUIS) sans protocole actif ; rapport de validation par ligne. */
  ingest(user: User, source: PartnerSource, rows: unknown[]): PartnerLot {
    authorize(user, 'fiscal:partner-data.ingest');
    const st = this.protocolStatus(source);
    if (!st.active) {
      this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.partner_data.refused', resourceType: 'partner_source', resourceId: source, outcome: 'DENIED', details: { reason: 'PROTOCOLE_REQUIS', rows: rows.length } });
      throw unprocessable('PROTOCOLE_REQUIS', `Protocole requis (J13) : aucune donnée « ${SOURCE_LABELS[source]} » ne peut être ingérée sans protocole d’échange actif.`, { source });
    }
    if (rows.length === 0 || rows.length > 5000) throw badRequest('INVALID_LOT', 'Un lot contient de 1 à 5 000 enregistrements.');
    const lotId = this.ids.next('LOT-PART');
    const now = this.d.nowIso();
    const rejected: PartnerLot['rejected'] = [];
    let accepted = 0;
    rows.forEach((row, index) => {
      const r = RECORD_SCHEMAS[source].safeParse(row);
      if (!r.success) { rejected.push({ index, error: r.error.issues.map((i) => `${i.path.join('.') || '(ligne)'} : ${i.message}`).join(' ; ') }); return; }
      this.records.append({ id: this.ids.next('ENR', 8), lotId, source, data: r.data as Record<string, unknown>, receivedAt: now });
      accepted++;
    });
    const lot = this.lots.insert({ id: lotId, source, protocolRef: st.reference ?? '—', receivedBy: user.id, receivedAt: now, accepted, rejected, contentHash: sha256Hex(JSON.stringify(rows)) });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.partner_data.ingested', resourceType: 'partner_lot', resourceId: lotId, details: { source, accepted, rejected: rejected.length, protocol: st.reference } });
    return lot;
  }

  // ——— Détection ———

  private resolveObject(r: string | undefined): FiscalObject | undefined {
    if (!r) return undefined;
    const objs = this.d.ctx.objects.objects;
    return objs.get(r) ?? objs.findOne((o) => o.igf?.code === r);
  }

  private resolveTaxpayer(r: string): string | undefined {
    const tps = this.d.ctx.taxpayers.taxpayers;
    const byId = tps.get(r) ?? tps.findOne((t) => t.iuc === r);
    if (byId) return byId.id;
    return this.taxpayerByNif(r);
  }

  /** Recherche d'un contribuable par NIF déclaré ou vérifié (empreinte, registre d'identité du module d'accès). */
  private taxpayerByNif(nif: string): string | undefined {
    const acces = this.d.ctx.ext['acces'] as { proofs?: { findOne(p: (x: { type: string; referenceHash: string; status: string; taxpayerId: string }) => boolean): { taxpayerId: string } | undefined } } | undefined;
    const hash = sha256Hex(`NIF:${nif.trim().toUpperCase()}`);
    return acces?.proofs?.findOne((p) => p.type === 'NIF' && p.referenceHash === hash && p.status !== 'REJETEE')?.taxpayerId;
  }

  private rentalFootprint(o: FiscalObject): { leases: number; declarations: number; units: number } {
    const children = this.d.ctx.objects.objects.find((x) => parentIdOf(x) === o.id);
    const grand = children.flatMap((c) => this.d.ctx.objects.objects.find((x) => parentIdOf(x) === c.id));
    const ids = new Set([o.id, ...children.map((c) => c.id), ...grand.map((g) => g.id)]);
    const fiscal = this.d.ctx.ext['fiscal'] as { declarations?: { declarations: { find(p: (x: { objectId: string; kind: string }) => boolean): unknown[] } } } | undefined;
    return {
      leases: this.d.ctx.objects.leases.find((l) => ids.has(l.unitObjectId)).length,
      declarations: fiscal?.declarations?.declarations.find((x) => ids.has(x.objectId) && x.kind === 'IRL').length ?? 0,
      units: [...children, ...grand].filter((x) => x.category === 'UNITE_LOCATIVE').length,
    };
  }

  private addMonths(date: string, months: number): string {
    const t = new Date(`${date}T00:00:00.000Z`);
    t.setUTCMonth(t.getUTCMonth() + months);
    return t.toISOString().slice(0, 10);
  }

  /**
   * Exécution des règles de rapprochement : crée ou complète des dossiers de vérification (dédoublonnés par signal et
   * par objet ou contribuable). Idempotente ; ne crée ni obligation, ni avis, ni changement d'objet.
   */
  detect(user: User) {
    authorize(user, 'fiscal:anomaly.detect');
    const runId = this.ids.next('DET');
    const today = this.d.today();
    const created: string[] = [];
    const refreshed: string[] = [];
    const push = (signal: Signal, c: { key: string; objectId?: string; objectRef?: string; taxpayerId?: string; commune?: string; summary: string; evidence: string[] }) => {
      const key = `${signal}|${c.key}`;
      const open = this.cases.findOne((x) => x.key === key && (x.status === 'A_EXAMINER' || x.status === 'EN_VERIFICATION'));
      if (open) {
        const evidence = [...new Set([...open.evidence, ...c.evidence])];
        if (evidence.length !== open.evidence.length) { this.cases.update({ ...open, evidence, priority: evidence.length }); refreshed.push(open.id); }
        return;
      }
      if (this.cases.findOne((x) => x.key === key && x.status === 'ECARTEE' && c.evidence.every((e) => x.evidence.includes(e)))) return;
      const k = this.cases.insert({
        id: this.ids.next('ANO'), key, signal, ...(c.objectId ? { objectId: c.objectId } : {}), ...(c.objectRef ? { objectRef: c.objectRef } : {}),
        ...(c.taxpayerId ? { taxpayerId: c.taxpayerId } : {}), ...(c.commune ? { commune: c.commune } : {}),
        summary: c.summary, evidence: c.evidence, priority: c.evidence.length, status: 'A_EXAMINER', detectedAt: this.d.nowIso(), detectionRunId: runId,
        nature: 'LISTE_DE_TRAVAIL', reviews: [],
      });
      created.push(k.id);
    };
    const bySource = (s: PartnerSource) => this.records.find((r) => r.source === s);

    for (const r of bySource('COMPTEURS')) {
      const x = r.data as { objectRef: string; meters: number; utility: string };
      if (x.meters < MULTIPLE_METERS_MIN) continue;
      const o = this.resolveObject(x.objectRef);
      if (o) {
        const f = this.rentalFootprint(o);
        if (f.leases || f.declarations) continue;
      }
      push('COMPTEURS_MULTIPLES', { key: o?.id ?? x.objectRef, ...(o ? { objectId: o.id, commune: o.commune } : { objectRef: x.objectRef }), summary: `${x.meters} compteurs (${x.utility.toLowerCase()}) sans déclaration locative associée.`, evidence: [r.id] });
    }
    for (const r of bySource('PAIE_EMPLOYEURS')) {
      const x = r.data as { employerRef: string; period: string; employeesWithHousingAllowance: number; irlWithheld: boolean };
      if (x.employeesWithHousingAllowance <= 0 || x.irlWithheld) continue;
      const tp = this.resolveTaxpayer(x.employerRef);
      push('INDEMNITES_SANS_RETENUE', { key: tp ?? x.employerRef, ...(tp ? { taxpayerId: tp } : { objectRef: x.employerRef }), summary: `${x.employeesWithHousingAllowance} salarié(s) avec indemnité de logement, sans retenue IRL (période ${x.period}).`, evidence: [r.id] });
    }
    for (const r of bySource('ANNONCES_AGENCES')) {
      const x = r.data as { agency: string; objectRef?: string; commune: string; address: string };
      const o = this.resolveObject(x.objectRef);
      if (o?.taxpayerId) continue;
      push('ANNONCE_BIEN_NON_RATTACHE', { key: o?.id ?? `${x.commune}|${x.address.toLowerCase()}`, ...(o ? { objectId: o.id } : { objectRef: x.objectRef ?? x.address }), commune: o?.commune ?? x.commune, summary: `Annonce de ${x.agency} : bien ${o ? 'recensé sans redevable rattaché' : 'non recensé'} (${x.address}).`, evidence: [r.id] });
    }
    for (const r of bySource('BAUX_IMPOT_PROFESSIONNEL')) {
      const x = r.data as { lesseeRef: string; lessorName: string; lessorNif?: string; objectRef?: string; commune?: string };
      const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
      const known = (x.lessorNif && this.taxpayerByNif(x.lessorNif)) || this.d.ctx.taxpayers.taxpayers.findOne((t) => norm(t.fullName) === norm(x.lessorName));
      if (known) continue;
      const o = this.resolveObject(x.objectRef);
      push('BAIL_ENTREPRISE_BAILLEUR_INCONNU', { key: `${norm(x.lessorName)}|${x.lessorNif ?? ''}`, ...(o ? { objectId: o.id } : {}), ...(x.commune ? { commune: x.commune } : o ? { commune: o.commune } : {}), summary: `Bail déclaré par ${x.lesseeRef} à l’impôt professionnel : bailleur « ${x.lessorName} » inconnu du registre provincial.`, evidence: [r.id] });
    }
    for (const r of bySource('PERMIS_IMAGERIE')) {
      const x = r.data as { objectRef: string; evidence: string; reference: string };
      const o = this.resolveObject(x.objectRef);
      if (!o || o.category !== 'PARCELLE') continue;
      const bati = o.attributes['bati'] ?? o.attributes['nature'];
      if (!(typeof bati === 'string' || typeof bati === 'boolean') || !NOT_BUILT.has(String(bati))) continue;
      push('PARCELLE_NON_BATIE_CONSTRUITE', { key: o.id, objectId: o.id, commune: o.commune, summary: `Parcelle déclarée non bâtie ; ${x.evidence === 'PERMIS' ? 'permis' : 'image'} ${x.reference} montrant une construction.`, evidence: [r.id] });
    }
    const receptions: { o: FiscalObject; date: string; ev: string }[] = [];
    for (const r of bySource('RECEPTION_IMMEUBLES')) {
      const x = r.data as { objectRef: string; receptionDate: string };
      const o = this.resolveObject(x.objectRef);
      if (o) receptions.push({ o, date: x.receptionDate, ev: r.id });
    }
    // Donnée interne équivalente : bâtiment recensé portant sa date de réception.
    for (const o of this.d.ctx.objects.objects.find((x) => x.category === 'BATIMENT' && typeof x.attributes['dateReception'] === 'string')) {
      receptions.push({ o, date: String(o.attributes['dateReception']), ev: `objet:${o.id}` });
    }
    for (const { o, date, ev } of receptions) {
      if (this.addMonths(date, NEW_BUILDING_NO_UNIT_MONTHS) > today) continue;
      if (this.rentalFootprint(o).units > 0) continue;
      push('IMMEUBLE_NEUF_SANS_UNITE', { key: o.id, objectId: o.id, commune: o.commune, summary: `Immeuble réceptionné le ${date} : aucune unité locative déclarée après ${NEW_BUILDING_NO_UNIT_MONTHS} mois.`, evidence: [ev] });
    }
    // Signal interne existant : unités locatives sans bail (même définition que l'agent d'intelligence locative).
    for (const u of this.d.ctx.objects.objects.find((x) => x.category === 'UNITE_LOCATIVE')) {
      const f = this.rentalFootprint(u);
      if (f.leases || f.declarations) continue;
      push('UNITES_SANS_BAIL', { key: u.id, objectId: u.id, commune: u.commune, summary: 'Unité locative recensée sans bail ni déclaration IRL.', evidence: [`objet:${u.id}`] });
    }
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.anomalies.detected', resourceType: 'anomaly_run', resourceId: runId, details: { created: created.length, refreshed: refreshed.length } });
    return { runId, created: created.length, refreshed: refreshed.length, notice: 'Listes de travail pour vérification humaine : aucune obligation, aucun avis, aucune dette.' };
  }

  // ——— Revue humaine ———

  review(user: User, id: string, input: { decision: 'EN_VERIFICATION' | 'CONFIRMEE' | 'ECARTEE'; reason: string; missionRef?: string }): AnomalyCase {
    authorize(user, 'fiscal:anomaly.review');
    const c = this.cases.get(id);
    if (!c) throw notFound('ANOMALY_NOT_FOUND', `Dossier inconnu : ${id}`);
    if (c.status === 'CONFIRMEE' || c.status === 'ECARTEE') throw conflict('ANOMALY_CLOSED', 'Dossier déjà clos.');
    if (input.decision === 'CONFIRMEE' && c.status !== 'EN_VERIFICATION') throw conflict('VERIFICATION_REQUIRED', 'Une vérification (visite, enquête) doit précéder la confirmation.');
    assertNotRelated(user, c.taxpayerId, 'Un agent ne vérifie pas un dossier concernant un contribuable auquel il est lié.');
    const out = this.cases.update({ ...c, status: input.decision, reviews: [...c.reviews, { by: user.id, at: this.d.nowIso(), decision: input.decision, reason: input.reason, ...(input.missionRef ? { missionRef: input.missionRef } : {}) }] });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.anomaly.reviewed', resourceType: 'anomaly', resourceId: id, details: { signal: c.signal, decision: input.decision, reason: input.reason } });
    return out;
  }

  view(c: AnomalyCase) {
    const cat = SIGNAL_CATALOGUE[c.signal];
    return {
      ...c, signalLabel: cat.label, rule: cat.rule, output: cat.output,
      followUp: c.status === 'CONFIRMEE' ? 'Suite par les circuits habituels (recensement, relation, déclaration) — aucune dette n’est créée par ce dossier.' : null,
    };
  }

  list(user: User, filter: { signal?: string; status?: string; commune?: string } = {}) {
    authorize(user, 'fiscal:anomaly.read');
    return this.cases.all()
      .filter((c) => (!filter.signal || c.signal === filter.signal) && (!filter.status || c.status === filter.status) && (!filter.commune || c.commune === filter.commune))
      .filter((c) => !user.territory || !c.commune || user.territory.includes(c.commune))
      .sort((a, b) => b.priority - a.priority || a.detectedAt.localeCompare(b.detectedAt))
      .map((c) => this.view(c));
  }

  catalogue() {
    return SIGNALS.map((s) => {
      const c = SIGNAL_CATALOGUE[s];
      return { code: s, ...c, sourceLabel: c.source ? SOURCE_LABELS[c.source] : 'Données internes du registre', protocol: c.source ? this.protocolStatus(c.source) : { active: true, reference: null, origin: 'LOCAL' as const, notice: 'Données internes : aucun protocole requis.' }, open: this.cases.find((x) => x.signal === s && (x.status === 'A_EXAMINER' || x.status === 'EN_VERIFICATION')).length };
    });
  }
}
