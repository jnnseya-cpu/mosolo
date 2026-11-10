/**
 * Fourrières, enlèvement et gardiennage (module 83 — n° 60 du catalogue du maître d'ouvrage du 27/09/2026).
 *
 * Chaîne en sept étapes, chacune journalisée et chaînée (chaîne de garde à empreintes) :
 *  a. constat et immobilisation : motif légal, agent, position GPS, horodatage serveur, photos du véhicule et de son
 *     état — dossier incomplet ⇒ aucune entrée ; l'ENLÈVEMENT n'est possible que sur DÉCISION de l'autorité
 *     compétente enregistrée avant (une personne distincte de l'agent) ; un algorithme ou un score ne fait que
 *     PRIORISER, jamais ordonner ;
 *  b. entrée : inventaire photographique contradictoire (cinq vues, empreinte SHA-256 comme la caméra de preuve),
 *     état, inventaire des objets, site (objet géolocalisé), numéro d'ordre attribué par le serveur ;
 *  c. gardiennage : compteur de jours automatique depuis les horodatages d'entrée et de sortie, que personne ne modifie
 *     sauf par une écriture contraire motivée validée par une seconde personne ; tarif lu au registre des règles ;
 *     aucun calcul manuel, aucune remise sur place ;
 *  d. liquidation détaillée (enlèvement, gardiennage, autres) avec la fiche et la référence légale montrées à l'usager ;
 *  e. paiement Mobile Money, banque ou carte vers le compte public désigné — AUCUN encaissement par un agent ou un
 *     partenaire (gestionnaires, caissières, pointeurs) ;
 *  f. mainlevée et sortie : quittance à QR appariée, photo de l'état à la sortie, identité de la personne qui retire —
 *     sortie TECHNIQUEMENT IMPOSSIBLE sans quittance appariée (ou décision motivée de mainlevée sans frais dus) ;
 *  g. destination légale (vente, destruction) : décision de l'autorité compétente, preuve de notification (envoyée et
 *     reçue), délai de recours expiré (compte à rebours affiché), double validation hiérarchique — JAMAIS déclenchée par
 *     une IA, un score ou un seuil.
 */
import { extractProofCode, isRuleExecutable, Money, type RuleSheet } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { DAY_MS } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { CentresService } from './centres.js';
import { maskRef, type PhotoInput, type VcDeps } from './common.js';
import type { CtService } from './ct.js';
import {
  ENTRY_PHOTO_SLOTS, FOURRIERE_ALERTE_GARDE_JOURS, RULE_CODES, type CustodyLink, type FeeLine, type FourriereDossier, type FourriereSite, type RemovalDecision,
} from './model.js';

/** Origines refusées pour une décision : une personne décide, jamais un calcul. */
const ORIGINES_AUTOMATIQUES = ['IA', 'SCORE', 'SEUIL', 'ALGORITHME', 'AUTOMATIQUE'];

export class FourriereService {
  readonly sites = new InMemoryRepository<FourriereSite>();
  readonly dossiers = new InMemoryRepository<FourriereDossier>();
  readonly custody = new InMemoryAppendOnlyRepository<CustodyLink>();
  private readonly orderSeq = new Map<string, number>();

  constructor(private readonly d: VcDeps, private readonly ct: CtService, private readonly centres: CentresService) {}

  private get(id: string): FourriereDossier {
    const x = this.dossiers.get(id);
    if (!x) throw notFound('DOSSIER_INCONNU', `Dossier de fourrière inconnu : ${id}`);
    return x;
  }

  /** Maillon de la chaîne de garde : empreinte du maillon précédent incluse (toute altération rompt la chaîne). */
  private link(dossierId: string, by: string, step: string, details: Record<string, unknown>): CustodyLink {
    const prev = this.custody.find((c) => c.dossierId === dossierId).at(-1);
    const seq = (prev?.seq ?? 0) + 1;
    const at = this.d.now();
    const prevHash = prev?.hash ?? '0'.repeat(64);
    const hash = sha256Hex(canonicalJson({ dossierId, seq, at, by, step, details, prevHash }));
    return this.custody.append({ id: `${dossierId}-${seq}`, dossierId, seq, at, by, step, details, prevHash, hash });
  }

  verifyCustody(dossierId: string) {
    const links = this.custody.find((c) => c.dossierId === dossierId);
    let prev = '0'.repeat(64);
    for (const l of links) {
      const h = sha256Hex(canonicalJson({ dossierId: l.dossierId, seq: l.seq, at: l.at, by: l.by, step: l.step, details: l.details, prevHash: l.prevHash }));
      if (l.prevHash !== prev || h !== l.hash) return { intact: false, brokenAt: l.seq, links: links.length };
      prev = l.hash;
    }
    return { intact: true, links: links.length, lastHash: prev };
  }

  // ——— Sites ———

  createSite(user: User, input: { name: string; commune: string; lat: number; lon: number; capacity: number; operatorCentreId?: string }, opts: { demo?: boolean; fixedId?: string } = {}): FourriereSite {
    authorize(user, 'fourriere:site.manage');
    if (input.operatorCentreId) this.centres.assertCanOperate(input.operatorCentreId, 'GARDIENNAGE');
    let objectId: string | undefined;
    try {
      objectId = this.d.ctx.objects.create(user, { category: 'AUTRE', commune: input.commune, quartier: '—', localityRank: 4, lat: input.lat, lon: input.lon, attributes: { nature: 'SITE_FOURRIERE', nom: input.name, capacite: input.capacity, ...(opts.demo ? { exemple: true } : {}) } }).id;
    } catch { /* commune hors référentiel */ }
    const s = this.sites.insert({ id: opts.fixedId ?? this.d.ids.next('FRR', 3), ...(objectId ? { objectId } : {}), ...input, status: 'OUVERT', ...(opts.demo ? { demo: true } : {}) });
    this.d.audit(user, 'fourriere.site.created', 'site_fourriere', s.id, { commune: s.commune, capacity: s.capacity, operatorCentreId: s.operatorCentreId ?? null });
    return s;
  }

