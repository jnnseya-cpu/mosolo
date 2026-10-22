/**
 * Interfaces RFCK ↔ MOSOLO (dix flux), séquence d'intégration en sept étapes, reprise des registres, chiffres publiés
 * par la RFCK, fiche de l'entité RFCK et enrôlement dans les centres.
 *
 * Chaque flux est derrière une porte « convention requise » (même garde que les protocoles de données : convention
 * signée enregistrée par une personne, conformité au Code du numérique vérifiée par le délégué à la protection des
 * données — une AUTRE personne). Le connecteur de production n'existe pas encore : seul l'adaptateur BAC À SABLE répond,
 * et chaque flux porte la mention « À RACCORDER — convention requise ».
 */
import { randomInt } from 'node:crypto';
import type { User } from '../../core/auth.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { CentresService } from './centres.js';
import { addDays, type VcDeps } from './common.js';
import type { CtService } from './ct.js';
import type { DomaineService } from './domaine.js';
import type { FourriereService } from './fourriere.js';
import {
  ANALYTIQUE_HISTORIQUE_SEMAINES, INTEGRATION_STEPS, INTERFACE_FLOWS, REPRISE_ECHANTILLON, RFCK, RFCK_PUBLISHED_FIGURES, RULE_CODES, VEHICLE_CATEGORIES, type FlowCode, type StepCode,
  type VehicleCategory,
} from './model.js';
import type { ScanService } from './scan.js';

// ─────────────────────────────── Connecteur ───────────────────────────────

export interface RfckMessage { flow: FlowCode; direction: 'ENVOI' | 'RECEPTION'; payload: unknown }
export interface RfckConnector {
  readonly id: string;
  readonly mode: 'BAC_A_SABLE' | 'PRODUCTION';
  readonly label: string;
  send(msg: RfckMessage): { accepted: boolean; remoteRef: string };
  /** Compteurs du registre distant (rapprochement quotidien). */
  counters(flow: FlowCode): { records: number; sha256: string };
}

/** Adaptateur bac à sable : écho déterministe, aucune donnée ne sort de la plateforme. */
export class SandboxRfckConnector implements RfckConnector {
  readonly id = 'rfck-bac-a-sable';
  readonly mode = 'BAC_A_SABLE' as const;
  readonly label = 'RFCK — bac à sable (À RACCORDER — convention requise)';
  private readonly store = new Map<FlowCode, unknown[]>();
  send(msg: RfckMessage) {
    const list = this.store.get(msg.flow) ?? [];
    list.push(msg.payload);
    this.store.set(msg.flow, list);
    return { accepted: true, remoteRef: `SBX-${msg.flow}-${list.length}` };
  }
  counters(flow: FlowCode) {
    const list = this.store.get(flow) ?? [];
    return { records: list.length, sha256: sha256Hex(canonicalJson(list)) };
  }
}

// ─────────────────────────────── Registres ───────────────────────────────

export interface FlowConvention {
  id: string; flow: FlowCode; reference: string; signedOn: string; signatories: string; documentSha256: string; recordedBy: string; recordedAt: string;
  compliance?: { conclusion: 'CONFORME' | 'NON_CONFORME'; note: string; by: string; at: string };
  status: 'CONFORMITE_A_VERIFIER' | 'ACTIVE' | 'NON_CONFORME';
  exemple?: boolean;
}
export interface FlowExchange { id: string; flow: FlowCode; direction: 'ENVOI' | 'RECEPTION'; at: string; by: string; records: number; sha256: string; remoteRef: string; connector: string }
export interface RepriseBatch {
  id: string; source: string; records: { plate: string; category: VehicleCategory }[]; importedBy: string; importedAt: string; sample: string[];
  control?: { by: string; at: string; conforming: number; checked: number; conclusion: 'ACCEPTE' | 'REJETE'; note: string };
  status: 'A_CONTROLER' | 'ACCEPTE' | 'REJETE';
}
export interface FigureDecision { code: string; decision: 'CONFIRME' | 'RETIRE'; motif: string; source: string; by: string; at: string }
export interface StepValidation { step: StepCode; by: string; at: string; motif: string }
export interface CashAttestation { by: string; at: string; motif: string; reference: string }
export interface EntityContacts { adresse: string; telephone: string; courriel: string; updatedBy?: string; updatedAt?: string }
export interface Enrolment { id: string; centreId: string; taxpayerId: string; plate?: string; codeHash: string; status: 'CODE_ENVOYE' | 'TELEPHONE_VERIFIE'; by: string; at: string; attempts: number }

