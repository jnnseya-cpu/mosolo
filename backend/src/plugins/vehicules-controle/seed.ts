/**
 * Données de DÉMONSTRATION de la chaîne véhicule — fictives, non contractuelles, marquées [EXEMPLE].
 * Aucune personne réelle, aucun nom de dirigeant, aucun numéro de téléphone ni contact de la RFCK : les contacts de
 * l'entité restent vides, modifiables par l'administrateur d'entité seulement. Les centres portent des noms [EXEMPLE]
 * (jamais ceux des sociétés réelles). Aucune fiche de frais n'est active : les frais restent « acte requis ».
 */
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { DEMO } from '../../seed.js';
import { addDays } from './common.js';
import { ARRETE_CT, CT_POINTS, MODULES_VEHICULES, NOTE_NUMEROTATION, RFCK, RULE_CODES, type CtPointResult } from './model.js';
import type { VehiculesControleService } from './service.js';

export const VC_DEMO = {
  users: {
    dg: 'vc-u-direction-rfck', chef: 'vc-u-chef-service-rfck', admin: 'vc-u-admin-rfck', controleur: 'vc-u-controleur-rfck', agentFourriere: 'vc-u-agent-fourriere-rfck',
    ministre: 'vc-u-ministre-transports', centre1: 'vc-u-centre-ex-01', centre2: 'vc-u-centre-ex-02', gardien: 'vc-u-gardien-ex-01', dpo: 'vc-u-dpo',
  },
  centres: { ct1: 'CENTRE-CT-EX-01', ct2: 'CENTRE-CT-EX-02', fourriere: 'OPERATEUR-FOURRIERE-EX-01' },
  site: 'FRR-EX-01',
  plates: { aJour: 'KN-2026-CT', echu: 'KN-1999-EC', fourriere: 'KN-7788-FR' },
} as const;

/** JPEG minimal de démonstration (octets fictifs, marqueur SOI). */
export function demoJpeg(seed: string): { imageBase64: string; sha256: string } {
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`EXEMPLE-${seed}`), Buffer.from([0xff, 0xd9])]);
  return { imageBase64: buf.toString('base64'), sha256: createHash('sha256').update(buf).digest('hex') };
}

/** Fiche du registre juridique amorcée A_VERIFIER : table de taux vide, jamais exécutable en l'état. */
function sheet(code: string, label: string, baseDefinition: string, formula: string) {
  return {
    id: `rule-${code.toLowerCase()}-v1`, code, version: 1, revenueCategory: 'REDEVANCE_SERVICE' as const, label, legalInstrumentIds: [ARRETE_CT.id],
    articles: ['Arrêté du 12 novembre 2025 et acte tarifaire à certifier [À VÉRIFIER]'], competentAuthority: 'Ministère provincial des Transports et de la Mobilité urbaine (acte requis)',
    administeringEntity: RFCK.id, taxableEvent: label, liableParty: 'Propriétaire ou détenteur du véhicule', baseDefinition, formula, rateTable: {}, currency: 'CDF' as const, rounding: 'HALF_UP' as const,
    periodicity: 'PONCTUELLE' as const, dueRule: 'Avant la sortie du véhicule [À VÉRIFIER]', exemptions: [], penalties: [], effectiveFrom: '2026-01-01',
    beneficiaryAccountAlias: 'Compte public de la RFCK — à désigner au coffre', appealPath: 'Réclamation auprès de la RFCK puis autorité de décision contentieuse',
    status: 'A_VERIFIER' as const, sourceVerification: 'AUCUNE' as const, approvals: [], sourceReference: 'Cahier — chapitre 18 (RFCK, contrôle technique, chaîne véhicule)',
    readingNote: 'Tarif NON renseigné : aucun montant tant que l’acte n’est pas lu, certifié et la fiche ACTIVE (quatre visas).',
  };
}

