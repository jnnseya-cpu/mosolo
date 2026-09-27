/**
 * Scan unique au contrôle (chapitre 18) : plaque, QR de la vignette FISCALE ou QR de la vignette TECHNIQUE ⇒ une seule
 * vue hiérarchique, construite PAR-DESSUS les contrôles existants (moteur de titres pour la vignette, la taxe de
 * circulation et l'autorisation de transport ; quitus fiscal ; contrôle technique ; fourrière). Il ne crée pas de
 * contrôle parallèle : il relit les mêmes registres.
 *
 * - Affichage seulement : jamais de sanction. La décision de l'agent est enregistrée avec son identité, sa position et
 *   l'horodatage serveur.
 * - La vignette fiscale et la vignette technique sont DEUX lignes distinctes, jamais agrégées en un statut unique.
 * - Mode courtoisie : bandeau affiché ; aucun constat de vignette n'est créé.
 * - Hors ligne : paquet minimal (empreintes de plaques, états) chargé en début de mission, avec sa fraîcheur.
 */
import type { User } from '../../core/auth.js';
import { sha256Hex } from '../../core/crypto.js';
import { conflict, forbidden, notFound } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { TitresService } from '../titres/service.js';
import type { Credential } from '../titres/model.js';
import { maskRef, type VcDeps } from './common.js';
import type { CentresService } from './centres.js';
import type { CtService } from './ct.js';
import type { DomaineService } from './domaine.js';
import type { FourriereService } from './fourriere.js';
import { CATEGORY_LABELS, type VehicleCategory } from './model.js';

export type ScanMethod = 'PLAQUE' | 'QR_VIGNETTE_FISCALE' | 'QR_VIGNETTE_TECHNIQUE';
export interface ScanEvent { id: string; plate: string; method: ScanMethod; agentId: string; roles: string[]; position: { commune?: string; lat?: number; lon?: number }; at: string; courtesyId: string | null; deviceId?: string }
export type AgentDecision = 'AUCUNE_SUITE' | 'INFORMATION_USAGER' | 'CONSTAT_A_INSTRUIRE';
export interface ScanDecision { id: string; scanId: string; decision: AgentDecision; motif: string; agentId: string; position: { lat?: number; lon?: number; commune?: string }; at: string }

const VALID = ['VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE'];

interface ClearanceApi {
  clearances?: {
    active(tp: string): { number: string; validUntil: string } | undefined;
    eligibility(tp: string): { eligible: boolean; blockers: { reason: string }[] };
  };
}

export class ScanService {
  readonly scans = new InMemoryAppendOnlyRepository<ScanEvent>();
  readonly decisions = new InMemoryRepository<ScanDecision>();

  constructor(private readonly d: VcDeps, private readonly ct: CtService, private readonly fourriere: FourriereService, private readonly domaine: DomaineService, private readonly centres: CentresService) {}

  private get titres(): TitresService | undefined { return this.d.ctx.ext['titres'] as TitresService | undefined; }

  /** Résolution de la saisie : QR technique (domaine officiel), QR de vignette fiscale, sinon plaque. */
  resolve(saisie: string): { plate: string; method: ScanMethod } {
    const s = saisie.trim();
    if (/^https?:\/\//i.test(s) || /^VTS-/i.test(s)) {
      const v = this.ct.publicVerify(s) as { found: boolean; state: string; number?: string };
      if (!v.found) throw conflict(v.state === 'DOMAINE_NON_OFFICIEL' ? 'QR_DOMAINE_NON_OFFICIEL' : 'VIGNETTE_TECHNIQUE_INCONNUE', v.state === 'DOMAINE_NON_OFFICIEL' ? 'QR pointant vers un domaine non officiel : vignette douteuse (alerte levée).' : 'Vignette technique inconnue : fausse par construction.');
      const st = this.ct.sticker(v.number!);
      if (!st.plate) throw conflict('VIGNETTE_NON_ATTRIBUEE', 'Vignette technique jamais attribuée à un véhicule.');
      return { plate: st.plate, method: 'QR_VIGNETTE_TECHNIQUE' };
    }
    const t = this.titres;
    if (t && (s.startsWith('MT1.') || s.startsWith('MD1.') || s.includes('|'))) {
      const r = t.resolvePresented(s, this.d.ctx.clock.now().getTime());
      if (r.credential?.subject.plate) return { plate: this.d.plate(r.credential.subject.plate), method: 'QR_VIGNETTE_FISCALE' };
      throw notFound('TITRE_INCONNU', r.failure ?? 'QR de vignette fiscale non reconnu.');
    }
    return { plate: this.d.plate(s), method: 'PLAQUE' };
  }