export class RaccordementService {
  connector: RfckConnector = new SandboxRfckConnector();
  readonly conventions = new InMemoryRepository<FlowConvention>();
  readonly exchanges = new InMemoryAppendOnlyRepository<FlowExchange>();
  readonly reprises = new InMemoryRepository<RepriseBatch>();
  readonly figureDecisions = new InMemoryRepository<FigureDecision & { id: string }>();
  readonly stepValidations = new InMemoryRepository<StepValidation & { id: string }>();
  cashAttestation: CashAttestation | null = null;
  contacts: EntityContacts = { adresse: '', telephone: '', courriel: '' };
  readonly enrolments = new InMemoryRepository<Enrolment>();
  /** Générateur du code de vérification du téléphone (remplaçable en test). */
  codeGenerator: () => string = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

  constructor(
    private readonly d: VcDeps, private readonly ct: CtService, private readonly fourriere: FourriereService, private readonly centres: CentresService,
    private readonly domaine: DomaineService, private readonly scan: ScanService,
  ) {}

  // ——— Conventions (porte de chaque flux) ———

  recordConvention(user: User, input: { flow: FlowCode; reference: string; signedOn: string; signatories: string; documentSha256: string }, opts: { exemple?: boolean } = {}) {
    authorize(user, 'rfck:convention.record');
    if (!INTERFACE_FLOWS.some((f) => f.code === input.flow)) throw notFound('FLUX_INCONNU', `Flux inconnu : ${input.flow}`);
    if (!/^[0-9a-f]{64}$/i.test(input.documentSha256)) throw unprocessable('EMPREINTE_INVALIDE', 'Empreinte SHA-256 de la convention signée requise.');
    if (this.conventions.findOne((c) => c.flow === input.flow && c.status !== 'NON_CONFORME')) throw conflict('CONVENTION_EXISTANTE', 'Une convention est déjà enregistrée pour ce flux.');
    const c = this.conventions.insert({ id: this.d.ids.next('CONV-RFCK', 3), ...input, recordedBy: user.id, recordedAt: this.d.now(), status: 'CONFORMITE_A_VERIFIER', ...(opts.exemple ? { exemple: true } : {}) });
    this.d.audit(user, 'rfck.convention.recorded', 'convention_rfck', c.id, { flow: c.flow, reference: c.reference });
    return c;
  }

  recordCompliance(user: User, id: string, input: { conclusion: 'CONFORME' | 'NON_CONFORME'; note: string }) {
    authorize(user, 'rfck:convention.compliance');
    const c = this.conventions.get(id);
    if (!c) throw notFound('CONVENTION_INCONNUE', `Convention inconnue : ${id}`);
    assertDistinctPerson(user.id, [c.recordedBy], 'La conformité est vérifiée par une autre personne que celle qui a enregistré la convention.');
    const out = this.conventions.update({ ...c, compliance: { ...input, by: user.id, at: this.d.now() }, status: input.conclusion === 'CONFORME' ? 'ACTIVE' : 'NON_CONFORME' });
    this.d.audit(user, 'rfck.convention.compliance', 'convention_rfck', c.id, { conclusion: input.conclusion, recordedBy: c.recordedBy });
    return out;
  }

  flowActive(flow: FlowCode): FlowConvention | undefined {
    return this.conventions.findOne((c) => c.flow === flow && c.status === 'ACTIVE');
  }

  /** Échange sur un flux (bac à sable) : refusé sans convention active. */
  exchange(user: User, flow: FlowCode, input: { direction: 'ENVOI' | 'RECEPTION'; payload: unknown[] }) {
    authorize(user, 'rfck:flow.exchange');
    if (!INTERFACE_FLOWS.some((f) => f.code === flow)) throw notFound('FLUX_INCONNU', `Flux inconnu : ${flow}`);
    if (!this.flowActive(flow)) {
      this.d.audit(user, 'rfck.flow.refused', 'flux_rfck', flow, { reason: 'CONVENTION_REQUISE' }, 'DENIED');
      throw forbidden('CONVENTION_REQUISE', `Flux « ${flow} » : À RACCORDER — convention requise (signée et déclarée conforme par une seconde personne).`);
    }
    const r = this.connector.send({ flow, direction: input.direction, payload: input.payload });
    const ex = this.exchanges.append({ id: this.d.ids.next('ECH-RFCK', 6), flow, direction: input.direction, at: this.d.now(), by: user.id, records: input.payload.length, sha256: sha256Hex(canonicalJson(input.payload)), remoteRef: r.remoteRef, connector: this.connector.id });
    this.d.audit(user, 'rfck.flow.exchanged', 'flux_rfck', ex.id, { flow, direction: input.direction, records: ex.records, sha256: ex.sha256, connector: this.connector.id });
    return ex;
  }

