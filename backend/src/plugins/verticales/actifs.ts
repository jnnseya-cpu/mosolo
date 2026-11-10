/**
 * Patrimoine provincial (MOSOLO Assets, modules 48 et 61 — Spécification fonctionnelle, Partie V) :
 * inventaire des actifs → évaluation → appel public ou délibération → suivi des revenus domaniaux.
 *
 * Règle propre : « aucune attribution de gré à gré sans procédure ». Il n'existe AUCUNE route d'attribution directe :
 * un actif n'est attribué qu'au terme d'un appel (public, ou délibération citée), après la date limite (heure du serveur),
 * après l'ouverture des offres scellées par une personne, et par une autre personne qui motive son choix parmi les
 * candidatures reçues. Les candidatures sont les démarches « Manifester un intérêt » de la verticale (offre scellée par
 * empreinte jusqu'à l'ouverture). Les résultats et motifs sont publiés.
 *
 * La redevance domaniale du titulaire est liquidée par le moteur commun sur la règle du registre (clé VX-ACT-REDEVANCE,
 * quatre visas) : aucun montant tant qu'aucune règle ACTIVE n'existe ; aucun taux par défaut. Les revenus domaniaux
 * suivis sont les obligations réelles, leurs paiements confirmés et leurs règlements rapprochés.
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { isCommune } from '../../reference/kinshasa.js';
import { COMMUNE_CENTROIDS } from './catalogue.js';
import { ruleCodeFor, type VerticalesService } from './service.js';

const { always, sameEntity } = GRANTS;
export const ACTIFS_ENTITY = 'MINFIN';

export const PA = {
  read: 'verticales:actifs.read',
  inventory: 'verticales:actifs.inventory',
  evaluate: 'verticales:actifs.evaluate',
  publish: 'verticales:actifs.publish',
  open: 'verticales:actifs.open',
  award: 'verticales:actifs.award',
} as const;

export function registerActifsPolicies(): void {
  definePolicy(PA.read, { R01: always, R02: always, R05: always, R06: sameEntity, R07: sameEntity, R11: sameEntity, R15: always, R22: always, R23: always });
  // Le gestionnaire du patrimoine inventorie ; la validatrice financière (ou le chef de service) évalue ;
  // le chef de service publie l'appel et ouvre les plis ; l'attribution revient au DG ou au ministre (personne distincte).
  definePolicy(PA.inventory, { R11: sameEntity, R07: sameEntity });
  definePolicy(PA.evaluate, { R15: always, R07: sameEntity });
  definePolicy(PA.publish, { R07: sameEntity, R06: sameEntity });
  definePolicy(PA.open, { R07: sameEntity, R06: sameEntity });
  definePolicy(PA.award, { R05: always, R06: sameEntity });
}

export const ASSET_NATURES = ['TERRAIN', 'BATIMENT', 'LOCAL_COMMERCIAL', 'ESPACE_PUBLICITAIRE', 'DROIT_DENOMINATION', 'EQUIPEMENT', 'AUTRE'] as const;
export type AssetNature = (typeof ASSET_NATURES)[number];
export const EVALUATION_METHODS = ['COMPARAISON', 'REVENU', 'COUT_REMPLACEMENT', 'EXPERTISE_EXTERNE'] as const;

export type AssetStatus = 'INVENTORIE' | 'EVALUE' | 'EN_APPEL' | 'ATTRIBUE';

export interface PublicAsset {
  id: string;
  reference: string;
  nature: AssetNature;
  designation: string;
  commune: string;
  quartier: string;
  lat: number;
  lon: number;
  surfaceM2: string | null;
  /** Référence du titre ou de l'acte d'affectation au domaine provincial. */
  titleReference: string;
  status: AssetStatus;
  inventoriedBy: string;
  inventoriedAt: string;
  /** Objet fiscal du titulaire après attribution (redevance liquidée sur cet objet). */
  concessionObjectId?: string;
  demo: boolean;
}

export interface AssetEvaluation {
  id: string;
  assetId: string;
  method: (typeof EVALUATION_METHODS)[number];
  marketValue: MoneyJSON;
  /** Revenu annuel de référence estimé par l'évaluateur (sert de mise à prix, jamais de tarif). */
  annualRevenueEstimate: MoneyJSON;
  reportSha256: string;
  note: string;
  by: string;
  at: string;
}

