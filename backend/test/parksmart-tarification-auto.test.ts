/**
 * Module 75 — ParkSmart : tarification dynamique AUTOMATIQUE à l'intérieur des fourchettes fixées par l'acte
 * (minimum/maximum par zone et par heure dans la règle ACTIVE) pour maintenir 15 à 25 % de places libres ;
 * hors fourchette ou sans acte : recommandation seulement (décision du maître d'ouvrage, 27/09/2026).
 */
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/core/clock.js';
import { parkingPlugin } from '../src/plugins/parking/plugin.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import type { ParkingService } from '../src/plugins/parking/service.js';
import { pricingSchedulerEnabled } from '../src/plugins/parking/tarification-dynamique.js';
import { titresPlugin } from '../src/plugins/titres/plugin.js';
import { exampleRule, idem, setupApp } from './partie5-helpers.js';

const zoneBody = (code: string) => ({
  code, name: `Zone d’exemple ${code} [EXEMPLE]`, commune: 'Gombe', quartier: 'Commerce', kind: 'SECTEUR',
  geometry: { type: 'Polygon', coordinates: [[15.31, -4.30], [15.312, -4.30], [15.312, -4.302]] }, localityRank: 1,
  capacity: { standard: 4, livraison: 0, pmr: 0 },
});

async function setup() {
  const env = await setupApp([titresPlugin, parkingPlugin]);
  const svc = env.app.ctx.ext.parking as ParkingService;
  exampleRule(env, {
    code: 'EX-PARK-DYN', currency: 'CDF', revenueCategory: 'REDEVANCE_SERVICE', formula: 'duree_minutes / 60 * places * tarif_dynamique',
    rateTable: {
      // Fourchette de l'heure 09 (heure de Kinshasa) et fourchette par défaut de la zone ; pas d'ajustement [EXEMPLE].
      'fourchette_min.EX-DYN-01.09': '500', 'fourchette_max.EX-DYN-01.09': '1000',
      'fourchette_min.EX-DYN-01': '500', 'fourchette_max.EX-DYN-01': '800', pas_ajustement: '250',
    },
  });
  const zr = await env.req('POST', '/v1/parking/zones', 'pk-regie', zoneBody('EX-DYN-01'));
  expect(zr.statusCode, zr.body).toBe(201);
  const z1 = zr.json().id as string;
  expect((await env.req('POST', `/v1/parking/zones/${z1}/tariff`, 'pk-regie', { tariffRuleCode: 'EX-PARK-DYN', actReference: 'Arrêté de zonage FICTIF [EXEMPLE]' })).json().legalStatus).toBe('OUVERTE');
  return { env, svc, z1 };
}

/** Relevé capteur saturé (4/4 places) pendant l'heure 09 de Kinshasa (08:00–09:00 UTC) du jour donné. */
async function saturate9(env: Awaited<ReturnType<typeof setup>>['env'], zoneId: string, day: string) {
  expect((await env.req('POST', `/v1/parking/zones/${zoneId}/sensor-readings`, 'pk-regie', { sensorId: 'CAP-EX-1', occupied: 4, at: `${day}T08:20:00.000Z` })).statusCode).toBe(201);
}

