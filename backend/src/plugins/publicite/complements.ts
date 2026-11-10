/**
 * KIN PUB CONTROL — compléments du § 11B.2 et du § 11B.5 (sur le même inventaire, les mêmes autorisations et les mêmes
 * constats que `service.ts`) :
 *  - couches de carte : zones saturées, zones à contrôler, espaces disponibles, interventions réalisées, signalements,
 *    propositions d'analyse d'image ;
 *  - renouvellement d'autorisation en ligne (reprise de la fiche et des pièces, nouvelle instruction) ;
 *  - contrats publicitaires de l'exploitant et suivi des échéances (contrats et autorisations) ;
 *  - portail citoyen de signalement (lié à la ligne d'intégrité pour les demandes d'espèces et faux contrôleurs) ;
 *  - suivi du pilote en sept étapes ;
 *  - analyse d'image : PROPOSITIONS seulement, vérifiées par une personne ; jamais de dossier ni de sanction automatique.
 *
 * Aucun seuil inventé : une zone « saturée » est une DÉCISION motivée de l'autorité ; la densité par commune est
 * affichée comme information ; les « zones à contrôler » cumulent des faits (non déclarés, expirés, signalements,
 * propositions confirmées) sans seuil.
 */
import { haversineM } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { isCommune } from '../../reference/kinshasa.js';
import type { IntegriteService } from '../integrite/service.js';
import { actorOf, DGTK } from '../parking/support.js';
import { EXPIRY_NOTICE_DAYS, type AdEvidencePhoto, type Piece, type PubliciteService } from './service.js';

export interface AdZone {
  id: string;
  kind: 'SATUREE' | 'A_CONTROLER';
  label: string;
  commune: string;
  lat: number;
  lon: number;
  radiusM: number;
  motif: string;
  status: 'ACTIVE' | 'CLOSE';
  decidedBy: string;
  decidedAt: string;
  closed?: { by: string; at: string; motif: string };
}

export interface AdSpace {
  id: string;
  label: string;
  commune: string;
  lat: number;
  lon: number;
  widthM: string;
  heightM: string;
  status: 'DISPONIBLE' | 'RESERVE' | 'ATTRIBUE' | 'RETIRE';
  notes: string;
  history: { by: string; at: string; status: AdSpace['status']; note: string }[];
}

export interface AdContract {
  id: string;
  deviceId: string;
  ownerTaxpayerId: string;
  advertiser: string;
  reference: string;
  from: string;
  to: string;
  sha256: string;
  status: 'ACTIF' | 'RESILIE';
  createdBy: string;
  createdAt: string;
  termination?: { by: string; at: string; motif: string };
}

export const CITIZEN_REPORT_KINDS = ['SUPPORT_SANS_PLAQUE', 'SUPPORT_DANGEREUX', 'AFFICHAGE_SAUVAGE', 'AUTRE', 'DEMANDE_ESPECES', 'FAUX_CONTROLEUR'] as const;
export type CitizenReportKind = (typeof CITIZEN_REPORT_KINDS)[number];
/** Catégories relevant de la ligne d'intégrité (identité protégée, code de suivi). */
const INTEGRITY_KINDS: Partial<Record<CitizenReportKind, 'DEMANDE_ESPECES' | 'FAUX_AGENT'>> = { DEMANDE_ESPECES: 'DEMANDE_ESPECES', FAUX_CONTROLEUR: 'FAUX_AGENT' };

export interface AdCitizenReport {
  id: string;
  kind: CitizenReportKind;
  description: string;
  commune: string | null;
  lat: number;
  lon: number;
  photoSha256?: string;
  qrToken?: string;
  deviceId?: string;
  status: 'RECU' | 'A_INSPECTER' | 'CLASSE' | 'DOUBLON' | 'TRANSMIS_INTEGRITE';
  integrityReference?: string;
  receivedAt: string;
  triage?: { by: string; at: string; outcome: 'A_INSPECTER' | 'CLASSE' | 'DOUBLON'; motif: string };
}