  /** Rapprochement quotidien du registre des véhicules (compteurs locaux vs distants). */
  reconcileRegistry(user: User) {
    authorize(user, 'rfck:read');
    const local = this.ct.vehicles.count();
    const remote = this.connector.counters('REGISTRE_VEHICULES');
    const sent = this.exchanges.find((e) => e.flow === 'REGISTRE_VEHICULES').reduce((a, e) => a + e.records, 0);
    const out = { at: this.d.now(), local, remoteRecords: remote.records, exchangedRecords: sent, remoteSha256: remote.sha256, connector: this.connector.label, ecart: remote.records - sent };
    this.d.audit(user, 'rfck.registry.reconciled', 'flux_rfck', 'REGISTRE_VEHICULES', out);
    return out;
  }

  flowsView() {
    return INTERFACE_FLOWS.map((f) => {
      const c = this.conventions.find((x) => x.flow === f.code).at(-1);
      const ex = this.exchanges.find((e) => e.flow === f.code);
      return {
        ...f, convention: c ?? null, status: c?.status === 'ACTIVE' ? 'CONVENTION_ACTIVE' : 'A_RACCORDER', statusLabel: c?.status === 'ACTIVE' ? `Convention active (${this.connector.mode === 'BAC_A_SABLE' ? 'bac à sable' : 'production'})` : 'À RACCORDER — convention requise',
        exchanges: ex.length, lastExchangeAt: ex.at(-1)?.at ?? null, connector: this.connector.label,
      };
    });
  }

  // ——— Reprise des registres ———

  importReprise(user: User, input: { source: string; records: { plate: string; category: VehicleCategory }[] }) {
    authorize(user, 'rfck:reprise.import');
    if (!input.records.length) throw unprocessable('LOT_VIDE', 'Lot vide.');
    const bad = input.records.filter((r) => !(VEHICLE_CATEGORIES as readonly string[]).includes(r.category));
    if (bad.length) throw unprocessable('CATEGORIE_INCONNUE', `${bad.length} enregistrement(s) de catégorie inconnue.`);
    const records = input.records.map((r) => ({ plate: this.d.plate(r.plate), category: r.category }));
    // Échantillon déterministe (empreinte) : non choisi par l'importateur.
    const ranked = records.map((r) => ({ r, k: sha256Hex(`${r.plate}|${this.d.now()}`) })).sort((a, b) => a.k.localeCompare(b.k));
    const sample = ranked.slice(0, Math.min(REPRISE_ECHANTILLON, records.length)).map((x) => x.r.plate);
    const b = this.reprises.insert({ id: this.d.ids.next('REP-RFCK', 4), source: input.source, records, importedBy: user.id, importedAt: this.d.now(), sample, status: 'A_CONTROLER' });
    this.d.audit(user, 'rfck.reprise.imported', 'reprise_rfck', b.id, { source: input.source, records: records.length, sample });
    return b;
  }

  controlReprise(user: User, id: string, input: { conforming: number; note: string }) {
    authorize(user, 'rfck:reprise.control');
    const b = this.reprises.get(id);
    if (!b) throw notFound('LOT_INCONNU', `Lot inconnu : ${id}`);
    if (b.status !== 'A_CONTROLER') throw conflict('LOT_DEJA_CONTROLE', 'Lot déjà contrôlé.');
    assertDistinctPerson(user.id, [b.importedBy], 'Le contrôle par échantillon est fait par une personne distincte de l’importateur.');
    if (input.conforming < 0 || input.conforming > b.sample.length) throw unprocessable('ECHANTILLON', `Nombre conforme entre 0 et ${b.sample.length}.`);
    const accepted = input.conforming === b.sample.length;
    const out = this.reprises.update({ ...b, status: accepted ? 'ACCEPTE' : 'REJETE', control: { by: user.id, at: this.d.now(), conforming: input.conforming, checked: b.sample.length, conclusion: accepted ? 'ACCEPTE' : 'REJETE', note: input.note } });
    if (accepted) for (const r of b.records) this.ct.upsertVehicle({ plate: r.plate, category: r.category, source: 'REGISTRE_RFCK', ...(this.ct.vehicle(r.plate)?.taxpayerId ? { taxpayerId: this.ct.vehicle(r.plate)!.taxpayerId! } : {}) });
    this.d.audit(user, accepted ? 'rfck.reprise.accepted' : 'rfck.reprise.rejected', 'reprise_rfck', id, { conforming: input.conforming, checked: b.sample.length, importedBy: b.importedBy });
    return out;
  }

