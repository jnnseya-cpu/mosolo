/**
 * Indicateurs des modules 1, 2, 3 et 6 (Spécification fonctionnelle), calculés sur les données réelles des modules
 * existants (compte unique, enrôlement, paiements, déclarations, canaux, communications). Un indicateur sans donnée
 * source est rendu « non mesuré » avec sa raison — jamais une valeur estimée.
 */
import type { AppContext } from '../../context.js';
import { DAY_MS } from '../../core/clock.js';
import { accesOf, extOpt, fiscalOf, hoursBetween, median, parDefaut, pct } from './common.js';

/** Fenêtre d'activité des utilisateurs (module 3 « utilisateurs actifs ») — valeur par défaut à confirmer. */
export const FENETRE_UTILISATEURS_JOURS = parDefaut(30, 'Spécification fonctionnelle, module 3 — indicateur « utilisateurs actifs »');

const CONFIRMED = ['CONFIRME', 'REGLE', 'RAPPROCHE'];
const VERIFICATION_LEVELS = ['N0', 'N0A', 'N1', 'N2', 'N3'] as const;
const TOUS = { limit: Number.MAX_SAFE_INTEGER };

/**
 * Activité des contribuables et mandataires (module 3 « utilisateurs actifs ») : dernière action de chaque acteur R30 /
 * R31, tenue à jour à chaque écriture du journal d'audit (aucune relecture intégrale du journal).
 */
export class SuiviActivite {
  readonly derniere = new Map<string, number>();
  constructor(ctx: AppContext) {
    ctx.audit.onAppend((r) => {
      if (r.actor.kind === 'user' && (r.actor.roles ?? []).some((x) => x === 'R30' || x === 'R31')) this.derniere.set(r.actor.id, new Date(r.at).getTime());
    });
  }
}
const nonMesure = (raison: string) => ({ valeur: null, raison });

interface CanauxLike {
  engine: { sessions: { all(): { channel: string; startedAt: string }[] }; enrolmentsCreated?: number };
  enrolment: { enrolments: { all(): { channel: string; status: string; duplicateCandidates?: unknown[]; capturedAt?: string; review?: { at?: string } }[] } };
}
interface PlanifLike { satisfaction: { all(): { note: number; moment: string }[] } }

export function indicateursModule1(ctx: AppContext) {
  const tps = ctx.taxpayers.taxpayers.all().filter((t) => t.status !== 'FUSIONNE');
  const acces = accesOf(ctx);
  const parNiveau = Object.fromEntries(VERIFICATION_LEVELS.map((l) => [l, tps.filter((t) => t.verificationLevel === l).length]));
  const proofs = acces?.proofs.all() ?? [];
  const nifValides = new Set(proofs.filter((p) => p.type === 'NIF' && p.status === 'VALIDEE').map((p) => p.taxpayerId));
  const nifDeclares = new Set([...proofs.filter((p) => p.type === 'NIF').map((p) => p.taxpayerId), ...(acces?.organisations.all().filter((o) => o.nifDeclared).map((o) => o.taxpayerId) ?? [])]);
  const candidats = acces ? acces.duplicateCandidates() : [];
  const merges = acces?.merges.all() ?? [];
  const delais = proofs.filter((p) => p.reviewedAt && p.status !== 'DECLAREE').map((p) => hoursBetween(p.declaredAt, p.reviewedAt!));
  const med = median(delais);
  return {
    comptesActifsParNiveau: { valeur: tps.length, parNiveau },
    tauxRattachementNif: { valeur: pct(nifValides.size, tps.length), numerateur: nifValides.size, denominateur: tps.length, nifDeclares: nifDeclares.size, definition: 'Comptes dont le NIF est validé (preuve NIF VALIDÉE) / comptes actifs.' },
    doublons: {
      detectes: candidats.length, surNomSeul: candidats.filter((c) => c.nameOnly).length,
      resolus: merges.filter((m) => m.status === 'EFFECTUEE' || m.status === 'REJETEE').length, fusionsEnCours: merges.filter((m) => m.status === 'PROPOSEE' || m.status === 'VERIFIEE').length,
      regle: 'Aucune fusion automatique sur simple similitude de nom : fusion sur preuve et double validation.',
    },
    delaiVerification: med === null ? nonMesure('Aucune preuve d’identité instruite : délai non mesuré.') : { valeur: med.toFixed(1), unite: 'h (médiane dépôt → décision de la preuve)', mesures: delais.length },
  };
}