export function seedVehicules(ctx: AppContext, svc: VehiculesControleService): void {
  const at = ctx.clock.now().toISOString();
  const today = at.slice(0, 10);
  const U = VC_DEMO.users;
  const add = (u: Parameters<AppContext['users']['add']>[0]) => { if (!ctx.users.get(u.id)) ctx.users.add(u); };
  add({ id: U.dg, name: 'Direction générale — RFCK (démo)', roles: ['R06'], entity: RFCK.id });
  add({ id: U.chef, name: 'Chef de service contrôle technique — RFCK (démo)', roles: ['R07'], entity: RFCK.id });
  add({ id: U.admin, name: 'Administrateur d’entité — RFCK (démo)', roles: ['R08'], entity: RFCK.id });
  add({ id: U.controleur, name: 'Contrôleur routier — RFCK (démo)', roles: ['R11'], entity: RFCK.id });
  add({ id: U.agentFourriere, name: 'Agent de fourrière — RFCK (démo)', roles: ['R10'], entity: RFCK.id });
  add({ id: U.ministre, name: 'Ministre provincial des Transports et de la Mobilité urbaine (démo)', roles: ['R04'], entity: RFCK.tutelleEntity });
  add({ id: U.centre1, name: 'Opérateur — Centre de contrôle [EXEMPLE] n° 1 (démo)', roles: ['R34'], entity: VC_DEMO.centres.ct1 });
  add({ id: U.centre2, name: 'Opérateur — Centre de contrôle [EXEMPLE] n° 2 (démo)', roles: ['R34'], entity: VC_DEMO.centres.ct2 });
  add({ id: U.gardien, name: 'Gardien — Opérateur de fourrière [EXEMPLE] (démo)', roles: ['R35'], entity: VC_DEMO.centres.fourriere });
  add({ id: U.dpo, name: 'Délégué à la protection des données (démo)', roles: ['R25'], entity: 'PLATEFORME' });
  const u = (id: string) => ctx.users.get(id)! as User;

  // Texte (registre des instruments) et fiches de frais A_VERIFIER.
  if (!ctx.rules.instruments.get(ARRETE_CT.id)) ctx.rules.instruments.insert({ id: ARRETE_CT.id, title: ARRETE_CT.title, status: 'A_VERIFIER', note: `Champ : ${ARRETE_CT.scope.join(' ; ')}.` });
  const sheets = [
    sheet(RULE_CODES.redevanceCt, 'Redevance de contrôle technique', 'Contrôle technique réalisé (par catégorie de véhicule)', 'quantite * tarif'),
    sheet(RULE_CODES.enlevement, 'Frais d’enlèvement (fourrière)', 'Enlèvement exécuté sur décision de l’autorité compétente', 'quantite * tarif'),
    sheet(RULE_CODES.gardiennage, 'Frais de gardiennage (fourrière)', 'Jours de garde entamés, comptés depuis les horodatages d’entrée et de sortie', 'jours * tarif_jour'),
  ];
  for (const s of sheets) if (!ctx.rules.rules.find((r) => r.code === s.code).length) ctx.rules.rules.insert({ ...s, createdAt: at, sample: true } as never);

  // Espace d'entité RFCK et fiches des trois modules (module d'accès, s'il est chargé).
  const acces = ctx.ext['acces'] as { entities?: { get(id: string): unknown; insert(x: unknown): unknown }; modules?: { get(id: string): unknown; insert(x: unknown): unknown } } | undefined;
  if (acces?.entities && !acces.entities.get(RFCK.id)) {
    acces.entities.insert({ id: RFCK.id, name: RFCK.name, shortName: RFCK.shortName, kind: 'REGIE', parentId: RFCK.tutelleEntity, status: 'ACTIVE', createdAt: at, createdBy: 'u-superadmin', decisionRef: `${RFCK.nature} — tutelle : ${RFCK.tutelle}`, demo: true });
    for (const m of MODULES_VEHICULES) {
      acces.modules?.insert({
        id: `MOD-VC-${m.numero}`, code: m.code, label: `${m.numero}. ${m.label} (${NOTE_NUMEROTATION})`, revenueScope: m.code, responsibleEntity: RFCK.id, beneficiaryAliases: [],
        objectTypes: ['VEHICULE'], ruleCodes: m.numero === 83 ? [RULE_CODES.enlevement, RULE_CODES.gardiennage] : m.numero === 82 ? [RULE_CODES.redevanceCt] : [], credentialTypes: m.numero === 82 ? ['Vignette technique sécurisée'] : [],
        validityModel: m.numero === 82 ? 'ANNUEL' : 'SANS_TITRE', proofMechanisms: m.numero === 82 ? ['VIGNETTE', 'QR_STATIQUE', 'PLAQUE'] : ['RECU_IMPRIME'], usageRules: 'Aucun paiement en espèces ; décision humaine motivée pour toute mesure.',
        channels: ['APPLICATION', 'USSD', 'TERMINAL'], fieldWorkflows: m.numero === 83 ? ['Constat et immobilisation', 'Entrée et inventaire contradictoire', 'Sortie sur quittance appariée'] : ['Contrôle par plaque ou QR'],
        dashboards: ['Chaîne véhicule — indicateurs'], dependencies: m.numero === 82 ? ['Contrôle technique valide (dépendance INFORMATIVE jusqu’à l’acte)'] : [], sharedReadWith: ['DGIPK'],
        actReferences: [ARRETE_CT.title], status: 'VALIDATION_JURIDIQUE', visas: [{ step: 'SOUMISSION', by: U.admin, role: 'R08', at }], history: [{ at, from: null, to: 'BROUILLON', by: U.admin }],
        attachments: [], createdBy: U.admin, createdAt: at, demo: true,
      });
    }
  }

  // Centres [EXEMPLE] : circuit complet d'agrément (invitation → dossier → diligences → proposition → décision).
  const accredit = (id: string, kind: 'CONTROLE_TECHNIQUE' | 'FOURRIERE_OPERATEUR', name: string, commune: string, lat: number, lon: number, member: string, activities: ('CONTROLE_TECHNIQUE' | 'EMISSION_VIGNETTES' | 'GARDIENNAGE' | 'ENROLEMENT')[], quotas: { stockVignettes: number; inspectionsParJour: number }) => {
    const r = svc.centres.invite(u(U.chef), { kind, name, commune, lat, lon, categories: ['PARTICULIER', 'ENTREPRISE', 'MISSION_DIPLOMATIQUE_OI', 'MOTO_2_ROUES', 'MOTO_3_ROUES', 'MOTO_4_ROUES', 'ADMINISTRATIF_MOINS_20T', 'REMORQUE'], activities, declaredHours: { open: '07:00', close: '18:00' } }, { exemple: true, fixedId: id });
    svc.centres.submitDossier(u(member), id, { invitationCode: r.invitationCode, legalExistence: 'RCCM [EXEMPLE] — fictif', quitusRef: 'Quitus [EXEMPLE] — fictif', conflictDeclaration: 'Aucun conflit déclaré (fictif)', linksWithOfficials: 'Aucun (fictif)' });
    svc.centres.recordDiligence(u(U.chef), id, [
      { code: 'EXISTENCE_LEGALE', label: 'Existence légale', ok: true }, { code: 'QUITUS', label: 'Quitus fiscal à jour', ok: true },
      { code: 'CONFLITS', label: 'Absence de conflit d’intérêts', ok: true }, { code: 'EQUIPEMENTS', label: 'Équipements et personnel', ok: true },
    ]);
    svc.centres.propose(u(U.chef), id, { motif: 'Diligences satisfaites (démonstration)', habilitation: { from: addDays(today, -60), to: addDays(today, 305) }, quotas });
    svc.centres.decide(u(U.dg), id, { approve: true, motif: 'Agrément de démonstration [EXEMPLE] — non contractuel' });
  };
  accredit(VC_DEMO.centres.ct1, 'CONTROLE_TECHNIQUE', 'Centre de contrôle technique [EXEMPLE] — Limete', 'Limete', -4.37, 15.34, U.centre1, ['CONTROLE_TECHNIQUE', 'EMISSION_VIGNETTES', 'ENROLEMENT'], { stockVignettes: 50, inspectionsParJour: 40 });
  accredit(VC_DEMO.centres.ct2, 'CONTROLE_TECHNIQUE', 'Centre de contrôle technique [EXEMPLE] — Ngaliema', 'Ngaliema', -4.33, 15.25, U.centre2, ['CONTROLE_TECHNIQUE', 'EMISSION_VIGNETTES'], { stockVignettes: 30, inspectionsParJour: 30 });
  accredit(VC_DEMO.centres.fourriere, 'FOURRIERE_OPERATEUR', 'Opérateur de fourrière [EXEMPLE] — Kingabwa', 'Limete', -4.33, 15.35, U.gardien, ['GARDIENNAGE'], { stockVignettes: 0, inspectionsParJour: 0 });
  svc.ct.issueLot(u(U.chef), { centreId: VC_DEMO.centres.ct1, quantity: 20 }, { demo: true });
  svc.ct.issueLot(u(U.chef), { centreId: VC_DEMO.centres.ct2, quantity: 10 }, { demo: true });

  // Véhicule du contribuable de démonstration (objet VEHICULE du socle) et procès-verbaux [EXEMPLE].
  const owner = DEMO.taxpayerId;
  if (ctx.taxpayers.taxpayers.get(owner)) {
    const obj = ctx.objects.create(u('u-controleur'), { taxpayerId: owner, category: 'VEHICULE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.3312, lon: 15.3471, attributes: { nom: 'Berline [EXEMPLE]', immatriculation: VC_DEMO.plates.aJour, categorie_ct: 'PARTICULIER', demo: true } });
    svc.ct.upsertVehicle({ plate: VC_DEMO.plates.aJour, category: 'PARTICULIER', objectId: obj.id, taxpayerId: owner, commune: 'Limete', source: 'OBJET_MOSOLO' });
  }
  const points = (bad: string[] = []) => Object.fromEntries(CT_POINTS.map((k) => [k, { conforme: !bad.includes(k), ...(bad.includes(k) ? { note: 'Non conforme (démonstration)' } : {}) }])) as Record<string, CtPointResult>;
  const minus = (min: number) => new Date(Date.parse(at) - min * 60_000).toISOString();
  const pv1 = svc.ct.submitPv(u(U.centre1), { centreId: VC_DEMO.centres.ct1, plate: VC_DEMO.plates.aJour, category: 'PARTICULIER', inspecteur: 'INSP-EX-01', startedAt: minus(55), endedAt: minus(20), points: points(), result: 'FAVORABLE', echeance: addDays(today, 180) }, { demo: true });
  const firstSticker = svc.ct.stickers.find((s) => s.centreId === VC_DEMO.centres.ct1 && s.status === 'EN_STOCK')[0]!;
  svc.ct.assignSticker(u(U.centre1), { number: firstSticker.number, pvId: pv1.id });
  svc.ct.upsertVehicle({ plate: VC_DEMO.plates.echu, category: 'ENTREPRISE', commune: 'Gombe', source: 'REGISTRE_RFCK' });
  svc.ct.submitPv(u(U.centre2), { centreId: VC_DEMO.centres.ct2, plate: VC_DEMO.plates.echu, category: 'ENTREPRISE', inspecteur: 'INSP-EX-07', startedAt: minus(45), endedAt: minus(10), points: points(['PNEUMATIQUES', 'DIODES_NON_HOMOLOGUEES']), result: 'DEFAVORABLE', echeance: addDays(today, 30) }, { demo: true });

  // Mode courtoisie [EXEMPLE] : paramètre daté (tricycles à Nsele), décidé par l'autorité compétente.
  svc.ct.decideCourtesy(u(U.ministre), { categories: ['MOTO_3_ROUES'], communes: ['Nsele'], from: addDays(today, -3), to: addDays(today, 30), authority: 'Ministre provincial des Transports (démo)', decisionRef: 'Décision [EXEMPLE] n° DEMO-COURT-01 — fictive', reason: 'Phase d’information [EXEMPLE]' }, { exemple: true });

  // Fourrière [EXEMPLE] : site géolocalisé, un dossier en garde (frais « acte requis »).
  svc.fourriere.createSite(u(U.chef), { name: 'Fourrière [EXEMPLE] — Kingabwa', commune: 'Limete', lat: -4.3301, lon: 15.3522, capacity: 40, operatorCentreId: VC_DEMO.centres.fourriere }, { demo: true, fixedId: VC_DEMO.site });
  svc.ct.upsertVehicle({ plate: VC_DEMO.plates.fourriere, category: 'PARTICULIER', commune: 'Gombe', source: 'REGISTRE_RFCK' });
  const x = svc.fourriere.constat(u(U.controleur), { plate: VC_DEMO.plates.fourriere, motifLegal: 'Stationnement gênant sur voie publique [EXEMPLE]', commune: 'Gombe', etat: 'Carrosserie rayée côté gauche (démonstration)', gps: { lat: -4.3052, lon: 15.3083, accuracyM: 8 }, photos: [{ slot: 'VEHICULE', ...demoJpeg('constat-1') }] }, { demo: true });
  svc.fourriere.decideRemoval(u(U.chef), x.id, { motifLegal: 'Stationnement gênant [EXEMPLE]', legalBasis: 'Acte de police de la circulation [À VÉRIFIER]', source: { kind: 'DECISION_AUTORITE', ref: 'Décision [EXEMPLE] DEMO-ENL-01' } });
  svc.fourriere.entry(u(U.gardien), x.id, {
    siteId: VC_DEMO.site, photos: (['AVANT', 'ARRIERE', 'GAUCHE', 'DROITE', 'INTERIEUR'] as const).map((slot) => ({ slot, ...demoJpeg(`entree-${slot}`) })),
    conditionReport: 'Rayure côté gauche ; pneus en bon état (démonstration)', inventory: [{ label: 'Roue de secours', quantity: 1 }, { label: 'Triangle', quantity: 1 }], contradictoire: { kind: 'TEMOIN', ref: 'Témoin [EXEMPLE] T-01' },
  });

  // Convention [EXEMPLE] enregistrée, conformité à vérifier : aucun flux n'est ouvert.
  svc.raccordement.recordConvention(u(U.dg), { flow: 'PROCES_VERBAUX', reference: 'Convention [EXEMPLE] RFCK–Ville n° DEMO-01 (fictive)', signedOn: today, signatories: 'Signataires [EXEMPLE]', documentSha256: createHash('sha256').update('convention-exemple').digest('hex') }, { exemple: true });
}