  // ——— Chiffres publiés par la RFCK (À VÉRIFIER, jamais une base de référence) ———

  decideFigure(user: User, code: string, input: { decision: 'CONFIRME' | 'RETIRE'; motif: string; source: string }) {
    authorize(user, 'rfck:figures.decide');
    if (!RFCK_PUBLISHED_FIGURES.some((f) => f.code === code)) throw notFound('CHIFFRE_INCONNU', `Chiffre inconnu : ${code}`);
    if (this.figureDecisions.findOne((f) => f.code === code)) throw conflict('DEJA_DECIDE', 'Chiffre déjà confirmé ou retiré.');
    const f = this.figureDecisions.insert({ id: `FIG-${code}`, code, ...input, by: user.id, at: this.d.now() });
    this.d.audit(user, 'rfck.figure.decided', 'chiffre_publie_rfck', code, { ...input });
    return f;
  }

  figuresView() {
    return RFCK_PUBLISHED_FIGURES.map((f) => {
      const dec = this.figureDecisions.findOne((x) => x.code === f.code);
      return { ...f, decision: dec ?? null, status: dec ? dec.decision : f.status, usage: 'Source publiée conservée pour mémoire : jamais une base de référence ni un objectif.' };
    });
  }

  // ——— Séquence d'intégration (7 étapes, conditions de passage) ———

  private conditionsOf(step: StepCode): boolean[] {
    switch (step) {
      case 'CONVENTION': return [this.conventions.find((c) => c.status === 'ACTIVE').length > 0];
      case 'DOMAINE_OFFICIEL': return [this.domaine.domain.status === 'VALIDE'];
      case 'REPRISE_REGISTRES': return [this.reprises.find((r) => r.status === 'ACCEPTE').length > 0, RFCK_PUBLISHED_FIGURES.every((f) => this.figureDecisions.findOne((x) => x.code === f.code))];
      case 'AFFICHAGE_UNIFIE': return [true, this.scan.scans.count() > 0];
      case 'PAIEMENT_ELECTRONIQUE': return ['rule' in this.fourriere.activeRule(RULE_CODES.gardiennage), this.fourriere.dossiers.find((x) => x.exit?.basis === 'QUITTANCE_APPARIEE').length > 0];
      case 'FERMETURE_ESPECES': return [!!this.cashAttestation];
      case 'ANALYTIQUE': {
        const first = this.ct.activePvs().map((p) => p.endedAt).sort()[0];
        return [!!first && first.slice(0, 10) <= addDays(this.d.today(), -7 * ANALYTIQUE_HISTORIQUE_SEMAINES)];
      }
    }
  }

  stepsView() {
    let previousPassed = true;
    return INTEGRATION_STEPS.map((s, i) => {
      const met = this.conditionsOf(s.code);
      const validation = this.stepValidations.findOne((v) => v.step === s.code) ?? null;
      const allMet = met.every(Boolean);
      const status = validation ? 'FRANCHIE' : allMet && previousPassed ? 'PRETE_A_VALIDER' : previousPassed ? 'CONDITIONS_NON_REMPLIES' : 'EN_ATTENTE_ETAPE_PRECEDENTE';
      previousPassed = !!validation;
      return { rank: i + 1, ...s, conditions: s.conditions.map((label, k) => ({ label, met: !!met[k] })), status, validation };
    });
  }

  validateStep(user: User, step: StepCode, motif: string) {
    authorize(user, 'rfck:step.validate');
    const v = this.stepsView().find((s) => s.code === step);
    if (!v) throw notFound('ETAPE_INCONNUE', `Étape inconnue : ${step}`);
    if (v.status !== 'PRETE_A_VALIDER') throw conflict('ETAPE_NON_FRANCHISSABLE', `Étape « ${v.label} » : ${v.status === 'FRANCHIE' ? 'déjà franchie' : v.status === 'EN_ATTENTE_ETAPE_PRECEDENTE' ? 'l’étape précédente doit être franchie' : 'conditions de passage non remplies'}.`);
    const out = this.stepValidations.insert({ id: `ETAPE-${step}`, step, by: user.id, at: this.d.now(), motif });
    this.d.audit(user, 'rfck.step.validated', 'integration_rfck', step, { motif });
    return out;
  }