  occupancy(siteId: string): number {
    return this.dossiers.find((x) => x.entry?.siteId === siteId && x.status === 'EN_GARDE').length;
  }

  // ——— a. Constat et immobilisation ———

  constat(user: User, input: { plate: string; motifLegal: string; commune: string; etat: string; gps?: { lat: number; lon: number; accuracyM?: number }; photos: PhotoInput[] }, opts: { demo?: boolean } = {}): FourriereDossier {
    authorize(user, 'fourriere:constat');
    const missing = [
      ...(input.plate?.trim() ? [] : ['plaque']), ...(input.motifLegal?.trim() ? [] : ['motif légal']), ...(input.gps ? [] : ['position GPS']),
      ...(input.etat?.trim() ? [] : ['état du véhicule']), ...(input.photos?.length ? [] : ['photos du véhicule et de son état']),
    ];
    if (missing.length) {
      this.d.audit(user, 'fourriere.constat.incomplete', 'dossier_fourriere', this.d.plate(input.plate ?? ''), { missing }, 'DENIED');
      throw unprocessable('DOSSIER_INCOMPLET', `Dossier incomplet : ${missing.join(', ')}. Aucune entrée en fourrière n’est possible.`, { missing });
    }
    const photos = this.d.photos(input.photos, { min: 1, max: 5 });
    const plate = this.d.plate(input.plate);
    const open = this.dossiers.findOne((x) => x.plate === plate && ['CONSTATE', 'ENLEVEMENT_DECIDE', 'EN_GARDE'].includes(x.status));
    if (open) throw conflict('DOSSIER_OUVERT', `Un dossier est déjà ouvert pour cette plaque : ${open.id}.`);
    const v = this.ct.vehicle(plate);
    const x = this.dossiers.insert({
      id: this.d.ids.next('FRD', 6), plate, ...(v?.category ? { category: v.category } : {}), ...(v?.taxpayerId ? { taxpayerId: v.taxpayerId } : {}), ...(v?.objectId ? { objectId: v.objectId } : {}),
      status: 'CONSTATE', constat: { by: user.id, at: this.d.now(), motifLegal: input.motifLegal, gps: input.gps!, commune: input.commune, photos, etat: input.etat },
      corrections: [], ...(opts.demo ? { demo: true } : {}),
    });
    this.link(x.id, user.id, 'CONSTAT', { motifLegal: input.motifLegal, gps: input.gps, photos: photos.map((p) => p.sha256) });
    this.d.audit(user, 'fourriere.constat.recorded', 'dossier_fourriere', x.id, { plate, motifLegal: input.motifLegal, commune: input.commune, photos: photos.length });
    return x;
  }

  /** Décision d'enlèvement : une personne habilitée (autorité compétente), distincte de l'agent du constat. */
  decideRemoval(user: User, id: string, input: { motifLegal: string; legalBasis: string; source: RemovalDecision['source']; origine?: string }): FourriereDossier {
    authorize(user, 'fourriere:decision');
    if (input.origine && ORIGINES_AUTOMATIQUES.includes(input.origine.toUpperCase())) {
      this.d.audit(user, 'fourriere.removal.automatic_refused', 'dossier_fourriere', id, { origine: input.origine }, 'DENIED');
      throw forbidden('DECISION_HUMAINE_REQUISE', 'Un algorithme, un score ou un seuil ne fait que prioriser : l’enlèvement est décidé par l’autorité compétente.');
    }
    const x = this.get(id);
    if (x.status !== 'CONSTATE') throw conflict('DOSSIER_ETAT', `Décision possible sur un dossier constaté (statut ${x.status}).`);
    assertDistinctPerson(user.id, [x.constat.by], 'L’enlèvement est décidé par une personne distincte de l’agent qui a fait le constat.');
    this.assertSource(input.source);
    const decision: RemovalDecision = { id: this.d.ids.next('DEC-ENL', 5), dossierId: x.id, motifLegal: input.motifLegal, legalBasis: input.legalBasis, source: input.source, decidedBy: user.id, decidedRole: user.roles.join(','), decidedAt: this.d.now() };
    const out = this.dossiers.update({ ...x, status: 'ENLEVEMENT_DECIDE', decision });
    this.link(x.id, user.id, 'DECISION_ENLEVEMENT', { decisionId: decision.id, legalBasis: input.legalBasis, source: input.source });
    this.d.audit(user, 'fourriere.removal.decided', 'dossier_fourriere', x.id, { decisionId: decision.id, legalBasis: input.legalBasis, source: input.source, proposedBy: x.constat.by });
    return out;
  }

