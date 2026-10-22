/**
 * Module « fiscal » : objets et relations, identifiant géofiscal, QR par bien, déclarations pré-remplies,
 * registre des exonérations et remises, quitus fiscal numérique, attestation de bail, carte à deux couches.
 * Tout passe par le socle : règles du registre, moteur de liquidation, audit chaîné, communications.
 */
import type { User } from '../../core/auth.js';
import { evaluate } from '../../core/policy.js';
import type { AppContext } from '../../context.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { AnomalyService } from './anomalies.js';
import { Assiette2026Service } from './assiette2026.js';
import { CENSUS_STAGE_LABELS, CensusService, provenanceView, stageOf } from './census.js';
import { ClearanceService } from './clearances.js';
import { DependencyService } from './dependencies.js';
import { EnrolmentService } from './enrolment.js';
import { ImportService } from './imports.js';
import { CATEGORY_LABELS, makeDeps, type FiscalDeps } from './common.js';
import { DeclarationService } from './declarations.js';
import { ExemptionService } from './exemptions.js';
import { GeoRegistry } from './geo.js';
import { ObjectLifecycleService } from './lifecycle.js';
import { RentalCoverageService } from './couverture-locative.js';
import { buildMap, type MapLayer } from './map.js';
import { PropertyService } from './properties.js';
import { RelationService, ROLE_LABELS, isHighValue } from './relations.js';
import { BiensOccupationsService, toClaimRole } from './biens-occupations.js';
import { recordStatusOf } from '../../modules/objects/service.js';
import { unprocessable } from '../../core/errors.js';
import { coverageOf, occupancyOf, situationOf } from './situation.js';

export class FiscalService {
  readonly d: FiscalDeps;
  readonly geo: GeoRegistry;
  readonly relations: RelationService;
  readonly properties: PropertyService;
  readonly declarations: DeclarationService;
  readonly exemptions: ExemptionService;
  readonly clearances: ClearanceService;
  /** § 16.4 : détection d'anomalies locatives (listes de travail, protocole requis). */
  readonly anomalies: AnomalyService;
  /** § 16.3 : élargissement d'assiette de l'édit 2026 (règles À VÉRIFIER, formulaires propres). */
  readonly assiette2026: Assiette2026Service;
  /** § 8.1, § 10A.3 : dépendances entre services (quitus, vignette), informatives jusqu'à l'acte. */
  readonly dependencies: DependencyService;
  /** § 17.4 : vagues de recensement et provenance des données. */
  readonly census: CensusService;
  /** § 2, § 7.5 : reprise e-DGRK et import par lots. */
  readonly imports: ImportService;
  /** § 9.3 : enrôlement par profil, espaces, NIF provisoire, récupération de compte. */
  readonly enrolment: EnrolmentService;
  /** § 30 (Document maître FR 2) : cycle de vie de l'objet fiscal (provisoire, actif, suspendu, clos). */
  readonly lifecycle: ObjectLifecycleService;
  /** § 16.6 (Document maître FR 2) : indicateurs de couverture locative par avenue, quartier et commune. */
  readonly rentalCoverage: RentalCoverageService;
  /** Liaison des biens et occupations (spécification v1.0 du 28/09/2026) : revendications, candidats, preuves, revue. */
  readonly biens: BiensOccupationsService;

  constructor(readonly ctx: AppContext) {
    this.geo = new GeoRegistry(() => ctx.clock.now().toISOString());
    this.d = makeDeps(ctx, this.geo);
    this.relations = new RelationService(this.d);
    this.properties = new PropertyService(this.d, this.relations);
    this.declarations = new DeclarationService(this.d);
    this.exemptions = new ExemptionService(this.d);
    this.clearances = new ClearanceService(this.d);
    this.anomalies = new AnomalyService(this.d);
    this.assiette2026 = new Assiette2026Service(this.d);
    this.dependencies = new DependencyService(this.d, this.clearances);
    this.census = new CensusService(this.d);
    this.imports = new ImportService(this.d, this.relations);
    this.enrolment = new EnrolmentService(this.d);
    this.lifecycle = new ObjectLifecycleService(this.d);
    this.rentalCoverage = new RentalCoverageService(this.d);
    this.biens = new BiensOccupationsService(this.d, this.relations);
    this.branchCompteUnique();
    // Les exonérations approuvées s'appliquent à toute liquidation (trace dans l'explication).
    ctx.assessment.registerAdjuster(this.exemptions.adjuster());
    // Référentiels (idempotents) : fiches À VÉRIFIER de l'édit 2026, dépendances informatives.
    this.seedReference();
  }

