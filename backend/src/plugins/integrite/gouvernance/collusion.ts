/**
 * Détection explicable de la collusion sous « quatre yeux » : sur les décisions à deux personnes reconstituées du
 * journal d'audit, quatre signaux et un plafond de rotation. Chaque constat est une ALERTE à examiner par un humain :
 * il ne vaut ni preuve ni soupçon établi, et n'a aucun effet automatique sur les personnes.
 *
 *  1. PAIRE_CONCENTREE — une part élevée des décisions d'un proposant est prise par un même valideur ;
 *  2. VALIDATION_EXPRESS — un valideur approuve souvent dans les secondes qui suivent la proposition ;
 *  3. HORS_HEURES — un valideur approuve souvent hors des heures ouvrables (heure de Kinshasa) ;
 *  4. JAMAIS_DE_REFUS — un valideur n'a jamais refusé sur un volume significatif de décisions ;
 *  5. ROTATION_DEPASSEE — une même paire proposant → valideur dépasse le plafond sur la fenêtre glissante.
 */
import type { TwoPersonDecision } from './circuits.js';

export interface CollusionParams {
  windowDays: number;
  pairShareMinPct: number;
  pairDecisionsMin: number;
  fastSeconds: number;
  fastMinCount: number;
  workStartHour: number;
  workEndHour: number;
  offHoursMinCount: number;
  neverRefuseMin: number;
  rotationEnforced: boolean;
  rotationMaxPerPair: number;
  rotationWindowDays: number;
}

export type FindingCode = 'PAIRE_CONCENTREE' | 'VALIDATION_EXPRESS' | 'HORS_HEURES' | 'JAMAIS_DE_REFUS' | 'ROTATION_DEPASSEE';

export const FINDING_LABELS: Record<FindingCode, string> = {
  PAIRE_CONCENTREE: 'Paire proposant → valideur concentrée',
  VALIDATION_EXPRESS: 'Validations express (quelques secondes)',
  HORS_HEURES: 'Validations hors heures ouvrables',
  JAMAIS_DE_REFUS: 'Valideur qui ne refuse jamais',
  ROTATION_DEPASSEE: 'Plafond de rotation dépassé',
};

export interface Finding {
  code: FindingCode;
  label: string;
  severity: 'MEDIUM' | 'HIGH';
  /** Personnes concernées (identifiants d'utilisateur). */
  subjects: string[];
  explanation: string;
  variables: { name: string; value: string }[];
  /** Décisions à l'appui (identifiants d'audit, au plus 20). */
  evidence: string[];
  fingerprint: string;
}

export interface PairStat {
  proposerId: string; approverId: string; approvals: number; refusals: number;
  /** Part des décisions du proposant prises par ce valideur (%). */
  sharePct: number; fast: number; offHours: number; inRotationWindow: number; circuits: string[];
}

export interface ApproverStat {
  approverId: string; decisions: number; approvals: number; refusals: number; fast: number; offHours: number;
  medianDelaySeconds: number | null; proposers: number;
}

/** Heure de Kinshasa (UTC+1, sans heure d'été). */
const KINSHASA_OFFSET_H = 1;

export function isOffHours(iso: string, p: Pick<CollusionParams, 'workStartHour' | 'workEndHour'>): boolean {
  const d = new Date(Date.parse(iso) + KINSHASA_OFFSET_H * 3_600_000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return true;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return h < p.workStartHour || h >= p.workEndHour;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

const group = <T>(xs: T[], k: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x]);
  return m;
};

/** Nombre d'approbations d'une paire dans la fenêtre glissante de rotation se terminant à `nowMs`. */
export function pairApprovalsInWindow(decisions: TwoPersonDecision[], proposerId: string, approverId: string, windowDays: number, nowMs: number): number {
  const from = nowMs - windowDays * 86_400_000;
  return decisions.filter((d) => d.outcome === 'APPROUVE' && d.proposerId === proposerId && d.approverId === approverId && Date.parse(d.decidedAt) >= from).length;
}

