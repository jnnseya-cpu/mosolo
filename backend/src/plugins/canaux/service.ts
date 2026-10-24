/**
 * Service « canaux » : enrôlement inclusif, carte MOSOLO, USSD / SVI, points de paiement agréés, vérification par
 * code court. Assemble les sous-services et fournit l'avis à pictogrammes, les indicateurs et la démonstration.
 */
import { AssistedPaymentService } from './assisted.js';
import type { MoneyJSON, PublicReceiptCheck } from '@mosolo/shared';
import { Money } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { authorize } from '../../core/policy.js';
import { CardRegistry, formatCardNumber, normalizeCardNumber, cardNumberFrom } from './cards.js';
import { EnrolmentService } from './enrolment.js';
import { VerificationLimiter } from './limiter.js';
import {
  CHANNEL_OPERATIONS, IVR_NUMBER_LABEL, PICTOGRAMS, PILOT_COMMUNES, USSD_CODE_LABEL, initials, pictogramForCategory, type PictogramCode,
} from './model.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import { PaymentPointService, normalizeShortCode, type ReferenceInput } from './points.js';
import { ChannelEngine, type VerifyOutcome } from './ussd.js';

const RECEIPT_STATUS_FR: Record<PublicReceiptCheck | 'REVERSED' | 'REFUNDED', string> = {
  VALID: 'VALIDE', PENDING: 'EN ATTENTE', CANCELLED: 'ANNULÉE', REPLACED: 'REMPLACÉE', FRAUD_SUSPECTED: 'SUSPECTE', UNKNOWN: 'INCONNU',
  REVERSED: 'CONTREPASSÉE', REFUNDED: 'REMBOURSÉE',
};

export class CanauxService {
  readonly cards: CardRegistry;
  readonly points: PaymentPointService;
  readonly enrolment: EnrolmentService;
  readonly limiter: VerificationLimiter;
  readonly engine: ChannelEngine;
  readonly assisted: AssistedPaymentService;

  constructor(private readonly ctx: AppContext) {
    this.cards = new CardRegistry(ctx.clock, ctx.audit, ctx.comms, ctx.taxpayers);
    this.points = new PaymentPointService(ctx, this.cards);
    this.enrolment = new EnrolmentService(ctx, this.cards);
    this.limiter = new VerificationLimiter(ctx.clock, ctx.audit, ctx.alerts);
    this.assisted = new AssistedPaymentService(ctx);
    this.engine = new ChannelEngine(ctx, this.cards, this.points, (code, key, channel) => this.verify(code, key, channel));
  }

