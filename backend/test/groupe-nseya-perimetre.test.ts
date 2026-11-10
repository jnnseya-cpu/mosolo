/**
 * Groupe Nseya (R26 + R38) — périmètre de lecture selon la phase (30/09/2026) : en démonstration, lecture globale (aucun
 * « Accès refusé » en lecture) ; plateforme EN SERVICE : ni tableaux réservés au Gouverneur ni opérations quotidiennes
 * des services, seulement son périmètre (moteur de paiement et de répartition, grand livre, trésor en agrégats, audit…).
 * Jamais d'écriture ni d'approbation, dans les deux phases ; dossiers personnels par consultation motivée (C42-05).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { evaluate, isLectureGroupeNseya } from '../src/core/policy.js';
import type { User } from '../src/core/auth.js';

const nseya: User = { kind: 'user', id: 'u-superadmin', name: 'Groupe Nseya', roles: ['R26', 'R38'], entity: 'PLATEFORME' } as User;
const saved = process.env.MOSOLO_DEMO_MODE;
afterEach(() => { if (saved === undefined) delete process.env.MOSOLO_DEMO_MODE; else process.env.MOSOLO_DEMO_MODE = saved; });

describe('Groupe Nseya : périmètre de lecture selon la phase', () => {
  it('démonstration : lecture globale, y compris le poste du Gouverneur ; jamais d’écriture ni de dossier personnel direct', () => {
    process.env.MOSOLO_DEMO_MODE = '1';
    for (const a of ['pilotage:profile.gouverneur', 'dashboard.governor', 'ai.insight', 'decision:regie.read', 'moteur:repartition.read', 'tresor:overview']) expect(isLectureGroupeNseya(a), a).toBe(true);
    for (const a of ['programme:suivi.write', 'integrite:report.assign', 'rule.approve', 'taxpayer.read']) expect(isLectureGroupeNseya(a), a).toBe(false);
  });
  it('en service : pas de tableaux du Gouverneur ni des opérations des services ; son périmètre financier reste lisible', () => {
    delete process.env.MOSOLO_DEMO_MODE;
    for (const a of ['pilotage:profile.gouverneur', 'dashboard.governor', 'ai.insight', 'decision:regie.read', 'pilotage:profile.ministre', 'canaux:point.supervise']) {
      expect(isLectureGroupeNseya(a), a).toBe(false);
      expect(evaluate(nseya, a as never), a).toBe(false);
    }
    for (const a of ['moteur:repartition.read', 'ledger.read', 'tresor:overview', 'audit.read', 'repartition:read']) expect(isLectureGroupeNseya(a), a).toBe(true);
  });
});