  /**
   * Compte unique et liaison des biens (28/09/2026) :
   *  - un bien PROVISOIRE auto-déclaré (revendication) n'est jamais liquidé avant qualification (§ 8, § 10) ;
   *  - la situation choisie à l'inscription ou au parcours d'enrôlement ouvre une revendication BROUILLON ;
   *  - contributions du module au compte unique (déclarations, exonérations, quitus, rôles, NIF, relations).
   */
  private branchCompteUnique(): void {
    const ctx = this.ctx;
    ctx.assessment.addLiquidationGuard(({ objectId }) => {
      const o = ctx.objects.objects.get(objectId);
      if (o && o.recordProvenance === 'SELF_REPORTED' && recordStatusOf(o) !== 'CANONICAL') {
        throw unprocessable('SELF_REPORTED_NOT_QUALIFIED', 'Bien auto-déclaré non qualifié : aucune liquidation définitive avant validation du bien et des règles (§ 10, non validé juridiquement).');
      }
    });
    ctx.taxpayers.hooks.registered.push((t, input) => {
      const list = [...(typeof input.intention === 'string' ? [input.intention] : []), ...(Array.isArray(input.intentions) ? input.intentions : [])];
      for (const intention of new Set(list)) {
        if (intention === 'PROPRIETAIRE' || intention === 'LOCATAIRE' || intention === 'EXPLOITANT') this.biens.draftFromIntention(t.id, toClaimRole(intention), 'INSCRIPTION');
      }
    });
    this.enrolment.onRoleDeclared.push((taxpayerId, profile) => {
      const role = ({ PROPRIETAIRE_OCCUPANT: 'OWNER', BAILLEUR: 'OWNER', LOCATAIRE: 'TENANT', COMMERCANT_ENTREPRISE: 'OPERATOR', OPERATEUR_INFORMEL: 'OPERATOR' } as const)[profile as 'BAILLEUR'];
      if (role) this.biens.draftFromIntention(taxpayerId, role, 'ENROLEMENT');
    });
    ctx.compteUnique.register({
      module: 'biens-relations', titre: 'Mes biens et relations', lien: '/espace/biens-relations',
      collect: (tp) => this.biens.compteElements(tp),
    });
    ctx.compteUnique.register({
      module: 'fiscal', titre: 'Fiscalité : déclarations, exonérations, quitus, enrôlement', lien: '/fiscal/declarations',
      collect: (tp) => [
        ...this.declarations.list({ taxpayerId: tp }).map((x) => ({ rubrique: 'DEMARCHE' as const, id: x.id, libelle: `Déclaration ${x.kind} ${x.period}`, nature: 'DECLARATION', statut: x.status, objectId: x.objectId, lien: '/fiscal/declarations' })),
        ...this.exemptions.exemptions.find((x) => x.taxpayerId === tp).map((x) => ({ rubrique: 'DEMARCHE' as const, id: x.id, libelle: `Demande d’exonération (${x.kind})`, nature: 'EXONERATION', statut: x.status, ...(x.objectId ? { objectId: x.objectId } : {}), lien: '/fiscal/exonerations' })),
        ...this.clearances.clearances.find((x) => x.taxpayerId === tp).map((x) => ({ rubrique: 'TITRE' as const, id: x.id, libelle: `Quitus fiscal ${x.number}`, nature: 'QUITUS', statut: x.status, echeance: x.validUntil, lien: '/fiscal/quitus' })),
        ...this.enrolment.roles.find((x) => x.taxpayerId === tp).map((x) => ({ rubrique: 'ROLE' as const, id: x.id, libelle: `Rôle déclaré : ${x.profileLabel}`, nature: x.profile, statut: x.status, date: x.declaredAt, lien: '/fiscal/enrolement' })),
        ...this.enrolment.nifRequests.find((x) => x.taxpayerId === tp).map((x) => ({ rubrique: 'DEMARCHE' as const, id: x.id, libelle: `Demande de NIF (identifiant provisoire ${x.provisionalId})`, nature: 'NIF', statut: x.status, date: x.requestedAt, lien: '/fiscal/enrolement' })),
      ],
    });
  }