  /** Décision de stationnement ou de recouvrement citée : elle doit exister et avoir été décidée. */
  private assertSource(src: RemovalDecision['source']): void {
    if (src.kind === 'CONSTAT_STATIONNEMENT') {
      const parking = this.d.ctx.ext['parking'] as { violations?: { get(id: string): { status?: string } | undefined } } | undefined;
      const v = parking?.violations?.get(src.ref);
      // Un constat de stationnement ne fonde un enlèvement que s'il a été RETENU par la régie (décision humaine motivée).
      if (parking?.violations && v?.status !== 'RETENU') throw unprocessable('DECISION_SOURCE_INVALIDE', `Constat de stationnement ${src.ref} inconnu ou non retenu par la régie.`);
    }
    if (src.kind === 'RECOUVREMENT' && !src.ref.trim()) throw unprocessable('DECISION_SOURCE_INVALIDE', 'Référence de la décision de recouvrement requise.');
  }

  // ——— b. Entrée ———

  entry(user: User, id: string, input: { siteId: string; photos: PhotoInput[]; conditionReport: string; inventory: { label: string; quantity: number }[]; contradictoire: { kind: 'PROPRIETAIRE_PRESENT' | 'TEMOIN'; ref: string } }): FourriereDossier {
    authorize(user, 'fourriere:entry');
    const x = this.get(id);
    if (x.status === 'CONSTATE' || !x.decision) {
      this.d.audit(user, 'fourriere.entry.refused', 'dossier_fourriere', x.id, { reason: 'SANS_DECISION' }, 'DENIED');
      throw forbidden('DECISION_ENLEVEMENT_REQUISE', 'Aucun enlèvement ni aucune entrée sans décision de l’autorité compétente enregistrée au préalable.');
    }
    if (x.status !== 'ENLEVEMENT_DECIDE') throw conflict('DOSSIER_ETAT', `Entrée impossible (statut ${x.status}).`);
    const site = this.sites.get(input.siteId);
    if (!site || site.status !== 'OUVERT') throw notFound('SITE_INCONNU', 'Site de fourrière inconnu ou fermé.');
    if (user.roles.includes('R35') && user.entity !== site.operatorCentreId) throw forbidden('HORS_SITE', 'Vous n’opérez que sur le site confié à votre centre.');
    if (site.operatorCentreId) this.centres.assertCanOperate(site.operatorCentreId, 'GARDIENNAGE');
    if (this.occupancy(site.id) >= site.capacity) throw conflict('SITE_COMPLET', `Site ${site.name} complet (${site.capacity} places).`);
    if (!input.conditionReport.trim()) throw unprocessable('DOSSIER_INCOMPLET', 'Rapport d’état requis.');
    const photos = this.d.photos(input.photos, { min: ENTRY_PHOTO_SLOTS.length, max: ENTRY_PHOTO_SLOTS.length, slots: ENTRY_PHOTO_SLOTS, distinctSlots: true });
    const n = (this.orderSeq.get(site.id) ?? 0) + 1;
    this.orderSeq.set(site.id, n);
    const orderNumber = `${site.id}-${this.d.today().slice(0, 4)}-${String(n).padStart(5, '0')}`;
    const out = this.dossiers.update({ ...x, status: 'EN_GARDE', entry: { siteId: site.id, orderNumber, at: this.d.now(), by: user.id, photos, conditionReport: input.conditionReport, inventory: input.inventory, contradictoire: input.contradictoire } });
    this.link(x.id, user.id, 'ENTREE', { siteId: site.id, orderNumber, photos: photos.map((p) => p.sha256), inventory: input.inventory, contradictoire: input.contradictoire.kind });
    this.d.audit(user, 'fourriere.entry.recorded', 'dossier_fourriere', x.id, { siteId: site.id, orderNumber, photos: photos.length, inventory: input.inventory.length });
    return out;
  }

  // ——— c. Gardiennage : compteur de jours (horodatages serveur ; écriture contraire à deux personnes) ———

  private effective(x: FourriereDossier, field: 'entryAt' | 'exitAt'): string | undefined {
    const validated = x.corrections.filter((c) => c.field === field && c.status === 'VALIDEE').at(-1);
    if (validated) return validated.to;
    return field === 'entryAt' ? x.entry?.at : x.exit?.at;
  }

  /** Jours de garde entamés entre l'entrée et la sortie (ou maintenant). Méthode : par défaut — à confirmer par l'acte. */
  days(x: FourriereDossier): number {
    const from = this.effective(x, 'entryAt');
    if (!from) return 0;
    const to = this.effective(x, 'exitAt') ?? this.d.now();
    return Math.max(1, Math.ceil((Date.parse(to) - Date.parse(from)) / DAY_MS));
  }

  proposeCorrection(user: User, id: string, input: { field: 'entryAt' | 'exitAt'; to: string; reason: string }): FourriereDossier {
    authorize(user, 'fourriere:correction.propose');
    const x = this.get(id);
    const from = this.effective(x, input.field);
    if (!from) throw conflict('HORODATAGE_ABSENT', 'Aucun horodatage à corriger.');
    if (Number.isNaN(Date.parse(input.to))) throw unprocessable('DATE_INVALIDE', 'Horodatage invalide.');
    if (x.corrections.some((c) => c.status === 'PROPOSEE')) throw conflict('CORRECTION_EN_ATTENTE', 'Une écriture contraire est déjà en attente.');
    const c = { id: this.d.ids.next('CORR', 5), field: input.field, from, to: new Date(input.to).toISOString(), reason: input.reason, proposedBy: user.id, proposedAt: this.d.now(), status: 'PROPOSEE' as const };
    const out = this.dossiers.update({ ...x, corrections: [...x.corrections, c] });
    this.link(x.id, user.id, 'CORRECTION_PROPOSEE', { correctionId: c.id, field: c.field, from: c.from, to: c.to, reason: c.reason });
    this.d.audit(user, 'fourriere.correction.proposed', 'dossier_fourriere', c.id, { dossierId: x.id, field: c.field, from: c.from, to: c.to, reason: c.reason });
    return out;
  }

