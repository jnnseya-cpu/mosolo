/**
 * Calcul de validité — fonctions pures, heure du SERVEUR uniquement (AC-TIT-01).
 * Aucune fonction ne reçoit l'heure d'un terminal : l'instant de référence est toujours fourni par l'horloge serveur.
 */
import { badRequest } from '../../core/errors.js';
import {
  KINSHASA_OFFSET_MS, STATUS_PRESENTATION, type Credential, type DisplayStatus, type StatusColor, type ValidityPolicy,
} from './model.js';

const MIN = 60_000;
const DAY = 86_400_000;

/** Fin de la journée calendaire de Kinshasa contenant `t` (23:59:59.999 heure locale). */
export function endOfKinshasaDay(t: number): number {
  const local = new Date(t + KINSHASA_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23, 59, 59, 999) - KINSHASA_OFFSET_MS;
}

/** Fin de l'exercice (31 décembre 23:59:59.999, heure de Kinshasa) de l'année contenant `t`. */
export function endOfKinshasaYear(t: number): number {
  const local = new Date(t + KINSHASA_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), 11, 31, 23, 59, 59, 999) - KINSHASA_OFFSET_MS;
}

export interface WindowInput {
  /** Instant de début effectif (≥ heure serveur de l'émission). */
  start: number;
  durationMinutes?: number;
  eventStart?: string;
  eventEnd?: string;
}

/** Fenêtre de validité [début, fin] calculée par le serveur selon le modèle du type de titre. */
export function computeWindow(policy: ValidityPolicy, input: WindowInput): { from: number; until: number; uses?: number } {
  const s = input.start;
  switch (policy.model) {
    case 'DUREE_COURTE': {
      const d = input.durationMinutes ?? policy.durationMinutes;
      if (!d || d <= 0) throw badRequest('DURATION_REQUIRED', 'Durée requise pour un titre de durée courte.');
      if (policy.maxDurationMinutes && d > policy.maxDurationMinutes) {
        throw badRequest('DURATION_ABOVE_CAP', `Durée ${d} min au-delà du plafond de ${policy.maxDurationMinutes} min.`);
      }
      return { from: s, until: s + d * MIN - 1 };
    }
    case 'JOURNALIER':
      return { from: s, until: policy.dayMode === 'GLISSANT_24H' ? s + DAY - 1 : endOfKinshasaDay(s) };
    case 'HEBDOMADAIRE_MENSUEL':
    case 'ABONNEMENT':
      return { from: s, until: s + (policy.periodDays ?? 30) * DAY - 1 };
    case 'ANNUEL_EXERCICE':
      return { from: s, until: endOfKinshasaYear(s) };
    case 'PAR_EVENEMENT': {
      if (!input.eventStart || !input.eventEnd) throw badRequest('EVENT_DATES_REQUIRED', "Dates de début et de fin de l'événement requises.");
      const from = new Date(input.eventStart).getTime();
      const until = new Date(input.eventEnd).getTime();
      if (Number.isNaN(from) || Number.isNaN(until) || until <= from) throw badRequest('INVALID_EVENT_DATES', "Dates d'événement invalides.");
      return { from, until };
    }
    case 'USAGE_UNIQUE':
      return { from: s, until: s + (policy.periodDays ?? 1) * DAY - 1, uses: 1 };
    case 'CARNET_USAGES':
      return { from: s, until: s + (policy.periodDays ?? 365) * DAY - 1, uses: policy.uses ?? 10 };
    case 'GLISSANT_CONDITIONNEL':
      return { from: s, until: s + (policy.periodDays ?? 90) * DAY - 1 };
  }
}

export interface StatusView {
  status: DisplayStatus;
  color: StatusColor;
  icon: string;
  signal: 'COURT' | 'DISTINCT' | 'AUCUN';
  /** Texte toujours présent (la couleur n'est jamais seule). */
  text: string;
  /** Secondes restantes avant la fin (positif) ou écoulées depuis (négatif). */
  remainingSeconds: number;
  invalidReason?: 'REVOQUE' | 'ANNULE' | 'REMPLACE' | 'DEJA_UTILISE' | 'EPUISE' | 'CONDITION_NON_REMPLIE';
  serverTime: string;
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / MIN);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${Math.max(m, abs > 0 ? 1 : 0)} min`;
}

function kinshasaLabel(t: number): string {
  const d = new Date(t + KINSHASA_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Statut affiché d'un titre à l'instant serveur `now` (§ H.11.2). */
export function statusAt(c: Pick<Credential, 'state' | 'stateReason' | 'validFrom' | 'validUntil' | 'toleranceMinutes' | 'amberMinutes' | 'usesLeft' | 'usesTotal' | 'conditionMet' | 'model'>, now: Date): StatusView {
  const t = now.getTime();
  const from = new Date(c.validFrom).getTime();
  const until = new Date(c.validUntil).getTime();
  const remaining = until - t;
  const base = (status: DisplayStatus, text: string, extra: Partial<StatusView> = {}): StatusView => ({
    status, ...STATUS_PRESENTATION[status], text, remainingSeconds: Math.round(remaining / 1000), serverTime: now.toISOString(), ...extra,
  });
  if (c.state === 'REVOQUE') return base('INVALIDE', 'INVALIDE — titre révoqué', { invalidReason: 'REVOQUE' });
  if (c.state === 'ANNULE') return base('INVALIDE', 'INVALIDE — titre annulé', { invalidReason: 'ANNULE' });
  if (c.state === 'REMPLACE') return base('INVALIDE', 'INVALIDE — titre remplacé', { invalidReason: 'REMPLACE' });
  if (c.state === 'CONSOMME') {
    return c.model === 'CARNET_USAGES'
      ? base('INVALIDE', 'INVALIDE — carnet épuisé', { invalidReason: 'EPUISE' })
      : base('INVALIDE', 'DÉJÀ UTILISÉ', { invalidReason: 'DEJA_UTILISE' });
  }
  if (c.state === 'SUSPENDU') return base('SUSPENDU', `SUSPENDU — ${c.stateReason ?? 'motif communiqué au titulaire'}`);
  if (c.model === 'GLISSANT_CONDITIONNEL' && c.conditionMet === false) {
    return base('INVALIDE', 'INVALIDE — conditions non remplies', { invalidReason: 'CONDITION_NON_REMPLIE' });
  }
  if (t < from) return base('PAS_ENCORE_ACTIF', `VALIDE À PARTIR DU ${kinshasaLabel(from)}`);
  if (t > until + c.toleranceMinutes * MIN) return base('EXPIRE', `EXPIRÉ DEPUIS ${formatDuration(t - until)}`);
  if (t > until) return base('BIENTOT_EXPIRE', `EXPIRÉ — TOLÉRANCE EN COURS (${formatDuration(until + c.toleranceMinutes * MIN - t)})`);
  if (remaining <= c.amberMinutes * MIN) return base('BIENTOT_EXPIRE', `EXPIRE DANS ${formatDuration(remaining)}`);
  return base('VALIDE', `VALIDE — encore ${formatDuration(remaining)}`);
}

/** Réponse minimale de contrôle. */
export function controlResultOf(s: DisplayStatus): 'VALIDE' | 'INVALIDE' | 'EXPIRE' {
  if (s === 'VALIDE' || s === 'BIENTOT_EXPIRE') return 'VALIDE';
  if (s === 'EXPIRE') return 'EXPIRE';
  return 'INVALIDE';
}
