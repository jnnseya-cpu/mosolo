/**
 * Service de la chaîne véhicule : assemble le contrôle technique et la vignette sécurisée (module 82), les fourrières
 * (module 83), les centres agréés (module 84), le scan unique, le domaine officiel de vérification et le raccordement
 * RFCK. Numérotation : n° 59–61 dans le catalogue du maître d'ouvrage du 27/09/2026 (voir model.ts, collision signalée).
 */
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { authorize, evaluate } from '../../core/policy.js';
import type { TitresService } from '../titres/service.js';
import { CentresService } from './centres.js';
import { VcDeps } from './common.js';
import { CtService } from './ct.js';
import { DomaineService } from './domaine.js';
import { FourriereService } from './fourriere.js';
import {
  ARRETE_CT, CATEGORY_LABELS, COLLISION_NUMEROTATION, CT_POINT_LABELS, CT_POINTS, DOMAIN_REQUIREMENTS, FOURRIERE_STEPS, INTEGRATION_STEPS, INTERFACE_FLOWS, MODULES_VEHICULES,
  NOTE_NUMEROTATION, PHASES_2026_EXEMPLE, REVENUE_LINES, RFCK, RFCK_PUBLISHED_FIGURES, RULE_CODES, VEHICLE_CATEGORIES,
} from './model.js';
import { RaccordementService } from './raccordement.js';
import { ScanService } from './scan.js';

export class VehiculesControleService {
  readonly d: VcDeps;
  readonly centres: CentresService;
  readonly domaine: DomaineService;
  readonly ct: CtService;
  readonly fourriere: FourriereService;
  readonly scan: ScanService;
  readonly raccordement: RaccordementService;

  constructor(readonly ctx: AppContext) {
    this.d = new VcDeps(ctx);
    this.centres = new CentresService(this.d);
    this.domaine = new DomaineService(this.d);
    this.ct = new CtService(this.d, this.centres, this.domaine);
    this.fourriere = new FourriereService(this.d, this.ct, this.centres);
    this.scan = new ScanService(this.d, this.ct, this.fourriere, this.domaine, this.centres);
    this.raccordement = new RaccordementService(this.d, this.ct, this.fourriere, this.centres, this.domaine, this.scan);
  }

  /** Branche le mode courtoisie sur le moteur de titres : pendant la courtoisie, aucun constat de vignette (module 11). */
  hookTitres(): void {
    const t = this.ctx.ext['titres'] as (TitresService & { constatSuspensions?: ((q: { module?: string; plate?: string; commune?: string; at: string }) => string | null)[] }) | undefined;
    t?.constatSuspensions?.push((q) => {
      if (q.module !== '11') return null;
      const v = q.plate ? this.ct.vehicle(q.plate) : null;
      const p = this.ct.courtesyFor(v?.category, q.commune ?? v?.commune, q.at.slice(0, 10));
      return p ? `Mode courtoisie ${p.id} (${p.decisionRef}) jusqu’au ${p.to} : aucun constat de vignette.` : null;
    });
  }

  referentiel() {
    return {
      modules: MODULES_VEHICULES.map((m) => ({ ...m, note: NOTE_NUMEROTATION })), numerotation: { note: NOTE_NUMEROTATION, aArbitrer: COLLISION_NUMEROTATION },
      entity: RFCK, arrete: ARRETE_CT, categories: VEHICLE_CATEGORIES.map((c) => ({ code: c, label: CATEGORY_LABELS[c] })),
      points: CT_POINTS.map((p) => ({ code: p, label: CT_POINT_LABELS[p] })), revenueLines: REVENUE_LINES, ruleCodes: RULE_CODES,
      fourriereSteps: FOURRIERE_STEPS, flows: INTERFACE_FLOWS, integrationSteps: INTEGRATION_STEPS, domainRequirements: DOMAIN_REQUIREMENTS,
      publishedFigures: RFCK_PUBLISHED_FIGURES, phases2026: PHASES_2026_EXEMPLE,
    };
  }

  /** Six lignes de recettes du véhicule, chacune avec son administration, sa base légale et son compte bénéficiaire. */
  revenueLines(user: User, plateIn: string) {
    authorize(user, 'vc:read');
    const plate = this.d.plate(plateIn);
    const view = this.scan.view(plate);
    const v = this.ct.vehicle(plate);
    const rule = (code: string) => { const a = this.fourriere.activeRule(code); return 'rule' in a ? `ACTIVE (${a.rule.code} v${a.rule.version})` : 'A_VERIFIER — acte requis, aucun montant'; };
    const fees = this.fourriere.dossiers.find((x) => x.plate === plate).flatMap((x) => (x.liquidation?.lines ?? []).filter((l) => l.obligationId));
    const penalties = v?.objectId ? this.ctx.assessment.byTaxpayer(v.taxpayerId ?? '').filter((o) => o.objectId === v.objectId && o.revenueCategory === 'PENALITE') : [];
    const status: Record<string, { state: string; label: string }> = {
      VIGNETTE_FISCALE: { state: view.vignetteFiscale.state, label: view.vignetteFiscale.label },
      TAXE_CIRCULATION: { state: view.taxeCirculation.state, label: view.taxeCirculation.label },
      REDEVANCE_CT: { state: rule(RULE_CODES.redevanceCt).startsWith('ACTIVE') ? 'SELON_FICHE' : 'ACTE_REQUIS', label: `Fiche ${RULE_CODES.redevanceCt} : ${rule(RULE_CODES.redevanceCt)}` },
      FRAIS_FOURRIERE: { state: fees.length ? (fees.every((l) => this.fourriere.isPaid(this.ctx.assessment.get(l.obligationId!))) ? 'PAYES' : 'DUS') : 'AUCUN', label: `${fees.length} frais liquidé(s) ; gardiennage : ${rule(RULE_CODES.gardiennage)}` },
      AUTORISATION_TRANSPORT: { state: view.autorisationTransport.state, label: view.autorisationTransport.label },
      AMENDES_CIRCULATION: { state: penalties.some((o) => o.status !== 'SOLDEE' && o.status !== 'ANNULEE') ? 'DUES' : 'AUCUNE', label: `${penalties.length} amende(s) ou pénalité(s) liquidée(s) par décision motivée` },
    };
    return { plate, lines: REVENUE_LINES.map((l) => ({ ...l, ...status[l.code]! })), notice: 'Six lignes distinctes, chacune avec son administration, sa base légale et son compte bénéficiaire : aucune n’est agrégée avec une autre.' };
  }