export const PILOT_STEPS = [
  'Sélection de communes ou axes à forte concentration',
  'Recensement numérique des supports',
  'Enregistrement des autorisations existantes',
  'Formation et accréditation des contrôleurs',
  'Déploiement de l’application',
  'Évaluation',
  'Extension progressive',
] as const;

export interface PilotStep {
  id: string;
  rank: number;
  label: string;
  status: 'A_FAIRE' | 'EN_COURS' | 'TERMINEE';
  notes: { by: string; at: string; status: PilotStep['status']; note: string; evidenceSha256?: string }[];
}

export interface AiProposal {
  id: string;
  photoId: string;
  requestedBy: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  kind: 'SUPPORT_NON_ENREGISTRE_PROBABLE' | 'SUPPORT_ENREGISTRE_PROCHE' | 'POSITION_INSUFFISANTE';
  candidates: { deviceId: string; reference: string; distanceM: number }[];
  analyser: string;
  explanation: string;
  status: 'A_VERIFIER' | 'CONFIRMEE' | 'REJETEE';
  createdAt: string;
  verification?: { by: string; at: string; confirm: boolean; motif: string };
}

/** Analyseur d'image : interface (un analyseur fondé sur un modèle pourra s'y brancher) ; il PROPOSE, il ne décide pas. */
export interface AdImageAnalyser {
  readonly name: string;
  detect(photo: AdEvidencePhoto): { label: string; confidence: 'NON_EVALUEE' | 'FAIBLE' | 'MOYENNE' | 'ELEVEE' }[];
}

/** Analyseur de démonstration, déterministe : il signale un support probable sur chaque photo, sans confiance évaluée. */
export const DEMO_ANALYSER: AdImageAnalyser = {
  name: 'Analyseur de démonstration déterministe (non entraîné)',
  detect: () => [{ label: 'Support publicitaire probable', confidence: 'NON_EVALUEE' }],
};

export class PubComplements {
  readonly zones = new InMemoryRepository<AdZone>();
  readonly spaces = new InMemoryRepository<AdSpace>();
  readonly contracts = new InMemoryRepository<AdContract>();
  readonly citizenReports = new InMemoryRepository<AdCitizenReport>();
  readonly pilot = new InMemoryRepository<PilotStep>();
  readonly aiProposals = new InMemoryRepository<AiProposal>();
  private readonly ids = new IdGenerator();
  analyser: AdImageAnalyser = DEMO_ANALYSER;

  constructor(private readonly ctx: AppContext, private readonly pub: PubliciteService) {
    PILOT_STEPS.forEach((label, i) => {
      const id = `PILOTE-PUB-${i + 1}`;
      if (!this.pilot.get(id)) this.pilot.insert({ id, rank: i + 1, label, status: 'A_FAIRE', notes: [] });
    });
  }

  private now() { return this.ctx.clock.now(); }

  // ------------------------------------------------------------------ couches de carte (§ 11B.2)