export type CallProcedure = 'APPEL_PUBLIC' | 'DELIBERATION';
export type CallStatus = 'PUBLIE' | 'PLIS_OUVERTS' | 'ATTRIBUE' | 'INFRUCTUEUX';

export interface CallOffer { caseId: string; taxpayerId: string; offerSha256: string; amount: MoneyJSON | null; receivedAt: string }

export interface AssetCall {
  id: string;
  reference: string;
  assetId: string;
  procedure: CallProcedure;
  /** Délibération citée (procédure DELIBERATION) : organe, numéro, date. */
  deliberationRef: string | null;
  objet: string;
  /** Mise à prix issue de l'évaluation (jamais inventée). */
  reservePrice: MoneyJSON;
  deadline: string;
  status: CallStatus;
  publishedBy: string;
  publishedAt: string;
  opening?: { by: string; at: string; offers: CallOffer[] };
  award?: { caseId: string; taxpayerId: string; amount: MoneyJSON; by: string; at: string; motif: string; concessionObjectId: string };
  unsuccessful?: { by: string; at: string; motif: string };
}

const sumByCurrency = (items: MoneyJSON[]) => {
  const m = new Map<CurrencyCode, Money>();
  for (const x of items) m.set(x.currency, (m.get(x.currency) ?? Money.zero(x.currency)).add(Money.fromJSON(x)));
  return [...m.values()].map((x) => x.toJSON());
};