  /** Couche usager : véhicules du compte, contrôle technique, vignettes, fourrière, rendez-vous, paiements. */
  myVehicles(user: User) {
    const taxpayerId = user.taxpayerId ?? user.mandants?.[0];
    authorize(user, 'vc:vehicle.own', { ...(taxpayerId ? { taxpayerId } : {}) });
    if (!taxpayerId) return { vehicles: [], situationFiscale: [] };
    const plates = new Set<string>();
    for (const o of this.ctx.objects.byTaxpayer(taxpayerId).filter((x) => x.category === 'VEHICULE')) {
      const p = o.attributes['immatriculation'] ?? o.attributes['plaque'];
      if (typeof p === 'string') plates.add(this.d.plate(p));
    }
    for (const v of this.ct.vehicles.find((x) => x.taxpayerId === taxpayerId)) plates.add(v.plate);
    return {
      vehicles: [...plates].map((plate) => {
        const view = this.scan.view(plate);
        return {
          plate, identification: view.identification, vignetteFiscale: view.vignetteFiscale, taxeCirculation: view.taxeCirculation, controleTechnique: view.controleTechnique,
          autorisationTransport: view.autorisationTransport, quitus: view.quitus,
          fourriere: this.fourriere.byTaxpayer(taxpayerId).filter((x) => x.plate === plate),
          appointments: this.ct.appointments.find((a) => a.plate === plate && a.taxpayerId === taxpayerId).map((a) => this.ct.appointmentView(a)),
          attestation: this.ct.status(plate).pv ? { number: this.ct.status(plate).pv!.number, result: this.ct.status(plate).pv!.result, echeance: this.ct.status(plate).pv!.echeance } : null,
        };
      }),
      // Effet recettes (chapitre 18) : à la visite au centre ou au retrait en fourrière, la situation fiscale du titulaire
      // est présentée dans SON espace, payable depuis son téléphone (même référence, même quittance) — jamais au guichet du tiers.
      situationFiscale: this.ctx.assessment.byTaxpayer(taxpayerId).filter((o) => ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'].includes(o.status) && !o.supersededBy)
        .map((o) => ({ id: o.id, label: o.label, amount: o.amount, dueDate: o.dueDate, status: o.status, payPath: `/v1/obligations/${o.id}/payment-orders` })),
      notice: 'Informations, rendez-vous, suivi de dossier, paiement et quittance dans votre espace unique. Aucun paiement en espèces.',
    };
  }

  indicators(user: User) {
    if (!evaluate(user, 'vc:read') && !evaluate(user, 'fourriere:read')) authorize(user, 'centres:read');
    const pvs = this.ct.activePvs();
    const analytics = this.centres.analytics(null, pvs, this.ct.stickers.all());
    const rated = analytics.rows.filter((r) => r.inspections > 0);
    return {
      controleTechnique: this.ct.indicators(), fourriere: this.fourriere.indicators(), centres: { ...this.centres.indicators(), alertesAnalytique: analytics.alerts.length },
      tauxConformite: rated.length ? { peerRatePct: analytics.rows[0]?.peerRate ?? null, centres: rated.map((r) => ({ centreId: r.centreId, name: r.name, passRate: r.passRate })) } : null,
      scan: this.scan.indicators(),
      generatedAt: this.d.now(),
    };
  }

  domainRequirements() {
    const dv = this.domaine.domain;
    const foreignRefused = this.ctx.audit.list({ action: 'vc.sticker.foreign_domain', limit: 1 }).total;
    const figures = this.raccordement.figuresView();
    const req = [
      dv.status === 'VALIDE',
      dv.status === 'VALIDE' && this.domaine.verifyUrl('ct', 'X').startsWith(`https://${dv.host}/`),
      true,
      true,
      true,
      figures.every((f) => f.status !== 'CONFIRME' || !!f.decision),
    ];
    const details = [
      `${dv.host} — ${dv.ownedBy} (${dv.status === 'VALIDE' ? 'validé' : dv.status === 'EXEMPLE' ? 'EXEMPLE — domaine à désigner' : 'proposé'})`,
      `Exemple de QR : ${this.domaine.verifyUrl('ct', 'VTS-EXEMPLE')}`,
      `QR d’un autre domaine refusés et signalés : ${foreignRefused}`,
      `${this.domaine.legacy.count()} ancien(s) domaine(s) en redirection`,
      `${this.domaine.watch.count()} domaine(s) ressemblant(s) surveillé(s)`,
      `${figures.length} chiffre(s) publié(s) conservé(s) « À VÉRIFIER »`,
    ];
    return DOMAIN_REQUIREMENTS.map((r, i) => ({ ...r, status: req[i] ? 'CONFORME' : 'A_FAIRE', detail: details[i] }));
  }
}
