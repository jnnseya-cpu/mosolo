/**
 * Centres agréés et tiers de confiance (module 84 — n° 61 du catalogue du maître d'ouvrage du 27/09/2026).
 *
 * Agrément des centres de contrôle technique, des opérateurs de fourrière et des autres tiers de confiance : invitation,
 * dépôt du dossier, diligences, proposition par une personne, décision par une AUTRE (circuit CENTRE_AGREMENT) ;
 * habilitation datée par catégorie de véhicule et par activité ; quotas (stock de vignettes sécurisées, contrôles par
 * jour) ; analytique de conformité (taux de réussite comparé aux pairs, durées, séries, horaires, écart procès-verbaux /
 * vignettes) qui lève des ALERTES seulement.
 *
 * Suspension : UNIQUEMENT par décision motivée de la RFCK (chapitre 18 ; jamais automatique — la suspension
 * conservatoire automatique décidée pour les points de paiement du module 66 ne s'applique pas aux centres). Elle est
 * propagée immédiatement aux terminaux de contrôle par la liste de révocation signée.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { User } from '../../core/auth.js';
import { conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { InMemoryRepository } from '../../core/repository.js';
import type { VcDeps } from './common.js';
import {
  ANALYTIQUE_PARAMS, CENTRE_KIND_LABELS, CT_POINTS, CT_POINT_LABELS, RFCK, type Centre, type CentreActivity, type CentreKind, type CentreStatus, type ProcesVerbal,
  type SecureSticker, type VehicleCategory,
} from './model.js';

const hashCode = (c: string) => createHash('sha256').update(`centre-invitation|${c}`).digest('hex');

export interface CentreAlert { centreId: string; code: string; label: string; detail: string }

export class CentresService {
  readonly centres = new InMemoryRepository<Centre>();
  /** Version de la liste de révocation (incrémentée à chaque suspension / révocation). */
  revocationVersion = 1;

  constructor(private readonly d: VcDeps) {}

  get(id: string): Centre {
    const c = this.centres.get(id) ?? this.centres.findOne((x) => x.publicCode === id);
    if (!c) throw notFound('CENTRE_INCONNU', `Centre inconnu : ${id}`);
    return c;
  }

  private transition(c: Centre, to: CentreStatus, by: string, motif?: string, patch: Partial<Centre> = {}): Centre {
    return this.centres.update({ ...c, ...patch, status: to, history: [...c.history, { at: this.d.now(), from: c.status, to, by, ...(motif ? { motif } : {}) }] });
  }

  /** Le centre peut-il exercer l'activité (agréé, habilitation en cours, activité et catégorie autorisées) ? */
  assertCanOperate(centreId: string, activity: CentreActivity, category?: VehicleCategory): Centre {
    const c = this.get(centreId);
    if (c.status === 'SUSPENDU') throw forbidden('CENTRE_SUSPENDU', `Centre ${c.name} suspendu par décision motivée de la RFCK : aucune opération possible.`);
    if (c.status !== 'AGREE') throw forbidden('CENTRE_NON_AGREE', `Centre ${c.name} non agréé (statut ${c.status}).`);
    const today = this.d.today();
    if (!c.habilitation || today < c.habilitation.from || today > c.habilitation.to) throw forbidden('HABILITATION_HORS_PERIODE', 'Habilitation du centre hors période de validité.');
    if (!c.activities.includes(activity)) throw forbidden('ACTIVITE_NON_HABILITEE', `Activité non habilitée pour ce centre : ${activity}.`);
    if (category && !c.categories.includes(category)) throw forbidden('CATEGORIE_NON_HABILITEE', `Catégorie non autorisée pour ce centre : ${category}.`);
    return c;
  }

  /** L'utilisateur tiers appartient-il au centre ? */
  assertMember(user: User, centreId: string): void {
    if (user.entity !== centreId) throw forbidden('HORS_CENTRE', 'Vous n’agissez qu’au nom de votre propre centre.');
  }

  // ——— Agrément (invitation → dossier → diligences → proposition → décision à deux personnes) ———

  invite(user: User, input: { kind: CentreKind; name: string; commune: string; lat: number; lon: number; categories: VehicleCategory[]; activities: CentreActivity[]; declaredHours: { open: string; close: string } }, opts: { exemple?: boolean; fixedId?: string } = {}) {
    authorize(user, 'centres:invite');
    const code = randomBytes(9).toString('base64url');
    const id = opts.fixedId ?? this.d.ids.next('CTR', 4);
    let objectId: string | undefined;
    try {
      // Tiers de confiance = objet géolocalisé du socle (§ 16.1).
      objectId = this.d.ctx.objects.create(user, { category: 'AUTRE', commune: input.commune, quartier: '—', localityRank: 4, lat: input.lat, lon: input.lon, attributes: { nature: 'TIERS_DE_CONFIANCE', genre: input.kind, nom: input.name, ...(opts.exemple ? { exemple: true } : {}) } }).id;
    } catch { /* commune hors référentiel : objet non créé, position conservée sur la fiche */ }
    const c = this.centres.insert({
      id, publicCode: `AGR-${id}`, kind: input.kind, name: input.name, commune: input.commune, lat: input.lat, lon: input.lon, ...(objectId ? { objectId } : {}),
      status: 'INVITE', categories: input.categories, activities: input.activities, quotas: { stockVignettes: 0, inspectionsParJour: 0 }, declaredHours: input.declaredHours,
      invitation: { codeHash: hashCode(code), by: user.id, at: this.d.now() }, history: [{ at: this.d.now(), from: null, to: 'INVITE', by: user.id }], ...(opts.exemple ? { exemple: true } : {}),
    });
    this.d.audit(user, 'centres.invited', 'centre_agree', c.id, { kind: c.kind, commune: c.commune });
    return { centre: c, invitationCode: code, notice: 'Code d’invitation remis une seule fois au centre (seule son empreinte est conservée).' };
  }

  submitDossier(user: User, id: string, input: { invitationCode: string; legalExistence: string; quitusRef: string; conflictDeclaration: string; linksWithOfficials: string }) {
    authorize(user, 'centres:read');
    const c = this.get(id);
    this.assertMember(user, c.id);
    if (c.status !== 'INVITE') throw conflict('CENTRE_ETAT', `Dossier déjà déposé (statut ${c.status}).`);
    if (hashCode(input.invitationCode) !== c.invitation.codeHash) throw forbidden('INVITATION_INVALIDE', 'Code d’invitation invalide.');
    const { invitationCode: _i, ...dossier } = input;
    const out = this.transition(c, 'DOSSIER_DEPOSE', user.id, undefined, { dossier: { ...dossier, at: this.d.now(), by: user.id } });
    this.d.audit(user, 'centres.dossier.submitted', 'centre_agree', c.id, {});
    return out;
  }

  recordDiligence(user: User, id: string, checks: { code: string; label: string; ok: boolean; note?: string }[]) {
    authorize(user, 'centres:diligence');
    const c = this.get(id);
    if (c.status !== 'DOSSIER_DEPOSE') throw conflict('CENTRE_ETAT', `Diligences possibles après dépôt du dossier (statut ${c.status}).`);
    const out = this.transition(c, 'DILIGENCE_FAITE', user.id, undefined, { diligence: { checks, by: user.id, at: this.d.now() } });
    this.d.audit(user, 'centres.diligence.recorded', 'centre_agree', c.id, { failed: checks.filter((x) => !x.ok).map((x) => x.code) });
    return out;
  }

  propose(user: User, id: string, input: { motif: string; habilitation: { from: string; to: string }; quotas: { stockVignettes: number; inspectionsParJour: number } }) {
    authorize(user, 'centres:propose');
    const c = this.get(id);
    if (c.status !== 'DILIGENCE_FAITE') throw conflict('CENTRE_ETAT', `Proposition possible après les diligences (statut ${c.status}).`);
    if (c.diligence?.checks.some((x) => !x.ok)) throw unprocessable('DILIGENCES_NON_SATISFAITES', 'Une diligence au moins n’est pas satisfaite : agrément non proposable.');
    if (input.habilitation.to < input.habilitation.from) throw unprocessable('HABILITATION_DATES', 'Fin d’habilitation antérieure au début.');
    const out = this.transition(c, 'PROPOSE', user.id, input.motif, { proposal: { by: user.id, at: this.d.now(), motif: input.motif }, habilitation: input.habilitation, quotas: input.quotas });
    this.d.audit(user, 'centres.agrement.proposed', 'centre_agree', c.id, { motif: input.motif, habilitation: input.habilitation, quotas: input.quotas });
    return out;
  }

  decide(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'centres:decide');
    const c = this.get(id);
    if (c.status !== 'PROPOSE' || !c.proposal) throw conflict('CENTRE_ETAT', `Aucune proposition d’agrément en attente (statut ${c.status}).`);
    assertDistinctPerson(user.id, [c.proposal.by, c.invitation.by], 'L’agrément est décidé par une personne distincte de celle qui l’a proposé.');
    const out = this.transition(c, input.approve ? 'AGREE' : 'REFUSE', user.id, input.motif, { decision: { by: user.id, at: this.d.now(), motif: input.motif, approve: input.approve } });
    this.d.audit(user, input.approve ? 'centres.agrement.approved' : 'centres.agrement.rejected', 'centre_agree', c.id, { proposedBy: c.proposal.by, motif: input.motif });
    return out;
  }

  updateHabilitation(user: User, id: string, input: { categories?: VehicleCategory[]; activities?: CentreActivity[]; habilitation?: { from: string; to: string }; quotas?: { stockVignettes: number; inspectionsParJour: number }; motif: string }) {
    authorize(user, 'centres:habilitation');
    const c = this.get(id);
    const { motif, ...patch } = input;
    const out = this.centres.update({ ...c, ...patch });
    this.d.audit(user, 'centres.habilitation.updated', 'centre_agree', c.id, { ...patch, motif });
    return out;
  }

  // ——— Suspension par décision motivée (jamais automatique) ———

  suspend(user: User, id: string, input: { motif: string; legalRef: string }) {
    authorize(user, 'centres:suspend');
    const c = this.get(id);
    if (c.status !== 'AGREE') throw conflict('CENTRE_ETAT', `Seul un centre agréé peut être suspendu (statut ${c.status}).`);
    const out = this.transition(c, 'SUSPENDU', user.id, input.motif, { suspension: { by: user.id, at: this.d.now(), motif: input.motif, legalRef: input.legalRef } });
    this.revocationVersion++;
    this.d.audit(user, 'centres.suspended', 'centre_agree', c.id, { motif: input.motif, legalRef: input.legalRef, revocationVersion: this.revocationVersion });
    return { centre: out, propagation: { revocationVersion: this.revocationVersion, notice: 'Suspension propagée immédiatement aux terminaux de contrôle (liste de révocation signée).' } };
  }

  requestReinstatement(user: User, id: string, motif: string) {
    authorize(user, 'centres:reinstatement.request');
    const c = this.get(id);
    if (c.status !== 'SUSPENDU') throw conflict('CENTRE_ETAT', 'Centre non suspendu.');
    const out = this.centres.update({ ...c, reinstatementRequest: { by: user.id, at: this.d.now(), motif } });
    this.d.audit(user, 'centres.reinstatement.requested', 'centre_agree', c.id, { motif });
    return out;
  }

  decideReinstatement(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'centres:reinstatement.decide');
    const c = this.get(id);
    if (c.status !== 'SUSPENDU' || !c.reinstatementRequest) throw conflict('CENTRE_ETAT', 'Aucune demande de rétablissement en attente.');
    assertDistinctPerson(user.id, [c.reinstatementRequest.by], 'Le rétablissement est décidé par une personne distincte de celle qui l’a demandé.');
    const { reinstatementRequest: req, ...rest } = c;
    const out = input.approve ? this.transition(rest as Centre, 'AGREE', user.id, input.motif) : this.centres.update(rest as Centre);
    if (input.approve) this.revocationVersion++;
    this.d.audit(user, input.approve ? 'centres.reinstated' : 'centres.reinstatement.rejected', 'centre_agree', c.id, { requestedBy: req.by, motif: input.motif });
    return out;
  }

  // ——— Lectures ———

  list(user: User) {
    authorize(user, 'centres:read');
    const all = this.centres.all();
    const mine = user.roles.includes('R34') || user.roles.includes('R35') ? all.filter((c) => c.id === user.entity) : all;
    return mine.map((c) => this.view(c));
  }

  view(c: Centre) {
    const { invitation, ...rest } = c;
    return { ...rest, kindLabel: CENTRE_KIND_LABELS[c.kind], invitation: { by: invitation.by, at: invitation.at } };
  }

  /** Vérification publique d'un agrément : statut minimal, jamais les données du dossier. */
  /**
   * Annuaire public des centres agréés (30/09/2026) : pour que l'usager CHOISISSE son centre au lieu d'en saisir le
   * numéro. Centres AGRÉÉS et dans leur période d'habilitation seulement ; aucune donnée interne (dossier, quotas,
   * diligence, invitation) — les mêmes informations que la vérification publique d'un centre.
   */
  publicDirectory(activity?: CentreActivity) {
    const today = this.d.today();
    return this.centres.find((c) => c.status === 'AGREE' && !!c.habilitation && c.habilitation.from <= today && today <= c.habilitation.to && (!activity || c.activities.includes(activity)))
      .map((c) => ({ id: c.id, publicCode: c.publicCode, name: c.name, kindLabel: CENTRE_KIND_LABELS[c.kind], commune: c.commune, categories: c.categories, hours: c.declaredHours }))
      .sort((a, b) => a.commune.localeCompare(b.commune, 'fr') || a.name.localeCompare(b.name, 'fr'));
  }

  publicVerify(code: string) {
    const c = this.centres.findOne((x) => x.publicCode === code.trim().toUpperCase() || x.id === code.trim().toUpperCase());
    if (!c) return { found: false, state: 'NON_AGREE', message: 'Aucun centre agréé ne porte ce numéro : ne confiez pas votre véhicule et signalez-le.', checkedAt: this.d.now() };
    const today = this.d.today();
    const inPeriod = !!c.habilitation && c.habilitation.from <= today && today <= c.habilitation.to;
    const state = c.status === 'AGREE' && inPeriod ? 'AGREE' : c.status === 'SUSPENDU' ? 'SUSPENDU' : 'NON_AGREE';
    return {
      found: true, state, name: c.name, kindLabel: CENTRE_KIND_LABELS[c.kind], commune: c.commune, categories: c.categories, habilitation: c.habilitation ?? null,
      message: state === 'AGREE' ? 'Centre agréé par la RFCK.' : state === 'SUSPENDU' ? 'Agrément suspendu par décision motivée de la RFCK.' : 'Centre non agréé à ce jour.',
      checkedAt: this.d.now(),
    };
  }

  // ——— Analytique de conformité (alertes seulement) ———

  analytics(user: User | null, pvs: ProcesVerbal[], stickers: SecureSticker[], opts: { raise?: boolean } = {}) {
    if (user) authorize(user, 'centres:analytics');
    const P = ANALYTIQUE_PARAMS;
    const current = pvs.filter((p) => !p.supersededBy);
    const ctCentres = this.centres.find((c) => c.kind === 'CONTROLE_TECHNIQUE');
    const rateOf = (list: ProcesVerbal[]) => (list.length ? Math.round((list.filter((p) => p.result === 'FAVORABLE').length / list.length) * 1000) / 10 : null);
    const peerRate = rateOf(current);
    const alerts: CentreAlert[] = [];
    const rows = ctCentres.map((c) => {
      const mine = current.filter((p) => p.centreId === c.id);
      const rate = rateOf(mine);
      const favorable = mine.filter((p) => p.result === 'FAVORABLE').length;
      const consumed = stickers.filter((s) => s.centreId === c.id && s.status === 'ATTRIBUEE').length;
      const short = mine.filter((p) => (Date.parse(p.endedAt) - Date.parse(p.startedAt)) / 60_000 < P.dureeInspectionMinMinutes);
      const outside = mine.filter((p) => {
        const hm = new Date(Date.parse(p.startedAt) + 3_600_000).toISOString().slice(11, 16);
        return hm < c.declaredHours.open || hm > c.declaredHours.close;
      });
      const allConforme = mine.length > 0 && mine.every((p) => CT_POINTS.every((k) => p.points[k]?.conforme));
      // Série : même inspecteur, N procès-verbaux ou plus dans la fenêtre.
      const byInspector = new Map<string, number[]>();
      for (const p of mine) byInspector.set(p.inspecteur, [...(byInspector.get(p.inspecteur) ?? []), Date.parse(p.startedAt)]);
      let series = 0;
      for (const [, times] of byInspector) {
        const t = times.sort((a, b) => a - b);
        for (let i = 0; i + P.serieMemeInspecteur - 1 < t.length; i++) if (t[i + P.serieMemeInspecteur - 1]! - t[i]! <= P.serieFenetreMinutes * 60_000) { series++; break; }
      }
      const add = (code: string, label: string, detail: string) => alerts.push({ centreId: c.id, code, label, detail });
      if (mine.length >= P.echantillonMin && rate !== null && rate >= P.tauxReussiteAlertePct) add('TAUX_REUSSITE_ANORMAL', 'Taux de réussite anormalement élevé', `${rate} % sur ${mine.length} contrôles (pairs : ${peerRate ?? '—'} %).`);
      if (mine.length >= P.echantillonMin && allConforme) add('RESULTATS_UNIFORMES', 'Résultats anormalement uniformes', `Tous les points conformes sur ${mine.length} contrôles.`);
      if (short.length) add('DUREE_INVRAISEMBLABLE', 'Durée d’inspection invraisemblable', `${short.length} contrôle(s) de moins de ${P.dureeInspectionMinMinutes} min.`);
      if (series) add('SERIE_MEME_INSPECTEUR', 'Série par un même inspecteur', `${series} série(s) de ${P.serieMemeInspecteur} contrôles ou plus en ${P.serieFenetreMinutes} min.`);
      if (outside.length) add('HORS_HORAIRES', 'Activité hors des horaires déclarés', `${outside.length} contrôle(s) hors ${c.declaredHours.open}–${c.declaredHours.close}.`);
      if (favorable !== consumed) add('ECART_PV_VIGNETTES', 'Écart entre contrôles favorables et vignettes consommées', `${favorable} procès-verbal(aux) favorable(s) pour ${consumed} vignette(s) attribuée(s).`);
      return { centreId: c.id, name: c.name, status: c.status, inspections: mine.length, passRate: rate, peerRate, favorable, stickersConsumed: consumed, shortInspections: short.length, outsideHours: outside.length, series };
    });
    // Comparaison par point de non-conformité entre centres.
    const byPoint = CT_POINTS.map((k) => ({
      point: k, label: CT_POINT_LABELS[k],
      centres: ctCentres.map((c) => {
        const mine = current.filter((p) => p.centreId === c.id);
        const nc = mine.filter((p) => p.points[k] && !p.points[k].conforme).length;
        return { centreId: c.id, name: c.name, nonConformes: nc, total: mine.length, ratePct: mine.length ? Math.round((nc / mine.length) * 1000) / 10 : null };
      }),
    }));
    if (opts.raise) {
      for (const a of alerts) {
        this.d.ctx.alerts.raise({ type: `CENTRE_${a.code}`, severity: 'MEDIUM', source: 'vehicules-controle', detail: `${a.label} — ${this.get(a.centreId).name} : ${a.detail} Examen humain requis ; aucune suspension automatique.`, context: { centreId: a.centreId }, ...(user ? { actor: { kind: 'user', id: user.id, roles: user.roles } } : {}) });
      }
      this.d.audit(user, 'centres.analytics.run', 'centre_agree', 'tous', { alerts: alerts.length });
    }
    return { rows, byPoint, alerts, params: P, notice: 'Signaux proposés à l’examen humain : aucune suspension, aucune sanction automatique. Suspension uniquement par décision motivée de la RFCK.' };
  }

  indicators() {
    const all = this.centres.all();
    return {
      actifs: all.filter((c) => c.status === 'AGREE').length,
      suspendus: all.filter((c) => c.status === 'SUSPENDU').length,
      enInstruction: all.filter((c) => ['INVITE', 'DOSSIER_DEPOSE', 'DILIGENCE_FAITE', 'PROPOSE'].includes(c.status)).length,
    };
  }

  /** Entité RFCK (référence) — utilisée par les écrans. */
  static entity() { return RFCK; }
}
