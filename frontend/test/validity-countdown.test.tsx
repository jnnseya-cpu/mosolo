import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidityCountdown } from '../src/components/ValidityCountdown';
import { PrintedProof } from '../src/modules/preuves/ProofPrint';
import { noteServerTime } from '../src/lib/api';
import { renderWithApp } from './helpers';

const FROM = '2026-09-26T08:00:00.000Z';
const UNTIL = '2026-09-26T18:00:00.000Z'; // 10 h

/** Cale l'horloge « serveur » à `from + h` heures (l'heure du téléphone est ignorée). */
function serverAt(h: number) {
  noteServerTime(new Date(Date.parse(FROM) + h * 3_600_000).toISOString());
}

afterEach(() => { noteServerTime(new Date().toISOString()); vi.useRealTimers(); });

describe('Compte à rebours de validité — règle 49 % / 21 %', () => {
  it.each([
    [0, 'vc-VERT', /VALIDE/], [5.0, 'vc-VERT', /VALIDE/], [5.2, 'vc-AMBRE', /VALIDE/], [7.8, 'vc-AMBRE', /VALIDE/],
    [8.1, 'vc-ROUGE', /expire dans/], [10.5, 'vc-EXPIRE', /EXPIRÉ/], [-1, 'vc-PAS_ACTIF', /PAS ENCORE ACTIF/],
  ])('à +%s h : %s', (h, cls, text) => {
    serverAt(h as number);
    const { container } = renderWithApp(<ValidityCountdown from={FROM} until={UNTIL} />);
    const el = container.querySelector('.vc')!;
    expect(el.className).toContain(cls as string);
    expect(el.textContent).toMatch(text as RegExp);
    // Couleur jamais seule : rôle minuterie + libellé accessible.
    expect(el.getAttribute('role')).toBe('timer');
    expect(el.getAttribute('aria-label')).toMatch(/VALIDE|EXPIRÉ|PAS ENCORE/);
  });

  it('les dates seules (AAAA-MM-JJ) couvrent la journée entière à Kinshasa', () => {
    noteServerTime('2026-09-30T20:00:00.000Z'); // 21:00 à Kinshasa, dernier jour
    const { container } = renderWithApp(<ValidityCountdown from="2026-09-01" until="2026-09-30" />);
    expect(container.querySelector('.vc')!.className).toContain('vc-ROUGE');
  });

  it('un statut bloquant remplace le compte à rebours', () => {
    const { container } = renderWithApp(<ValidityCountdown from={FROM} until={UNTIL} blocked="Révoqué" />);
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.textContent).toContain('Révoqué');
  });
});

describe('Preuve imprimée', () => {
  it('porte le logo, le code, l’échéancier des couleurs et la mention de démonstration', () => {
    serverAt(1);
    const r = {
      found: true, kind: 'TICKET_STATIONNEMENT', kindLabel: 'Ticket de stationnement', code: 'PKT4K7M2QX', authentic: true, state: 'VALIDE' as const,
      stateLabel: 'Valide', title: 'Ticket de stationnement', facts: [{ label: 'Zone', value: 'Gombe-Centre' }],
      validity: { band: 'VERT', pct: 90, from: FROM, until: UNTIL, remainingSeconds: 32_400, text: '', serverTime: FROM },
      message: '', verifyPath: '/preuve/PKT4K7M2QX', checkedAt: FROM, advice: '', printedAt: FROM,
    };
    const { container } = renderWithApp(<PrintedProof r={r} format="ticket80" verifyUrl="https://exemple/preuve/PKT4K7M2QX" />);
    expect(container.querySelector('img.pv-logo')?.getAttribute('src')).toBe('/logo-ville-de-kinshasa.png');
    expect(container.textContent).toContain('PKT4K7M2QX');
    expect(container.textContent).toMatch(/Vert jusqu’au/);
    expect(container.textContent).toMatch(/Orange jusqu’au/);
    expect(container.textContent).toMatch(/Rouge jusqu’au/);
    expect(container.textContent).toContain('DÉMONSTRATION — NON OPPOSABLE');
    expect(container.textContent).toContain('Aucun agent ne reçoit d’espèces');
  });
});