  layers(user: User) {
    authorize(user, 'publicite:inventory', { entity: DGTK });
    const views = this.pub.devices.all().map((d) => ({ d, st: this.pub.deviceStatus(d) }));
    const communes = [...new Set([...views.map((v) => v.d.commune), ...this.citizenReports.all().map((r) => r.commune).filter((c): c is string => !!c)])].sort();
    const pendingReports = this.citizenReports.find((r) => r.status === 'RECU' || r.status === 'A_INSPECTER');
    const confirmedAi = this.aiProposals.find((p) => p.status === 'CONFIRMEE');
    const toControl = communes.map((commune) => {
      const vs = views.filter((v) => v.d.commune === commune);
      const facts = {
        undeclared: vs.filter((v) => v.st.status === 'NON_DECLARE').length, expired: vs.filter((v) => v.st.status === 'EXPIRE').length,
        openCases: vs.filter((v) => v.st.openCase).length, citizenReports: pendingReports.filter((r) => r.commune === commune).length,
        aiConfirmed: confirmedAi.filter((p) => this.communeAt(p.lat, p.lon) === commune).length,
      };
      return { commune, ...facts, total: Object.values(facts).reduce((a, b) => a + b, 0) };
    }).filter((z) => z.total > 0).sort((a, b) => b.total - a.total);
    return {
      supports: this.pub.map(user),
      density: communes.map((commune) => ({ commune, activeSupports: views.filter((v) => v.d.commune === commune && v.st.status !== 'RETIRE').length })),
      saturatedZones: this.zones.find((z) => z.kind === 'SATUREE' && z.status === 'ACTIVE'),
      zonesToControl: { designated: this.zones.find((z) => z.kind === 'A_CONTROLER' && z.status === 'ACTIVE'), computed: toControl },
      availableSpaces: this.spaces.find((s) => s.status === 'DISPONIBLE'),
      interventions: this.pub.inspections.all().map((i) => ({ id: i.id, reference: i.reference, lat: i.lat, lon: i.lon, finding: i.finding, observedAt: i.observedAt, caseId: i.caseId })),
      citizenReports: pendingReports.map((r) => ({ id: r.id, kind: r.kind, lat: r.lat, lon: r.lon, commune: r.commune, status: r.status, receivedAt: r.receivedAt })),
      aiProposals: this.aiProposals.find((p) => p.status === 'A_VERIFIER').map((p) => ({ id: p.id, kind: p.kind, lat: p.lat, lon: p.lon })),
      notice: 'Zones saturées : décisions motivées de l’autorité. Zones à contrôler : faits constatés cumulés, sans seuil ni sanction.',
    };
  }

  private communeAt(lat: number, lon: number): string | null {
    let best: { c: string; d: number } | null = null;
    for (const d of this.pub.devices.all()) {
      const m = haversineM({ lat, lon }, { lat: d.lat, lon: d.lon });
      if (!best || m < best.d) best = { c: d.commune, d: m };
    }
    return best?.c ?? null;
  }