export class ActifsService {
  readonly assets = new InMemoryRepository<PublicAsset>();
  readonly evaluations = new InMemoryRepository<AssetEvaluation>();
  readonly calls = new InMemoryRepository<AssetCall>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly vx: VerticalesService) {}

  private now() { return this.ctx.clock.now(); }
  private res() { return { entity: ACTIFS_ENTITY }; }

  asset(id: string): PublicAsset {
    const a = this.assets.get(id);
    if (!a) throw notFound('ASSET_NOT_FOUND', `Actif inconnu : ${id}`);
    return a;
  }
  call(id: string): AssetCall {
    const c = this.calls.get(id);
    if (!c) throw notFound('CALL_NOT_FOUND', `Appel inconnu : ${id}`);
    return c;
  }

  // ------------------------------------------------------------------ 1. inventaire

  inventory(user: User, input: { nature: AssetNature; designation: string; commune: string; quartier: string; surfaceM2?: string; titleReference: string; lat?: number; lon?: number }, demo = false): PublicAsset {
    authorize(user, PA.inventory, this.res());
    if (!isCommune(input.commune)) throw unprocessable('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    const dup = this.assets.findOne((a) => a.titleReference.trim().toLowerCase() === input.titleReference.trim().toLowerCase());
    if (dup) throw conflict('ASSET_ALREADY_INVENTORIED', `Titre déjà inventorié : ${dup.reference}.`, { assetId: dup.id });
    const [lat, lon] = input.lat !== undefined && input.lon !== undefined ? [input.lat, input.lon] : COMMUNE_CENTROIDS[input.commune] ?? [-4.325, 15.31];
    const id = this.ids.next('ACT');
    const a = this.assets.insert({
      id, reference: `PAT-${id.slice(4)}`, nature: input.nature, designation: input.designation.trim(), commune: input.commune, quartier: input.quartier.trim(),
      lat, lon, surfaceM2: input.surfaceM2 ?? null, titleReference: input.titleReference.trim(), status: 'INVENTORIE',
      inventoriedBy: user.id, inventoriedAt: this.now().toISOString(), demo,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'actifs.asset.inventoried', resourceType: 'public_asset', resourceId: id, details: { nature: a.nature, commune: a.commune, titleReference: a.titleReference } });
    return a;
  }

  // ------------------------------------------------------------------ 2. évaluation

  evaluate(user: User, assetId: string, input: { method: AssetEvaluation['method']; marketValue: MoneyJSON; annualRevenueEstimate: MoneyJSON; reportSha256: string; note: string }): AssetEvaluation {
    authorize(user, PA.evaluate, this.res());
    const a = this.asset(assetId);
    if (a.status === 'EN_APPEL' || a.status === 'ATTRIBUE') throw conflict('ASSET_LOCKED', 'Actif en appel ou attribué : l’évaluation est figée.');
    // Celui qui inventorie n'évalue pas (séparation des tâches).
    assertDistinctPerson(user.id, [a.inventoriedBy], 'L’évaluation est faite par une personne distincte de celle qui a inventorié l’actif.');
    for (const m of [input.marketValue, input.annualRevenueEstimate]) {
      const mm = Money.fromJSON(m);
      if (mm.isZero() || mm.isNegative()) throw unprocessable('INVALID_AMOUNT', 'Valeurs strictement positives attendues.');
    }
    const ev = this.evaluations.insert({ id: this.ids.next('EVA'), assetId, ...input, note: input.note.trim(), by: user.id, at: this.now().toISOString() });
    this.assets.update({ ...a, status: 'EVALUE' });
    this.ctx.audit.append({ actor: actorOf(user), action: 'actifs.asset.evaluated', resourceType: 'public_asset', resourceId: assetId, details: { evaluationId: ev.id, method: ev.method, reportSha256: ev.reportSha256 } });
    return ev;
  }

  private lastEvaluation(assetId: string) {
    return this.evaluations.find((e) => e.assetId === assetId).sort((x, y) => x.at.localeCompare(y.at)).at(-1);
  }

  // ------------------------------------------------------------------ 3. appel public ou délibération

  publishCall(user: User, input: { assetId: string; procedure: CallProcedure; deliberationRef?: string; objet: string; deadline: string }): AssetCall {
    authorize(user, PA.publish, this.res());
    const a = this.asset(input.assetId);
    if (a.status !== 'EVALUE') throw unprocessable('ASSET_NOT_EVALUATED', 'Un appel suppose un actif inventorié ET évalué (mise à prix issue de l’évaluation).');
    if (input.procedure === 'DELIBERATION' && !input.deliberationRef?.trim()) throw unprocessable('DELIBERATION_REQUIRED', 'Procédure par délibération : la délibération (organe, numéro, date) doit être citée.');
    const deadline = new Date(input.deadline);
    if (Number.isNaN(deadline.getTime()) || deadline <= this.now()) throw unprocessable('INVALID_DEADLINE', 'La date limite doit être postérieure à l’heure du serveur.');
    const ev = this.lastEvaluation(a.id)!;
    const id = this.ids.next('APL');
    const call = this.calls.insert({
      id, reference: `APL-${this.now().getUTCFullYear()}-${id.slice(4)}`, assetId: a.id, procedure: input.procedure, deliberationRef: input.deliberationRef?.trim() || null,
      objet: input.objet.trim(), reservePrice: ev.annualRevenueEstimate, deadline: deadline.toISOString(), status: 'PUBLIE', publishedBy: user.id, publishedAt: this.now().toISOString(),
    });
    this.assets.update({ ...a, status: 'EN_APPEL' });
    this.ctx.audit.append({ actor: actorOf(user), action: 'actifs.call.published', resourceType: 'asset_call', resourceId: id, details: { assetId: a.id, procedure: call.procedure, deadline: call.deadline } });
    return call;
  }

  /** Candidatures reçues : démarches MANIFESTATION_INTERET de la verticale citant la référence de l'appel. */
  candidatures(call: AssetCall) {
    return this.vx.cases.find((c) => c.vertical === 'actifs' && c.type === 'MANIFESTATION_INTERET' && (c.details.appel ?? '').trim().toUpperCase() === call.reference.toUpperCase());
  }

  /** Ouverture des plis : après la date limite (heure du serveur), par une personne habilitée ; montants lus dans les offres. */
  openOffers(user: User, callId: string, input: { offers: { caseId: string; amount: MoneyJSON }[] }): AssetCall {
    authorize(user, PA.open, this.res());
    const call = this.call(callId);
    if (call.status !== 'PUBLIE') throw conflict('CALL_NOT_OPEN', `Appel au statut ${call.status}.`);
    if (this.now() < new Date(call.deadline)) throw unprocessable('DEADLINE_NOT_REACHED', 'Les offres restent scellées jusqu’à la date limite (heure du serveur).');
    const received = this.candidatures(call).filter((c) => new Date(c.createdAt) <= new Date(call.deadline));
    const offers: CallOffer[] = received.map((c) => {
      const read = input.offers.find((o) => o.caseId === c.id);
      if (read && read.amount.currency !== call.reservePrice.currency) throw unprocessable('CURRENCY_MISMATCH', 'L’offre doit être exprimée dans la devise de la mise à prix.');
      const sealed = c.documents[0]?.sha256 ?? '';
      return { caseId: c.id, taxpayerId: c.taxpayerId, offerSha256: sealed, amount: read?.amount ?? null, receivedAt: c.createdAt };
    });
    const unknown = input.offers.filter((o) => !received.some((c) => c.id === o.caseId));
    if (unknown.length) throw unprocessable('UNKNOWN_OFFER', `Offres hors candidatures reçues dans le délai : ${unknown.map((u) => u.caseId).join(', ')}.`);
    const next = this.calls.update({ ...call, status: 'PLIS_OUVERTS', opening: { by: user.id, at: this.now().toISOString(), offers } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'actifs.call.opened', resourceType: 'asset_call', resourceId: callId, details: { offers: offers.length } });
    return next;
  }

  /**
   * Attribution motivée par une personne distincte de celle qui a ouvert les plis et publié l'appel, parmi les offres
   * ouvertes, au moins égale à la mise à prix. Crée l'objet fiscal du titulaire (concession) au compte unique.
   */
  award(user: User, callId: string, input: { caseId: string; motif: string }): AssetCall {
    authorize(user, PA.award, this.res());
    const call = this.call(callId);
    if (call.status !== 'PLIS_OUVERTS' || !call.opening) throw conflict('OFFERS_NOT_OPENED', 'Attribution impossible avant l’ouverture publique des offres : aucune attribution de gré à gré.');
    try {
      assertDistinctPerson(user.id, [call.opening.by, call.publishedBy], 'La personne qui attribue est distincte de celles qui ont publié l’appel et ouvert les plis.');
    } catch (e) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'actifs.call.award.refused', resourceType: 'asset_call', resourceId: callId, outcome: 'DENIED', details: { reason: 'SEPARATION_OF_DUTIES' } });
      throw e;
    }
    const offer = call.opening.offers.find((o) => o.caseId === input.caseId);
    if (!offer) throw forbidden('NOT_A_CANDIDATE', 'Seul un candidat ayant déposé une offre dans le délai peut être retenu : aucune attribution de gré à gré.');
    if (!offer.amount) throw unprocessable('OFFER_NOT_READ', 'Offre non lue à l’ouverture : elle ne peut pas être retenue.');
    if (Money.fromJSON(offer.amount).compare(Money.fromJSON(call.reservePrice)) < 0) throw unprocessable('BELOW_RESERVE', 'Offre inférieure à la mise à prix issue de l’évaluation.');
    const a = this.asset(call.assetId);
    const owner = this.ctx.users.all().find((u) => u.roles.includes('R30') && u.taxpayerId === offer.taxpayerId);
    const obj = this.ctx.objects.create(owner ?? user, {
      taxpayerId: offer.taxpayerId, category: 'AUTRE', commune: a.commune, quartier: a.quartier, localityRank: 2, lat: a.lat, lon: a.lon,
      attributes: {
        verticale: 'actifs', objectType: 'CONCESSION_ACTIF', nom: a.designation, actif: a.reference, appel: call.reference,
        redevance_annuelle: offer.amount.amount, devise: offer.amount.currency, ...(a.demo ? { demo: true } : {}),
      },
    });
    const at = this.now().toISOString();
    const next = this.calls.update({ ...call, status: 'ATTRIBUE', award: { caseId: offer.caseId, taxpayerId: offer.taxpayerId, amount: offer.amount, by: user.id, at, motif: input.motif.trim(), concessionObjectId: obj.id } });
    this.assets.update({ ...a, status: 'ATTRIBUE', concessionObjectId: obj.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'actifs.call.awarded', resourceType: 'asset_call', resourceId: callId, details: { caseId: offer.caseId, concessionObjectId: obj.id, motif: input.motif.trim() } });
    this.ctx.comms.publish('approval.approved', this.recipients(offer.taxpayerId), { reference: call.reference }, { entity: ACTIFS_ENTITY });
    return next;
  }

  /** Appel infructueux (aucune offre recevable) : décision motivée ; l'actif redevient disponible pour un nouvel appel. */
  declareUnsuccessful(user: User, callId: string, motif: string): AssetCall {
    authorize(user, PA.award, this.res());
    const call = this.call(callId);
    if (call.status !== 'PLIS_OUVERTS') throw conflict('OFFERS_NOT_OPENED', 'Constat d’infructuosité après l’ouverture des plis seulement.');
    assertDistinctPerson(user.id, [call.opening!.by], 'La personne qui constate l’infructuosité est distincte de celle qui a ouvert les plis.');
    const next = this.calls.update({ ...call, status: 'INFRUCTUEUX', unsuccessful: { by: user.id, at: this.now().toISOString(), motif: motif.trim() } });
    this.assets.update({ ...this.asset(call.assetId), status: 'EVALUE' });
    this.ctx.audit.append({ actor: actorOf(user), action: 'actifs.call.unsuccessful', resourceType: 'asset_call', resourceId: callId, details: { motif: motif.trim() } });
    return next;
  }

  private recipients(taxpayerId: string) {
    const tp = this.ctx.taxpayers.taxpayers.get(taxpayerId);
    return tp ? [taxpayerRecipient(tp)] : [];
  }

  // ------------------------------------------------------------------ 4. suivi des revenus domaniaux

  /** Revenus domaniaux : obligations réelles des concessions, paiements confirmés, règlements rapprochés. */
  revenues(user: User) {
    authorize(user, PA.read, this.res());
    const code = ruleCodeFor('actifs')!;
    const active = this.vx.activeRuleFor('actifs');
    const rows = this.assets.all().sort((a, b) => a.reference.localeCompare(b.reference)).map((a) => {
      const obligations = a.concessionObjectId ? this.ctx.assessment.obligations.find((o) => o.objectId === a.concessionObjectId && o.status !== 'ANNULEE') : [];
      const liquidated: MoneyJSON[] = [];
      const paid: MoneyJSON[] = [];
      const reconciled: MoneyJSON[] = [];
      for (const o of obligations) {
        liquidated.push(o.amount);
        for (const p of this.ctx.payments.byObligation(o.id)) {
          if (['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status)) paid.push(p.amount);
          if (p.status === 'RAPPROCHE') reconciled.push(p.amount);
        }
      }
      const call = this.calls.find((c) => c.assetId === a.id).sort((x, y) => x.publishedAt.localeCompare(y.publishedAt)).at(-1);
      return {
        assetId: a.id, reference: a.reference, designation: a.designation, nature: a.nature, commune: a.commune, status: a.status, demo: a.demo,
        evaluation: this.lastEvaluation(a.id) ?? null, call: call ? { id: call.id, reference: call.reference, procedure: call.procedure, status: call.status } : null,
        concessionObjectId: a.concessionObjectId ?? null, obligations: obligations.length,
        liquidated: sumByCurrency(liquidated), paid: sumByCurrency(paid), reconciled: sumByCurrency(reconciled),
      };
    });
    return {
      rule: active ? { code: active.code, version: active.version, status: 'ACTIVE', demo: active.demo === true } : { code, status: this.vx.ruleByCode(code)?.status ?? 'ACTE_REQUIS', note: 'Aucune règle ACTIVE : aucune redevance ne peut être liquidée.' },
      items: rows,
      totals: {
        assets: rows.length, attributed: rows.filter((r) => r.status === 'ATTRIBUE').length,
        liquidated: sumByCurrency(rows.flatMap((r) => r.liquidated)), paid: sumByCurrency(rows.flatMap((r) => r.paid)), reconciled: sumByCurrency(rows.flatMap((r) => r.reconciled)),
      },
      notice: 'Revenus domaniaux comptés sur les paiements confirmés et les règlements rapprochés du compte public ; aucune attribution de gré à gré.',
    };
  }

  overview(user: User) {
    authorize(user, PA.read, this.res());
    return {
      assets: this.assets.all().map((a) => ({ ...a, evaluation: this.lastEvaluation(a.id) ?? null })),
      calls: this.calls.all().map((c) => ({ ...c, candidatures: this.candidatures(c).length })),
    };
  }

  /** Résultats publics : procédure, date limite, nombre d'offres, attributaire et motif (aucune offre avant l'ouverture). */
  publicCalls() {
    return this.calls.all().map((c) => {
      const a = this.asset(c.assetId);
      const winner = c.award ? this.ctx.taxpayers.taxpayers.get(c.award.taxpayerId)?.fullName ?? 'Attributaire' : null;
      return {
        reference: c.reference, actif: a.designation, commune: a.commune, procedure: c.procedure, deliberationRef: c.deliberationRef, deadline: c.deadline, status: c.status,
        reservePrice: c.reservePrice, offers: c.opening ? c.opening.offers.length : null,
        result: c.award ? { attributaire: winner, amount: c.award.amount, motif: c.award.motif, at: c.award.at } : c.unsuccessful ? { infructueux: true, motif: c.unsuccessful.motif, at: c.unsuccessful.at } : null,
      };
    });
  }
}