  /** Vue d'un bien pour un lecteur donné : relations nominatives seulement pour soi ou un agent habilité. */
  objectView(o: FiscalObject, viewer: User, viewerTaxpayers: string[]) {
    const plate = this.properties.currentPlate(o.id);
    const rels = this.relations.ofObject(o.id);
    const agent = !!evaluate(viewer, 'fiscal:object.read', { communes: [o.commune] }) && !viewer.roles.some((r) => r === 'R30' || r === 'R31');
    return {
      id: o.id,
      category: o.category,
      categoryLabel: CATEGORY_LABELS[o.category] ?? o.category,
      commune: o.commune,
      quartier: o.quartier,
      avenue: o.avenue ?? null,
      localityRank: o.localityRank,
      status: o.status,
      probativeStatus: o.probativeStatus,
      lifecycle: this.lifecycle.view(o),
      igf: o.igf ? { code: o.igf.code, uuid: o.igf.uuid, assignedAt: o.igf.assignedAt, cahierCode: o.igf.cahierCode ?? null } : null,
      holder: o.taxpayerId ? (viewerTaxpayers.includes(o.taxpayerId) || agent ? o.taxpayerId : 'autre') : null,
      highValue: isHighValue(o),
      attributes: o.attributes,
      situation: situationOf(this.d, o),
      coverage: coverageOf(this.d, o, this.relations),
      occupancy: occupancyOf(this.d, o),
      tree: this.properties.tree(o),
      plate: plate ? this.properties.qrOf(plate) : null,
      relations: rels.map((r) =>
        agent || viewerTaxpayers.includes(r.taxpayerId)
          ? { ...r, own: viewerTaxpayers.includes(r.taxpayerId), roleLabel: ROLE_LABELS[r.role] }
          : { ...RelationService.anonymized(r), roleLabel: ROLE_LABELS[r.role] }),
      leases: this.ctx.objects.leases.find((l) => l.unitObjectId === o.id).map((l) => ({
        id: l.id, periodicity: l.periodicity, start: l.start, end: l.end ?? null,
        role: viewerTaxpayers.includes(l.lessorId ?? '') ? 'BAILLEUR' : viewerTaxpayers.includes(l.lesseeId ?? '') ? 'LOCATAIRE' : agent ? 'AGENT' : null,
      })).filter((l) => l.role !== null),
      example: o.id.includes('DEMO') || o.attributes['demo'] === true,
      census: { stage: stageOf(this.d, o), label: CENSUS_STAGE_LABELS[stageOf(this.d, o)].label, history: agent ? o.censusHistory ?? [] : [] },
      provenance: provenanceView(o),
      importedFrom: o.importedFrom ?? null,
    };
  }

  map(user: User | undefined, layer: MapLayer, commune?: string) {
    return buildMap(this.d, this.relations, user, layer, commune);
  }

  // ——————————————————— Données de démonstration (fictives, non opposables) ———————————————————
  /** Référentiels (hors démonstration) : fiches À VÉRIFIER de l'édit 2026 et dépendances informatives. */
  seedReference(): void {
    this.assiette2026.seedRules();
    this.dependencies.seed();
  }