export function indicateursModule2(ctx: AppContext) {
  const canaux = extOpt<CanauxLike>(ctx, 'canaux');
  const fiscal = fiscalOf(ctx);
  const assisted = canaux?.enrolment.enrolments.all() ?? [];
  const records = ctx.audit.list({ action: 'enrolement.channel.recorded', ...TOUS }).items;
  const byRecorded = (c: string) => records.filter((r) => (r.details as { channel?: string }).channel === c).length;
  const ussd = ctx.audit.list({ action: 'canaux.session.enrolled', ...TOUS }).items;
  const tps = ctx.taxpayers.taxpayers.all();
  const parCanal = {
    APPLICATION: byRecorded('APPLICATION'),
    WEB: byRecorded('WEB'),
    USSD: ussd.filter((r) => (r.details as { channel?: string }).channel === 'USSD').length,
    SVI: ussd.filter((r) => (r.details as { channel?: string }).channel === 'SVI').length,
    GUICHET: assisted.filter((e) => e.channel === 'GUICHET_MOSOLO').length + (fiscal?.enrolment.roles.find((r) => r.channel === 'GUICHET').length ?? 0),
    AGENT: assisted.filter((e) => e.channel === 'DOMICILE' || e.channel === 'SITE').length,
    LOTS: tps.filter((t) => !!t.importedFrom).length,
  };
  const roles = fiscal?.enrolment.roles.all() ?? [];
  const decided = roles.filter((r) => r.status === 'CONFIRMEE' || r.status === 'REJETEE');
  const complements = new Set(ctx.audit.list({ action: 'enrolement.role.instructed', ...TOUS }).items.filter((r) => (r.details as { decision?: string }).decision === 'COMPLEMENT_DEMANDE').map((r) => String((r.details as { declarationId?: string }).declarationId)));
  const premierCoup = decided.filter((r) => r.status === 'CONFIRMEE' && !complements.has(r.id)).length + assisted.filter((e) => e.status === 'CREE' && !(e.duplicateCandidates?.length)).length;
  const denom = decided.length + assisted.filter((e) => e.status !== 'A_REVOIR').length;
  const delais = decided.filter((r) => r.decision).map((r) => hoursBetween(r.declaredAt, r.decision!.at));
  const rejets = roles.filter((r) => r.status === 'REJETEE').length + assisted.filter((e) => e.status === 'DOUBLON_CONFIRME').length;
  return {
    enrolementsParCanal: { valeur: Object.values(parCanal).reduce((s, n) => s + n, 0), parCanal, note: 'Web et application : inscriptions comptées depuis la mise en service de la mesure par canal ; guichet et agent : dossiers assistés et déclarations de rôle.' },
    tauxCompletsPremierCoup: denom ? { valeur: pct(premierCoup, denom), numerateur: premierCoup, denominateur: denom } : nonMesure('Aucun dossier d’enrôlement instruit.'),
    delaiMoyen: delais.length ? { valeur: (delais.reduce((s, d) => s + d, 0) / delais.length).toFixed(1), unite: 'h (déclaration de rôle → décision)', mesures: delais.length } : nonMesure('Aucune déclaration de rôle décidée : délai non mesuré.'),
    tauxRejet: (decided.length + assisted.length) ? { valeur: pct(rejets, decided.length + assisted.length), numerateur: rejets, denominateur: decided.length + assisted.length } : nonMesure('Aucun dossier d’enrôlement.'),
    gratuite: 'Enrôlement gratuit sur tous les canaux : aucun paiement n’est demandé ni reçu à l’enrôlement.',
  };
}

