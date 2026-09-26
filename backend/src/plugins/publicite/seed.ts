/**
 * Données de DÉMONSTRATION KIN PUB CONTROL (fictives, non opposables) : exploitant fictif, dispositifs, autorisations
 * à différents stades, règle de liquidation FICTIVE publiée par le circuit à quatre visas, inspecteur accrédité,
 * constats et dossiers en cours.
 */
import type { AppContext } from '../../context.js';
import { DAY_MS, isoDate } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';
import { demoPay, DEMO_INSTRUMENT, DGTK, DGTK_ALIAS, publishDemoRule } from '../parking/support.js';
import { AD_TAX_RULE, type PubliciteService } from './service.js';

export const PUB_DEMO = {
  advertiserTaxpayerId: 'TP-PUB-0001',
  inspectorCommunes: ['Gombe', 'Lingwala', 'Barumbu', 'Kinshasa'],
} as const;

export function seedPublicite(ctx: AppContext, svc: PubliciteService): void {
  const add = (u: Parameters<typeof ctx.users.add>[0]) => ctx.users.get(u.id) ?? ctx.users.add(u);
  const instructeur = add({ id: 'pb-instructeur', name: 'Instructeur des autorisations publicitaires — DGTK (démo)', roles: ['R07'], entity: DGTK });
  const autorite = add({ id: 'pb-autorite', name: 'Autorité de décision publicité — DGTK (démo)', roles: ['R06'], entity: DGTK });
  const inspecteur = add({ id: 'pb-inspecteur', name: 'Inspectrice publicité accréditée (démo)', roles: ['R11'], entity: DGTK, territory: [...PUB_DEMO.inspectorCommunes] });
  add({ id: 'pb-inspecteur-2', name: 'Contrôleur publicité non accrédité (démo)', roles: ['R11'], entity: DGTK, territory: ['Gombe'] });
  const superviseur = add({ id: 'pb-superviseur', name: 'Superviseur des inspections publicitaires (démo)', roles: ['R09'], entity: DGTK, territory: [...PUB_DEMO.inspectorCommunes] });
  if (!ctx.taxpayers.taxpayers.get(PUB_DEMO.advertiserTaxpayerId)) {
    ctx.taxpayers.register({ phone: '+243890000201', fullName: 'Affiches du Fleuve SARL (exploitant fictif)', language: 'fr', situation: 'business_tenant', email: 'affiches.demo@example.cd' }, PUB_DEMO.advertiserTaxpayerId);
  }
  const annonceur = add({ id: 'pb-annonceur', name: 'Affiches du Fleuve SARL — exploitant publicitaire (fictif)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: PUB_DEMO.advertiserTaxpayerId, lang: 'fr' });

  publishDemoRule(ctx, {
    code: AD_TAX_RULE, revenueCategory: 'PROVINCIAL_SPECIFIQUE',
    label: 'DÉMONSTRATION — taxe annuelle sur la publicité extérieure (barème fictif, non opposable)',
    legalInstrumentIds: [DEMO_INSTRUMENT], articles: ['Article 1 (fictif)'], competentAuthority: 'Gouvernorat — Finances (démonstration)', administeringEntity: DGTK,
    taxableEvent: 'Exploitation d’un dispositif publicitaire autorisé (démonstration)', liableParty: 'Exploitant du dispositif',
    baseDefinition: 'Surface d’une face (m²) × nombre de faces × (tarif du rang + supplément si éclairé ou numérique)',
    formula: 'surface_m2 * faces * (tarif_m2 + eclaire * supplement_eclairage_m2)',
    rateTable: { 'tarif_m2:1': '15000', 'tarif_m2:2': '10000', 'tarif_m2:3': '5000', 'tarif_m2:4': '5000', supplement_eclairage_m2: '5000' },
    currency: 'CDF', rounding: 'HALF_UP', periodicity: 'ANNUELLE', dueRule: '30 jours après la décision d’autorisation (démonstration)',
    exemptions: [], penalties: [], effectiveFrom: '2026-01-01', beneficiaryAccountAlias: DGTK_ALIAS,
    appealPath: 'Réclamation auprès de la DGTK via MOSOLO (démonstration)', sourceVerification: 'OFFICIEL_CERTIFIE',
  });

  const now = ctx.clock.now().getTime();
  const day = (n: number) => isoDate(new Date(now + n * DAY_MS));
  svc.grantAccreditation(autorite, { userId: inspecteur.id, communes: [...PUB_DEMO.inspectorCommunes], validFrom: day(-60), validUntil: day(270) });

  const piece = (kind: 'PLAN_SITUATION' | 'PHOTO_MONTAGE' | 'TITRE_OCCUPATION', name: string) => ({ kind, name, sha256: sha256Hex(`piece-demo-${name}`) });
  const photo = (s: string) => sha256Hex(`photo-demo-${s}`);

  // D1 : panneau autorisé et payé.
  const d1 = svc.declareDevice(annonceur, {
    type: 'PANNEAU', widthM: '4.00', heightM: '3.00', faces: 2, lighting: 'ECLAIRE', commune: 'Gombe', quartier: 'Boulevard du 30 Juin',
    address: 'Bd du 30 Juin, face au n° fictif 12', localityRank: 1, lat: -4.3032, lon: 15.3071, photos: [photo('d1')],
  });
  const r1 = svc.submitRequest(annonceur, { deviceId: d1.id, periodFrom: day(-30), periodTo: day(335), pieces: [piece('PLAN_SITUATION', 'plan-d1.pdf'), piece('PHOTO_MONTAGE', 'montage-d1.jpg')] });
  svc.instruct(instructeur, r1.id, { action: 'PROPOSER', proposal: 'ACCORDER', analysis: 'Dossier complet ; emplacement compatible (démonstration).' });
  const g1 = svc.decideRequest(autorite, r1.id, { outcome: 'ACCORDEE', reason: 'Conforme au règlement fictif de démonstration.' });
  if (g1.liquidation?.obligationId) demoPay(ctx, annonceur, g1.liquidation.obligationId);

  // D2 : enseigne déclarée, demande déposée (en attente d'instruction).
  const d2 = svc.declareDevice(annonceur, {
    type: 'ENSEIGNE', widthM: '2.00', heightM: '1.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: 'Avenue du Commerce',
    address: 'Av. du Commerce, n° fictif 45', localityRank: 1, lat: -4.3068, lon: 15.3129, photos: [photo('d2')],
  });
  svc.submitRequest(annonceur, { deviceId: d2.id, periodFrom: day(1), periodTo: day(365), pieces: [piece('TITRE_OCCUPATION', 'bail-d2.pdf')] });

  // D3 : écran numérique autorisé, échéance proche, droits impayés.
  const d3 = svc.declareDevice(annonceur, {
    type: 'ECRAN_NUMERIQUE', widthM: '6.00', heightM: '3.00', faces: 1, lighting: 'NUMERIQUE', commune: 'Lingwala', quartier: 'Avenue des Aviateurs',
    address: 'Carrefour fictif des Aviateurs', localityRank: 2, lat: -4.3151, lon: 15.3016, photos: [photo('d3')],
  });
  const r3 = svc.submitRequest(annonceur, { deviceId: d3.id, periodFrom: day(-345), periodTo: day(20), pieces: [piece('PLAN_SITUATION', 'plan-d3.pdf')] });
  svc.instruct(instructeur, r3.id, { action: 'PROPOSER', proposal: 'ACCORDER', analysis: 'Écran conforme aux prescriptions fictives de luminosité.' });
  svc.decideRequest(autorite, r3.id, { outcome: 'ACCORDEE', reason: 'Autorisation annuelle (démonstration).' });

  // Inspections : conforme (QR lu), non déclaré (support recensé), non conforme vérifié en attente de décision.
  svc.inspect(inspecteur, {
    deviceId: d1.id, qrScanned: svc.getDevice(d1.id).qrToken, finding: 'CONFORME', photos: [photo('i1')], lat: -4.30321, lon: 15.30712, gpsAccuracyM: 5,
    ocrText: `${svc.getDevice(d1.id).reference} ${r1.reference}`, observations: 'Plaque QR présente et lisible (démonstration).',
  });
  svc.inspect(inspecteur, {
    finding: 'NON_DECLARE', photos: [photo('i2a'), photo('i2b')], lat: -4.3102, lon: 15.3213, gpsAccuracyM: 7, presumedOperator: 'Mention « Régie Horizon » (fictive) visible',
    newDevice: { type: 'BACHE', widthM: '8.00', heightM: '4.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Barumbu', quartier: 'Bon Marché', address: 'Façade fictive, avenue Kabinda', localityRank: 2 },
    observations: 'Bâche sans plaque QR ; aucune autorisation retrouvée (démonstration).',
  });
  const nc = svc.inspect(inspecteur, {
    deviceId: d3.id, finding: 'NON_CONFORME', photos: [photo('i3')], lat: -4.31512, lon: 15.30158, gpsAccuracyM: 4,
    observations: 'Dimensions apparentes supérieures à la déclaration (≈ 7 × 3 m) (démonstration).',
  });
  if (nc.case) svc.verifyCase(superviseur, nc.case.id, { confirm: true, note: 'Mesure au télémètre cohérente avec les photographies (démonstration).' });
}
