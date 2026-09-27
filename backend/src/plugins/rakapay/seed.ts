/**
 * Données de DÉMONSTRATION RakaPay / wewa — toutes FICTIVES et non opposables.
 * Les tarifs sont portés par deux règles FICTIVES publiées par le circuit complet (quatre visas distincts, marquées demo) :
 * le montant de 500 FC par jour reprend l'illustration [EXEMPLE] du § H.27.16.1 ; semaine et mois = 7 et 30 jours.
 * Les paiements de démonstration passent par le VRAI circuit : ordre de paiement puis rappel prestataire signé HMAC.
 */
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { hmacSha256Hex } from '../../core/crypto.js';
import type { RuleInput } from '../../modules/rules/service.js';
import type { RakaPayService, WewaDuration } from './service.js';
import { BUS_RULE, MODULE_WEWA, RAKAPAY_ENTITY, WEWA_RULE } from './service.js';

export const RK_DEMO = {
  driverUser: 'rk-conducteur',
  driver2User: 'rk-conducteur-2',
  coopUser: 'rk-coop-kalamu',
  controllerUser: 'rk-controleur',
  managerUser: 'rk-responsable',
  driverTaxpayer: 'TP-RK-WEWA-0001',
  driver2Taxpayer: 'TP-RK-WEWA-0002',
  coopTaxpayer: 'TP-RK-COOP-0001',
  device: 'dev-rakapay-01',
  deviceKey: 'demo-device-key-rakapay-01',
  dgtkAlias: 'KIN-DGTK-RECETTES-01',
} as const;

function publishDemoRule(ctx: AppContext, input: Omit<RuleInput, 'beneficiaryAccountAlias' | 'legalInstrumentIds' | 'articles' | 'sourceVerification' | 'exemptions' | 'penalties' | 'effectiveFrom' | 'rounding' | 'currency' | 'competentAuthority' | 'administeringEntity' | 'appealPath' | 'dueRule'>): void {
  if (ctx.rules.rules.findOne((r) => r.code === input.code)) return;
  const drafter = ctx.users.get('u-juriste-redacteur');
  const checker = ctx.users.get('u-juriste-verificateur');
  const finance = ctx.users.get('u-validateur-financier');
  const publisher = ctx.users.get('u-autorite-publication');
  if (!drafter || !checker || !finance || !publisher || !ctx.rules.instrument('demo-instrument-001') || !ctx.vault.aliasExists(RK_DEMO.dgtkAlias)) return;
  const rule = ctx.rules.create(drafter, {
    ...input, legalInstrumentIds: ['demo-instrument-001'], articles: ['Article 1 (fictif)'],
    competentAuthority: 'Ministère provincial des Transports (démonstration)', administeringEntity: RAKAPAY_ENTITY,
    currency: 'CDF', rounding: 'HALF_UP', dueRule: 'Payable à l’achat (démonstration)', exemptions: [], penalties: [],
    effectiveFrom: '2026-01-01', beneficiaryAccountAlias: RK_DEMO.dgtkAlias,
    appealPath: 'Réclamation via MOSOLO auprès de l’entité responsable du module (démonstration)', sourceVerification: 'OFFICIEL_CERTIFIE',
  });
  ctx.rules.approve(drafter, rule.id, 'REDACTEUR');
  ctx.rules.approve(checker, rule.id, 'VERIFICATEUR_JURIDIQUE');
  ctx.rules.approve(finance, rule.id, 'VALIDATEUR_FINANCIER');
  ctx.rules.approve(publisher, rule.id, 'AUTORITE_PUBLICATION');
  ctx.rules.rules.update({ ...ctx.rules.rules.get(rule.id)!, demo: true });
}

/** Simule le PRESTATAIRE (données de démo) : rappel signé HMAC traité par le circuit commun, jamais un raccourci. */
export function demoProviderConfirm(ctx: AppContext, paymentReference: string): boolean {
  const provider = 'mm-operator-a';
  const secret = ctx.secrets.providerSecrets[provider];
  const order = ctx.payments.byReference(paymentReference);
  if (!secret || !order) return false;
  const now = ctx.clock.now().toISOString();
  const raw = JSON.stringify({ providerTxnId: `DEMO-RK-${randomUUID()}`, paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: now });
  ctx.payments.handleCallback(provider, { signature: hmacSha256Hex(secret, raw), nonce: randomUUID(), timestamp: now }, raw);
  return true;
}