  /**
   * Vérification publique par code court (module 68) : reçu de point agréé (6 caractères avec contrôle), quittance
   * (code Q…) ou carte MOSOLO (12 chiffres). Réponse minimale, fréquence limitée, échecs comptés contre l'énumération.
   */
  verify(rawCode: string, key: string, channel: string): VerifyOutcome {
    this.limiter.admit(key, channel);
    const code = rawCode.trim();
    const done = (o: VerifyOutcome, failure: boolean) => {
      this.limiter.record(key, channel, code, o.kind, o.status, failure);
      return o;
    };
    const cardNo = normalizeCardNumber(code);
    if (cardNo) {
      const card = this.cards.byNumber(cardNo);
      if (!card) return done({ kind: 'CARTE', status: 'INCONNU', message: 'Aucune carte ne correspond.' }, true);
      const st = card.status === 'ACTIVE' ? 'VALIDE' : card.status === 'BLOQUEE' ? 'BLOQUÉE' : 'RÉVOQUÉE';
      return done({ kind: 'CARTE', status: st, message: card.status === 'ACTIVE' ? 'Carte MOSOLO active.' : card.status === 'BLOQUEE' ? 'Carte bloquée (perte ou vol).' : 'Carte révoquée : une nouvelle carte a été émise.' }, false);
    }
    const short = normalizeShortCode(code);
    let receiptCode: string | undefined;
    let kind = 'QUITTANCE';
    if (short) {
      const c = this.points.collections.findOne((x) => x.shortCode === short);
      if (!c) return done({ kind: 'RECU_POINT', status: 'INCONNU', message: 'Aucun reçu ne correspond à ce code.' }, true);
      receiptCode = c.receiptCode;
      kind = 'RECU_POINT';
    } else if (/^Q[0-9A-Z-]{6,40}$/i.test(code)) {
      receiptCode = code.toUpperCase();
    } else {
      // Tout autre code (ticket, place, pass, certificat, quitus, badge…) : résolveur universel « preuves », même réponse
      // que l'application, le SMS et WhatsApp — couleur 50 % / 1 % et temps restant à l'heure du serveur.
      const pv = this.ctx.ext.preuves as { svc: { lookup(c: string): { found: boolean; kindLabel: string; stateLabel: string; validity: { text: string } | null; message: string } } } | undefined;
      const r = pv?.svc.lookup(code);
      if (r?.found) return done({ kind: r.kindLabel, status: r.stateLabel.toUpperCase(), message: r.validity ? r.validity.text : r.message }, false);
      // Module 6 : situation minimale d'un véhicule par sa plaque (vignette payée ou non régularisée, sans nom).
      const vh = (this.ctx.ext.citoyen as { vehicules?: { parPlaque(p: string): unknown; situation(p: string): { vignette: { statut: string; exigible: boolean }; dernierPaiement: string | null } } } | undefined)?.vehicules;
      if (vh?.parPlaque(code)) {
        const st = vh.situation(code);
        this.ctx.audit.append({ actor: { kind: 'public', id: `canal-${channel.toLowerCase()}` }, action: 'vehicule.plate.consulted', resourceType: 'vehicle_plate', resourceId: code.toUpperCase(), details: { motif: 'verification_publique', channel } });
        const message = !st.vignette.exigible ? 'Vignette non exigible : acte requis.' : st.vignette.statut === 'PAYEE' ? 'Vignette payée.' : 'Vignette non régularisée.';
        return done({ kind: 'VEHICULE', status: st.vignette.statut === 'PAYEE' ? 'PAYÉE' : 'NON RÉGULARISÉE', message, ...(st.dernierPaiement ? { date: st.dernierPaiement.slice(0, 10) } : {}) }, false);
      }
      return done({ kind: 'INCONNU', status: 'INCONNU', message: 'Code non reconnu : vérifiez la saisie.' }, true);
    }
    const r = this.ctx.receipts.publicVerify(receiptCode, { clientKey: key });
    const out: VerifyOutcome = {
      kind, status: RECEIPT_STATUS_FR[r.status as keyof typeof RECEIPT_STATUS_FR] ?? String(r.status), message: r.message,
      ...('amount' in r && r.amount ? { amount: r.amount } : {}), ...('paidOn' in r && r.paidOn ? { date: r.paidOn } : {}),
    };
    return done(out, r.status === 'UNKNOWN');
  }