export function indicateursModule3(ctx: AppContext, suivi: SuiviActivite) {
  const now = ctx.clock.now().getTime();
  const fen = FENETRE_UTILISATEURS_JOURS.valeur * DAY_MS;
  const actifs = new Set([...suivi.derniere.entries()].filter(([, at]) => now - at <= fen).map(([id]) => id));
  const orders = ctx.payments.orders.all().filter((o) => CONFIRMED.includes(o.status));
  const enLigne = orders.filter((o) => o.channel !== 'AGENT_POINT');
  const fiscal = fiscalOf(ctx);
  const delais: number[] = [];
  for (const d of fiscal?.declarations.declarations.all() ?? []) {
    const obl = d.liquidation.obligationId;
    if (!obl) continue;
    const pay = ctx.payments.orders.find((o) => o.obligationId === obl && CONFIRMED.includes(o.status)).map((o) => o.confirmedAt ?? o.createdAt).sort()[0];
    if (pay) delais.push(hoursBetween(d.acknowledgement.receivedAt, pay));
  }
  const med = median(delais);
  const sat = extOpt<PlanifLike>(ctx, 'planification')?.satisfaction.all() ?? [];
  return {
    utilisateursActifs: { valeur: actifs.size, fenetre: FENETRE_UTILISATEURS_JOURS, definition: 'Contribuables et mandataires ayant agi dans la fenêtre (journal d’audit).' },
    tauxPaiementEnLigne: orders.length ? { valeur: pct(enLigne.length, orders.length), numerateur: enLigne.length, denominateur: orders.length, definition: 'Paiements confirmés hors point agréé physique / paiements confirmés.' } : nonMesure('Aucun paiement confirmé.'),
    delaiDeclarationPaiement: med === null ? nonMesure('Aucune déclaration liquidée puis payée : délai non mesuré.') : { valeur: med.toFixed(1), unite: 'h (médiane accusé de réception → paiement confirmé)', mesures: delais.length },
    satisfaction: sat.length ? { valeur: (Math.round((sat.reduce((s, x) => s + x.note, 0) / sat.length) * 10) / 10).toFixed(1), echelle: '1 à 5', reponses: sat.length } : nonMesure('Aucune réponse au questionnaire de satisfaction.'),
  };
}

export function indicateursModule6(ctx: AppContext) {
  const canaux = extOpt<CanauxLike>(ctx, 'canaux');
  const sessions = canaux?.engine.sessions.all().filter((s) => s.channel === 'USSD') ?? [];
  const ussdOrders = ctx.payments.orders.all().filter((o) => o.channel === 'USSD');
  const sms = ctx.comms.deliveries.all().filter((d) => d.channel === 'sms' && d.status !== 'supprime_par_preference');
  const livres = sms.filter((d) => d.status === 'delivre' || d.status === 'lu').length;
  const reels = sms.filter((d) => d.providerMode === 'live');
  return {
    sessionsUssd: { valeur: sessions.length },
    paiementsUssd: { valeur: ussdOrders.filter((o) => CONFIRMED.includes(o.status)).length, referencesEmises: ussdOrders.length },
    tauxDelivranceSms: reels.length
      ? { valeur: pct(livres, sms.length), numerateur: livres, denominateur: sms.length }
      : { valeur: null, envoyes: sms.length, raison: 'Aucun opérateur SMS raccordé (bac à sable) : les accusés de délivrance opérateur manquent [À RACCORDER — convention opérateur télécom].' },
    coutParMessage: nonMesure('Aucun tarif opérateur conventionné : coût par message non mesuré [À RACCORDER — convention opérateur télécom].'),
  };
}