export function seedRakaPay(ctx: AppContext, svc: RakaPayService): void {
  const now = ctx.clock.now().toISOString();
  publishDemoRule(ctx, {
    code: WEWA_RULE, revenueCategory: 'PROVINCIAL_SPECIFIQUE',
    label: 'DÉMONSTRATION — pass professionnel wewa (règle fictive, non opposable ; acte réel requis J28)',
    taxableEvent: 'Exercice du transport de personnes par moto-taxi (démonstration)', liableParty: 'Conducteur (personne désignée par l’acte — démonstration)',
    baseDefinition: 'Nombre de pass jour, semaine, mois', formula: 'jour * pass_jour + semaine * pass_semaine + mois * pass_mois',
    rateTable: { pass_jour: '500', pass_semaine: '3500', pass_mois: '15000' }, periodicity: 'PONCTUELLE',
  });
  publishDemoRule(ctx, {
    code: BUS_RULE, revenueCategory: 'REDEVANCE_SERVICE',
    label: 'DÉMONSTRATION — tickets de bus urbain RakaPay (règle fictive, non opposable ; actes J21/J25 requis)',
    taxableEvent: 'Accès au transport urbain (démonstration)', liableParty: 'Usager', baseDefinition: 'Nombre de tickets par durée',
    formula: 'trajet * t_trajet + j1 * t_j1 + j7 * t_j7 + j30 * t_j30', rateTable: { t_trajet: '500', t_j1: '1500', t_j7: '9000', t_j30: '30000' }, periodicity: 'PONCTUELLE',
  });
  ctx.rules.refresh();

  // Utilisateurs de démonstration du module.
  const users = [
    { id: RK_DEMO.driverUser, name: 'Kabeya Tshibangu (conducteur wewa fictif)', roles: ['R30' as const], entity: 'PUBLIC', taxpayerId: RK_DEMO.driverTaxpayer, lang: 'ln' as const },
    { id: RK_DEMO.driver2User, name: 'Mukendi Ilunga (conducteur wewa fictif)', roles: ['R30' as const], entity: 'PUBLIC', taxpayerId: RK_DEMO.driver2Taxpayer, lang: 'fr' as const },
    { id: RK_DEMO.coopUser, name: 'Coopérative des wewa de Kalamu — gérance (démo)', roles: ['R30' as const], entity: 'PUBLIC', taxpayerId: RK_DEMO.coopTaxpayer, lang: 'fr' as const },
    { id: RK_DEMO.controllerUser, name: 'Contrôleur RakaPay Kalamu–Lemba (démo)', roles: ['R10' as const], entity: RAKAPAY_ENTITY, territory: ['Kalamu', 'Lemba', 'Limete', 'Gombe'] },
    { id: RK_DEMO.managerUser, name: 'Responsable du module RakaPay (démo)', roles: ['R07' as const], entity: RAKAPAY_ENTITY },
  ];
  for (const u of users) if (!ctx.users.get(u.id)) ctx.users.add(u);
  const register = (id: string, phone: string, fullName: string) => {
    if (!ctx.taxpayers.taxpayers.get(id)) ctx.taxpayers.register({ phone, fullName, language: 'fr', situation: 'other' }, id);
  };
  register(RK_DEMO.driverTaxpayer, '+243899100001', 'Kabeya Tshibangu (fictif)');
  register(RK_DEMO.driver2Taxpayer, '+243899100002', 'Mukendi Ilunga (fictif)');
  register(RK_DEMO.coopTaxpayer, '+243899100100', 'Coopérative des wewa de Kalamu (fictive)');
  if (!ctx.field.devices.get(RK_DEMO.device)) ctx.field.enroll(RK_DEMO.device, RK_DEMO.controllerUser, ctx.secrets.deviceKeys[RK_DEMO.device] ?? RK_DEMO.deviceKey);
  // Période de grâce (J28) : les constats y sont marqués pédagogiques [paramètre de démonstration].
  svc.titres.gracePeriods.set(MODULE_WEWA, '2026-10-31');

  // Stations géoréférencées (coordonnées approximatives, démonstration).
  const stations = [
    { id: 'ST-KAL-VICTOIRE', code: 'KAL-001', name: 'Station Rond-point Victoire', commune: 'Kalamu', quartier: 'Matonge', lat: -4.3389, lon: 15.3106, kinds: ['WEWA', 'BUS'] as ('WEWA' | 'BUS')[], estimatedMotos: 180 },
    { id: 'ST-KAL-KIMBANGU', code: 'KAL-002', name: 'Station Kimbangu', commune: 'Kalamu', quartier: 'Kimbangu', lat: -4.3462, lon: 15.3171, kinds: ['WEWA'] as ('WEWA' | 'BUS')[], estimatedMotos: 90 },
    { id: 'ST-LEM-ECHANGEUR', code: 'LEM-001', name: 'Station Échangeur de Limete', commune: 'Limete', quartier: 'Industriel', lat: -4.3712, lon: 15.3441, kinds: ['WEWA', 'BUS'] as ('WEWA' | 'BUS')[], estimatedMotos: 240 },
    { id: 'ST-GOM-GARE', code: 'GOM-001', name: 'Gare centrale', commune: 'Gombe', quartier: 'Gare', lat: -4.3036, lon: 15.3165, kinds: ['BUS'] as ('WEWA' | 'BUS')[] },
    { id: 'ST-LMB-UNIKIN', code: 'LMB-001', name: 'Arrêt Rond-point Ngaba – UNIKIN', commune: 'Lemba', quartier: 'Righini', lat: -4.3985, lon: 15.3118, kinds: ['WEWA', 'BUS'] as ('WEWA' | 'BUS')[], estimatedMotos: 150 },
  ];
  for (const s of stations) if (!svc.stations.get(s.id)) svc.stations.insert({ ...s, status: 'ACTIVE', demo: true });

  const op = (o: { id: string; code: string; name: string; kind: 'PUBLIC' | 'COOPERATIVE' | 'PRIVE'; commune: string; status: 'INVITE' | 'ACCREDITE'; taxpayerId?: string; stationIds: string[] }) => {
    if (!svc.operators.get(o.id)) svc.operators.insert({ ...o, entity: RAKAPAY_ENTITY, decisions: o.status === 'ACCREDITE' ? [{ decision: 'ACCREDITER', motif: 'Accréditation de démonstration (dossier fictif complet)', by: RK_DEMO.managerUser, at: now }] : [], demo: true, createdAt: now });
  };
  op({ id: 'OP-TRANSCO', code: 'TRANSCO', name: 'Transport urbain public (exploitant fictif)', kind: 'PUBLIC', commune: 'Gombe', status: 'ACCREDITE', stationIds: ['ST-GOM-GARE', 'ST-KAL-VICTOIRE', 'ST-LEM-ECHANGEUR', 'ST-LMB-UNIKIN'] });
  op({ id: 'COOP-KALAMU', code: 'COOP-KAL', name: 'Coopérative des wewa de Kalamu (fictive)', kind: 'COOPERATIVE', commune: 'Kalamu', status: 'ACCREDITE', taxpayerId: RK_DEMO.coopTaxpayer, stationIds: ['ST-KAL-VICTOIRE', 'ST-KAL-KIMBANGU'] });
  op({ id: 'COOP-LIMETE', code: 'COOP-LMT', name: 'Association des motocyclistes de Limete (fictive)', kind: 'COOPERATIVE', commune: 'Limete', status: 'INVITE', stationIds: ['ST-LEM-ECHANGEUR'] });

  if (!svc.lines.get('L-01')) svc.lines.insert({ id: 'L-01', code: 'Ligne 1', name: 'Gare centrale → Victoire → Échangeur', operatorId: 'OP-TRANSCO', stationIds: ['ST-GOM-GARE', 'ST-KAL-VICTOIRE', 'ST-LEM-ECHANGEUR'] });
  if (!svc.lines.get('L-02')) svc.lines.insert({ id: 'L-02', code: 'Ligne 2', name: 'Victoire → Rond-point Ngaba – UNIKIN', operatorId: 'OP-TRANSCO', stationIds: ['ST-KAL-VICTOIRE', 'ST-LMB-UNIKIN'] });
  const products = [
    { id: 'PRD-BUS-TRAJET-L1', commercialName: 'Trajet Ligne 1', typeCode: 'RKP-BUS-TRAJET', lineId: 'L-01' },
    { id: 'PRD-BUS-TRAJET-L2', commercialName: 'Trajet Ligne 2', typeCode: 'RKP-BUS-TRAJET', lineId: 'L-02' },
    { id: 'PRD-BUS-1J', commercialName: 'Pass bus 1 jour', typeCode: 'RKP-BUS-1J' },
    { id: 'PRD-BUS-7J', commercialName: 'Pass bus 7 jours', typeCode: 'RKP-BUS-7J' },
    { id: 'PRD-BUS-30J', commercialName: 'Pass bus 30 jours', typeCode: 'RKP-BUS-30J' },
  ];
  for (const p of products) if (!svc.products.get(p.id)) svc.products.insert({ ...p, operatorId: 'OP-TRANSCO', serviceType: 'BUS', publicRevenue: true, status: 'ACTIF' });

  // Registre wewa (enregistrement gratuit par le contrôleur de terrain et la coopérative).
  if (svc.motos.count() > 0) return;
  const agent = ctx.users.get(RK_DEMO.controllerUser)!;
  const coopUser = ctx.users.get(RK_DEMO.coopUser)!;
  const m1 = svc.registerMoto(coopUser, { plate: 'KN-M 20417', orderNumber: 'KAL-0417', make: 'TVS HLX 125 (démo)', ownerLabel: 'Propriétaire fictif n° 1', stationId: 'ST-KAL-VICTOIRE', cooperativeId: 'COOP-KALAMU' });
  const m2 = svc.registerMoto(coopUser, { plate: 'KN-M 20418', orderNumber: 'KAL-0418', make: 'Haojue HJ125 (démo)', ownerLabel: 'Propriétaire fictif n° 2', stationId: 'ST-KAL-VICTOIRE', cooperativeId: 'COOP-KALAMU' });
  const m3 = svc.registerMoto(coopUser, { plate: 'KN-M 20419', orderNumber: 'KAL-0419', make: 'Bajaj Boxer (démo)', ownerLabel: 'Propriétaire fictif n° 3', stationId: 'ST-KAL-KIMBANGU', cooperativeId: 'COOP-KALAMU' });
  const m4 = svc.registerMoto(agent, { plate: 'KN-M 31002', orderNumber: 'LMT-1002', make: 'TVS Star (démo)', ownerLabel: 'Propriétaire fictif n° 4', stationId: 'ST-LEM-ECHANGEUR' });
  svc.registerDriver(coopUser, { displayName: 'Kabeya T.', licenceNo: 'PC-KIN-DEMO-0417', phone: '+243899100001', taxpayerId: RK_DEMO.driverTaxpayer, motoId: m1.id, cooperativeId: 'COOP-KALAMU' });
  svc.registerDriver(coopUser, { displayName: 'Mukendi I.', licenceNo: 'PC-KIN-DEMO-0418', phone: '+243899100002', taxpayerId: RK_DEMO.driver2Taxpayer, motoId: m2.id, cooperativeId: 'COOP-KALAMU' });
  svc.registerDriver(coopUser, { displayName: 'Lukusa M.', licenceNo: 'PC-KIN-DEMO-0419', motoId: m3.id, cooperativeId: 'COOP-KALAMU' });
  svc.registerDriver(agent, { displayName: 'Mbala K.', licenceNo: 'PC-KIN-DEMO-1002', motoId: m4.id });
  for (const m of [m1, m2, m3, m4]) svc.motos.update({ ...svc.motos.get(m.id)!, demo: true });
  for (const d of svc.drivers.all()) svc.drivers.update({ ...d, demo: true });

  // Paiements de démonstration par le circuit commun.
  const pay = (iss: { payments: { paymentReference: string }[] }) => { for (const p of iss.payments) demoProviderConfirm(ctx, p.paymentReference); };
  const driverUser = ctx.users.get(RK_DEMO.driverUser)!;
  pay(svc.buyPass(driverUser, { motoId: m1.id, duration: 'SEMAINE' as WewaDuration, channel: 'USSD' }));
  pay(svc.groupPayment(coopUser, 'COOP-KALAMU', { items: [{ motoId: m3.id, duration: 'JOUR' }], channel: 'MOBILE_MONEY' }));
  const citizen = ctx.users.get('u-contribuable');
  if (citizen) pay(svc.buyTicket(citizen, { productId: 'PRD-BUS-7J', departureStationId: 'ST-KAL-VICTOIRE', channel: 'MOBILE_MONEY' }));
  svc.titres.sync();

  // Contrôles de démonstration : un wewa en vert (rien à payer) ; une moto sans pass (constat, aucun montant).
  svc.control(agent, { plate: m1.plate, place: { commune: 'Kalamu', label: 'Rond-point Victoire', lat: -4.3389, lon: 15.3106 } });
  svc.control(agent, { plate: m2.plate, place: { commune: 'Kalamu', label: 'Avenue de la Victoire', lat: -4.3395, lon: 15.3112 } });
  svc.report(undefined, {
    category: 'DEMANDE_ESPECES', commune: 'Limete', stationId: 'ST-LEM-ECHANGEUR', occurredAt: now,
    description: 'Signalement FICTIF de démonstration : une personne en civil a réclamé 1 000 FC en espèces sur la route.', amountDemanded: { amount: '1000', currency: 'CDF' }, anonymous: true,
  });
}