  decideCorrection(user: User, id: string, correctionId: string, input: { approve: boolean; motif: string }): FourriereDossier {
    authorize(user, 'fourriere:correction.approve');
    const x = this.get(id);
    const c = x.corrections.find((k) => k.id === correctionId && k.status === 'PROPOSEE');
    if (!c) throw notFound('CORRECTION_INCONNUE', 'Aucune écriture contraire en attente.');
    assertDistinctPerson(user.id, [c.proposedBy], 'Une écriture contraire est validée par une personne distincte de celle qui l’a proposée.');
    const updated = { ...c, status: input.approve ? 'VALIDEE' as const : 'REJETEE' as const, decidedBy: user.id, decidedAt: this.d.now() };
    const out = this.dossiers.update({ ...x, corrections: x.corrections.map((k) => (k.id === c.id ? updated : k)) });
    this.link(x.id, user.id, input.approve ? 'CORRECTION_VALIDEE' : 'CORRECTION_REJETEE', { correctionId: c.id, motif: input.motif });
    this.d.audit(user, input.approve ? 'fourriere.correction.approved' : 'fourriere.correction.rejected', 'dossier_fourriere', c.id, { dossierId: x.id, proposedBy: c.proposedBy, motif: input.motif });
    return out;
  }

  // ——— d. Liquidation détaillée (règle ACTIVE du registre, jamais de montant saisi) ———

  activeRule(code: string): { rule: RuleSheet } | { reason: string } {
    const versions = this.d.ctx.rules.list().filter((r) => r.code === code).sort((a, b) => b.version - a.version);
    if (!versions.length) return { reason: 'Fiche absente du registre.' };
    const rule = versions.find((r) => isRuleExecutable(r, this.d.ctx.clock.now()).ok);
    return rule ? { rule } : { reason: `Aucune version ACTIVE et certifiée (dernière : v${versions[0]!.version} ${versions[0]!.status}) : acte requis, aucun montant.` };
  }

  liquidate(user: User, id: string): FourriereDossier {
    authorize(user, 'fourriere:liquidate');
    const x = this.get(id);
    if (!['EN_GARDE'].includes(x.status) || !x.entry) throw conflict('DOSSIER_ETAT', `Liquidation possible pendant la garde (statut ${x.status}).`);
    if (x.liquidation?.lines.some((l) => l.status === 'LIQUIDEE' && l.obligationId && this.d.ctx.assessment.get(l.obligationId).status !== 'ANNULEE')) {
      throw conflict('DEJA_LIQUIDE', 'Frais déjà liquidés : toute rectification passe par le circuit de réclamation.');
    }
    const days = this.days(x);
    const known: Record<string, string> = { jours: String(days), nombre_jours: String(days), jours_garde: String(days), quantite: '1', nombre: '1' };
    const lineDefs: [FeeLine['code'], string, string][] = [['ENLEVEMENT', 'Frais d’enlèvement', RULE_CODES.enlevement], ['GARDIENNAGE', `Frais de gardiennage (${days} jour(s))`, RULE_CODES.gardiennage]];
    const lines: FeeLine[] = lineDefs.map(([code, label, ruleCode]) => {
      if (!x.taxpayerId || !x.objectId) return { code, label, ruleCode, status: 'PROPRIETAIRE_A_IDENTIFIER', reason: 'Propriétaire ou objet véhicule non rattaché : liquidation après identification.' };
      const a = this.activeRule(ruleCode);
      if ('reason' in a) return { code, label, ruleCode, status: 'ACTE_REQUIS', reason: a.reason };
      const required = this.d.ctx.rules.requiredInputs(a.rule);
      const unknown = required.filter((k) => !(k in known));
      if (unknown.length) return { code, label, ruleCode, status: 'ACTE_REQUIS', reason: `Donnée requise par la fiche non disponible : ${unknown.join(', ')}.` };
      const inputs = Object.fromEntries(required.map((k) => [k, known[k]!]));
      const r = this.d.ctx.assessment.calculate(user, { ruleId: a.rule.id, taxpayerId: x.taxpayerId, objectId: x.objectId, inputs, simulate: false });
      return { code, label, ruleCode, status: 'LIQUIDEE', obligationId: r.obligation!.id, amount: r.obligation!.amount, legalReference: `${a.rule.code} v${a.rule.version} — ${a.rule.articles.join(' ; ')}`, inputs };
    });
    lines.push({ code: 'AUTRES', label: 'Autres frais', ruleCode: '—', status: 'ACTE_REQUIS', reason: 'Aucune autre fiche au registre : rien n’est dû à ce titre.' });
    const out = this.dossiers.update({ ...x, liquidation: { at: this.d.now(), by: user.id, days, lines } });
    this.link(x.id, user.id, 'LIQUIDATION', { days, lines: lines.map((l) => ({ code: l.code, status: l.status, obligationId: l.obligationId ?? null, amount: l.amount ?? null })) });
    this.d.audit(user, 'fourriere.liquidated', 'dossier_fourriere', x.id, { days, lines: lines.map((l) => `${l.code}:${l.status}`) });
    return out;
  }

