/**
 * « Sept questions » et chaîne opératoire (Cahier v2.9 § 3) : pour chaque objet et chaque obligation, la plateforme
 * répond en permanence à qui ? quoi ? où ? quelle règle ? combien ? payé ? l'argent est-il arrivé sur le compte public
 * et comptabilisé ? — et montre les treize maillons RECENSER → … → PLANIFIER, chacun avec son événement horodaté et
 * signé (journal d'audit chaîné, grand livre chaîné, quittance signée).
 *
 * Lecture seule : tout est reconstitué depuis les dépôts existants (objets, compte unique, registre juridique,
 * obligations, avis, paiements, règlements, grand livre, quittances, constats, recouvrement, audit). Accès :
 * mêmes règles que les lectures d'objet et d'obligation (périmètre territorial, accès minimal sans nom ni montant pour
 * l'agent de terrain, contribuable limité à ses propres dossiers). Chaque consultation est journalisée.
 */
import { Money, normalizePlate, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { AuditActor, AuditRecord } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { forbidden } from '../../core/errors.js';
import { authorize, evaluate, type Access } from '../../core/policy.js';
import type { Obligation } from '../../modules/assessment/service.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import type { PaymentOrder } from '../../modules/payments/service.js';
import { CATEGORY_LABELS } from '../fiscal/common.js';
import { NEARBY_MAX_ACCURACY_M } from '../fiscal/nearby.js';
import type { FiscalService } from '../fiscal/service.js';
import { buildGraph, buildTrail } from '../pilotage/trail.js';
import type { RecoveryService } from '../recouvrement/service.js';
import type { TerrainService } from '../terrain/service.js';
import { approvalProblem, checkChainInvariants, legalTextProblem } from './invariants.js';
import { MAILLONS, QUESTIONS, type Answer, type Maillon, type MaillonCode, type MaillonStatus, type QuestionCode } from './model.js';

const CONFIRMED_LIKE = new Set(['CONFIRME', 'REGLE', 'RAPPROCHE', 'CONTESTE', 'CONTREPASSE', 'REMBOURSE']);
const OPEN_EXCEPTION = new Set(['OUVERTE', 'EN_COURS']);
const WITHOUT_PAYMENT = new Set(['ANNULEE', 'ADMISE_EN_NON_VALEUR']);
const TAXPAYER_ROLES = new Set(['R30', 'R31']);

type Draft = Omit<Maillon, 'rang' | 'label' | 'garde' | 'code'>;
const draft = (status: MaillonStatus, detail: string, extra: Partial<Draft> = {}): Draft => ({
  status, detail, at: null, actor: null, auditEventId: null, auditSeq: null, chainHash: null, evidence: [], ...extra,
});

function fromAudit(r: AuditRecord | undefined): Partial<Draft> {
  return r ? { at: r.at, actor: r.actor, auditEventId: r.id, auditSeq: r.seq, chainHash: r.hash } : {};
}

export class ChaineService {
  constructor(private readonly ctx: AppContext) {}

  private get fiscal(): FiscalService | undefined { return this.ctx.ext.fiscal as FiscalService | undefined; }
  private get recovery(): RecoveryService | undefined { return this.ctx.ext.recouvrement as RecoveryService | undefined; }
  private get terrain(): TerrainService | undefined { return this.ctx.ext.terrain as TerrainService | undefined; }

  // ————————————————————————— habilitations —————————————————————————

  /** Contribuables dont le lecteur voit les données (lui-même ou ses mandants). */
  private viewerTaxpayers(user: User): string[] {
    if (user.roles.includes('R30')) return user.taxpayerId ? [user.taxpayerId] : [];
    if (user.roles.includes('R31')) return user.mandants ?? [];
    return [];
  }

  private related(user: User, o: FiscalObject): boolean {
    const mine = this.viewerTaxpayers(user);
    if (!mine.length) return false;
    if (o.taxpayerId && mine.includes(o.taxpayerId)) return true;
    return !!this.fiscal && mine.some((t) => this.fiscal!.relations.objectIdsOf(t).includes(o.id));
  }

  /** Accès à un objet : dossier propre, lecture d'objet (territoire), lecture d'obligation ou audit. */
  private objectAccess(user: User, o: FiscalObject): Access {
    if (this.related(user, o)) return 'full';
    const res = { communes: [o.commune], ...(o.taxpayerId ? { taxpayerId: o.taxpayerId } : {}) };
    const candidates: (Access | false)[] = [evaluate(user, 'fiscal:object.read', res), evaluate(user, 'audit.read')];
    for (const ob of this.ctx.assessment.obligations.find((x) => x.objectId === o.id)) {
      candidates.push(evaluate(user, 'obligation.read', { taxpayerId: ob.taxpayerId, entity: ob.entity, communes: [o.commune] }));
    }
    if (candidates.includes('full')) return 'full';
    if (candidates.includes('minimal')) return 'minimal';
    // Refus journalisé (gestionnaire d'erreurs) avec l'action de lecture d'objet.
    return authorize(user, 'fiscal:object.read', res);
  }

  /** Accès à une obligation : même décision que GET /v1/obligations/:id (audit interne : lecture complète). */
  private obligationAccess(user: User, ob: Obligation, o: FiscalObject | undefined): Access | false {
    const r = evaluate(user, 'obligation.read', { taxpayerId: ob.taxpayerId, entity: ob.entity, communes: o ? [o.commune] : [] });
    if (r) return r;
    return evaluate(user, 'audit.read') ? 'full' : false;
  }

  /** Nom du contribuable : visible de lui-même, de son mandataire et des agents à lecture complète du compte unique. */
  private nameVisible(user: User, taxpayerId: string, o: FiscalObject | undefined): boolean {
    if (this.viewerTaxpayers(user).includes(taxpayerId)) return true;
    return evaluate(user, 'taxpayer.read', { taxpayerId, entities: ['DGIPK', 'DGTK'], communes: o ? [o.commune] : [] }) === 'full';
  }

  private maskActor(a: AuditActor | null, access: Access): AuditActor | null {
    if (!a || access === 'full') return a;
    return a.kind === 'user' && (a.roles ?? []).some((r) => TAXPAYER_ROLES.has(r)) ? { kind: 'user', id: 'contribuable (masqué)' } : { kind: a.kind, id: a.id };
  }

  // ————————————————————————— journal —————————————————————————

  private auditOf(resourceId: string, match: (action: string) => boolean): AuditRecord[] {
    return this.ctx.audit.list({ resourceId, limit: Number.MAX_SAFE_INTEGER }).items.filter((r) => match(r.action));
  }
  private firstAudit(resourceId: string, ...actions: string[]): AuditRecord | undefined {
    return this.auditOf(resourceId, (a) => actions.some((x) => (x.endsWith('.') ? a.startsWith(x) : a === x)))[0];
  }
  private lastAudit(resourceId: string, ...actions: string[]): AuditRecord | undefined {
    return this.auditOf(resourceId, (a) => actions.some((x) => (x.endsWith('.') ? a.startsWith(x) : a === x))).at(-1);
  }

  // ————————————————————————— maillons de l'objet —————————————————————————

  private precisionOf(o: FiscalObject) {
    const f = this.terrain?.findings.find((x) => x.objectId === o.id && x.status !== 'REJETE').sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))[0];
    if (f) {
      return { accuracyM: f.gps.accuracyM, source: 'CONSTAT_TERRAIN' as const, findingId: f.id, measuredAt: f.capturedAt, plausible: f.gps.accuracyM <= NEARBY_MAX_ACCURACY_M && !f.flags.includes('DISTANCE') };
    }
    return { accuracyM: null, source: 'DECLARATION' as const, findingId: null, measuredAt: o.createdAt, plausible: null };
  }

  /**
   * Contrôles des verticales rattachés à l'objet, par ordre chronologique : scan de plaque (NFIU, étal, emprise…),
   * contrôle d'événement, contrôle d'un titre (RakaPay, wewa, étal) payé sur une obligation de l'objet, contrôle par
   * plaque d'une session de stationnement de l'objet. Lecture seule, par duck typing des modules chargés.
   */
  private verticalControls(o: FiscalObject): { id: string; type: string; label: string; at: string; audit?: AuditRecord }[] {
    const out: { id: string; type: string; label: string; at: string; audit?: AuditRecord }[] = [];
    const byId = this.ctx.audit.list({ resourceId: o.id, limit: Number.MAX_SAFE_INTEGER }).items;
    for (const r of byId) {
      if (r.action === 'vertical.event.controlled') out.push({ id: r.id, type: 'event_control', label: 'contrôle de jauge sur place', at: r.at, audit: r });
      if (r.action === 'object.plate.agent_scan') out.push({ id: r.id, type: 'plate_scan', label: 'scan de la plaque par un agent', at: r.at, audit: r });
    }
    for (const r of this.ctx.audit.list({ action: 'vertical.plate.scanned', limit: Number.MAX_SAFE_INTEGER }).items) {
      if (r.details.objectId === o.id) out.push({ id: r.id, type: 'plate_scan', label: `scan de la plaque ${r.resourceId}`, at: r.at, audit: r });
    }
    const obligationIds = new Set(this.ctx.assessment.obligations.find((ob) => ob.objectId === o.id).map((ob) => ob.id));
    type Ctl = { id: string; credentialId?: string; at: string; module?: string };
    const titres = this.ctx.ext.titres as { controls?: { all(): Ctl[] }; credentials?: { get(id: string): { obligationId?: string } | undefined } } | undefined;
    if (titres?.controls && titres.credentials && obligationIds.size) {
      for (const e of titres.controls.all()) {
        const c = e.credentialId ? titres.credentials.get(e.credentialId) : undefined;
        if (c?.obligationId && obligationIds.has(c.obligationId)) {
          out.push({ id: e.id, type: 'credential_control', label: `contrôle du titre${e.module ? ` (module ${e.module})` : ''}`, at: e.at, audit: this.lastAudit(e.id, 'titres.control.recorded', 'titres.control.offline_reconciled') });
        }
      }
    }
    type Sess = { plate: string; objectId: string; zoneId: string };
    type Chk = { id: string; plate: string; zoneId: string | null; at: string };
    const parking = this.ctx.ext.parking as { sessions?: { find(f: (s: Sess) => boolean): Sess[] }; checks?: { all(): Chk[] } } | undefined;
    if (parking?.sessions && parking.checks) {
      const sessions = parking.sessions.find((s) => s.objectId === o.id);
      if (sessions.length) {
        const plates = new Set(sessions.map((s) => s.plate));
        for (const k of parking.checks.all()) {
          if (plates.has(k.plate)) out.push({ id: k.id, type: 'parking_check', label: `contrôle par plaque ${k.plate}`, at: k.at });
        }
      }
    }
    // Contrôle d'un véhicule par plaque (modules 11, 12, 25) : journalisé sur la plaque normalisée de l'objet.
    const rawPlate = o.attributes.immatriculation ?? o.attributes.plaque ?? o.attributes.plate;
    if (typeof rawPlate === 'string' && rawPlate) {
      const plate = normalizePlate(rawPlate);
      for (const r of this.ctx.audit.list({ action: 'verticales.vehicle.controlled', limit: Number.MAX_SAFE_INTEGER }).items) {
        if (r.resourceId === plate) out.push({ id: r.id, type: 'vehicle_control', label: `contrôle du véhicule ${plate}`, at: r.at, audit: r });
      }
    }
    // Inspection publicitaire (module 77) d'un dispositif rattaché à l'objet.
    type Insp = { id: string; deviceId: string; observedAt: string; finding: string };
    const pub = this.ctx.ext.publicite as { inspections?: { all(): Insp[] }; devices?: { get(id: string): { objectId?: string } | undefined } } | undefined;
    if (pub?.inspections && pub.devices) {
      for (const i of pub.inspections.all()) {
        if (pub.devices.get(i.deviceId)?.objectId === o.id) out.push({ id: i.id, type: 'ad_inspection', label: `inspection publicitaire (${i.finding})`, at: i.observedAt, audit: this.lastAudit(i.id, 'publicite.inspection.recorded') });
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  private objectLinks(o: FiscalObject): Partial<Record<MaillonCode, Draft>> {
    const declared = this.firstAudit(o.id, 'object.declared');
    const recenser = draft('FAIT', `Objet ${o.id} ${o.status === 'VALIDE' ? 'recensé et vérifié' : 'recensé (provisoire tant qu’il n’est pas vérifié)'} — ${o.probativeStatus}.`, {
      at: o.createdAt, actor: { kind: 'user', id: o.createdBy }, ...fromAudit(declared), evidence: [{ type: 'fiscal_object', id: o.id }],
    });
    if (!declared) Object.assign(recenser, { detail: `${recenser.detail} Événement de déclaration absent du journal.` });

    let identifier: Draft;
    const tp = o.taxpayerId ? this.ctx.taxpayers.taxpayers.get(o.taxpayerId) : undefined;
    if (!o.taxpayerId) identifier = draft('EN_ATTENTE', 'Aucun compte unique rattaché : rattachement sur pièce, validé par un agent habilité.');
    else if (!tp) identifier = draft('BLOQUE', `Compte ${o.taxpayerId} introuvable.`, { reason: 'Compte unique introuvable.' });
    else {
      const rel = this.ctx.audit.list({ action: 'relationship.validated', limit: Number.MAX_SAFE_INTEGER }).items.filter((r) => r.details.objectId === o.id).at(-1);
      identifier = draft('FAIT', `Rattaché au compte unique ${tp.iuc} (niveau ${tp.verificationLevel})${tp.status === 'FUSIONNE' ? ` — compte fusionné dans ${tp.mergedInto}` : ''}.`, {
        at: rel?.at ?? declared?.at ?? o.createdAt, ...(rel ? fromAudit(rel) : fromAudit(declared)), evidence: [{ type: 'taxpayer', id: tp.id }],
      });
    }

    const precision = this.precisionOf(o);
    const validated = this.lastAudit(o.id, 'object.validated');
    const geoloc = o.igf
      ? draft('FAIT', `IGF ${o.igf.code} (${o.lat.toFixed(5)}, ${o.lon.toFixed(5)})${precision.accuracyM !== null ? ` — précision ± ${Math.round(precision.accuracyM)} m (constat terrain)` : ' — position déclarée, précision non mesurée'}.`, {
        at: o.igf.assignedAt, actor: { kind: 'user', id: o.igf.assignedBy }, ...fromAudit(validated), evidence: [{ type: 'igf', id: o.igf.code }],
      })
      : draft('EN_ATTENTE', 'Objet provisoire : l’identifiant géofiscal est attribué à la validation par une personne distincte du déclarant.');

    // Contrôle terrain : constats et observations sur l'objet ; missions ouvertes le ciblant.
    const findings = this.terrain?.findings.find((f) => f.objectId === o.id) ?? [];
    const observations = this.ctx.field.observations.find((x) => x.objectId === o.id);
    const lastFinding = findings.sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : 1)).at(-1);
    const openMission = this.terrain?.missions.find((m) => m.objectIds.includes(o.id) && ['A_AFFECTER', 'AFFECTEE', 'EN_COURS'].includes(m.status))[0];
    let controler: Draft;
    if (lastFinding) {
      controler = draft('FAIT', `${findings.length} constat(s) terrain scellé(s) — dernier : ${lastFinding.outcome}, revue ${lastFinding.status}.`, {
        at: lastFinding.receivedAt, ...fromAudit(this.lastAudit(lastFinding.id, 'terrain.finding.submitted')), evidence: [{ type: 'finding', id: lastFinding.id, hash: lastFinding.seal }],
      });
    } else if (observations.length) {
      const last = observations.at(-1)!;
      controler = draft('FAIT', `${observations.length} observation(s) terrain synchronisée(s) (appareil enrôlé).`, { at: last.receivedAt, actor: { kind: 'device', id: last.deviceId }, evidence: [{ type: 'observation', id: last.id }] });
    } else if (this.verticalControls(o).length) {
      // Contrôles des verticales (Partie V) : scan de plaque, contrôle de titre, contrôle par plaque du stationnement,
      // contrôle d'événement — chacun journalisé ; l'agent constate, il n'encaisse pas.
      const vc = this.verticalControls(o);
      const last = vc.at(-1)!;
      controler = draft('FAIT', `${vc.length} contrôle(s) de verticale journalisé(s) — dernier : ${last.label}.`, {
        at: last.at, ...fromAudit(last.audit), evidence: vc.slice(-5).map((c) => ({ type: c.type, id: c.id })),
      });
    } else if (openMission) {
      controler = draft('EN_ATTENTE', `Mission ${openMission.id} (${openMission.kind}) prévue au ${openMission.dueDate}.`);
    } else {
      controler = draft('SANS_OBJET', 'Aucun contrôle requis à ce jour : les missions sont ciblées par le risque et l’échantillonnage.');
    }
    return { RECENSER: recenser, IDENTIFIER: identifier, GEOLOCALISER: geoloc, CONTROLER: controler };
  }

  // ————————————————————————— maillons d'une obligation —————————————————————————

  private obligationLinks(ob: Obligation): Partial<Record<MaillonCode, Draft>> {
    const ctx = this.ctx;
    const links: Partial<Record<MaillonCode, Draft>> = {};
    const zero = Money.fromJSON(ob.amount).isZero();

    // QUALIFIER : règle du registre, version figée, ACTIVE à la liquidation, visas et texte en vigueur.
    const rule = ctx.rules.rules.get(ob.ruleId);
    if (!rule) links.QUALIFIER = draft('BLOQUE', `Règle ${ob.ruleCode} v${ob.ruleVersion} absente du registre.`, { reason: 'Règle introuvable dans le registre juridique.' });
    else {
      const problems = [
        rule.version !== ob.ruleVersion ? `version figée v${ob.ruleVersion} ≠ registre v${rule.version}` : null,
        ob.trace.ruleStatus !== 'ACTIVE' || !ob.trace.executable ? `règle ${ob.trace.ruleStatus} à la liquidation` : null,
        approvalProblem(rule),
        legalTextProblem(ctx, rule, kinshasaDate(new Date(ob.createdAt))),
      ].filter((x): x is string => !!x);
      const ev = this.lastAudit(rule.id, 'rule.activated') ?? this.lastAudit(rule.id, 'rule.approved.');
      links.QUALIFIER = draft(problems.length ? 'BLOQUE' : 'FAIT', `${rule.code} v${rule.version} — ${rule.label} ; textes : ${rule.legalInstrumentIds.join(', ') || 'aucun'} ; statut actuel ${rule.status}.`, {
        at: rule.activatedAt ?? ev?.at ?? rule.publishedAt ?? null, ...fromAudit(ev), evidence: [{ type: 'rule', id: rule.id }, ...rule.legalInstrumentIds.map((i) => ({ type: 'legal_instrument', id: i, ...(ctx.rules.instrument(i)?.officialDocumentHash ? { hash: ctx.rules.instrument(i)!.officialDocumentHash! } : {}) }))],
        ...(problems.length ? { reason: `Règle non validée ou sans texte en vigueur : ${problems.join(' ; ')}.` } : {}),
      });
    }

    // CALCULER : obligation émise (journal) et écriture de constatation (grand livre chaîné).
    const issued = this.firstAudit(ob.id, 'assessment.issued', 'assessment.rectified');
    const entry = ob.ledgerEntryId ? ctx.ledger.get(ob.ledgerEntryId) : undefined;
    const calcProblems = [
      ob.trace.simulate || ob.trace.nonOpposable ? 'simulation non opposable' : null,
      !issued ? 'émission absente du journal d’audit' : null,
      !zero && !entry ? 'aucune écriture de constatation' : null,
    ].filter((x): x is string => !!x);
    links.CALCULER = draft(calcProblems.length ? 'BLOQUE' : 'FAIT', `Obligation ${ob.id} (${ob.status})${ob.supersedes ? `, rectifie ${ob.supersedes}` : ''}${ob.supersededBy ? `, remplacée par ${ob.supersededBy}` : ''} — échéance ${ob.dueDate}.`, {
      at: ob.createdAt, ...fromAudit(issued), evidence: [{ type: 'obligation', id: ob.id }, ...(entry ? [{ type: 'ledger_entry', id: entry.id, hash: entry.hash }] : [])],
      ...(calcProblems.length ? { reason: `Obligation non liquidée : ${calcProblems.join(', ')}.` } : {}),
    });

    // NOTIFIER : avis du recouvrement ou délivrance de l'avis d'émission (canal, empreinte du contenu).
    const notice = this.recovery?.notices.find((n) => n.obligationId === ob.id).sort((a, b) => (a.issuedAt < b.issuedAt ? -1 : 1))[0];
    const delivery = ctx.comms.deliveries.all().find((d) => d.recipientId === ob.taxpayerId && (d.eventCode === 'assessment.issued' || d.eventCode === 'assessment.rectified') && d.at >= ob.createdAt);
    if (delivery) {
      links.NOTIFIER = draft('FAIT', `Avis d’émission ${delivery.channel} — ${delivery.status}${notice ? ` ; ${notice.number} (${notice.content.title})` : ''}.`, {
        at: delivery.at, actor: { kind: 'system', id: 'communications' }, ...fromAudit(issued), evidence: [{ type: 'delivery', id: delivery.id, hash: delivery.contentHash }, ...(notice ? [{ type: 'notice', id: notice.number, hash: notice.contentHash }] : [])],
      });
    } else if (notice) {
      links.NOTIFIER = draft('FAIT', `${notice.number} — ${notice.content.title} (${notice.notification}).`, {
        at: notice.issuedAt, actor: { kind: 'user', id: notice.issuedBy }, ...fromAudit(this.firstAudit(notice.number, 'recovery.notice.issued')), evidence: [{ type: 'notice', id: notice.number, hash: notice.contentHash }],
      });
    } else links.NOTIFIER = draft('EN_ATTENTE', 'Aucune preuve de délivrance de l’avis au contribuable.');

    // PAYER / RAPPROCHER / QUITTANCER / PLANIFIER : ordres de paiement de l'obligation.
    const orders = ctx.payments.byObligation(ob.id);
    const confirmed = orders.filter((o) => o.confirmedAt && CONFIRMED_LIKE.has(o.status)).sort((a, b) => (a.confirmedAt! < b.confirmedAt! ? -1 : 1));
    const noPayment = zero ? 'Montant nul : aucun paiement attendu.' : WITHOUT_PAYMENT.has(ob.status) ? `Obligation ${ob.status} : aucun paiement attendu.` : null;
    if (confirmed.length) {
      const o = confirmed.at(-1)!;
      const ev = this.lastAudit(o.id, 'payment.confirmed');
      links.PAYER = draft(ev ? 'FAIT' : 'BLOQUE', `${confirmed.length} paiement(s) confirmé(s) par le prestataire — dernier ${o.paymentReference} (${o.channel}, ${o.status}).`, {
        at: o.confirmedAt!, actor: { kind: 'provider', id: o.provider ?? 'prestataire' }, ...fromAudit(ev), evidence: confirmed.map((c) => ({ type: 'payment_order', id: c.paymentReference })),
        ...(ev ? {} : { reason: 'Confirmation signée du prestataire absente du journal d’audit.' }),
      });
    } else if (noPayment) links.PAYER = draft('SANS_OBJET', noPayment);
    else {
      const active = orders.find((o) => o.status === 'INITIE');
      links.PAYER = draft('EN_ATTENTE', active ? `Référence ${active.paymentReference} émise, en attente de confirmation du prestataire.` : 'Aucun paiement confirmé.');
    }

    const reconciled = confirmed.filter((o) => o.reconciledAt || o.status === 'RAPPROCHE');
    const openExc = ctx.treasury.rawExceptions().filter((e) => e.paymentReference && orders.some((o) => o.paymentReference === e.paymentReference) && OPEN_EXCEPTION.has(e.status));
    if (reconciled.length) {
      const o = reconciled.at(-1)!;
      const settle = ctx.ledger.list({ sourceId: o.id }).find((e) => e.eventType === 'SETTLEMENT_CREDITED');
      links.RAPPROCHER = draft(settle ? 'FAIT' : 'BLOQUE', `Règlement reçu sur le compte public et rapproché (${o.paymentReference}).`, {
        at: o.reconciledAt ?? null, actor: { kind: 'system', id: 'rapprochement' }, ...fromAudit(this.lastAudit(o.id, 'reconciliation.matched')),
        evidence: settle ? [{ type: 'ledger_entry', id: settle.id, hash: settle.hash }] : [],
        ...(settle ? {} : { reason: 'Rapproché sans écriture de crédit du compte public au grand livre.' }),
      });
    } else if (confirmed.length && openExc.length) {
      links.RAPPROCHER = draft('BLOQUE', `${openExc.length} exception(s) de rapprochement ouverte(s).`, { reason: openExc.map((e) => `${e.type} : ${e.detail}`).join(' ; '), evidence: openExc.map((e) => ({ type: 'reconciliation_exception', id: e.id })) });
    } else if (confirmed.length) links.RAPPROCHER = draft('EN_ATTENTE', 'Paiement confirmé, en attente du relevé de règlement sur le compte public.');
    else links.RAPPROCHER = noPayment ? draft('SANS_OBJET', noPayment) : draft('EN_ATTENTE', 'Rien à rapprocher tant que le paiement n’est pas confirmé.');

    const receipts = orders.map((o) => ({ o, r: ctx.receipts.byPaymentOrder(o.id) })).filter((x): x is { o: PaymentOrder; r: NonNullable<typeof x.r> } => !!x.r);
    const orphan = receipts.find((x) => !x.o.confirmedAt || !CONFIRMED_LIKE.has(x.o.status));
    const missing = confirmed.filter((o) => !ctx.receipts.byPaymentOrder(o.id));
    const last = receipts.at(-1);
    if (orphan) links.QUITTANCER = draft('BLOQUE', `Quittance ${orphan.r.number} sur un paiement non confirmé (${orphan.o.status}).`, { reason: 'Quittance sans paiement confirmé.', evidence: [{ type: 'receipt', id: orphan.r.number }] });
    else if (missing.length) links.QUITTANCER = draft('BLOQUE', `Paiement ${missing[0]!.paymentReference} confirmé sans quittance.`, { reason: 'Paiement confirmé sans quittance signée.' });
    else if (last && last.r.status === 'DEFINITIVE') {
      links.QUITTANCER = draft('FAIT', `Quittance définitive ${last.r.number} (signature ${last.r.signatureAlgorithm}).`, {
        at: last.r.finalizedAt ?? null, actor: { kind: 'system', id: 'quittances' }, ...fromAudit(this.lastAudit(last.r.id, 'receipt.finalized')), evidence: [{ type: 'receipt', id: last.r.number, hash: last.r.signature }],
      });
    } else if (last) {
      links.QUITTANCER = draft('EN_ATTENTE', `Quittance ${last.r.number} au statut ${last.r.status}${last.r.status === 'PROVISOIRE' ? ' : définitive après rapprochement du règlement' : ''}.`, {
        at: last.r.issuedAt, actor: { kind: 'system', id: 'quittances' }, ...fromAudit(this.firstAudit(last.r.id, 'receipt.issued_provisional')), evidence: [{ type: 'receipt', id: last.r.number, hash: last.r.signature }],
      });
    } else links.QUITTANCER = noPayment ? draft('SANS_OBJET', noPayment) : draft('EN_ATTENTE', 'Aucune quittance : elle n’est émise qu’après confirmation du paiement.');

    // RECOUVRER : dossier de recouvrement, ou situation à l'échéance.
    const rc = this.recovery?.cases.find((c) => c.obligationId === ob.id).at(-1);
    const today = kinshasaDate(ctx.clock.now());
    if (rc) {
      const opened = this.firstAudit(rc.id, 'recovery.case.opened');
      links.RECOUVRER = draft(rc.status === 'OUVERT' ? 'EN_ATTENTE' : 'FAIT', `Dossier ${rc.id} ${rc.status} — ${rc.steps.length} étape(s) (décision humaine habilitée, recours garanti).`, {
        at: rc.steps.at(-1)?.at ?? rc.openedAt, ...fromAudit(opened), evidence: [{ type: 'recovery_case', id: rc.id }],
      });
    } else if (ob.status === 'SOLDEE' || zero) links.RECOUVRER = draft('SANS_OBJET', 'Obligation soldée : aucun recouvrement.');
    else if (WITHOUT_PAYMENT.has(ob.status)) links.RECOUVRER = draft('SANS_OBJET', `Obligation ${ob.status}.`);
    else if (ob.status === 'EN_RETARD' || ob.dueDate < today) links.RECOUVRER = draft('EN_ATTENTE', `Échéance du ${ob.dueDate} dépassée : relances graduées à engager.`);
    else links.RECOUVRER = draft('SANS_OBJET', `Échéance du ${ob.dueDate} non atteinte.`);

    // PLANIFIER : la recette rapprochée entre dans les agrégats du pilotage (commune du fait générateur).
    if (reconciled.length) {
      const o = reconciled.at(-1)!;
      links.PLANIFIER = draft('FAIT', `Recette rapprochée comptée au pilotage de la commune ${ob.attribution?.commune ?? 'non attribuée'} (${ob.revenueCategory}) : base des scénarios et de la capacité de financement.`, {
        at: o.reconciledAt ?? null, ...fromAudit(this.lastAudit(o.id, 'reconciliation.matched')), evidence: [{ type: 'attribution', id: ob.attribution?.commune ?? 'NON_ATTRIBUE' }],
      });
    } else links.PLANIFIER = noPayment ? draft('SANS_OBJET', noPayment) : draft('EN_ATTENTE', 'Recette non encore rapprochée : comptée comme créance à recouvrer.');
    return links;
  }

  /** AUDITER : journal chaîné vérifié, événement de chaque maillon accompli, contrôles de la piste d'audit du dossier. */
  private auditLink(links: Partial<Record<MaillonCode, Draft>>, ob?: Obligation): Draft {
    const v = this.ctx.audit.verify();
    const head = this.ctx.audit.head();
    const missing = (Object.entries(links) as [MaillonCode, Draft][]).filter(([c, d]) => d.status === 'FAIT' && !d.auditEventId && c !== 'CONTROLER' && c !== 'NOTIFIER').map(([c]) => c);
    const failed = ob ? buildTrail(this.ctx, buildGraph(this.ctx, 'obligation', ob.id)).controls.filter((c) => !c.passed) : [];
    const problems = [
      !v.ok ? `journal rompu au rang ${v.brokenAt} (${v.reason})` : null,
      missing.length ? `événement absent du journal pour : ${missing.join(', ')}` : null,
      ob && !this.firstAudit(ob.id, 'assessment.issued', 'assessment.rectified') ? `émission de l’obligation ${ob.id} absente du journal : dossier non reconstituable` : null,
      ...failed.map((c) => `${c.label} — ${c.detail}`),
    ].filter((x): x is string => !!x);
    return draft(problems.length ? 'BLOQUE' : 'FAIT', `Journal chaîné vérifié : ${v.length} événement(s), tête ${head.hash.slice(0, 16)}…${ob ? ' ; piste d’audit du dossier complète' : ''}.`, {
      at: v.verifiedAt, actor: { kind: 'system', id: 'journal-audit' }, auditSeq: head.seq, chainHash: head.hash,
      ...(problems.length ? { reason: problems.join(' ; ') } : {}),
    });
  }

  /** Assemble les treize maillons, applique la règle « aucun maillon sauté » et masque selon l'accès. */
  private chain(o: FiscalObject, ob: Obligation | undefined, access: Access): Maillon[] {
    const links: Partial<Record<MaillonCode, Draft>> = { ...this.objectLinks(o), ...(ob ? this.obligationLinks(ob) : {}) };
    if (!ob) {
      for (const c of ['QUALIFIER', 'CALCULER', 'NOTIFIER', 'PAYER', 'RAPPROCHER', 'QUITTANCER', 'RECOUVRER', 'PLANIFIER'] as MaillonCode[]) {
        links[c] = draft('EN_ATTENTE', 'Aucune obligation liquidée pour cet objet.');
      }
    }
    links.AUDITER = this.auditLink(links, ob);
    const out: Maillon[] = MAILLONS.map((m, i) => ({ rang: i + 1, code: m.code, label: m.label, garde: m.garde, ...links[m.code]! }));
    for (const m of out) {
      if (m.status !== 'FAIT') continue;
      const req = MAILLONS.find((x) => x.code === m.code)!.requires as readonly MaillonCode[];
      const skipped = req.filter((r) => out.find((x) => x.code === r)!.status !== 'FAIT');
      if (skipped.length) Object.assign(m, { status: 'BLOQUE', rupture: true, reason: `Maillon sauté : ${skipped.map((s) => MAILLONS.find((x) => x.code === s)!.label).join(', ')} non accompli.` });
    }
    return out.map((m) => ({ ...m, actor: this.maskActor(m.actor, access) }));
  }

  // ————————————————————————— sept questions —————————————————————————

  private breakdown(ob: Obligation) {
    const paid = this.ctx.payments.paidOn(ob.id);
    const amount = Money.fromJSON(ob.amount);
    const remaining = amount.subtract(paid);
    return {
      obligationId: ob.id, label: ob.label,
      gross: ob.explanation.grossAmount ?? ob.amount,
      adjustments: (ob.explanation.adjustments ?? []).map((a) => ({ label: a.label, rate: a.rate, reduction: a.reduction, legalBasis: a.legalBasis })),
      base: ob.explanation.base, rates: ob.explanation.rates, formula: ob.explanation.formula, localityRank: ob.explanation.localityRank,
      amount: ob.amount, paid: paid.toJSON(), remaining: (remaining.isNegative() ? Money.zero(remaining.currency) : remaining).toJSON(), dueDate: ob.dueDate,
    };
  }

  private payStatus(ob: Obligation): 'PAYE' | 'PARTIEL' | 'NON_PAYE' | 'SANS_OBJET' {
    const amount = Money.fromJSON(ob.amount);
    if (amount.isZero() || WITHOUT_PAYMENT.has(ob.status)) return 'SANS_OBJET';
    const paid = this.ctx.payments.paidOn(ob.id);
    if (paid.compare(amount) >= 0) return 'PAYE';
    return paid.isZero() ? 'NON_PAYE' : 'PARTIEL';
  }

  private settlement(ob: Obligation) {
    return this.ctx.payments.byObligation(ob.id).filter((o) => o.confirmedAt && CONFIRMED_LIKE.has(o.status)).map((o) => {
      const r = this.ctx.receipts.byPaymentOrder(o.id);
      const ledger = this.ctx.ledger.list({ sourceId: o.id }).map((e) => ({ entryId: e.id, eventType: e.eventType, at: e.at, hash: e.hash, reversalOf: e.reversalOf ?? null }));
      const credited = ledger.some((e) => e.eventType === 'SETTLEMENT_CREDITED');
      return {
        obligationId: ob.id, paymentReference: o.paymentReference, status: o.status, beneficiaryAlias: o.beneficiaryAlias,
        settled: !!o.settledAt || credited, settledAt: o.settledAt ?? null, reconciled: !!o.reconciledAt || o.status === 'RAPPROCHE', reconciledAt: o.reconciledAt ?? null,
        postedToLedger: credited, ledger,
        receipt: r ? { number: r.number, status: r.status, level: r.status === 'DEFINITIVE' ? 'DEFINITIVE' : r.status === 'PROVISOIRE' ? 'PROVISOIRE' : r.status, issuedAt: r.issuedAt, finalizedAt: r.finalizedAt ?? null } : null,
      };
    });
  }

  private questions(o: FiscalObject, obs: { ob: Obligation; access: Access }[], access: Access, user: User, hidden: number): Answer[] {
    const ctx = this.ctx;
    const tp = o.taxpayerId ? ctx.taxpayers.taxpayers.get(o.taxpayerId) : undefined;
    const named = !!tp && access === 'full' && this.nameVisible(user, tp.id, o);
    const a = (code: QuestionCode, status: Answer['status'], answer: string, sources: Record<string, unknown>): Answer => ({ code, question: QUESTIONS[code], status, answer, sources });
    const full = obs.filter((x) => x.access === 'full').map((x) => x.ob);
    const out: Answer[] = [];

    out.push(tp
      ? a('QUI', named ? 'REPONDU' : 'MASQUE', named ? `${tp.fullName} — compte unique ${tp.iuc} (niveau ${tp.verificationLevel}).` : `Compte unique ${access === 'full' ? tp.iuc : 'rattaché'} — nom non communiqué à ce profil.`, {
        taxpayerId: access === 'full' ? tp.id : null, iuc: access === 'full' ? tp.iuc : null, name: named ? tp.fullName : null, kind: tp.kind ?? 'PERSONNE_PHYSIQUE', verificationLevel: tp.verificationLevel, identitySource: 'COMPTE_UNIQUE',
      })
      : a('QUI', 'EN_ATTENTE', 'Aucun compte unique rattaché à cet objet.', { taxpayerId: null }));

    const label = CATEGORY_LABELS[o.category] ?? o.category;
    out.push(a('QUOI', 'REPONDU', `${label} ${o.igf ? o.igf.code : o.id} — ${o.status === 'VALIDE' ? 'vérifié' : 'provisoire'}${obs.length ? ` ; ${obs.length} obligation(s) : ${[...new Set(obs.map((x) => x.ob.label))].join(', ')}` : ''}.`, {
      objectId: o.id, objectRef: o.igf?.code ?? o.id, igfCode: o.igf?.code ?? null, category: o.category, categoryLabel: label, status: o.status, probativeStatus: o.probativeStatus, parentObjectId: o.parentObjectId ?? null,
      obligations: obs.map((x) => ({ obligationId: x.ob.id, label: x.ob.label, revenueCategory: x.ob.revenueCategory, status: x.ob.status })),
    }));

    const precision = this.precisionOf(o);
    out.push(a('OU', o.igf ? 'REPONDU' : 'PARTIEL', `${o.commune} › ${o.quartier}${o.avenue ? ` › ${o.avenue}` : ''} — ${o.lat.toFixed(5)}, ${o.lon.toFixed(5)} ${precision.accuracyM !== null ? `(± ${Math.round(precision.accuracyM)} m, constat terrain)` : '(position déclarée, précision non mesurée)'}${o.igf ? ` ; IGF ${o.igf.code}` : ' ; IGF attribué à la validation'}.`, {
      commune: o.commune, quartier: o.quartier, avenue: o.avenue ?? null, lat: o.lat, lon: o.lon, igfCode: o.igf?.code ?? null, igfVersion: o.igf?.codeVersion ?? null, precision,
      attribution: obs.map((x) => ({ obligationId: x.ob.id, commune: x.ob.attribution?.commune ?? null, basis: x.ob.attribution?.basis ?? null })),
    }));

    const rules = obs.map(({ ob }) => {
      const rule = ctx.rules.rules.get(ob.ruleId);
      const legal = (rule?.legalInstrumentIds ?? ob.trace.legalInstrumentIds).map((id) => {
        const inst = ctx.rules.instrument(id);
        return { id, title: inst?.title ?? id, status: inst?.status ?? 'INCONNU', abrogatedOn: inst?.abrogatedOn ?? null };
      });
      const problem = rule ? (approvalProblem(rule) ?? legalTextProblem(ctx, rule, kinshasaDate(new Date(ob.createdAt)))) : 'règle absente du registre';
      return {
        obligationId: ob.id, ruleId: ob.ruleId, code: ob.ruleCode, version: ob.ruleVersion, label: rule?.label ?? ob.label, status: rule?.status ?? 'INCONNUE',
        statusAtLiquidation: ob.trace.ruleStatus, legalReferences: legal, articles: rule?.articles ?? ob.explanation.articles, competentAuthority: ob.explanation.competentAuthority,
        appealPath: ob.explanation.appealPath, textInForce: problem === null, problem,
      };
    });
    out.push(rules.length
      ? a('REGLE', rules.every((r) => r.textInForce && r.statusAtLiquidation === 'ACTIVE') ? 'REPONDU' : 'PARTIEL', rules.map((r) => `${r.code} v${r.version} (${r.status}) — ${r.legalReferences.map((l) => l.title).join(' ; ')}${r.articles.length ? `, ${r.articles.join(', ')}` : ''}`).join(' | '), { rules })
      : a('REGLE', 'EN_ATTENTE', 'Aucune règle appliquée : aucune obligation liquidée pour cet objet.', { rules: [] }));

    if (!obs.length) out.push(a('COMBIEN', 'SANS_OBJET', 'Aucun montant liquidé.', { breakdown: [] }));
    else if (!full.length) out.push(a('COMBIEN', 'MASQUE', 'Montant non communiqué à ce profil (accès minimal).', { breakdown: [] }));
    else {
      const bd = full.map((ob) => this.breakdown(ob));
      out.push(a('COMBIEN', full.length === obs.length ? 'REPONDU' : 'PARTIEL', bd.map((b) => `${b.label} : ${fmt(b.amount)}${b.adjustments.length ? ` (brut ${fmt(b.gross)}, ${b.adjustments.length} exonération(s))` : ''} — payé ${fmt(b.paid)}, reste ${fmt(b.remaining)}`).join(' | '), { breakdown: bd }));
    }

    const pays = obs.map(({ ob, access: acc }) => ({
      obligationId: ob.id, obligationStatus: ob.status, payStatus: this.payStatus(ob),
      payments: acc === 'full' ? ctx.payments.byObligation(ob.id).map((p) => ({ paymentReference: p.paymentReference, status: p.status, channel: p.channel, confirmedAt: p.confirmedAt ?? null })) : [],
    }));
    const agg = !pays.length ? 'SANS_OBJET' : pays.every((p) => p.payStatus === 'PAYE' || p.payStatus === 'SANS_OBJET') ? 'PAYE' : pays.some((p) => p.payStatus !== 'NON_PAYE' && p.payStatus !== 'SANS_OBJET') ? 'PARTIEL' : 'NON_PAYE';
    const payLabel: Record<string, string> = { PAYE: 'Oui — payé', PARTIEL: 'Partiellement payé', NON_PAYE: 'Non payé', SANS_OBJET: 'Aucun paiement attendu' };
    out.push(a('PAYE', !pays.length ? 'SANS_OBJET' : agg === 'PAYE' ? 'REPONDU' : 'EN_ATTENTE', `${payLabel[agg]}${pays.length ? ` (${pays.map((p) => `${p.obligationId} : ${p.payStatus}`).join(', ')})` : ''}.`, { status: agg, obligations: pays }));

    const settlements = full.flatMap((ob) => this.settlement(ob));
    if (!obs.length || !obs.some(({ ob }) => this.payStatus(ob) !== 'SANS_OBJET' && this.payStatus(ob) !== 'NON_PAYE')) {
      out.push(a('COMPTE_PUBLIC', obs.length ? 'EN_ATTENTE' : 'SANS_OBJET', obs.length ? 'Aucun paiement confirmé : rien n’est encore attendu sur le compte public.' : 'Aucune obligation.', { status: obs.length ? 'EN_ATTENTE_DE_PAIEMENT' : 'SANS_OBJET', payments: [] }));
    } else if (!full.length) {
      const reconciledAll = obs.every(({ ob }) => ctx.payments.byObligation(ob.id).filter((p) => p.confirmedAt).every((p) => p.status === 'RAPPROCHE'));
      out.push(a('COMPTE_PUBLIC', 'MASQUE', reconciledAll ? 'Fonds arrivés et comptabilisés (détail non communiqué à ce profil).' : 'Règlement en attente (détail non communiqué à ce profil).', { status: reconciledAll ? 'ARRIVE_ET_COMPTABILISE' : 'EN_ATTENTE_DE_REGLEMENT', payments: [] }));
    } else {
      const done = settlements.length > 0 && settlements.every((s) => s.reconciled && s.postedToLedger && s.receipt?.level === 'DEFINITIVE');
      const status = done ? 'ARRIVE_ET_COMPTABILISE' : 'EN_ATTENTE_DE_REGLEMENT';
      out.push(a('COMPTE_PUBLIC', done ? 'REPONDU' : 'EN_ATTENTE', settlements.map((s) => `${s.paymentReference} : ${s.reconciled ? `arrivé sur le compte public ${s.beneficiaryAlias} et rapproché` : 'en attente du règlement'}${s.postedToLedger ? ', comptabilisé au grand livre' : ''}${s.receipt ? `, quittance ${s.receipt.number} ${s.receipt.level === 'DEFINITIVE' ? 'définitive' : s.receipt.level === 'PROVISOIRE' ? 'provisoire' : s.receipt.level}` : ''}`).join(' | ') || 'Aucun paiement confirmé.', { status, payments: settlements }));
    }
    if (hidden) out.find((x) => x.code === 'QUOI')!.sources.hiddenObligations = hidden;
    return out;
  }

  // ————————————————————————— lectures publiques du module —————————————————————————

  private objectHeader(o: FiscalObject) {
    return { id: o.id, ref: o.igf?.code ?? o.id, category: o.category, categoryLabel: CATEGORY_LABELS[o.category] ?? o.category, commune: o.commune, quartier: o.quartier, status: o.status, demo: o.id.includes('DEMO') || o.attributes['demo'] === true };
  }

  private journal(user: User, kind: 'objet' | 'obligation', id: string, access: Access) {
    // Ressource « chaine » : la consultation n'entre pas dans la chronologie métier du dossier (piste d'audit).
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'chaine.sept_questions.viewed', resourceType: 'chaine', resourceId: `${kind}:${id}`, details: { access } });
  }

  /** GET /v1/objects/:id/sept-questions */
  objectView(user: User, objectId: string) {
    const o = this.ctx.objects.get(objectId);
    const access = this.objectAccess(user, o);
    const all = this.ctx.assessment.obligations.find((x) => x.objectId === o.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const visible: { ob: Obligation; access: Access }[] = [];
    for (const ob of all) {
      const acc = this.obligationAccess(user, ob, o);
      if (acc) visible.push({ ob, access: access === 'minimal' ? 'minimal' : acc });
    }
    const hidden = all.length - visible.length;
    const principal = [...visible].reverse().find((x) => !x.ob.supersededBy)?.ob;
    this.journal(user, 'objet', o.id, access);
    const chaines = visible.map(({ ob, access: acc }) => {
      const maillons = this.chain(o, ob, acc);
      return { obligationId: ob.id, label: ob.label, status: ob.status, current: !ob.supersededBy, complete: maillons.every((m) => m.status === 'FAIT' || m.status === 'SANS_OBJET'), ruptures: maillons.filter((m) => m.rupture).length, maillons };
    });
    const main = principal ? chaines.find((c) => c.obligationId === principal.id)!.maillons : this.chain(o, undefined, access);
    return {
      objet: this.objectHeader(o), access, generatedAt: this.ctx.clock.now().toISOString(),
      questions: this.questions(o, visible, access, user, hidden),
      chaine: { obligationId: principal?.id ?? null, maillons: main, complete: main.every((m) => m.status === 'FAIT' || m.status === 'SANS_OBJET'), ruptures: main.filter((m) => m.rupture).length },
      obligations: chaines, hiddenObligations: hidden,
      notice: access === 'minimal'
        ? 'Accès minimal : ni nom ni montant. Aucun encaissement sur le terrain ; l’usager paie par les canaux officiels.'
        : 'Chaque maillon renvoie à son événement horodaté et signé (journal d’audit chaîné, grand livre, quittance). Un maillon ne peut pas être sauté.',
    };
  }

  /** GET /v1/obligations/:id/chaine */
  obligationView(user: User, obligationId: string) {
    const ob = this.ctx.assessment.get(obligationId);
    const o = this.ctx.objects.objects.get(ob.objectId);
    const access = authorize(user, 'obligation.read', { taxpayerId: ob.taxpayerId, entity: ob.entity, communes: o ? [o.commune] : [] });
    if (!o) throw forbidden('OBJECT_MISSING', `Objet ${ob.objectId} introuvable : chaîne non reconstituable.`);
    this.journal(user, 'obligation', ob.id, access);
    const maillons = this.chain(o, ob, access);
    return {
      objet: this.objectHeader(o), obligation: { id: ob.id, label: ob.label, status: ob.status, ruleCode: ob.ruleCode, ruleVersion: ob.ruleVersion, supersededBy: ob.supersededBy ?? null, supersedes: ob.supersedes ?? null },
      access, generatedAt: this.ctx.clock.now().toISOString(),
      questions: this.questions(o, [{ ob, access }], access, user, 0),
      chaine: { obligationId: ob.id, maillons, complete: maillons.every((m) => m.status === 'FAIT' || m.status === 'SANS_OBJET'), ruptures: maillons.filter((m) => m.rupture).length },
    };
  }

  /** GET /v1/integrite/chaine/ruptures : détection et alertes (examen humain, aucun effet automatique). */
  ruptures(user: User) {
    authorize(user, 'chaine:ruptures.read');
    const res = checkChainInvariants(this.ctx);
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'chaine.invariants.checked', resourceType: 'chaine', resourceId: 'invariants', details: { total: res.total, alertsRaised: res.alertsRaised } });
    return res;
  }
}

function fmt(m: MoneyJSON): string {
  return `${m.amount} ${m.currency}`;
}
