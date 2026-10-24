/**
 * Indicateurs des modules 27 à 40 de la spécification fonctionnelle (rubrique « Indicateurs » de chaque fiche) :
 * chaque indicateur est CALCULÉ sur les données réelles des dépôts (socle et modules chargés) ou déclaré « non mesuré »
 * avec le motif (source absente) — jamais une valeur supposée. Lecture seule, aucune donnée nominative.
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';

const { always } = GRANTS;
definePolicy('pilotage:indicateurs-modules.read', {
  R01: always, R02: always, R03: always, R04: always, R05: always, R06: always, R07: always, R08: always,
  R17: always, R18: always, R20: always, R21: always, R22: always, R23: always, R24: always,
});

export interface ModuleIndicator { code: string; libelle: string; statut: 'MESURE' | 'NON_MESURE'; valeur: string | null; detail: string; source: string }
export interface ModuleIndicators { module: number; titre: string; indicateurs: ModuleIndicator[] }

const HOUR = 3_600_000;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const pct = (n: number, d: number) => (d ? `${Math.round((n * 1000) / d) / 10} %` : null);
const round1 = (x: number) => Math.round(x * 10) / 10;
function sum(list: MoneyJSON[]): Record<string, string> {
  const t: Record<string, string> = {};
  for (const m of list) t[m.currency] = Money.fromJSON({ amount: t[m.currency] ?? '0', currency: m.currency }).add(Money.fromJSON(m)).toDecimalString();
  return t;
}
const money = (t: Record<string, string>) => Object.entries(t).map(([c, v]) => `${v} ${c}`).join(' + ') || '0';
const M = (code: string, libelle: string, valeur: string, detail: string, source: string): ModuleIndicator => ({ code, libelle, statut: 'MESURE', valeur, detail, source });
const N = (code: string, libelle: string, detail: string, source: string): ModuleIndicator => ({ code, libelle, statut: 'NON_MESURE', valeur: null, detail, source });

type Ext = Record<string, unknown>;
const ext = <T>(ctx: AppContext, name: string): T | undefined => (ctx.ext as Ext)[name] as T | undefined;

export function computeModuleIndicators(ctx: AppContext): ModuleIndicators[] {
  const obligations = ctx.assessment.obligations.all();
  const orders = ctx.payments.orders.all();
  const audit = (action: string) => ctx.audit.list({ action, limit: 1_000_000 }).items;
  const out: ModuleIndicators[] = [];

  // Module 27 — Déclaration et liquidation.
  {
    const issued = obligations.filter((o) => !o.supersedes);
    const corrected = obligations.filter((o) => !!o.supersedes);
    const recalcs = audit('rule.recalculation.applied').length;
    const fiscal = ext<{ declarations?: { declarations: { all(): { acknowledgement: { receivedAt: string }; liquidation: { obligationId?: string } }[] } } }>(ctx, 'fiscal');
    const delays = (fiscal?.declarations?.declarations.all() ?? []).filter((d) => !!d.liquidation.obligationId).map((d) => {
      const o = ctx.assessment.obligations.get(d.liquidation.obligationId!);
      return o ? (Date.parse(o.createdAt) - Date.parse(d.acknowledgement.receivedAt)) / HOUR : null;
    }).filter((x): x is number => x !== null && x >= 0);
    const med = median(delays);
    out.push({ module: 27, titre: 'Déclaration et liquidation', indicateurs: [
      M('M27_OBLIGATIONS_EMISES', 'Obligations émises', String(issued.length), `${issued.length} obligation(s) initiale(s) ; ${obligations.length} au total avec les rectificatives.`, 'registre des obligations'),
      M('M27_ERREURS_CORRIGEES', 'Erreurs corrigées', String(corrected.length + recalcs), `${corrected.length} obligation(s) rectificative(s) (réclamation, remise, correction de déclaration) ; ${recalcs} recalcul(s) appliqué(s).`, 'obligations rectificatives et journal des recalculs'),
      med === null ? N('M27_DELAI_LIQUIDATION', 'Délai de liquidation', 'Aucune déclaration liquidée (module fiscal) : délai non mesurable.', 'déclarations déposées → obligations')
        : M('M27_DELAI_LIQUIDATION', 'Délai de liquidation', `${round1(med)} h`, `Médiane dépôt → obligation sur ${delays.length} déclaration(s).`, 'déclarations déposées → obligations'),
    ] });
  }

  // Module 28 — Orchestration des paiements.
  {
    const confirmed = orders.filter((o) => !!o.confirmedAt);
    const failed = orders.filter((o) => o.status === 'ECHOUE');
    const confDelays = confirmed.map((o) => (Date.parse(o.confirmedAt!) - Date.parse(o.createdAt)) / 60_000).filter((x) => x >= 0);
    const dup = audit('payment.duplicate_detected').length + orders.filter((o) => o.status === 'DOUBLON').length;
    const replays = audit('payment.callback.replayed').length + audit('payment.webhook.replayed').length;
    const med = median(confDelays);
    out.push({ module: 28, titre: 'Orchestration des paiements', indicateurs: [
      confirmed.length + failed.length ? M('M28_TAUX_SUCCES', 'Taux de succès', pct(confirmed.length, confirmed.length + failed.length)!, `${confirmed.length} confirmé(s), ${failed.length} échoué(s).`, 'ordres de paiement')
        : N('M28_TAUX_SUCCES', 'Taux de succès', 'Aucun paiement confirmé ni échoué.', 'ordres de paiement'),
      med === null ? N('M28_DELAI_CONFIRMATION', 'Délai de confirmation', 'Aucune confirmation reçue.', 'ordres de paiement')
        : M('M28_DELAI_CONFIRMATION', 'Délai de confirmation', `${round1(med)} min`, `Médiane création de la référence → confirmation, ${confDelays.length} paiement(s).`, 'ordres de paiement'),
      M('M28_DOUBLONS_EVITES', 'Doublons évités', String(dup + replays), `${dup} doublon(s) détecté(s), ${replays} rappel(s) rejoué(s) écarté(s).`, 'journal des paiements'),
    ] });
  }

  // Module 29 — Règlement en trésorerie.
  {
    const settled = orders.filter((o) => !!o.confirmedAt && !!o.settledAt).map((o) => (Date.parse(o.settledAt!) - Date.parse(o.confirmedAt!)) / HOUR);
    const med = median(settled);
    const tresor = ext<{ suspense?: { all(): { status: string; amount: MoneyJSON }[] } }>(ctx, 'tresor');
    const open = tresor?.suspense ? tresor.suspense.all().filter((s) => s.status === 'OUVERT') : null;
    const pending = ctx.treasury.imports.all().filter((i) => i.status === 'EN_ATTENTE_VALIDATION').length;
    out.push({ module: 29, titre: 'Règlement en trésorerie', indicateurs: [
      med === null ? N('M29_DELAI_REGLEMENT', 'Délai de règlement', 'Aucun paiement confirmé puis réglé sur relevé validé.', 'ordres de paiement et relevés')
        : M('M29_DELAI_REGLEMENT', 'Délai de règlement', `${round1(med)} h`, `Médiane confirmation → règlement, ${settled.length} paiement(s) ; ${pending} import(s) en attente de seconde validation.`, 'ordres de paiement et relevés'),
      open === null ? N('M29_FONDS_EN_ATTENTE', 'Fonds en attente', 'Module Trésor non chargé : compte d’attente indisponible.', 'compte d’attente')
        : M('M29_FONDS_EN_ATTENTE', 'Fonds en attente', money(sum(open.map((s) => s.amount))), `${open.length} suspens ouvert(s) au compte d’attente.`, 'compte d’attente'),
    ] });
  }

  // Module 30 — Rapprochement.
  {
    const reconciled = orders.filter((o) => o.status === 'RAPPROCHE' || !!o.reconciledAt);
    const tresor = ext<{ matching?: { proposals: { all(): { status: string }[] } } }>(ctx, 'tresor');
    const manual = tresor?.matching?.proposals.all().filter((p) => p.status === 'CONFIRMEE').length ?? 0;
    const exceptions = ctx.treasury.exceptions.all();
    const openAfterJ2 = exceptions.filter((e) => ['OUVERTE', 'EN_COURS'].includes(e.status) && Date.parse(ctx.clock.now().toISOString()) - Date.parse(e.openedAt) > 48 * HOUR);
    const treat = exceptions.map((e) => (e.resolution as { resolvedAt?: string } | undefined)?.resolvedAt ? (Date.parse((e.resolution as { resolvedAt: string }).resolvedAt) - Date.parse(e.openedAt)) / HOUR : null).filter((x): x is number => x !== null && x >= 0);
    const med = median(treat);
    out.push({ module: 30, titre: 'Rapprochement', indicateurs: [
      reconciled.length ? M('M30_TAUX_AUTOMATIQUE', 'Taux de rapprochement automatique', pct(Math.max(0, reconciled.length - manual), reconciled.length)!, `${reconciled.length - manual} automatique(s), ${manual} proposé(s) puis confirmé(s) à quatre yeux.`, 'ordres rapprochés et propositions d’appariement')
        : N('M30_TAUX_AUTOMATIQUE', 'Taux de rapprochement automatique', 'Aucun paiement rapproché.', 'ordres rapprochés'),
      M('M30_ECART_J2', 'Écart à J+2', String(openAfterJ2.length), `${openAfterJ2.length} exception(s) encore ouverte(s) plus de 48 h après leur ouverture${openAfterJ2.length ? ` (${money(sum(openAfterJ2.map((e) => e.line?.amount).filter((x): x is MoneyJSON => !!x)))})` : ''}.`, 'files d’exception'),
      med === null ? N('M30_DELAI_TRAITEMENT', 'Délai de traitement', 'Aucune exception résolue.', 'files d’exception')
        : M('M30_DELAI_TRAITEMENT', 'Délai de traitement', `${round1(med)} h`, `Médiane ouverture → résolution, ${treat.length} exception(s).`, 'files d’exception'),
    ] });
  }

  // Module 31 — Quittances électroniques.
  {
    const receipts = ctx.receipts.receipts.all();
    const delays = receipts.map((r) => { const o = ctx.payments.orders.get(r.paymentOrderId); return o?.confirmedAt ? (Date.parse(r.issuedAt) - Date.parse(o.confirmedAt)) / 60_000 : null; }).filter((x): x is number => x !== null && x >= 0);
    const verifs = audit('receipt.verified');
    const med = median(delays);
    out.push({ module: 31, titre: 'Quittances électroniques', indicateurs: [
      med === null ? N('M31_DELAI_QUITTANCE', 'Délai paiement → quittance', 'Aucune quittance émise sur paiement confirmé.', 'quittances et ordres')
        : M('M31_DELAI_QUITTANCE', 'Délai paiement → quittance', `${round1(med)} min`, `Médiane confirmation → émission, ${delays.length} quittance(s).`, 'quittances et ordres'),
      M('M31_VERIFICATIONS', 'Vérifications', String(verifs.length), `${verifs.filter((e) => e.details.found).length} vérification(s) abouties, ${verifs.filter((e) => e.details.found === false).length} code(s) inconnu(s).`, 'journal des vérifications publiques'),
      M('M31_QUITTANCES_SUSPECTES', 'Quittances suspectes', String(receipts.filter((r) => r.status === 'SUSPECTE').length), `${receipts.length} quittance(s) au registre.`, 'registre des quittances'),
    ] });
  }

  // Module 32 — Arriérés et créances.
  {
    const rec = ext<{ arrears(): { items: { amount: MoneyJSON; obligationId: string }[] }; rendement?: { summary(): { status: string; gross: Record<string, string>; net: Record<string, string> | string; detail: string } } }>(ctx, 'recouvrement');
    if (!rec) {
      out.push({ module: 32, titre: 'Arriérés et créances', indicateurs: [N('M32_ENCOURS', 'Encours', 'Module de recouvrement non chargé.', 'arriérés'), N('M32_RECOUVRES', 'Arriérés recouvrés bruts et nets', 'Module de recouvrement non chargé.', 'rendement du recouvrement')] });
    } else {
      const items = rec.arrears().items;
      const outstanding = items.map((a) => { const paid = ctx.payments.paidOn(a.obligationId); const rest = Money.fromJSON(a.amount).subtract(paid.currency === a.amount.currency ? paid : Money.zero(a.amount.currency as CurrencyCode)); return (rest.isNegative() ? Money.zero(a.amount.currency as CurrencyCode) : rest).toJSON(); });
      const y = rec.rendement?.summary();
      out.push({ module: 32, titre: 'Arriérés et créances', indicateurs: [
        M('M32_ENCOURS', 'Encours', money(sum(outstanding)), `${items.length} créance(s) échue(s) ou contestée(s) (restant dû).`, 'balance âgée'),
        !y ? N('M32_RECOUVRES', 'Arriérés recouvrés bruts et nets', 'Mesure du rendement indisponible.', 'rendement du recouvrement')
          : M('M32_RECOUVRES', 'Arriérés recouvrés bruts et nets', `brut ${money(y.gross)} ; net ${typeof y.net === 'string' ? 'non mesuré (aucun coût saisi)' : money(y.net)}`, y.detail, 'rendement du recouvrement'),
      ] });
    }
  }

  // Module 33 — Campagnes de recouvrement.
  {
    const camp = ext<{ relances?: { indicators(): { statut: string; detail: string; rows: { code: string; regularisationTest: string | null; regularisationControl: string | null; costPerFranc: { cdfEquivalent: string | null; byCurrency: Record<string, string | null>; statut: string } | null }[] } } }>(ctx, 'campagnes');
    const ind = camp?.relances?.indicators();
    const measured = ind?.rows.filter((r) => r.regularisationTest !== null) ?? [];
    const costed = ind?.rows.filter((r) => r.costPerFranc?.statut === 'MESURE') ?? [];
    out.push({ module: 33, titre: 'Campagnes de recouvrement', indicateurs: [
      measured.length ? M('M33_TAUX_REGULARISATION', 'Taux de régularisation', measured.map((r) => `${r.code} : ${r.regularisationTest} (témoin ${r.regularisationControl ?? '—'})`).join(' ; '), 'Groupe test comparé au groupe témoin, dernière mesure.', 'campagnes de recouvrement')
        : N('M33_TAUX_REGULARISATION', 'Taux de régularisation', ind ? ind.detail : 'Module des campagnes non chargé.', 'campagnes de recouvrement'),
      costed.length ? M('M33_COUT_PAR_FRANC', 'Coût par franc récupéré', costed.map((r) => `${r.code} : ${r.costPerFranc!.cdfEquivalent ?? Object.entries(r.costPerFranc!.byCurrency).filter(([, v]) => v).map(([c, v]) => `${v} (${c})`).join(', ')}`).join(' ; '), 'Coûts saisis avec pièce / récupération brute depuis le lancement.', 'campagnes et coûts du recouvrement')
        : N('M33_COUT_PAR_FRANC', 'Coût par franc récupéré', 'Aucun coût de campagne saisi ou aucune récupération constatée.', 'campagnes et coûts du recouvrement'),
    ] });
  }

  // Module 34 — Recensement terrain.
  {
    const terrain = ext<{ findings?: { all(): { outcome: string; status: string }[] } }>(ctx, 'terrain');
    const findings = terrain?.findings?.all() ?? [];
    const discovered = findings.filter((f) => f.outcome === 'OBJET_NON_ENREGISTRE').length + ctx.objects.objects.all().filter((o) => o.status === 'PROVISOIRE').length;
    const reviewed = findings.filter((f) => f.status === 'VALIDE' || f.status === 'REJETE');
    const objects = ctx.objects.objects.all();
    const validated = objects.filter((o) => o.status === 'VALIDE').length;
    out.push({ module: 34, titre: 'Recensement terrain', indicateurs: [
      M('M34_OBJETS_DECOUVERTS', 'Objets découverts', String(discovered), 'Constats « objet non enregistré » et objets provisoires au registre.', 'constats de terrain et registre des objets'),
      objects.length ? M('M34_COUVERTURE', 'Couverture', pct(validated, objects.length)!, `${validated} objet(s) validé(s) sur ${objects.length} connu(s) (vagues de recensement : écran Recensement).`, 'registre des objets')
        : N('M34_COUVERTURE', 'Couverture', 'Aucun objet au registre.', 'registre des objets'),
      reviewed.length ? M('M34_REJET_QUALITE', 'Taux de rejet qualité', pct(reviewed.filter((f) => f.status === 'REJETE').length, reviewed.length)!, `${reviewed.length} constat(s) revu(s).`, 'revue des constats')
        : N('M34_REJET_QUALITE', 'Taux de rejet qualité', terrain ? 'Aucun constat revu.' : 'Module terrain non chargé.', 'revue des constats'),
    ] });
  }

  // Module 35 — Inspection et constat.
  {
    const terrain = ext<{ inspection?: { pvs: { all(): { status: string; contestations: unknown[] }[] } }; findings?: { all(): { status: string }[] } }>(ctx, 'terrain');
    const findings = terrain?.findings?.all() ?? [];
    const reviewed = findings.filter((f) => f.status === 'VALIDE' || f.status === 'REJETE');
    const pvs = terrain?.inspection?.pvs.all().filter((p) => p.status !== 'REMPLACE') ?? [];
    out.push({ module: 35, titre: 'Inspection et constat', indicateurs: [
      M('M35_CONSTATS', 'Constats', String(findings.length), `${pvs.length} procès-verbal(aux) établi(s).`, 'constats et procès-verbaux'),
      reviewed.length ? M('M35_TAUX_VALIDATION', 'Taux de validation', pct(reviewed.filter((f) => f.status === 'VALIDE').length, reviewed.length)!, `${reviewed.length} constat(s) revu(s).`, 'revue des constats')
        : N('M35_TAUX_VALIDATION', 'Taux de validation', 'Aucun constat revu.', 'revue des constats'),
      M('M35_CONTESTATIONS', 'Contestations', String(pvs.reduce((n, p) => n + p.contestations.length, 0)), 'Contestations de procès-verbaux enregistrées (accusé de réception).', 'procès-verbaux'),
    ] });
  }

  // Module 36 — Dossiers d'exécution.
  {
    const rec = ext<{ cases: { all(): { status: string; openedAt: string; steps: { kind: string; at: string }[] }[] }; proposals: { all(): { status: string; kind: string; proposedAt: string; decision?: { at: string } }[] } }>(ctx, 'recouvrement');
    if (!rec) out.push({ module: 36, titre: 'Gestion des dossiers d’exécution', indicateurs: [N('M36_DOSSIERS', 'Dossiers ouverts, clos, délais', 'Module de recouvrement non chargé.', 'dossiers de recouvrement')] });
    else {
      const cases = rec.cases.all();
      const decided = rec.proposals.all().filter((p) => p.decision).map((p) => (Date.parse(p.decision!.at) - Date.parse(p.proposedAt)) / HOUR / 24);
      const med = median(decided);
      out.push({ module: 36, titre: 'Gestion des dossiers d’exécution', indicateurs: [
        M('M36_OUVERTS', 'Dossiers ouverts', String(cases.filter((c) => c.status === 'OUVERT').length), `${rec.proposals.all().filter((p) => p.status === 'PROPOSEE').length} proposition(s) en attente de décision.`, 'dossiers de recouvrement'),
        M('M36_CLOS', 'Dossiers clos', String(cases.filter((c) => c.status !== 'OUVERT').length), `${cases.filter((c) => c.status === 'REGULARISE').length} régularisé(s), ${cases.filter((c) => c.status === 'CLASSE').length} classé(s).`, 'dossiers de recouvrement'),
        med === null ? N('M36_DELAIS', 'Délais', 'Aucune proposition décidée.', 'propositions et décisions')
          : M('M36_DELAIS', 'Délais', `${round1(med)} j`, `Médiane proposition → décision motivée, ${decided.length} décision(s).`, 'propositions et décisions'),
      ] });
    }
  }

  // Module 37 — Réclamations et recours.
  {
    const appeals = ctx.appeals.list();
    const decided = appeals.filter((a) => a.decision);
    out.push({ module: 37, titre: 'Réclamations et recours', indicateurs: [
      decided.length ? M('M37_DANS_LE_DELAI', 'Recours traités dans le délai', pct(decided.filter((a) => a.deadlines.state === 'DECIDE_DANS_LE_DELAI').length, decided.length)!, `${decided.length} décision(s) ; ${appeals.filter((a) => a.deadlines.state === 'DELAI_DEPASSE').length} recours en délai dépassé.`, 'recours')
        : N('M37_DANS_LE_DELAI', 'Recours traités dans le délai', 'Aucun recours décidé.', 'recours'),
      decided.length ? M('M37_ERREURS_CONFIRMEES', 'Taux d’erreurs confirmées', pct(decided.filter((a) => a.decision!.decision !== 'REJETEE').length, decided.length)!, 'Recours acceptés totalement ou partiellement / recours décidés.', 'recours')
        : N('M37_ERREURS_CONFIRMEES', 'Taux d’erreurs confirmées', 'Aucun recours décidé.', 'recours'),
    ] });
  }

  // Module 38 — Gestion documentaire.
  {
    const docs = ext<{ indicators(): { volume: { documents: number; octets: number; versions: number }; integrite: { statut: string; conformes?: number; verifiees?: number; ecarts?: number; motif?: string } } }>(ctx, 'documents');
    const d = docs?.indicators();
    out.push({ module: 38, titre: 'Gestion documentaire', indicateurs: [
      d ? M('M38_VOLUME', 'Volume stocké', `${d.volume.documents} document(s), ${d.volume.octets} octets`, `${d.volume.versions} version(s) chiffrée(s).`, 'gestion documentaire') : N('M38_VOLUME', 'Volume stocké', 'Module documentaire non chargé.', 'gestion documentaire'),
      d && d.integrite.statut === 'MESURE' ? M('M38_INTEGRITE', 'Intégrité vérifiée', `${d.integrite.conformes}/${d.integrite.verifiees}`, `${d.integrite.ecarts} écart(s) au dernier contrôle.`, 'contrôle d’intégrité')
        : N('M38_INTEGRITE', 'Intégrité vérifiée', d?.integrite.motif ?? 'Module documentaire non chargé.', 'contrôle d’intégrité'),
    ] });
  }

  // Module 39 — Notifications et communication.
  {
    const com = ext<{ indicators(): { delivrance: { statut: string; taux?: string | null; motif?: string }; delai: { statut: string; medianeMinutes?: number; motif?: string }; ouverture: { messages: { statut: string; taux?: string | null; motif?: string }; avisLegaux: { statut: string; taux?: string | null; motif?: string } } } }>(ctx, 'communication');
    const c = com?.indicators();
    const src = 'journal de délivrance et accusés';
    out.push({ module: 39, titre: 'Notifications et communication', indicateurs: !c ? [N('M39_DELIVRANCE', 'Taux de délivrance', 'Module de communication non chargé.', src)] : [
      c.delivrance.statut === 'MESURE' ? M('M39_DELIVRANCE', 'Taux de délivrance', c.delivrance.taux ?? '—', 'Envois délivrés / envois sur canaux raccordés ou accusés.', src) : N('M39_DELIVRANCE', 'Taux de délivrance', c.delivrance.motif ?? '', src),
      c.delai.statut === 'MESURE' ? M('M39_DELAI', 'Délai', `${c.delai.medianeMinutes} min`, 'Médiane envoi → accusé de délivrance.', src) : N('M39_DELAI', 'Délai', c.delai.motif ?? '', src),
      c.ouverture.messages.statut === 'MESURE' || c.ouverture.avisLegaux.statut === 'MESURE'
        ? M('M39_OUVERTURE', 'Taux d’ouverture', `messages ${c.ouverture.messages.taux ?? 'non mesuré'} ; avis légaux ${c.ouverture.avisLegaux.taux ?? 'non mesuré'}`, 'Accusés de lecture et avis légaux lus.', src)
        : N('M39_OUVERTURE', 'Taux d’ouverture', `${c.ouverture.messages.motif ?? ''} ${c.ouverture.avisLegaux.motif ?? ''}`.trim(), src),
    ] });
  }

  // Module 40 — Renseignement anti-fraude.
  {
    const enq = ext<{ indicators(): { alertes: { ouvertes: number; resolues: number }; delaiInstruction: { statut: string; medianeJours?: number; motif?: string }; deperditionEvitee: { statut: string; montants?: Record<string, string>; motif?: string } } }>(ctx, 'integrite-enquetes');
    const e = enq?.indicators();
    out.push({ module: 40, titre: 'Renseignement anti-fraude', indicateurs: !e ? [N('M40_ALERTES', 'Alertes ouvertes, résolues', 'Module d’intégrité non chargé.', 'alertes')] : [
      M('M40_ALERTES', 'Alertes ouvertes, résolues', `${e.alertes.ouvertes} ouverte(s), ${e.alertes.resolues} résolue(s)`, 'Résolue : classée par un responsable distinct ou versée à un dossier.', 'alertes'),
      e.delaiInstruction.statut === 'MESURE' ? M('M40_DELAI_INSTRUCTION', 'Délai d’instruction', `${e.delaiInstruction.medianeJours} j`, 'Médiane ouverture → décision des dossiers.', 'dossiers d’enquête') : N('M40_DELAI_INSTRUCTION', 'Délai d’instruction', e.delaiInstruction.motif ?? '', 'dossiers d’enquête'),
      e.deperditionEvitee.statut === 'MESURE' ? M('M40_DEPERDITION_EVITEE', 'Déperdition évitée', money(e.deperditionEvitee.montants ?? {}), 'Montants constatés avec pièce justificative.', 'dossiers d’enquête') : N('M40_DEPERDITION_EVITEE', 'Déperdition évitée', e.deperditionEvitee.motif ?? '', 'dossiers d’enquête'),
    ] });
  }
  return out;
}

export function indicatorsFor(user: User, ctx: AppContext) {
  authorize(user, 'pilotage:indicateurs-modules.read');
  const modules = computeModuleIndicators(ctx);
  const all = modules.flatMap((m) => m.indicateurs);
  return { asOf: kinshasaDate(ctx.clock.now()), generatedAt: ctx.clock.now().toISOString(), modules, mesures: all.filter((i) => i.statut === 'MESURE').length, nonMesures: all.filter((i) => i.statut === 'NON_MESURE').length };
}

/** Module d'extension « indicateurs des modules 27 à 40 » (lecture seule). */
export const indicateursModules2740Plugin = definePlugin<null>({
  name: 'indicateurs-modules-27-40',
  create: () => null,
  routes: (app, ctx) => {
    app.get('/v1/pilotage/indicateurs-modules/27-40', async (req) => indicatorsFor(requireUser(req), ctx));
  },
});
