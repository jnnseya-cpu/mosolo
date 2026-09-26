import { describe, expect, it } from 'vitest';
import { normalizeComms, normalizeGovernor } from '../src/lib/normalize';
import { DEMO_COMMS } from '../src/demo/communications';
import { DEMO_GOVERNOR_RAW } from '../src/demo/governor';
import { extractCode } from '../src/pages/Verify';

describe('normalisation des réponses API', () => {
  it('lit la forme backend du tableau de bord (byCommune, tiles *Today, scénarios yearEnd)', () => {
    const v = normalizeGovernor({
      example: true,
      tiles: { confirmedToday: { amount: '412000000.00', currency: 'CDF' }, settledToday: { amount: '1.00', currency: 'CDF' }, reconRateJ1: '96.4', criticalAlerts: 3 },
      byCommune: [{ commune: 'Gombe', collected: { amount: '10.00', currency: 'CDF' }, complianceRate: '82.6' }],
      trend: [{ month: '2026-08', collected: { amount: '5.00', currency: 'CDF' }, target: { amount: '6.00', currency: 'CDF' } }, { month: '2026-09', collected: { amount: '5.00', currency: 'CDF' }, target: { amount: '6.00', currency: 'CDF' } }],
      scenarios: [{ label: 'Attendu', yearEnd: { amount: '100.00', currency: 'CDF' } }],
      criticalAlerts: [{ id: 'x', severity: 'HIGH', title: 'Alerte' }],
    });
    expect(v.tiles.reconRate).toBe(96.4);
    expect(v.tiles.settled?.amount).toBe('1.00');
    expect(v.communes[0]).toMatchObject({ name: 'Gombe', compliance: 82.6 });
    expect(v.trend[1]!.actual).toBe(10); // cumul
    expect(v.scenarioNames).toEqual(['Attendu']);
    expect(v.scenarios[v.scenarios.length - 1]!.s0).toBe(100);
    expect(v.alerts[0]!.severity).toBe('serious');
  });
  it('la démo embarquée est normalisable', () => {
    const v = normalizeGovernor(DEMO_GOVERNOR_RAW);
    expect(v.communes).toHaveLength(24);
    expect(v.ladder).toHaveLength(11);
  });
  it('lit la synthèse des communications (nombres à plat, channels[])', () => {
    const o = normalizeComms({ catalogue: 239, categories: 23, mandatory: 126, delivered: 11, attempted: 28, channelsWired: 1, coverage: { email: 192 }, channels: [{ channel: 'in-app', wired: true, sent: 4 }] }, DEMO_COMMS);
    expect(o.catalogue).toEqual({ events: 239, categories: 23, mandatory: 126 });
    expect(o.delivered).toEqual({ delivered: 11, attempted: 28 });
    expect(o.connectedChannels).toEqual(['in-app']);
    expect(o.coverage.find((c) => c.channel === 'email')?.events).toBe(192);
  });
  it('extrait le code d’un QR (URL ou code nu)', () => {
    expect(extractCode('https://mosolo.cd/verifier/ABC123')).toBe('ABC123');
    expect(extractCode('https://x/v?code=Q-1')).toBe('Q-1');
    expect(extractCode(' Q-2 ')).toBe('Q-2');
  });
});