  // ——— e. Paiement : jamais d'espèces à la fourrière ———

  /** Toute tentative d'encaissement sur place est refusée, journalisée et signalée (aucun agent, aucun partenaire). */
  refuseCash(user: User, id: string, input: { amount?: string; note?: string }) {
    this.d.audit(user, 'fourriere.cash.refused', 'dossier_fourriere', id, { amount: input.amount ?? null, note: input.note ?? null, roles: user.roles }, 'DENIED');
    this.d.ctx.alerts.raise({ type: 'FOURRIERE_ESPECES', severity: 'HIGH', source: 'vehicules-controle', detail: `Tentative d’encaissement en espèces sur le dossier ${id} par ${user.id}.`, context: { dossierId: id }, actor: { kind: 'user', id: user.id, roles: user.roles } });
    throw forbidden('ESPECES_INTERDITES', 'Aucun encaissement à la fourrière : paiement uniquement par monnaie mobile, banque ou carte vers le compte public, sur la référence de paiement de l’obligation.');
  }

  // ——— f. Mainlevée et sortie ———

  mainlevee(user: User, id: string, motif: string): FourriereDossier {
    authorize(user, 'fourriere:mainlevee');
    const x = this.get(id);
    if (x.status !== 'EN_GARDE') throw conflict('DOSSIER_ETAT', `Mainlevée possible pendant la garde (statut ${x.status}).`);
    assertDistinctPerson(user.id, [x.constat.by, x.entry?.by ?? ''], 'La mainlevée motivée est décidée par une personne distincte des agents du constat et de l’entrée.');
    const out = this.dossiers.update({ ...x, mainleveeDecision: { by: user.id, at: this.d.now(), motif, kind: 'DECISION_MOTIVEE' } });
    this.link(x.id, user.id, 'MAINLEVEE_DECIDEE', { motif });
    this.d.audit(user, 'fourriere.mainlevee.decided', 'dossier_fourriere', x.id, { motif });
    return out;
  }

  /** Payé = soldé au rapprochement, ou montant intégralement confirmé par le prestataire (quittance provisoire signée). */
  isPaid(o: { id: string; status: string; amount: { amount: string; currency: string } }): boolean {
    return o.status === 'SOLDEE' || this.d.ctx.payments.paidOn(o.id).compare(Money.fromJSON(o.amount as never)) >= 0;
  }

  /** Obligations dues du dossier (liquidées, non annulées). */
  private dueObligations(x: FourriereDossier) {
    return (x.liquidation?.lines ?? []).filter((l) => l.status === 'LIQUIDEE' && l.obligationId).map((l) => this.d.ctx.assessment.get(l.obligationId!)).filter((o) => o.status !== 'ANNULEE' && !o.supersededBy);
  }

  exit(user: User, id: string, input: { receipt?: string; photos: PhotoInput[]; collector: { pieceType: string; pieceNumber: string; qualite: string } }): FourriereDossier {
    authorize(user, 'fourriere:exit');
    const x = this.get(id);
    if (x.status !== 'EN_GARDE' || !x.entry) throw conflict('DOSSIER_ETAT', `Sortie impossible (statut ${x.status}).`);
    const site = this.sites.get(x.entry.siteId)!;
    if (user.roles.includes('R35') && user.entity !== site.operatorCentreId) throw forbidden('HORS_SITE', 'Vous n’opérez que sur le site confié à votre centre.');
    if (x.contestation?.status === 'EN_COURS') throw conflict('CONTESTATION_EN_COURS', 'Contestation en cours : sortie après décision, ou sur paiement.');
    const due = this.dueObligations(x);
    let basis: 'QUITTANCE_APPARIEE' | 'DECISION_MOTIVEE';
    let receiptNumber: string | undefined;
    const refuse = (code: string, detail: string) => {
      this.d.audit(user, 'fourriere.exit.refused', 'dossier_fourriere', x.id, { code }, 'DENIED');
      this.link(x.id, user.id, 'SORTIE_REFUSEE', { code });
      return conflict(code, detail);
    };
    if (due.length) {
      if (!input.receipt) throw refuse('QUITTANCE_REQUISE', 'Sortie impossible sans quittance appariée : les frais dus doivent être payés par le circuit officiel.');
      const token = input.receipt.trim();
      const r = this.d.ctx.receipts.find(extractProofCode(token));
      if (!r) throw refuse('QUITTANCE_INCONNUE', 'Quittance inconnue.');
      // QR présenté : la signature qu'il porte doit être celle de la quittance (QR recopié ou falsifié refusé).
      const qrSignatureOk = !token.startsWith('MOSOLO1|') || token.split('|')[2] === r.signature;
      if (!qrSignatureOk || !this.d.ctx.receipts.verifySignature(r) || !['PROVISOIRE', 'DEFINITIVE'].includes(r.status)) throw refuse('QUITTANCE_INVALIDE', `Quittance non valable (statut ${r.status}).`);
      if (!due.some((o) => o.id === r.obligationId)) throw refuse('QUITTANCE_NON_APPARIEE', 'Cette quittance ne correspond à aucun frais de ce dossier.');
      // Payé = soldé au rapprochement, ou montant intégralement confirmé par le prestataire (quittance provisoire signée).
      const unpaid = due.filter((o) => !this.isPaid(o));
      if (unpaid.length) throw refuse('FRAIS_NON_SOLDES', `Frais non soldés : ${unpaid.map((o) => o.label).join(', ')}.`);
      basis = 'QUITTANCE_APPARIEE';
      receiptNumber = r.number;
    } else {
      const liquidated = !!x.liquidation;
      if (!x.mainleveeDecision) throw refuse(liquidated ? 'DECISION_MAINLEVEE_REQUISE' : 'LIQUIDATION_REQUISE', liquidated ? 'Aucun frais dû (acte requis ou propriétaire à identifier) : la sortie exige une décision motivée de mainlevée.' : 'Liquidation préalable requise.');
      basis = 'DECISION_MOTIVEE';
    }
    const photos = this.d.photos(input.photos, { min: 1, max: 5 });
    const collector = { pieceType: input.collector.pieceType, pieceHash: sha256Hex(`${input.collector.pieceType}:${input.collector.pieceNumber.toUpperCase()}`), qualite: input.collector.qualite };
    const out = this.dossiers.update({ ...x, status: 'SORTI', exit: { at: this.d.now(), by: user.id, basis, ...(receiptNumber ? { receiptNumber } : {}), photos, collector } });
    this.link(x.id, user.id, 'SORTIE', { basis, receiptNumber: receiptNumber ?? null, photos: photos.map((p) => p.sha256), collectorPieceHash: collector.pieceHash });
    this.d.audit(user, 'fourriere.exit.recorded', 'dossier_fourriere', x.id, { basis, receiptNumber: receiptNumber ?? null, days: this.days({ ...out }) });
    return out;
  }