describe('ParkSmart — tarification automatique dans les fourchettes de l’acte (module 75)', () => {
  it('saturation → hausse d’un pas bornée par la fourchette de l’heure, appliquée à l’achat du lendemain ; idempotent et journalisé', async () => {
    const { env, svc, z1 } = await setup();
    // Tarif initial = minimum de la fourchette (le plus favorable à l'usager) : 1 h × 500 CDF.
    const s0 = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: z1, plate: 'KN-0009-DM', durationMinutes: 60 }, idem());
    expect(s0.statusCode).toBe(201);
    expect(s0.json().obligation.amount).toEqual({ amount: '500.00', currency: 'CDF' });

    await saturate9(env, z1, '2026-09-26');
    expect((await env.req('POST', '/v1/parking/tarification-dynamique/run', 'u-contribuable', {})).statusCode).toBe(403);
    const run = await env.req('POST', '/v1/parking/tarification-dynamique/run', 'pk-regie', {});
    expect(run.statusCode).toBe(201);
    expect(run.json()).toMatchObject({ date: '2026-09-26', hour: 9, trigger: 'MANUELLE' });
    expect(run.json().adjusted).toEqual([{ zoneId: z1, from: '500', to: '750', freeRate: '0.0' }]);
    // Zones sans tarif dynamique (règle fixe) ou sans acte : recommandation seulement.
    expect(run.json().recommendationOnly.find((r: { zoneId: string }) => r.zoneId === PARKING_DEMO.zoneGombe).reason).toMatch(/ne prévoit pas de tarif dynamique/);
    // Idempotence : second passage manuel ou planifié → aucun second ajustement.
    expect((await env.req('POST', '/v1/parking/tarification-dynamique/run', 'pk-regie', {})).json().adjusted).toEqual([]);
    expect(svc.tarification.scheduledTick()).toEqual({ ran: false });
    const audit = env.app.ctx.audit.list({ limit: 100000 }).items.filter((a) => a.action === 'parking.pricing.auto_adjusted');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ before: '500', after: '750', hour: '09', band: { min: '500', max: '1000', step: '250' }, rule: 'EX-PARK-DYN v1' });

    // Le lendemain à 09 h 30 (Kinshasa) : la vente est liquidée au tarif automatique de l'heure (750 CDF).
    env.clock.set(new Date('2026-09-27T08:30:00.000Z'));
    const s1 = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: z1, plate: 'KN-0010-DM', durationMinutes: 60 }, idem());
    expect(s1.json().obligation.amount).toEqual({ amount: '750.00', currency: 'CDF' });
    // À 10 h 30 : autre heure, fourchette par défaut de la zone, tarif initial 500.
    env.clock.set(new Date('2026-09-27T09:30:00.000Z'));
    const s2 = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: z1, plate: 'KN-0011-DM', durationMinutes: 60 }, idem());
    expect(s2.json().obligation.amount).toEqual({ amount: '500.00', currency: 'CDF' });
  });

  it('à la borne de la fourchette, l’écart persistant devient une recommandation (hors fourchette) ; sans fourchette : aucun tarif inventé', async () => {
    const { env, svc, z1 } = await setup();
    const days = ['2026-09-26', '2026-09-27', '2026-09-28'];
    const outcomes: unknown[] = [];
    for (const [i, day] of days.entries()) {
      env.clock.set(new Date(`${day}T09:00:00.000Z`));
      await saturate9(env, z1, day);
      const r = (await env.req('POST', '/v1/parking/tarification-dynamique/run', 'pk-regie', { date: day, hour: 9 })).json();
      outcomes.push(r.adjusted.find((a: { zoneId: string }) => a.zoneId === z1)?.to ?? r.recommendationOnly.find((x: { zoneId: string }) => x.zoneId === z1)?.reason);
      if (i === 2) expect(r.recommendations.length).toBeGreaterThan(0);
    }
    expect(outcomes[0]).toBe('750');
    expect(outcomes[1]).toBe('1000');
    expect(outcomes[2]).toMatch(/borne haute de la fourchette \(1000\) : hors fourchette, recommandation seulement/);
    // La recommandation suit le circuit existant (jamais appliquée).
    const recos = (await env.req('GET', '/v1/parking/pricing-recommendations', 'pk-regie')).json().items as { zoneId: string; applied: boolean; status: string }[];
    expect(recos.find((x) => x.zoneId === z1)).toMatchObject({ applied: false, status: 'PROPOSEE' });

    // Zone liée à la même règle sans fourchette pour son code : mode recommandation, et vente refusée (aucun tarif inventé).
    const z2 = (await env.req('POST', '/v1/parking/zones', 'pk-regie', zoneBody('EX-DYN-02'))).json().id as string;
    await env.req('POST', `/v1/parking/zones/${z2}/tariff`, 'pk-regie', { tariffRuleCode: 'EX-PARK-DYN', actReference: 'Arrêté de zonage FICTIF [EXEMPLE]' });
    const sold = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: z2, plate: 'KN-0012-DM', durationMinutes: 60 }, idem());
    expect(sold.json().code).toBe('DYNAMIC_BAND_MISSING');
    const view = (await env.req('GET', '/v1/parking/tarification-dynamique', 'pk-regie')).json();
    const v1 = view.zones.find((z: { zoneId: string }) => z.zoneId === z1);
    const v2 = view.zones.find((z: { zoneId: string }) => z.zoneId === z2);
    expect(v1).toMatchObject({ mode: 'AUTOMATIQUE', rule: { code: 'EX-PARK-DYN', demo: true } });
    expect(v1.hours[9]).toMatchObject({ band: { min: '500', max: '1000', step: '250' }, rate: '1000' });
    expect(v1.history.map((h: { to: string }) => h.to)).toEqual(['1000', '750']);
    expect(v2).toMatchObject({ mode: 'RECOMMANDATION_SEULEMENT' });
    expect(v2.reason).toMatch(/aucune fourchette/);
    expect(view.zones.find((z: { zoneId: string }) => z.zoneId === PARKING_DEMO.zoneGombeReal).reason).toMatch(/Sans acte/);
    expect((await env.req('GET', '/v1/parking/tarification-dynamique', 'u-contribuable')).statusCode).toBe(403);

    // Planificateur : l'heure précédente est évaluée une fois.
    env.clock.set(new Date('2026-09-29T09:05:00.000Z'));
    expect(svc.tarification.scheduledTick()).toEqual({ ran: true });
    expect(svc.tarification.scheduledTick()).toEqual({ ran: false });
    expect(pricingSchedulerEnabled({ VITEST: 'true' })).toBe(false);
    expect(pricingSchedulerEnabled({})).toBe(true);
    expect(pricingSchedulerEnabled({ MOSOLO_PARKSMART_PRICING_SCHEDULER: 'off' })).toBe(false);
    void DAY_MS;
  });
});