  /** Avis imprimé à pictogrammes (§ 13A.5, § H.7.4) : ce qui est dû, échéance, lieux de paiement, actions. */
  notice(user: User, taxpayerId: string) {
    authorize(user, 'canaux:notice.read', { taxpayerId });
    const tp = this.ctx.taxpayers.get(taxpayerId);
    const card = this.cards.activeFor(tp.id);
    const enrol = this.enrolment.enrolments.findOne((e) => e.taxpayerId === tp.id);
    const dues = this.points.payableObligations(tp.id).map((d) => {
      const o = this.ctx.assessment.get(d.obligationId);
      let category = 'PARCELLE';
      try {
        category = this.ctx.objects.get(o.objectId).category;
      } catch {
        /* objet non chargé : pictogramme par défaut */
      }
      return { ...d, pictogram: pictogramForCategory(category) as PictogramCode, commune: o.attribution.commune };
    });
    const commune = card?.commune ?? enrol?.commune ?? dues[0]?.commune ?? 'Gombe';
    const guichet = this.points.guichets.findOne((g) => g.commune === commune);
    const places = this.points.publicList(commune).filter((p) => p.status === 'ACTIF');
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'canaux.notice.printed', resourceType: 'taxpayer', resourceId: tp.id, details: { dues: dues.length } });
    return {
      title: 'Avis MOSOLO', language: tp.language, generatedAt: this.ctx.clock.now().toISOString(),
      holder: { initials: initials(tp.fullName), iuc: tp.iuc, level: tp.verificationLevel, cardNumber: card ? formatCardNumber(card.number) : null, commune },
      dues, total: sumMoney(dues.map((d) => d.amount)),
      emptyMessage: dues.length ? null : 'Aucune somme due à ce jour : aucune obligation n’existe sans règle en vigueur et objet rattaché.',
      paymentPlaces: [
        ...(guichet ? [{ kind: 'GUICHET_MOSOLO', name: guichet.name, address: guichet.address, hours: guichet.hours }] : []),
        ...places.map((p) => ({ kind: p.type, name: p.name, address: p.address, hours: p.hours })),
      ],
      actions: [
        { pictogram: 'PAYER', label: PICTOGRAMS.PAYER.label, how: 'Présentez cette carte ou cet avis au guichet bancaire MOSOLO ou chez un point agréé. Le montant affiché ne peut pas être modifié.' },
        { pictogram: 'CONTESTER', label: PICTOGRAMS.CONTESTER.label, how: 'Au guichet MOSOLO ou par le SVI, sans écrit, à tout moment.' },
        { pictogram: 'VERIFIER', label: PICTOGRAMS.VERIFIER.label, how: `Code court de la quittance par USSD ${USSD_CODE_LABEL} ou au SVI ${IVR_NUMBER_LABEL}.` },
      ],
      warnings: [
        { pictogram: 'ZERO_ESPECES_AGENT', text: 'Aucun agent ne peut recevoir d’argent. Payez seulement au guichet bancaire ou chez un point agréé.' },
        { pictogram: 'GRATUIT', text: 'L’enrôlement, la carte, l’USSD et le SVI sont gratuits.' },
      ],
      channels: { ussd: USSD_CODE_LABEL, ivr: IVR_NUMBER_LABEL },
      pictograms: PICTOGRAMS,
    };
  }

  /** Indicateurs d'inclusion (§ H.19, § H.24.4) : agrégats uniquement. */
  indicators(user: User) {
    authorize(user, 'canaux:indicators');
    this.points.scanOverdue();
    const enrols = this.enrolment.enrolments.all();
    const byCommune = new Map<string, { commune: string; total: number; created: number; toReview: number }>();
    for (const e of enrols) {
      const row = byCommune.get(e.commune) ?? { commune: e.commune, total: 0, created: 0, toReview: 0 };
      row.total += 1;
      if (e.status === 'CREE') row.created += 1;
      if (e.status === 'A_REVOIR') row.toReview += 1;
      byCommune.set(e.commune, row);
    }
    const cards = this.cards.cards.all();
    const sessions = this.engine.sessions.all();
    const days = this.points.cashDays.all().filter((d) => d.closedAt && d.deposit);
    const delays = days.map((d) => (new Date(d.deposit!.depositedAt).getTime() - new Date(d.closedAt!).getTime()) / 3_600_000).sort((a, b) => a - b);
    const median = delays.length ? delays[Math.floor((delays.length - 1) / 2)]! : null;
    const pts = this.points.points.all();
    return {
      enrolments: {
        total: enrols.length, rejectedAttempts: this.enrolment.rejectedAttempts,
        // Part par commune (module 63) : dossiers assistés de la commune / total, en pour cent (une décimale).
        byCommune: [...byCommune.values()].sort((a, b) => a.commune.localeCompare(b.commune, 'fr')).map((r) => ({ ...r, sharePct: enrols.length ? Math.round((r.total / enrols.length) * 1000) / 10 : null })),
      },
      cards: { active: cards.filter((c) => c.status === 'ACTIVE').length, blocked: cards.filter((c) => c.status === 'BLOQUEE').length, revoked: cards.filter((c) => c.status === 'REVOQUEE').length, reissues: this.cards.reissues.find((r) => r.status === 'APPROUVEE').length },
      channels: {
        ussdSessions: sessions.filter((s) => s.channel === 'USSD').length, ivrSessions: sessions.filter((s) => s.channel === 'SVI').length,
        authenticatedSessions: sessions.filter((s) => s.authenticated).length, referencesIssued: this.engine.referencesIssued,
        // Module 64 : appels (sessions SVI) et opérations réalisées à la voix, par nature.
        voice: (() => {
          const ivr = sessions.filter((s) => s.channel === 'SVI');
          const ops = ivr.flatMap((s) => s.operations ?? []);
          return {
            calls: ivr.length, callsWithOperation: ivr.filter((s) => (s.operations ?? []).length > 0).length, operations: ops.length,
            byKind: Object.fromEntries(CHANNEL_OPERATIONS.map((k) => [k, ops.filter((o) => o === k).length])),
            byLanguage: Object.fromEntries([...new Set(ivr.map((s) => s.lang))].sort().map((l) => [l, ivr.filter((s) => s.lang === l).length])),
            tollFreeNumber: IVR_NUMBER_LABEL,
          };
        })(),
        ussdOperations: sessions.filter((s) => s.channel === 'USSD').flatMap((s) => s.operations ?? []).length,
      },
      points: {
        active: pts.filter((p) => p.status === 'ACTIF').length, suspended: pts.filter((p) => p.status === 'SUSPENDU').length, referenced: pts.filter((p) => p.status === 'REFERENCE').length,
        pilotCommunesWithBankDesk: PILOT_COMMUNES.filter((c) => pts.some((p) => p.commune === c && p.type === 'GUICHET_BANCAIRE_MOSOLO' && p.status === 'ACTIF')).length,
        collections: this.points.collections.count(), collected: sumMoney(this.points.collections.all().map((c) => c.amount)),
        medianSettlementHours: median, openExceptions: this.points.exceptions.count(), pendingProposals: this.points.proposals.find((p) => p.status === 'PROPOSEE').length,
      },
      verification: { total: this.limiter.logs.count(), suspectedEnumeration: this.limiter.suspectedAttempts },
      // Module 66 : accessibilité mesurée sur les points réels (communes couvertes par au moins un point ACTIF) ;
      // la part de la population à moins de 15 minutes de marche exige la cartographie de la population (§ H.19).
      accessibility: (() => {
        const active = pts.filter((p) => p.status === 'ACTIF');
        const covered = COMMUNES.filter((c) => active.some((p) => p.commune === c));
        return {
          activePoints: active.length, communesTotal: COMMUNES.length, communesCovered: covered.length,
          communesCoveredPct: Math.round((covered.length / COMMUNES.length) * 1000) / 10,
          communesWithoutPoint: COMMUNES.filter((c) => !covered.includes(c)),
          byCommune: covered.map((c) => ({ commune: c, activePoints: active.filter((p) => p.commune === c).length })),
          populationWithin15Min: null,
          note: 'Part de la population à moins de 15 minutes de marche d’un point agréé : non mesurée — données de population géolocalisées absentes (cartographie § H.19).',
        };
      })(),
    };
  }

  // ---------- Démonstration (données fictives) ----------

  seedDemo(): void {
    const ctx = this.ctx;
    const add = (u: Parameters<typeof ctx.users.add>[0]) => ctx.users.add(u);
    add({ id: 'canaux-agent-enrol', name: 'Agent d’enrôlement assisté Limete (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Limete', 'Kalamu', 'Ngaliema'] });
    add({ id: 'canaux-guichetier', name: 'Guichetier MOSOLO Gombe (démo)', roles: ['R12'], entity: 'DGIPK' });
    add({ id: 'canaux-guichetier-2', name: 'Guichetière MOSOLO Gombe n° 2 (démo)', roles: ['R12'], entity: 'DGIPK' });
    add({ id: 'canaux-tresor-2', name: 'Comptable public adjoint — Trésor (démo)', roles: ['R17'], entity: 'TRESOR' });
    add({ id: 'canaux-op-gombe', name: 'Guichet bancaire partenaire Gombe — opérateur (démo)', roles: ['R32'], entity: 'BANQUE-PARTENAIRE-A' });
    add({ id: 'canaux-op-limete', name: 'Point agréé Limete — opérateur (démo)', roles: ['R32'], entity: 'OPERATEUR-MM-A' });
    add({ id: 'canaux-op-kalamu', name: 'Point agréé Kalamu — opérateur (démo)', roles: ['R32'], entity: 'BANQUE-PARTENAIRE-A' });
    add({ id: 'canaux-op-ngaliema', name: 'Point agréé Ngaliema — opérateur (démo)', roles: ['R32'], entity: 'BANQUE-PARTENAIRE-A' });
    ctx.field.enroll('dev-canaux-enrol-01', 'canaux-agent-enrol', ctx.secrets.deviceKeys['dev-canaux-enrol-01'] ?? 'demo-device-key-canaux-01');
    ctx.field.enroll('dev-canaux-guichet-01', 'canaux-guichetier', ctx.secrets.deviceKeys['dev-canaux-guichet-01'] ?? 'demo-device-key-canaux-02');

    const tresor = ctx.users.get('u-tresor')!;
    const tresor2 = ctx.users.get('canaux-tresor-2')!;
    const limits = { perTransaction: [{ amount: '2000.00', currency: 'USD' as const }, { amount: '5000000.00', currency: 'CDF' as const }], perDay: [{ amount: '20000.00', currency: 'USD' as const }, { amount: '50000000.00', currency: 'CDF' as const }] };
    const approval = (n: string, authority = 'Banque Centrale du Congo') => ({ authority: `${authority} [EXEMPLE]`, reference: `AGR-DEMO-${n}`, grantedOn: '2026-06-01' });
    const guichets = [
      { id: 'GM-GOMBE', commune: 'Gombe', address: 'Hôtel de Ville, boulevard du 30 Juin [adresse de démonstration]', lat: -4.3035, lon: 15.3059 },
      { id: 'GM-LIMETE', commune: 'Limete', address: 'Maison communale de Limete, 7e rue [adresse de démonstration]', lat: -4.3701, lon: 15.3452 },
      { id: 'GM-KALAMU', commune: 'Kalamu', address: 'Maison communale de Kalamu, avenue Victoire [adresse de démonstration]', lat: -4.3437, lon: 15.3137 },
      { id: 'GM-NGALIEMA', commune: 'Ngaliema', address: 'Maison communale de Ngaliema, avenue de la Libération [adresse de démonstration]', lat: -4.3363, lon: 15.2632 },
    ];
    const ops: Record<string, string> = { Gombe: 'canaux-op-gombe', Limete: 'canaux-op-limete', Kalamu: 'canaux-op-kalamu', Ngaliema: 'canaux-op-ngaliema' };
    for (const g of guichets) {
      const bankPointId = `PA-${g.commune.toUpperCase()}-GB01`;
      this.points.guichets.insert({
        id: g.id, name: `Guichet MOSOLO ${g.commune}`, commune: g.commune, address: g.address, hours: 'Lun–ven 8 h–16 h, sam 8 h–12 h',
        services: ['Accueil et assistance', 'Enrôlement assisté', 'Remise et réémission de la carte MOSOLO', 'Guichet bancaire partenaire (seul à encaisser)'], bankPointId, demo: true,
      });
      this.points.reference(tresor, {
        name: `Guichet bancaire — Guichet MOSOLO ${g.commune}`, type: 'GUICHET_BANCAIRE_MOSOLO', operator: 'Banque partenaire A (démo)', approval: approval(`${g.commune.toUpperCase()}-GB`),
        commune: g.commune, quartier: 'Centre', address: g.address, lat: g.lat, lon: g.lon, hours: 'Lun–ven 8 h–16 h', limits, settlementDelayHours: 24,
        guichetId: g.id, operatorUserIds: [ops[g.commune]!], demo: true,
      }, bankPointId);
      this.points.activate(tresor2, bankPointId);
    }
    const extra: (ReferenceInput & { id: string; activate: boolean })[] = [
      { id: 'PA-GOMBE-AB01', name: 'Agence bancaire partenaire — Gombe centre', type: 'AGENCE_BANCAIRE', operator: 'Banque partenaire A (démo)', approval: approval('GOMBE-AB'), commune: 'Gombe', quartier: 'Commerce', address: 'Avenue du Commerce [adresse de démonstration]', lat: -4.3102, lon: 15.3125, hours: 'Lun–ven 8 h 30–15 h 30', limits, settlementDelayHours: 24, operatorUserIds: ['canaux-op-gombe'], demo: true, activate: true },
      { id: 'PA-LIMETE-MM01', name: 'Agent monnaie mobile — Kingabwa', type: 'AGENT_MONNAIE_MOBILE', operator: 'Opérateur de monnaie mobile A (démo)', approval: approval('LIMETE-MM', 'Opérateur de monnaie mobile A'), commune: 'Limete', quartier: 'Kingabwa', address: 'Rond-point Kingabwa [adresse de démonstration]', lat: -4.3655, lon: 15.3548, hours: 'Tous les jours 7 h–20 h', limits: { perTransaction: [{ amount: '500.00', currency: 'USD' }, { amount: '1500000.00', currency: 'CDF' }], perDay: [{ amount: '3000.00', currency: 'USD' }, { amount: '9000000.00', currency: 'CDF' }] }, settlementDelayHours: 24, operatorUserIds: ['canaux-op-limete'], demo: true, activate: true },
      { id: 'PA-KALAMU-MM01', name: 'Agent monnaie mobile — Matonge', type: 'AGENT_MONNAIE_MOBILE', operator: 'Opérateur de monnaie mobile A (démo)', approval: approval('KALAMU-MM', 'Opérateur de monnaie mobile A'), commune: 'Kalamu', quartier: 'Matonge', address: 'Avenue Kanda-Kanda [adresse de démonstration]', lat: -4.3345, lon: 15.3106, hours: 'Tous les jours 7 h–21 h', limits, settlementDelayHours: 24, operatorUserIds: ['canaux-op-kalamu'], demo: true, activate: true },
      { id: 'PA-NGALIEMA-TPE01', name: 'Terminal de paiement — prestataire habilité', type: 'TPE_PRESTATAIRE', operator: 'Prestataire de paiement B (démo)', approval: approval('NGALIEMA-TPE'), commune: 'Ngaliema', quartier: 'Binza', address: 'Place Binza Delvaux [adresse de démonstration]', lat: -4.3551, lon: 15.2553, hours: 'Lun–sam 8 h–18 h', limits, settlementDelayHours: 24, operatorUserIds: ['canaux-op-ngaliema'], demo: true, activate: false },
    ];
    for (const { id, activate, ...input } of extra) {
      this.points.reference(tresor, input, id);
      if (activate) this.points.activate(tresor2, id);
    }
    this.points.suspend(tresor, 'PA-KALAMU-MM01', 'Démonstration : écart de versement non justifié constaté lors d’un contrôle (fictif).');

    // Personne sans téléphone enrôlée hors ligne (fictive) : N0-A + carte, puis deux obligations sur la règle FICTIVE.
    const agent = ctx.users.get('canaux-agent-enrol')!;
    const day = new Date(ctx.clock.now().getTime() - 86_400_000).toISOString().slice(0, 10);
    const at = (h: string) => `${day}T${h}.000Z`;
    const baseRecord = {
      channel: 'DOMICILE' as const, missionId: 'MISSION-DEMO-LIMETE-01', capturedAt: at('09:10:00'), gps: { lat: -4.3689, lon: 15.3561, accuracyM: 12 },
      commune: 'Limete', quartier: 'Mombele', landmark: 'Derrière l’école primaire, maison au portail bleu (démonstration)', declaredObjects: [],
      consent: { method: 'TEMOIN' as const, summaryLanguage: 'ln', summaryAudioVersion: 'resume-enrolement-ln-v0 (à valider)', summaryReadAt: at('09:05:00'), givenAt: at('09:08:00'), witness: { name: 'Voisin témoin (fictif)', relation: 'voisin' } },
      noPaymentAttested: true,
    };
    const res = this.enrolment.processRecord(agent, 'dev-canaux-enrol-01', 'LOT-DEMO-0001', {
      ...baseRecord, localId: 'DEMO-ENR-0001',
      person: { fullName: 'Mama Nsimba Kiese', sex: 'F', birthYear: 1958, language: 'ln' },
      declaredObjects: [{ type: 'PARCELLE', description: 'Parcelle familiale (déclarée, à vérifier)' }, { type: 'COMMERCE', description: 'Petit étal devant la parcelle (déclaré)' }],
    }, { fixedCardNumber: cardNumberFrom('48217730159') });
    this.enrolment.processRecord(agent, 'dev-canaux-enrol-01', 'LOT-DEMO-0001', {
      ...baseRecord, localId: 'DEMO-ENR-0002', capturedAt: at('10:20:00'),
      consent: { ...baseRecord.consent, summaryReadAt: at('10:12:00'), givenAt: at('10:15:00') },
      person: { fullName: 'Kalala Mbuyi', sex: 'M', language: 'fr' },
    });
    if (!res.taxpayerId) return;
    const controleur = ctx.users.get('u-controleur')!;
    const rule = ctx.rules.rules.findOne((r) => r.code === 'DEMO-IF-BATI');
    for (const [rank, lat] of [[4, -4.3689], [3, -4.3692]] as const) {
      const obj = ctx.objects.create(controleur, {
        taxpayerId: res.taxpayerId, category: 'PARCELLE', commune: 'Limete', quartier: 'Mombele', localityRank: rank, lat, lon: 15.3561,
        attributes: { demo: true, origine: 'enrôlement assisté (déclaré)' },
      });
      if (rule) ctx.assessment.calculate(controleur, { ruleId: rule.id, taxpayerId: res.taxpayerId, objectId: obj.id, inputs: {}, simulate: false });
    }
    this.cards.setPin(res.taxpayerId, '2468', { kind: 'system', id: 'demo' });
    // Code secret de démonstration du contribuable fictif (+243810000001).
    this.cards.setPin('TP-DEMO-0001', '1234', { kind: 'system', id: 'demo' });

    // Un encaissement de démonstration au point agréé de Limete, sur présentation de la carte (plus petite obligation).
    const smallest = this.points.payableObligations(res.taxpayerId).sort((a, b) => Money.fromJSON(a.amount).compare(Money.fromJSON(b.amount)))[0];
    if (smallest) {
      const op = ctx.users.get('canaux-op-limete')!;
      const ref = this.points.cardReference(op, 'PA-LIMETE-MM01', res.cardNumber!, smallest.obligationId);
      this.points.collect(op, 'PA-LIMETE-MM01', ref.paymentReference);
    }
  }
}

function sumMoney(items: MoneyJSON[]): MoneyJSON[] {
  const m = new Map<string, Money>();
  for (const i of items) {
    const cur = m.get(i.currency);
    m.set(i.currency, cur ? cur.add(Money.fromJSON(i)) : Money.fromJSON(i));
  }
  return [...m.values()].map((x) => x.toJSON());
}