  seedDemo(): void {
    this.seedReference();
    const { ctx } = this;
    const u = (id: string) => ctx.users.get(id)!;
    ctx.users.add({ id: 'u-fiscal-chef-service', name: 'Chef de service d’assiette DGIPK (démo)', roles: ['R07'], entity: 'DGIPK' });
    ctx.users.add({ id: 'u-fiscal-directeur', name: 'Directeur de l’assiette DGIPK (démo)', roles: ['R06'], entity: 'DGIPK' });
    ctx.users.add({ id: 'u-fiscal-urbanisme', name: 'Service de l’urbanisme — vérification du quitus (démo)', roles: ['R37'], entity: 'GOUVERNORAT' });

    const controller = u('u-controleur');
    const owner = u('u-contribuable');
    const tenant = u('u-locataire');
    const agentLimete = u('u-agent-terrain');

    // 1. Parcelle et unité de démonstration du socle : validation → IGF + QR par bien.
    this.properties.validateObject(controller, 'OBJ-DEMO-PARCELLE-01');
    this.properties.validateObject(controller, 'OBJ-DEMO-UNITE-01');
    const r1 = this.relations.declare(owner, {
      objectId: 'OBJ-DEMO-PARCELLE-01', role: 'PROPRIETAIRE', from: '2019-05-02',
      proofs: [{ type: 'CERTIFICAT_ENREGISTREMENT', reference: 'CE-DEMO-0001 (pièce fictive)' }],
    });
    this.relations.validate(controller, r1.id, { approve: true, reason: 'Certificat d’enregistrement concordant (démonstration).' });

    // 2. Bâtiment en copropriété recensé sans redevable : quotes-parts 60 / 40 ; le premier propriétaire validé
    //    devient redevable principal (revendication d'un objet provisoire).
    const bat = ctx.objects.create(agentLimete, {
      category: 'BATIMENT', commune: 'Limete', quartier: 'Industriel', avenue: 'Avenue de démonstration', localityRank: 2,
      lat: -4.3655, lon: 15.3502, attributes: { niveaux: '3', usage: 'mixte', demo: true },
    }, 'OBJ-FISC-DEMO-COPRO-01');
    this.properties.validateObject(controller, bat.id);
    for (const [who, share] of [[owner, '60'], [tenant, '40']] as const) {
      const r = this.relations.declare(who, { objectId: bat.id, role: 'COPROPRIETAIRE', share, from: '2021-03-01', proofs: [{ type: 'ACTE_DE_VENTE', reference: `AV-DEMO-${share} (pièce fictive)` }] });
      this.relations.validate(controller, r.id, { approve: true, reason: 'Acte de vente notarié concordant (démonstration).' });
    }

    // 3. Parcelle recensée sans rattachement, revendiquée par la locataire (file de validation des agents).
    const claim = ctx.objects.create(agentLimete, {
      category: 'PARCELLE', commune: 'Limete', quartier: 'Mombele', avenue: 'Avenue de démonstration 2', localityRank: 2,
      lat: -4.3768, lon: 15.3383, attributes: { superficie_m2: '420', demo: true },
    }, 'OBJ-FISC-DEMO-LIM-CLAIM');
    this.relations.declare(tenant, { objectId: claim.id, role: 'HERITIER_PRESUME', from: '2024-08-01', proofs: [{ type: 'ACTE_SUCCESSORAL', reference: 'Jugement d’hérédité fictif n° DEMO-77' }] });

    // 4. Recensement de démonstration (Limete, Lemba, Matete) : couverture et situation pour la carte.
    const quartiers: Record<string, string[]> = { Limete: ['Kingabwa', 'Mombele', 'Industriel'], Lemba: ['Salongo', 'Righini'], Matete: ['Tomba'] };
    const counts: Record<string, number> = { Limete: 22, Lemba: 6, Matete: 4 };
    const base: Record<string, [number, number]> = { Limete: [-4.372, 15.345], Lemba: [-4.405, 15.318], Matete: [-4.387, 15.335] };
    const agentOf = (_c: string) => agentLimete;
    let n = 0;
    for (const [commune, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i++) {
        n++;
        const [lat0, lon0] = base[commune]!;
        const qs = quartiers[commune]!;
        // Répartition déterministe (pas d'aléa) pour des démonstrations reproductibles.
        const lat = Number((lat0 + ((i * 37) % 23 - 11) * 0.0011).toFixed(5));
        const lon = Number((lon0 + ((i * 53) % 19 - 9) * 0.0012).toFixed(5));
        const o = ctx.objects.create(agentOf(commune), {
          category: i % 5 === 4 ? 'ACTIVITE' : i % 3 === 2 ? 'BATIMENT' : 'PARCELLE',
          commune, quartier: qs[i % qs.length]!, localityRank: 2, lat, lon,
          attributes: { superficie_m2: String(250 + ((i * 97) % 600)), demo: true },
        }, `OBJ-FISC-DEMO-${String(n).padStart(3, '0')}`);
        if (i % 3 === 0) this.properties.validateObject(controller, o.id);
      }
    }

    // 5. Contribuables fictifs avec obligations (règle DEMO active) : échéance dépassée simulée → rouge après vérification.
    const tpA = ctx.taxpayers.register({ phone: '+243830000101', fullName: 'Contribuable fictif A (démo)', language: 'fr', situation: 'owner_occupier' }, 'TP-FISC-DEMO-01');
    const tpB = ctx.taxpayers.register({ phone: '+243830000102', fullName: 'Contribuable fictif B (démo)', language: 'fr', situation: 'landlord' }, 'TP-FISC-DEMO-02');
    for (const [tp, id] of [[tpA, 'OBJ-FISC-DEMO-001'], [tpB, 'OBJ-FISC-DEMO-004']] as const) {
      const r = this.relations.declare(u('u-guichet'), { taxpayerId: tp.id, objectId: id, role: 'PROPRIETAIRE', from: '2018-01-01', proofs: [{ type: 'TITRE_FONCIER', reference: `TF-DEMO-${tp.id} (pièce fictive)` }] });
      this.relations.validate(controller, r.id, { approve: true, reason: 'Titre foncier concordant (démonstration).' });
    }
    // Exonération approuvée (circuit complet, quatre yeux) pour B, puis liquidation qui l'applique.
    // Initiateur (contrôleur) ≠ instructeur (guichet) ≠ juriste ≠ décideur.
    const exo = this.exemptions.request(u('u-controleur'), {
      taxpayerId: tpB.id, kind: 'EXONERATION', objectId: 'OBJ-FISC-DEMO-004', ruleCode: 'DEMO-IF-BATI', rate: '50',
      grounds: 'Exemple fictif : immeuble affecté partiellement à une œuvre sociale reconnue.',
      proofs: [{ type: 'DECISION_RECONNAISSANCE', reference: 'Décision fictive DEMO-OS-12' }],
      legalBasis: { instrumentId: 'demo-instrument-001', article: 'Article 2 (fictif)' }, validFrom: this.d.today(), validTo: `${this.d.today().slice(0, 4)}-12-31`,
    });
    this.exemptions.instruct(u('u-guichet'), exo.id, { decision: 'FAVORABLE', reason: 'Pièces complètes (démonstration).' });
    this.exemptions.legalVisa(u('u-juriste-verificateur'), exo.id, { decision: 'FAVORABLE', reason: 'Fondement vérifié dans le registre (instrument fictif).' });
    this.exemptions.decide(u('u-fiscal-chef-service'), exo.id, { decision: 'APPROUVEE', reason: 'Conditions réunies (démonstration).' });
    const demoRule = ctx.rules.list().find((r) => r.code === 'DEMO-IF-BATI' && r.status === 'ACTIVE');
    if (demoRule) {
      const a = ctx.assessment.calculate(controller, { ruleId: demoRule.id, taxpayerId: tpA.id, objectId: 'OBJ-FISC-DEMO-001', inputs: {}, simulate: false });
      // Vieillissement SIMULÉ pour la démonstration de la couleur rouge (aucune pénalité, aucune mesure).
      if (a.obligation) ctx.assessment.setStatus(a.obligation.id, 'EN_RETARD');
      ctx.assessment.calculate(controller, { ruleId: demoRule.id, taxpayerId: tpB.id, objectId: 'OBJ-FISC-DEMO-004', inputs: {}, simulate: false });
    }

    // 6. Demande d'exonération en attente (file des agents) pour le contribuable de démonstration.
    this.exemptions.request(owner, {
      kind: 'EXONERATION', objectId: 'OBJ-DEMO-PARCELLE-01', ruleCode: 'DEMO-IF-BATI', rate: '100',
      grounds: 'Exemple fictif : bien affecté à un usage d’intérêt général.', proofs: [{ type: 'ATTESTATION', reference: 'Attestation fictive DEMO-AIG-3' }],
      validFrom: `${Number(this.d.today().slice(0, 4)) + 1}-01-01`, validTo: `${Number(this.d.today().slice(0, 4)) + 1}-12-31`,
    });

    // 7. Déclaration IRL pré-remplie déposée (règle À VÉRIFIER ⇒ simulation non opposable), quitus et attestation de bail.
    const pre = this.declarations.prefill(owner, { objectId: 'OBJ-DEMO-UNITE-01', kind: 'IRL', period: this.d.today().slice(0, 4) });
    this.declarations.file(owner, { objectId: 'OBJ-DEMO-UNITE-01', kind: 'IRL', period: pre.period, inputs: {}, attest: true });
    this.clearances.request(owner);
    this.clearances.issueLeaseAttestation(tenant, 'BAIL-DEMO-0001');

    // 8. Anomalies locatives (§ 16.4) — protocole FICTIF de démonstration (aucune valeur juridique), données fictives.
    const dg = u('u-fiscal-directeur');
    const proto = this.anomalies.proposeProtocol(u('u-fiscal-chef-service'), {
      source: 'COMPTEURS', partner: 'Distributeur fictif (démo)', actReference: 'PROTOCOLE-FICTIF-DEMO-01 (aucune valeur juridique)',
      purpose: 'Démonstration du rapprochement compteurs ↔ déclarations locatives', validFrom: this.d.today(), validTo: `${Number(this.d.today().slice(0, 4)) + 1}-12-31`,
    });
    this.anomalies.decideProtocol(dg, proto.id, { approve: true, reason: 'Démonstration : protocole fictif.' });
    this.anomalies.ingest(dg, 'COMPTEURS', [
      { objectRef: 'OBJ-FISC-DEMO-COPRO-01', meters: 4, utility: 'ELECTRICITE', period: `${this.d.today().slice(0, 4)}-T2` },
      { objectRef: 'OBJ-FISC-DEMO-002', meters: 1, utility: 'EAU', period: `${this.d.today().slice(0, 4)}-T2` },
    ]);
    this.anomalies.detect(controller);
  }
}