  // ——— Contestation ———

  contest(user: User, id: string, motif: string): FourriereDossier {
    const x = this.get(id);
    authorize(user, 'fourriere:contest', { ...(x.taxpayerId ? { taxpayerId: x.taxpayerId } : {}) });
    if (x.contestation?.status === 'EN_COURS') throw conflict('CONTESTATION_EN_COURS', 'Contestation déjà en cours.');
    if (!['ENLEVEMENT_DECIDE', 'EN_GARDE', 'DESTINATION_PROPOSEE'].includes(x.status)) throw conflict('DOSSIER_ETAT', `Contestation impossible (statut ${x.status}).`);
    const out = this.dossiers.update({ ...x, contestation: { by: user.id, at: this.d.now(), motif, status: 'EN_COURS' } });
    this.link(x.id, user.id, 'CONTESTATION', { motif });
    this.d.audit(user, 'fourriere.contested', 'dossier_fourriere', x.id, { motif });
    return out;
  }

  decideContest(user: User, id: string, input: { accueillie: boolean; motif: string }): FourriereDossier {
    authorize(user, 'fourriere:contest.decide');
    const x = this.get(id);
    if (x.contestation?.status !== 'EN_COURS') throw conflict('AUCUNE_CONTESTATION', 'Aucune contestation en cours.');
    const contestation = { ...x.contestation, status: input.accueillie ? 'ACCUEILLIE' as const : 'REJETEE' as const, decidedBy: user.id, decidedAt: this.d.now(), decisionMotif: input.motif };
    const out = this.dossiers.update({ ...x, contestation, ...(input.accueillie ? { mainleveeDecision: { by: user.id, at: this.d.now(), motif: input.motif, kind: 'CONTESTATION_ACCUEILLIE' as const } } : {}) });
    this.link(x.id, user.id, input.accueillie ? 'CONTESTATION_ACCUEILLIE' : 'CONTESTATION_REJETEE', { motif: input.motif });
    this.d.audit(user, input.accueillie ? 'fourriere.contest.upheld' : 'fourriere.contest.rejected', 'dossier_fourriere', x.id, { motif: input.motif, contestedBy: x.contestation.by });
    return out;
  }

  // ——— g. Destination légale ———

  proposeDisposal(user: User, id: string, input: { kind: 'VENTE' | 'DESTRUCTION'; authorityDecisionRef: string; legalBasis: string; motif: string; notification: { sentAt: string; receivedAt: string; proofSha256: string }; appealDeadline: string; origine?: string }): FourriereDossier {
    authorize(user, 'fourriere:disposal.propose');
    if (input.origine && ORIGINES_AUTOMATIQUES.includes(input.origine.toUpperCase())) {
      this.d.audit(user, 'fourriere.disposal.automatic_refused', 'dossier_fourriere', id, { origine: input.origine }, 'DENIED');
      throw forbidden('DECISION_HUMAINE_REQUISE', 'Une vente ou une destruction n’est jamais déclenchée par une IA, un score ou un seuil.');
    }
    const x = this.get(id);
    if (x.status !== 'EN_GARDE') throw conflict('DOSSIER_ETAT', `Destination légale possible pour un véhicule en garde (statut ${x.status}).`);
    if (x.contestation?.status === 'EN_COURS') throw conflict('CONTESTATION_EN_COURS', 'Contestation en cours : aucune destination légale.');
    const n = input.notification;
    if (!n.sentAt || !n.receivedAt || !/^[0-9a-f]{64}$/i.test(n.proofSha256)) throw unprocessable('NOTIFICATION_NON_PROUVEE', 'Preuve de notification (envoi et réception, empreinte du justificatif) requise.');
    if (n.receivedAt < n.sentAt) throw unprocessable('NOTIFICATION_DATES', 'Réception antérieure à l’envoi.');
    const today = this.d.today();
    if (input.appealDeadline >= today) {
      const daysLeft = Math.ceil((Date.parse(`${input.appealDeadline}T23:59:59Z`) - Date.parse(this.d.now())) / DAY_MS);
      throw conflict('DELAI_RECOURS_EN_COURS', `Délai de recours non expiré : ${daysLeft} jour(s) restant(s) (jusqu’au ${input.appealDeadline} inclus).`, { appealDeadline: input.appealDeadline, daysLeft });
    }
    const disposal = { kind: input.kind, authorityDecisionRef: input.authorityDecisionRef, legalBasis: input.legalBasis, motif: input.motif, notification: n, appealDeadline: input.appealDeadline, proposedBy: user.id, proposedAt: this.d.now(), validations: [] };
    const out = this.dossiers.update({ ...x, status: 'DESTINATION_PROPOSEE', disposal });
    this.link(x.id, user.id, 'DESTINATION_PROPOSEE', { kind: input.kind, authorityDecisionRef: input.authorityDecisionRef, notificationProof: n.proofSha256 });
    this.d.audit(user, 'fourriere.disposal.proposed', 'dossier_fourriere', x.id, { kind: input.kind, authorityDecisionRef: input.authorityDecisionRef, legalBasis: input.legalBasis });
    return out;
  }