export function analyse(all: TwoPersonDecision[], p: CollusionParams, now: Date) {
  const nowMs = now.getTime();
  const day = now.toISOString().slice(0, 10);
  const decisions = all.filter((d) => nowMs - Date.parse(d.decidedAt) <= p.windowDays * 86_400_000);
  const fast = (d: TwoPersonDecision) => d.outcome === 'APPROUVE' && d.delaySeconds !== null && d.delaySeconds < p.fastSeconds;
  const off = (d: TwoPersonDecision) => d.outcome === 'APPROUVE' && isOffHours(d.decidedAt, p);
  const findings: Finding[] = [];

  // Paires
  const pairs: PairStat[] = [];
  const byProposer = group(decisions, (d) => d.proposerId);
  for (const [proposerId, list] of byProposer) {
    for (const [approverId, mine] of group(list, (d) => d.approverId)) {
      const approvals = mine.filter((d) => d.outcome === 'APPROUVE');
      const sharePct = Math.round((mine.length / list.length) * 1000) / 10;
      pairs.push({
        proposerId, approverId, approvals: approvals.length, refusals: mine.length - approvals.length, sharePct,
        fast: mine.filter(fast).length, offHours: mine.filter(off).length,
        inRotationWindow: pairApprovalsInWindow(all, proposerId, approverId, p.rotationWindowDays, nowMs),
        circuits: [...new Set(mine.map((d) => d.circuit))],
      });
      if (list.length >= p.pairDecisionsMin && sharePct >= p.pairShareMinPct && approvals.length > 0) {
        const approversAvailable = new Set(list.map((d) => d.approverId)).size;
        findings.push({
          code: 'PAIRE_CONCENTREE', label: FINDING_LABELS.PAIRE_CONCENTREE, severity: sharePct >= 90 ? 'HIGH' : 'MEDIUM', subjects: [proposerId, approverId],
          explanation: `${approverId} a pris ${mine.length} des ${list.length} décisions sur les propositions de ${proposerId} (${sharePct} %) en ${p.windowDays} jours. Peut refléter une petite équipe ou un tour de garde ; peut aussi signaler une entente. Vérifier la répartition des dossiers.`,
          variables: [
            { name: 'Part', value: `${sharePct} % (seuil ${p.pairShareMinPct} %)` },
            { name: 'Décisions', value: `${mine.length} / ${list.length}` },
            { name: 'Valideurs distincts du proposant', value: String(approversAvailable) },
            { name: 'Circuits', value: [...new Set(mine.map((d) => d.circuit))].join(', ') },
          ],
          evidence: mine.slice(-20).map((d) => d.auditId), fingerprint: `COL:PAIRE:${proposerId}>${approverId}:${day}`,
        });
      }
      if (p.rotationMaxPerPair > 0) {
        const n = pairApprovalsInWindow(all, proposerId, approverId, p.rotationWindowDays, nowMs);
        if (n > p.rotationMaxPerPair) {
          findings.push({
            code: 'ROTATION_DEPASSEE', label: FINDING_LABELS.ROTATION_DEPASSEE, severity: 'MEDIUM', subjects: [proposerId, approverId],
            explanation: `La paire ${proposerId} → ${approverId} totalise ${n} validations en ${p.rotationWindowDays} jours (plafond ${p.rotationMaxPerPair}). ${p.rotationEnforced ? 'Blocage de rotation actif : les validations suivantes de cette paire sont refusées jusqu’à la sortie de la fenêtre.' : 'Blocage désactivé : alerte seulement.'}`,
            variables: [{ name: 'Validations', value: `${n} (plafond ${p.rotationMaxPerPair})` }, { name: 'Fenêtre', value: `${p.rotationWindowDays} jours` }],
            evidence: mine.filter((d) => d.outcome === 'APPROUVE').slice(-20).map((d) => d.auditId), fingerprint: `COL:ROTATION:${proposerId}>${approverId}:${day}`,
          });
        }
      }
    }
  }

  // Valideurs
  const approvers: ApproverStat[] = [];
  for (const [approverId, mine] of group(decisions, (d) => d.approverId)) {
    const approvals = mine.filter((d) => d.outcome === 'APPROUVE');
    const fastList = mine.filter(fast);
    const offList = mine.filter(off);
    approvers.push({
      approverId, decisions: mine.length, approvals: approvals.length, refusals: mine.length - approvals.length,
      fast: fastList.length, offHours: offList.length,
      medianDelaySeconds: median(mine.map((d) => d.delaySeconds).filter((x): x is number => x !== null)),
      proposers: new Set(mine.map((d) => d.proposerId)).size,
    });
    if (fastList.length >= p.fastMinCount) {
      findings.push({
        code: 'VALIDATION_EXPRESS', label: FINDING_LABELS.VALIDATION_EXPRESS, severity: 'MEDIUM', subjects: [approverId],
        explanation: `${approverId} a approuvé ${fastList.length} proposition(s) moins de ${p.fastSeconds} s après leur dépôt : délai peu compatible avec l’examen des pièces. Une approbation préparée à l’avance ou un « tampon » est possible.`,
        variables: [
          { name: 'Validations express', value: `${fastList.length} (seuil ${p.fastMinCount})` },
          { name: 'Délai le plus court', value: `${Math.min(...fastList.map((d) => d.delaySeconds!))} s` },
          { name: 'Proposants', value: [...new Set(fastList.map((d) => d.proposerId))].join(', ') },
        ],
        evidence: fastList.slice(-20).map((d) => d.auditId), fingerprint: `COL:EXPRESS:${approverId}:${day}`,
      });
    }
    if (offList.length >= p.offHoursMinCount) {
      findings.push({
        code: 'HORS_HEURES', label: FINDING_LABELS.HORS_HEURES, severity: 'MEDIUM', subjects: [approverId],
        explanation: `${approverId} a approuvé ${offList.length} décision(s) hors des heures ouvrables (${p.workStartHour} h – ${p.workEndHour} h, lundi au vendredi, heure de Kinshasa). Une astreinte légitime est possible ; vérifier le motif.`,
        variables: [{ name: 'Hors heures', value: `${offList.length} (seuil ${p.offHoursMinCount})` }, { name: 'Exemples', value: offList.slice(-3).map((d) => d.decidedAt).join(', ') }],
        evidence: offList.slice(-20).map((d) => d.auditId), fingerprint: `COL:HORS_HEURES:${approverId}:${day}`,
      });
    }
    if (mine.length >= p.neverRefuseMin && approvals.length === mine.length) {
      findings.push({
        code: 'JAMAIS_DE_REFUS', label: FINDING_LABELS.JAMAIS_DE_REFUS, severity: 'MEDIUM', subjects: [approverId],
        explanation: `${approverId} a approuvé les ${mine.length} décisions qui lui ont été soumises en ${p.windowDays} jours, sans aucun refus. Le second regard pourrait ne plus jouer son rôle de contrôle.`,
        variables: [{ name: 'Décisions', value: `${mine.length} (seuil ${p.neverRefuseMin})` }, { name: 'Refus', value: '0' }],
        evidence: mine.slice(-20).map((d) => d.auditId), fingerprint: `COL:JAMAIS_REFUS:${approverId}:${day}`,
      });
    }
  }

  pairs.sort((a, b) => b.sharePct - a.sharePct || b.approvals - a.approvals);
  approvers.sort((a, b) => b.decisions - a.decisions);
  return { decisions, pairs, approvers, findings };
}