  declareZone(user: User, input: { kind: AdZone['kind']; label: string; commune: string; lat: number; lon: number; radiusM: number; motif: string }) {
    authorize(user, 'publicite:zone.manage', { entity: DGTK });
    if (!isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    const z = this.zones.insert({ id: this.ids.next('ZPUB'), ...input, status: 'ACTIVE', decidedBy: user.id, decidedAt: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.zone.declared', resourceType: 'ad_zone', resourceId: z.id, details: { kind: z.kind, commune: z.commune, motif: z.motif } });
    return z;
  }

  closeZone(user: User, id: string, motif: string) {
    authorize(user, 'publicite:zone.manage', { entity: DGTK });
    const z = this.zones.get(id);
    if (!z || z.status !== 'ACTIVE') throw notFound('ZONE_NOT_FOUND', 'Zone inconnue ou déjà close.');
    const saved = this.zones.update({ ...z, status: 'CLOSE', closed: { by: user.id, at: this.now().toISOString(), motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.zone.closed', resourceType: 'ad_zone', resourceId: id, details: { motif } });
    return saved;
  }

  registerSpace(user: User, input: { label: string; commune: string; lat: number; lon: number; widthM: string; heightM: string; notes: string }) {
    authorize(user, 'publicite:space.manage', { entity: DGTK });
    if (!isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    const at = this.now().toISOString();
    const s = this.spaces.insert({ id: this.ids.next('EPUB'), ...input, status: 'DISPONIBLE', history: [{ by: user.id, at, status: 'DISPONIBLE', note: 'Espace inscrit' }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.space.registered', resourceType: 'ad_space', resourceId: s.id, details: { commune: s.commune } });
    return s;
  }

  setSpaceStatus(user: User, id: string, status: AdSpace['status'], note: string) {
    authorize(user, 'publicite:space.manage', { entity: DGTK });
    const s = this.spaces.get(id);
    if (!s) throw notFound('SPACE_NOT_FOUND', `Espace inconnu : ${id}`);
    const saved = this.spaces.update({ ...s, status, history: [...s.history, { by: user.id, at: this.now().toISOString(), status, note }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.space.status_changed', resourceType: 'ad_space', resourceId: id, details: { from: s.status, to: status, note } });
    return saved;
  }

  // ------------------------------------------------------------------ renouvellement en ligne (§ 11B.5)

  renew(user: User, authorizationId: string, input: { periodFrom?: string; periodTo: string; pieces: Omit<Piece, 'addedAt'>[] }) {
    const prev = this.pub.requests.get(authorizationId) ?? this.pub.requests.findOne((r) => r.reference === authorizationId);
    if (!prev) throw notFound('AD_REQUEST_NOT_FOUND', `Autorisation inconnue : ${authorizationId}`);
    if (prev.status !== 'ACCORDEE') throw unprocessable('NOT_RENEWABLE', 'Seule une autorisation accordée se renouvelle ; sinon, déposez une nouvelle demande.');
    const nextDay = kinshasaDate(new Date(new Date(`${prev.periodTo}T12:00:00Z`).getTime() + DAY_MS));
    const today = kinshasaDate(this.now());
    const periodFrom = input.periodFrom ?? (nextDay > today ? nextDay : today);
    // Reprise de la fiche : pièces de la demande précédente (par empreinte), complétées des pièces nouvelles.
    const known = new Set(input.pieces.map((p) => p.sha256));
    const pieces = [...input.pieces, ...prev.pieces.filter((p) => !known.has(p.sha256)).map(({ kind, name, sha256 }) => ({ kind, name, sha256 }))];
    const view = this.pub.submitRequest(user, { deviceId: prev.deviceId, periodFrom, periodTo: input.periodTo, pieces });
    const created = this.pub.requests.get(view.id)!;
    this.pub.requests.update({ ...created, renewsId: prev.id, history: [...created.history, { at: this.now().toISOString(), by: user.id, action: 'RENOUVELLEMENT', note: `Renouvellement de ${prev.reference}` }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.authorization.renewal_requested', resourceType: 'ad_authorization', resourceId: view.id, details: { renews: prev.id, periodFrom, periodTo: input.periodTo } });
    return this.pub.requestView(this.pub.requests.get(view.id)!);
  }

  // ------------------------------------------------------------------ contrats publicitaires et échéances (§ 11B.5)

  addContract(user: User, input: { deviceId: string; advertiser: string; reference: string; from: string; to: string; sha256: string }) {
    const d = this.pub.getDevice(input.deviceId);
    if (!d.ownerTaxpayerId) throw unprocessable('DEVICE_OWNER_UNKNOWN', 'Exploitant non identifié.');
    authorize(user, 'publicite:device.declare', { taxpayerId: d.ownerTaxpayerId });
    if (input.to <= input.from) throw badRequest('INVALID_PERIOD', 'La fin du contrat doit suivre son début.');
    if (this.contracts.findOne((c) => c.deviceId === d.id && c.reference === input.reference)) throw conflict('CONTRACT_EXISTS', 'Contrat déjà enregistré pour ce support.');
    const c = this.contracts.insert({ id: this.ids.next('CPUB'), ...input, ownerTaxpayerId: d.ownerTaxpayerId, status: 'ACTIF', createdBy: user.id, createdAt: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.contract.registered', resourceType: 'ad_contract', resourceId: c.id, details: { deviceId: d.id, from: c.from, to: c.to, sha256: c.sha256 } });
    return c;
  }

  terminateContract(user: User, id: string, motif: string) {
    const c = this.contracts.get(id);
    if (!c) throw notFound('CONTRACT_NOT_FOUND', `Contrat inconnu : ${id}`);
    authorize(user, 'publicite:device.declare', { taxpayerId: c.ownerTaxpayerId });
    if (c.status !== 'ACTIF') throw conflict('CONTRACT_CLOSED', 'Contrat déjà résilié.');
    const saved = this.contracts.update({ ...c, status: 'RESILIE', termination: { by: user.id, at: this.now().toISOString(), motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.contract.terminated', resourceType: 'ad_contract', resourceId: id, details: { motif } });
    return saved;
  }

  /** Suivi des échéances : contrats et autorisations, avec le même préavis que les rappels (EXPIRY_NOTICE_DAYS). */
  expiries(user: User) {
    const own = user.taxpayerId;
    const agent = !own;
    if (agent) authorize(user, 'publicite:inventory', { entity: DGTK });
    else authorize(user, 'publicite:device.read', { taxpayerId: own });
    const today = kinshasaDate(this.now());
    const horizon = kinshasaDate(new Date(this.now().getTime() + EXPIRY_NOTICE_DAYS * DAY_MS));
    const days = (to: string) => Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY_MS);
    const deviceOk = (ownerId: string | null) => agent || ownerId === own;
    const contracts = this.contracts.find((c) => c.status === 'ACTIF' && deviceOk(c.ownerTaxpayerId)).map((c) => {
      const auth = this.pub.currentAuthorization(this.pub.getDevice(c.deviceId));
      return {
        kind: 'CONTRAT' as const, id: c.id, reference: c.reference, deviceId: c.deviceId, advertiser: c.advertiser, until: c.to, daysLeft: days(c.to),
        expiringSoon: c.to >= today && c.to <= horizon, expired: c.to < today,
        beyondAuthorization: !auth || auth.status !== 'ACCORDEE' || auth.periodTo < c.to,
      };
    });
    const auths = this.pub.requests.find((r) => r.status === 'ACCORDEE' && deviceOk(r.taxpayerId)).map((r) => ({
      kind: 'AUTORISATION' as const, id: r.id, reference: r.reference, deviceId: r.deviceId, until: r.periodTo, daysLeft: days(r.periodTo),
      expiringSoon: r.periodTo >= today && r.periodTo <= horizon, expired: r.periodTo < today,
      renewalPending: this.pub.requests.find((x) => x.renewsId === r.id && ['DEPOSEE', 'COMPLEMENT_DEMANDE', 'PROPOSEE'].includes(x.status)).length > 0,
    }));
    return { noticeDays: EXPIRY_NOTICE_DAYS, items: [...auths, ...contracts].sort((a, b) => a.until.localeCompare(b.until)) };
  }

  myContracts(user: User) {
    const own = user.taxpayerId;
    if (!own) return [];
    authorize(user, 'publicite:device.read', { taxpayerId: own });
    return this.contracts.find((c) => c.ownerTaxpayerId === own);
  }

  // ------------------------------------------------------------------ portail citoyen de signalement (§ 11B.5)

  citizenReport(input: { kind: CitizenReportKind; description: string; lat: number; lon: number; commune?: string; photoSha256?: string; qrToken?: string }) {
    if (input.commune && !isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    const device = input.qrToken ? this.pub.devices.findOne((d) => d.qrToken === input.qrToken) : undefined;
    const at = this.now().toISOString();
    const integrityCategory = INTEGRITY_KINDS[input.kind];
    let integrity: { reference: string; trackingCode: string } | undefined;
    if (integrityCategory) {
      const integ = this.ctx.ext.integrite as IntegriteService | undefined;
      if (!integ) throw unprocessable('INTEGRITY_LINE_UNAVAILABLE', 'Ligne d’intégrité indisponible : utilisez /signaler.');
      const r = integ.submit({
        category: integrityCategory, description: `[Publicité] ${input.description}`, ...(input.commune ? { commune: input.commune } : {}), anonymous: true,
        ...(integrityCategory === 'FAUX_AGENT' ? { target: { kind: 'AGENT' as const } } : {}),
        ...(input.photoSha256 ? { evidence: [{ sha256: input.photoSha256, label: 'Photo du signalant' }] } : {}),
      }, 'WEB', 'public');
      integrity = { reference: r.reference, trackingCode: r.trackingCode };
    }
    const rep = this.citizenReports.insert({
      id: this.ids.next('SPUB'), kind: input.kind, description: input.description.trim(), commune: input.commune ?? device?.commune ?? null, lat: input.lat, lon: input.lon,
      ...(input.photoSha256 ? { photoSha256: input.photoSha256 } : {}), ...(input.qrToken ? { qrToken: input.qrToken } : {}), ...(device ? { deviceId: device.id } : {}),
      status: integrity ? 'TRANSMIS_INTEGRITE' : 'RECU', ...(integrity ? { integrityReference: integrity.reference } : {}), receivedAt: at,
    });
    this.ctx.audit.append({ actor: { kind: 'system', id: 'portail-citoyen-publicite' }, action: 'publicite.citizen_report.received', resourceType: 'ad_citizen_report', resourceId: rep.id, details: { kind: rep.kind, commune: rep.commune, integrity: integrity?.reference ?? null } });
    return {
      reference: rep.id, status: rep.status,
      ...(integrity ? { integrity: { reference: integrity.reference, trackingCode: integrity.trackingCode, message: 'Transmis à la ligne d’intégrité : conservez ce code de suivi, il ne sera plus affiché.' } } : {}),
      message: 'Signalement reçu : un inspecteur accrédité vérifiera sur place. Aucune sanction n’est prononcée sur la seule foi d’un signalement.',
    };
  }

  listCitizenReports(user: User, status?: string) {
    authorize(user, 'publicite:inventory', { entity: DGTK });
    return this.citizenReports.find((r) => !status || r.status === status).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  triageReport(user: User, id: string, input: { outcome: 'A_INSPECTER' | 'CLASSE' | 'DOUBLON'; motif: string }) {
    const r = this.citizenReports.get(id);
    if (!r) throw notFound('REPORT_NOT_FOUND', `Signalement inconnu : ${id}`);
    authorize(user, 'publicite:report.triage', { entity: DGTK, communes: r.commune ? [r.commune] : [] });
    if (r.status !== 'RECU' && r.status !== 'A_INSPECTER') throw conflict('REPORT_CLOSED', `Signalement au statut ${r.status}.`);
    const saved = this.citizenReports.update({ ...r, status: input.outcome, triage: { by: user.id, at: this.now().toISOString(), ...input } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.citizen_report.triaged', resourceType: 'ad_citizen_report', resourceId: id, details: { outcome: input.outcome, motif: input.motif } });
    return saved;
  }

  // ------------------------------------------------------------------ pilote en sept étapes (§ 11B.5)

  pilotView(user: User) {
    authorize(user, 'publicite:indicators', { entity: DGTK });
    const measures: Record<number, string> = {
      2: `${this.pub.devices.count()} support(s) recensé(s)`,
      3: `${this.pub.requests.find((r) => r.status === 'ACCORDEE').length} autorisation(s) enregistrée(s)`,
      4: `${this.pub.accreditations.find((a) => a.status === 'ACTIVE').length} contrôleur(s) accrédité(s)`,
      5: `${this.pub.inspections.count()} inspection(s) réalisée(s)`,
    };
    return this.pilot.all().sort((a, b) => a.rank - b.rank).map((s) => ({ ...s, measure: measures[s.rank] ?? null }));
  }

  updatePilotStep(user: User, rank: number, input: { status: PilotStep['status']; note: string; evidenceSha256?: string }) {
    authorize(user, 'publicite:pilot.manage', { entity: DGTK });
    const s = this.pilot.get(`PILOTE-PUB-${rank}`);
    if (!s) throw notFound('PILOT_STEP_NOT_FOUND', `Étape inconnue : ${rank}`);
    const saved = this.pilot.update({ ...s, status: input.status, notes: [...s.notes, { by: user.id, at: this.now().toISOString(), ...input }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.pilot.step_updated', resourceType: 'ad_pilot_step', resourceId: s.id, details: { from: s.status, to: input.status } });
    return saved;
  }

  // ------------------------------------------------------------------ analyse d'image : propositions vérifiées par une personne

  analysePhoto(user: User, photoId: string): AiProposal {
    const photo = this.pub.photos.get(photoId);
    if (!photo) throw notFound('PHOTO_NOT_FOUND', `Photo inconnue : ${photoId}`);
    authorize(user, 'publicite:ia.analyse', { entity: DGTK, communes: [this.communeAt(photo.lat, photo.lon) ?? ''] });
    const existing = this.aiProposals.findOne((p) => p.photoId === photoId);
    if (existing) return existing;
    const detections = this.analyser.detect(photo);
    let kind: AiProposal['kind'];
    let candidates: AiProposal['candidates'] = [];
    // Rapprochement avec l'inventaire dans le rayon de PRÉCISION de la photo elle-même (aucun rayon inventé).
    if (photo.accuracyM === null || photo.gpsSource !== 'GPS') kind = 'POSITION_INSUFFISANTE';
    else {
      candidates = this.pub.devices.all()
        .map((d) => ({ deviceId: d.id, reference: d.reference, distanceM: Math.round(haversineM({ lat: photo.lat, lon: photo.lon }, { lat: d.lat, lon: d.lon })) }))
        .filter((c) => c.distanceM <= photo.accuracyM!).sort((a, b) => a.distanceM - b.distanceM);
      kind = candidates.length ? 'SUPPORT_ENREGISTRE_PROCHE' : 'SUPPORT_NON_ENREGISTRE_PROBABLE';
    }
    const p = this.aiProposals.insert({
      id: this.ids.next('IAPUB'), photoId, requestedBy: user.id, lat: photo.lat, lon: photo.lon, accuracyM: photo.accuracyM, kind, candidates, analyser: this.analyser.name,
      explanation: `${detections.map((d) => `${d.label} (confiance : ${d.confidence.toLowerCase().replace('_', ' ')})`).join(' ; ')}. ${kind === 'POSITION_INSUFFISANTE' ? 'Position trop imprécise pour rapprocher l’inventaire.' : kind === 'SUPPORT_ENREGISTRE_PROCHE' ? `${candidates.length} support(s) enregistré(s) dans le rayon de précision de la photo.` : 'Aucun support enregistré dans le rayon de précision de la photo.'} Proposition à vérifier par une personne : ni dossier, ni sanction.`,
      status: 'A_VERIFIER', createdAt: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.ai.proposal.created', resourceType: 'ad_ai_proposal', resourceId: p.id, details: { photoId, kind, analyser: p.analyser } });
    return p;
  }

  verifyProposal(user: User, id: string, input: { confirm: boolean; motif: string }) {
    const p = this.aiProposals.get(id);
    if (!p) throw notFound('PROPOSAL_NOT_FOUND', `Proposition inconnue : ${id}`);
    authorize(user, 'publicite:ia.verify', { entity: DGTK, communes: [this.communeAt(p.lat, p.lon) ?? ''] });
    if (p.status !== 'A_VERIFIER') throw conflict('PROPOSAL_CLOSED', 'Proposition déjà vérifiée.');
    const saved = this.aiProposals.update({ ...p, status: input.confirm ? 'CONFIRMEE' : 'REJETEE', verification: { by: user.id, at: this.now().toISOString(), ...input } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.ai.proposal.verified', resourceType: 'ad_ai_proposal', resourceId: id, details: { confirm: input.confirm, motif: input.motif } });
    return saved;
  }

  listProposals(user: User) {
    authorize(user, 'publicite:inventory', { entity: DGTK });
    return this.aiProposals.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