  private credLine(creds: Credential[], prefix: string) {
    const t = this.titres!;
    const mine = creds.filter((c) => t.types.findOne((x) => x.code === c.typeCode)?.prefix === prefix);
    const best = mine[0];
    if (!best) return { state: 'AUCUNE' as const, label: 'Aucun titre enregistré pour cette plaque', number: null, validUntil: null, receipt: null };
    const st = t.status(best).status;
    const obligation = best.obligationId ? this.safeObligation(best.obligationId) : undefined;
    const contested = obligation?.status === 'CONTESTEE';
    const state = contested ? 'CONTESTEE' as const : VALID.includes(st) ? 'PAYEE' as const : 'ECHUE' as const;
    const label = state === 'PAYEE' ? `Payée — valable jusqu’au ${best.validUntil.slice(0, 10)}` : state === 'CONTESTEE' ? 'Contestée — recours en cours' : `Échue (${best.validUntil.slice(0, 10)})`;
    return { state, label, number: best.number, validUntil: best.validUntil, receipt: best.receiptNumbers.at(-1) ?? null, displayStatus: st };
  }

  /** Vue hiérarchique (affichage seulement). */
  view(plateIn: string, commune?: string) {
    const plate = this.d.plate(plateIn);
    const v = this.ct.vehicle(plate);
    const category: VehicleCategory | undefined = v?.category;
    const t = this.titres;
    const creds = t ? t.byPlate(plate).filter((c) => c.state !== 'REMPLACE') : [];
    const absent = { state: 'INDISPONIBLE' as const, label: 'Moteur de titres non chargé', number: null, validUntil: null, receipt: null };
    const vignetteFiscale = t ? this.credLine(creds, 'VIG') : absent;
    const taxeCirculation = t ? this.credLine(creds, 'TSC') : absent;
    const lic = t ? this.credLine(creds, 'LIC') : absent;
    const commercial = category === 'ENTREPRISE' || category === 'MOTO_2_ROUES' || category === 'MOTO_3_ROUES';
    const autorisationTransport = lic.state === 'AUCUNE' && !commercial ? { ...lic, state: 'NON_APPLICABLE' as const, label: 'Sans objet pour cette catégorie (sauf usage commercial)' } : lic;
    const ct = this.ct.status(plate);
    const dossiers = this.fourriere.dossiers.find((x) => x.plate === plate);
    const unpaid = dossiers.flatMap((x) => (x.liquidation?.lines ?? []).filter((l) => { if (!l.obligationId) return false; const o = this.d.ctx.assessment.get(l.obligationId); return o.status !== 'ANNULEE' && !this.fourriere.isPaid(o); }));
    const fiscal = this.d.ctx.ext['fiscal'] as ClearanceApi | undefined;
    let quitus: { state: 'DISPONIBLE' | 'BLOQUE' | 'PROPRIETAIRE_NON_RATTACHE' | 'INDISPONIBLE'; label: string; reasons?: string[] };
    if (!v?.taxpayerId) quitus = { state: 'PROPRIETAIRE_NON_RATTACHE', label: 'Propriétaire de référence non rattaché à un compte : quitus non vérifiable.' };
    else if (!fiscal?.clearances) quitus = { state: 'INDISPONIBLE', label: 'Module fiscal non chargé.' };
    else {
      const a = fiscal.clearances.active(v.taxpayerId);
      if (a) quitus = { state: 'DISPONIBLE', label: `Quitus ${a.number} valable jusqu’au ${a.validUntil}` };
      else {
        const e = fiscal.clearances.eligibility(v.taxpayerId);
        quitus = e.eligible ? { state: 'DISPONIBLE', label: 'Conditions du quitus remplies (à demander depuis l’espace du contribuable).' } : { state: 'BLOQUE', label: 'Quitus non délivrable', reasons: [...new Set(e.blockers.map((b) => b.reason))] };
      }
    }
    const courtesy = this.ct.courtesyFor(category, commune ?? v?.commune);
    return {
      plate,
      identification: {
        plate, category: category ?? null, categoryLabel: category ? CATEGORY_LABELS[category] : 'Catégorie non renseignée', ownerRef: maskRef(v?.taxpayerId),
        accountLink: v?.taxpayerId ? 'COMPTE_RATTACHE' : 'NON_RATTACHE', source: v?.source ?? null,
      },
      vignetteFiscale,
      taxeCirculation,
      controleTechnique: {
        state: ct.state, label: ct.label, lastDate: ct.pv?.endedAt ?? null, centre: ct.pv ? this.centreName(ct.pv.centreId) : null, result: ct.pv?.result ?? null, echeance: ct.pv?.echeance ?? null,
        band: ct.validity?.band ?? null, stickerNumber: ct.sticker?.number ?? null,
      },
      autorisationTransport,
      fourriere: {
        passages: dossiers.length, sortiesRegulieres: dossiers.filter((x) => x.exit).length, enCours: dossiers.filter((x) => ['CONSTATE', 'ENLEVEMENT_DECIDE', 'EN_GARDE', 'DESTINATION_PROPOSEE'].includes(x.status)).length,
        fraisImpayes: unpaid.length,
      },
      quitus,
      courtesy: courtesy ? { id: courtesy.id, until: courtesy.to, authority: courtesy.authority, decisionRef: courtesy.decisionRef, notice: 'Mode courtoisie : contrôles de vignette et procès-verbaux suspendus ; information de l’usager seulement.' } : null,
      displayOnly: true as const,
      sanction: 'AUCUNE' as const,
      notice: 'Affichage seulement : aucune sanction n’est prise par la plateforme. La vignette fiscale et la vignette technique sont deux lignes distinctes.',
      serverTime: this.d.now(),
    };
  }

