/** Horloge injectable : l'heure serveur est la référence ; les tests la contrôlent. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Horloge manuelle pour les tests (délai de refroidissement, fenêtres temporelles…). */
export class ManualClock implements Clock {
  private current: number;
  constructor(start: Date | string = '2026-09-26T09:00:00.000Z') {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  set(d: Date | string): void {
    this.current = new Date(d).getTime();
  }
  advance(ms: number): void {
    this.current += ms;
  }
  advanceHours(h: number): void {
    this.advance(h * 3_600_000);
  }
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Décalage de Kinshasa (UTC+1, sans heure d'été). */
export const KINSHASA_OFFSET_MS = HOUR_MS;

/** Date calendaire (AAAA-MM-JJ) à Kinshasa de l'instant `d` : 23 h 30 UTC le 31/12 est déjà le 01/01 à Kinshasa. */
export function kinshasaDate(d: Date): string {
  return new Date(d.getTime() + KINSHASA_OFFSET_MS).toISOString().slice(0, 10);
}