  attestCashClosure(user: User, input: { motif: string; reference: string }) {
    authorize(user, 'rfck:cash.attest');
    this.cashAttestation = { by: user.id, at: this.d.now(), ...input };
    this.d.audit(user, 'rfck.cash_closure.attested', 'integration_rfck', 'FERMETURE_ESPECES', input);
    return this.cashAttestation;
  }

  // ——— Fiche de l'entité (contacts modifiables par l'administrateur seulement ; aucun contact semé) ———

  updateContacts(user: User, input: Partial<Pick<EntityContacts, 'adresse' | 'telephone' | 'courriel'>>) {
    authorize(user, 'rfck:entity.contacts');
    this.contacts = { ...this.contacts, ...input, updatedBy: user.id, updatedAt: this.d.now() };
    this.d.audit(user, 'rfck.entity.contacts_updated', 'entite', RFCK.id, { fields: Object.keys(input) });
    return this.contacts;
  }

  // ——— Enrôlement dans les centres (compte unique, téléphone vérifié) ———

  startEnrolment(user: User, centreId: string, input: { phone: string; fullName?: string; plate?: string }) {
    authorize(user, 'centres:enrol');
    this.centres.assertMember(user, centreId);
    this.centres.assertCanOperate(centreId, 'ENROLEMENT');
    const phone = input.phone.replace(/[\s-]/g, '');
    // Compte unique : le numéro retrouve le compte existant (compte fusionné ⇒ compte conservé) ; le nom n'est
    // demandé que pour une première inscription.
    const existing = this.d.ctx.taxpayers.findByPhone(phone);
    if (!existing && !input.fullName) throw badRequest('FULL_NAME_REQUIRED', 'Nom complet requis pour une première inscription.');
    const tp = existing ?? this.d.ctx.taxpayers.register({ phone, fullName: input.fullName!, language: 'fr', situation: 'other', kind: 'PERSONNE_PHYSIQUE' });
    const code = this.codeGenerator();
    const e = this.enrolments.insert({ id: this.d.ids.next('ENR-CTR', 5), centreId, taxpayerId: tp.id, ...(input.plate ? { plate: this.d.plate(input.plate) } : {}), codeHash: sha256Hex(`enrol|${code}`), status: 'CODE_ENVOYE', by: user.id, at: this.d.now(), attempts: 0 });
    this.d.ctx.comms.publish('auth.otp_code', [taxpayerRecipient(tp)], { code }, { entity: RFCK.id });
    this.d.audit(user, 'centres.enrolment.started', 'enrolement_centre', e.id, { centreId, existing: !!existing });
    return { id: e.id, status: e.status, existingAccount: !!existing, notice: 'Code envoyé par SMS au titulaire : il le communique lui-même à l’opérateur du centre.' };
  }

  completeEnrolment(user: User, id: string, code: string) {
    authorize(user, 'centres:enrol');
    const e = this.enrolments.get(id);
    if (!e) throw notFound('ENROLEMENT_INCONNU', `Enrôlement inconnu : ${id}`);
    this.centres.assertMember(user, e.centreId);
    if (e.status !== 'CODE_ENVOYE') throw conflict('ENROLEMENT_TERMINE', 'Enrôlement déjà terminé.');
    if (e.attempts >= 3) throw forbidden('TROP_DE_TENTATIVES', 'Trop de tentatives : recommencez l’enrôlement.');
    if (sha256Hex(`enrol|${code}`) !== e.codeHash) {
      this.enrolments.update({ ...e, attempts: e.attempts + 1 });
      throw unprocessable('CODE_INCORRECT', 'Code incorrect.');
    }
    this.d.ctx.taxpayers.markPhoneVerified(e.taxpayerId);
    const out = this.enrolments.update({ ...e, status: 'TELEPHONE_VERIFIE' });
    if (e.plate) {
      const v = this.ct.vehicle(e.plate);
      if (v && !v.taxpayerId) this.ct.upsertVehicle({ plate: v.plate, category: v.category, taxpayerId: e.taxpayerId, source: v.source, ...(v.objectId ? { objectId: v.objectId } : {}), ...(v.commune ? { commune: v.commune } : {}) });
    }
    this.d.audit(user, 'centres.enrolment.completed', 'enrolement_centre', e.id, { taxpayerId: e.taxpayerId });
    return { id: out.id, status: out.status, taxpayerId: e.taxpayerId };
  }
}