  private safeObligation(id: string) {
    try { return this.d.ctx.assessment.get(id); } catch { return undefined; }
  }

  private centreName(id: string): string {
    return this.centres.centres.get(id)?.name ?? id;
  }

  scan(user: User, input: { saisie: string; place: { commune?: string; lat?: number; lon?: number }; deviceId?: string }) {
    authorize(user, 'vc:scan');
    const r = this.resolve(input.saisie);
    const view = this.view(r.plate, input.place.commune);
    const ev = this.scans.append({
      id: this.d.ids.next('SCAN', 6), plate: r.plate, method: r.method, agentId: user.id, roles: user.roles, position: input.place, at: this.d.now(), courtesyId: view.courtesy?.id ?? null,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    });
    this.d.audit(user, 'vc.scan.recorded', 'scan_vehicule', ev.id, { plate: r.plate, method: r.method, position: input.place, courtesy: !!view.courtesy, ct: view.controleTechnique.state, vf: view.vignetteFiscale.state });
    return { scanId: ev.id, method: r.method, ...view };
  }

  decide(user: User, scanId: string, input: { decision: AgentDecision; motif: string; position: { lat?: number; lon?: number; commune?: string } }) {
    authorize(user, 'vc:scan.decision');
    const ev = this.scans.get(scanId);
    if (!ev) throw notFound('SCAN_INCONNU', `Contrôle inconnu : ${scanId}`);
    if (ev.agentId !== user.id) throw forbidden('AUTRE_AGENT', 'Seul l’agent qui a fait le contrôle enregistre sa décision.');
    if (this.decisions.findOne((x) => x.scanId === scanId)) throw conflict('DECISION_DEJA_ENREGISTREE', 'Décision déjà enregistrée pour ce contrôle.');
    if (input.decision === 'CONSTAT_A_INSTRUIRE' && ev.courtesyId) {
      this.d.audit(user, 'vc.scan.decision_refused', 'scan_vehicule', scanId, { reason: 'MODE_COURTOISIE', courtesyId: ev.courtesyId }, 'DENIED');
      throw conflict('MODE_COURTOISIE', 'Mode courtoisie en vigueur : aucun constat ni procès-verbal de vignette. Informez l’usager.');
    }
    const dec = this.decisions.insert({ id: this.d.ids.next('DEC-SCAN', 6), scanId, decision: input.decision, motif: input.motif, agentId: user.id, position: input.position, at: this.d.now() });
    this.d.audit(user, 'vc.scan.decision_recorded', 'scan_vehicule', scanId, { decision: input.decision, motif: input.motif, position: input.position, plate: ev.plate });
    return { ...dec, notice: input.decision === 'CONSTAT_A_INSTRUIRE' ? 'Constat transmis pour instruction par une personne habilitée : aucun montant, aucune immobilisation automatique.' : 'Décision enregistrée.' };
  }

  /** Paquet hors ligne : empreintes de plaques et états minimaux, sans donnée personnelle, avec sa date de fraîcheur. */
  offlinePack(user: User) {
    authorize(user, 'vc:scan');
    const plates = new Set([...this.ct.vehicles.all().map((v) => v.plate), ...this.fourriere.dossiers.all().map((x) => x.plate)]);
    const entries = [...plates].map((p) => {
      const v = this.view(p);
      return { plateHash: sha256Hex(`plaque|${p}`), vf: v.vignetteFiscale.state, tsc: v.taxeCirculation.state, ct: v.controleTechnique.state, ctEcheance: v.controleTechnique.echeance, fourriereEnCours: v.fourriere.enCours > 0 };
    }).sort((a, b) => a.plateHash.localeCompare(b.plateHash));
    const generatedAt = this.d.now();
    this.d.audit(user, 'vc.offline_pack.downloaded', 'paquet_hors_ligne', generatedAt, { entries: entries.length });
    return {
      generatedAt, entries, revocations: this.ct.revocationList(), officialDomain: this.domaine.domain.host,
      courtesy: this.ct.courtesy.all().filter((c) => c.to >= this.d.today()).map((c) => ({ id: c.id, categories: c.categories, communes: c.communes, from: c.from, to: c.to })),
      freshnessNotice: 'Statut minimal chargé en début de mission : sa fraîcheur est affichée à l’écran ; il ne vaut pas preuve de paiement récent.',
    };
  }

  indicators() {
    return { scans: this.scans.count(), decisions: this.decisions.count(), constatsTransmis: this.decisions.find((x) => x.decision === 'CONSTAT_A_INSTRUIRE').length };
  }
}