  validateDisposal(user: User, id: string, input: { level: 1 | 2; approve: boolean; motif: string }): FourriereDossier {
    authorize(user, input.level === 1 ? 'fourriere:disposal.validate1' : 'fourriere:disposal.validate2');
    const x = this.get(id);
    const p = x.disposal;
    if (x.status !== 'DESTINATION_PROPOSEE' || !p) throw conflict('DOSSIER_ETAT', 'Aucune destination légale proposée.');
    if (x.contestation?.status === 'EN_COURS') throw conflict('CONTESTATION_EN_COURS', 'Contestation en cours.');
    if (input.level === 2 && !p.validations.some((v) => v.level === 1)) throw conflict('VALIDATION_1_REQUISE', 'La validation hiérarchique de premier niveau précède celle de second niveau.');
    if (p.validations.some((v) => v.level === input.level)) throw conflict('DEJA_VALIDE', 'Niveau déjà validé.');
    assertDistinctPerson(user.id, [p.proposedBy, ...p.validations.map((v) => v.by)], 'Double validation hiérarchique par deux personnes distinctes du proposant.');
    if (!input.approve) {
      const { disposal: _d, ...rest } = x;
      const out = this.dossiers.update({ ...rest, status: 'EN_GARDE' } as FourriereDossier);
      this.link(x.id, user.id, 'DESTINATION_REFUSEE', { level: input.level, motif: input.motif });
      this.d.audit(user, 'fourriere.disposal.rejected', 'dossier_fourriere', x.id, { level: input.level, motif: input.motif, proposedBy: p.proposedBy });
      return out;
    }
    const validations = [...p.validations, { level: input.level, by: user.id, role: user.roles.join(','), at: this.d.now() }];
    const done = validations.length === 2;
    const out = this.dossiers.update({ ...x, status: done ? 'DESTINATION_EXECUTEE' : 'DESTINATION_PROPOSEE', disposal: { ...p, validations, ...(done ? { executedAt: this.d.now(), executedBy: user.id } : {}) } });
    this.link(x.id, user.id, done ? 'DESTINATION_EXECUTEE' : 'DESTINATION_VALIDEE_N1', { level: input.level, motif: input.motif });
    this.d.audit(user, done ? 'fourriere.disposal.executed' : 'fourriere.disposal.validated', 'dossier_fourriere', x.id, { level: input.level, motif: input.motif, proposedBy: p.proposedBy });
    return out;
  }

  // ——— Priorisation (jamais un ordre), alertes, rapprochement, indicateurs ———

  /** Liste priorisée de véhicules à examiner : ne crée aucun dossier et n'ordonne aucun enlèvement. */
  prioritise(user: User) {
    authorize(user, 'fourriere:read');
    const items = this.ct.vehicles.all().map((v) => {
      const st = this.ct.status(v.plate);
      const factors: { label: string; points: number }[] = [];
      if (st.state === 'ECHU') factors.push({ label: 'Contrôle technique échu', points: 40 });
      if (st.state === 'DEFAVORABLE') factors.push({ label: 'Contrôle défavorable', points: 30 });
      if (this.dossiers.find((x) => x.plate === v.plate && x.status === 'SORTI').length) factors.push({ label: 'Antécédent de fourrière', points: 10 });
      return { plate: v.plate, score: factors.reduce((a, f) => a + f.points, 0), factors };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    return { items, decision: 'AUCUNE' as const, notice: 'Priorisation indicative pour l’examen humain : elle n’ordonne aucun enlèvement ; seule l’autorité compétente décide, par décision enregistrée.' };
  }

  runOverdueAlerts(user: User | null) {
    if (user) authorize(user, 'fourriere:alerts.run');
    const overdue = this.dossiers.find((x) => x.status === 'EN_GARDE' && this.days(x) > FOURRIERE_ALERTE_GARDE_JOURS);
    for (const x of overdue) {
      this.d.ctx.alerts.raise({ type: 'FOURRIERE_GARDE_LONGUE', severity: 'MEDIUM', source: 'vehicules-controle', detail: `Véhicule ${x.plate} en garde depuis ${this.days(x)} jours (seuil par défaut ${FOURRIERE_ALERTE_GARDE_JOURS} j, à confirmer). Examen humain : aucune destination légale automatique.`, context: { dossierId: x.id } });
    }
    this.d.audit(user, 'fourriere.alerts.run', 'dossier_fourriere', 'garde', { overdue: overdue.length });
    return { overdue: overdue.map((x) => ({ id: x.id, plate: x.plate, days: this.days(x) })), disposalsCreated: 0 };
  }

  reconciliation() {
    return this.sites.all().map((s) => {
      const ds = this.dossiers.find((x) => x.entry?.siteId === s.id);
      const exits = ds.filter((x) => x.exit);
      const obligations = ds.flatMap((x) => this.dueObligations(x));
      return {
        siteId: s.id, name: s.name, capacity: s.capacity, entries: ds.length, exits: exits.length, inCustody: ds.filter((x) => x.status === 'EN_GARDE' || x.status === 'DESTINATION_PROPOSEE').length,
        disposed: ds.filter((x) => x.status === 'DESTINATION_EXECUTEE').length,
        exitsOnReceipt: exits.filter((x) => x.exit!.basis === 'QUITTANCE_APPARIEE').length, exitsOnDecision: exits.filter((x) => x.exit!.basis === 'DECISION_MOTIVEE').length,
        obligations: obligations.length, obligationsPaid: obligations.filter((o) => this.isPaid(o)).length,
        balanced: ds.length === exits.length + ds.filter((x) => ['EN_GARDE', 'DESTINATION_PROPOSEE', 'DESTINATION_EXECUTEE'].includes(x.status)).length,
      };
    });
  }

  indicators() {
    const all = this.dossiers.all();
    const exited = all.filter((x) => x.exit);
    const durations = exited.map((x) => this.days(x));
    const oblig = all.flatMap((x) => this.dueObligations(x));
    const sum = (list: typeof oblig) => {
      const by = new Map<string, number>();
      for (const o of list) by.set(o.amount.currency, (by.get(o.amount.currency) ?? 0) + Number(o.amount.amount));
      return [...by].map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) }));
    };
    return {
      enFourriere: all.filter((x) => x.status === 'EN_GARDE' || x.status === 'DESTINATION_PROPOSEE').length,
      constatsEnAttente: all.filter((x) => x.status === 'CONSTATE').length,
      enlevementsDecides: all.filter((x) => x.decision).length,
      sorties: exited.length,
      mainlevees: all.filter((x) => x.mainleveeDecision).length,
      dureeMoyenneGardeJours: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
      destinationsExecutees: all.filter((x) => x.status === 'DESTINATION_EXECUTEE').length,
      gardeLongue: all.filter((x) => x.status === 'EN_GARDE' && this.days(x) > FOURRIERE_ALERTE_GARDE_JOURS).length,
      recetteLiquidee: sum(oblig),
      recettePayee: sum(oblig.filter((o) => this.isPaid(o))),
    };
  }

  view(x: FourriereDossier, opts: { owner?: boolean } = {}) {
    const site = x.entry ? this.sites.get(x.entry.siteId) : undefined;
    const days = this.days(x);
    const lines = (x.liquidation?.lines ?? []).map((l) => ({ ...l, ...(l.obligationId ? { obligationStatus: this.d.ctx.assessment.get(l.obligationId).status, payPath: `/v1/obligations/${l.obligationId}/payment-orders` } : {}) }));
    const fiscal = opts.owner && x.taxpayerId
      ? this.d.ctx.assessment.byTaxpayer(x.taxpayerId).filter((o) => ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'].includes(o.status)).map((o) => ({ id: o.id, label: o.label, amount: o.amount, dueDate: o.dueDate, status: o.status }))
      : undefined;
    return {
      ...x, taxpayerRef: maskRef(x.taxpayerId), site: site ? { id: site.id, name: site.name, commune: site.commune } : null, daysInCustody: x.entry ? days : 0, liquidationLines: lines,
      appealCountdown: x.disposal ? { deadline: x.disposal.appealDeadline, daysLeft: Math.ceil((Date.parse(`${x.disposal.appealDeadline}T23:59:59Z`) - Date.parse(this.d.now())) / DAY_MS) } : null,
      custody: this.verifyCustody(x.id), noCash: 'Aucun paiement en espèces : monnaie mobile, banque ou carte vers le compte public uniquement.',
      ...(fiscal ? { situationFiscale: { obligations: fiscal, notice: 'Votre situation fiscale est payable depuis votre téléphone (même référence de paiement, même quittance).' } } : {}),
    };
  }

  list(user: User, filter: { status?: string; plate?: string } = {}) {
    authorize(user, 'fourriere:read');
    return this.dossiers.all()
      .filter((x) => (!filter.status || x.status === filter.status) && (!filter.plate || x.plate === this.d.plate(filter.plate)))
      .filter((x) => !user.roles.includes('R35') || (x.entry && this.sites.get(x.entry.siteId)?.operatorCentreId === user.entity))
      .map((x) => this.view(x));
  }

  getView(user: User, id: string) {
    const x = this.get(id);
    if (user.roles.includes('R30') || user.roles.includes('R31')) {
      authorize(user, 'fourriere:own', { ...(x.taxpayerId ? { taxpayerId: x.taxpayerId } : {}) });
      return this.view(x, { owner: true });
    }
    authorize(user, 'fourriere:read');
    return { ...this.view(x), custodyChain: this.custody.find((c) => c.dossierId === x.id) };
  }

  byTaxpayer(taxpayerId: string) {
    return this.dossiers.find((x) => x.taxpayerId === taxpayerId).map((x) => this.view(x, { owner: true }));
  }
}
