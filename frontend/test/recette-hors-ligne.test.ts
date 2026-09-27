/**
 * Recette (Document maître FR 2, ch. 42, critère 6 ; ch. 45, tests hors ligne) : l'application terrain fonctionne
 * sans réseau pendant une journée complète de mission et synchronise sans perte. Titre repris par le référentiel du
 * programme (backend/src/plugins/pilotage/recette-programme/referentiels.ts) — ne pas le renommer sans le mettre à jour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetOfflineQueuesForTests, flushOfflineQueues, OFFLINE_MISSION_TTL_HOURS, queueKey, readQueue, updateQueue } from '../src/lib/offlineQueue';

interface Capture { id: string; observedAt: string; state: 'pending' | 'synced'; note: string }

describe('Recette hors ligne — journée complète de mission (ch. 42, critère 6)', () => {
  beforeEach(() => { localStorage.clear(); __resetOfflineQueuesForTests({ dropKeys: true }); });
  afterEach(() => vi.restoreAllMocks());

  it('journée complète de mission hors réseau : aucune saisie perdue, relue après rechargement, synchronisée une seule fois', async () => {
    const k = queueKey('mosolo.fieldQueue.v2', 'agent-journee')!;
    const t0 = Date.parse('2026-09-26T07:00:00.000Z'); // 8 h à Kinshasa
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    // Une saisie toutes les 45 minutes pendant 10 h 30, avec deux rechargements de l'application en cours de journée.
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      now.mockReturnValue(t0 + i * 45 * 60_000);
      const id = `CST-${String(i).padStart(2, '0')}`;
      ids.push(id);
      updateQueue<Capture>(k, (q) => [...q, { id, observedAt: new Date(Date.now()).toISOString(), state: 'pending', note: `Constat ${i} (hors réseau)` }]);
      if (i === 5 || i === 11) {
        await flushOfflineQueues();
        __resetOfflineQueuesForTests(); // rechargement : la file chiffrée est relue depuis le stockage
        readQueue(k);
        await flushOfflineQueues();
      }
    }
    await flushOfflineQueues();
    expect(OFFLINE_MISSION_TTL_HOURS).toBeGreaterThanOrEqual(24); // conservation au-delà d'une journée de mission
    expect(readQueue<Capture>(k).map((c) => c.id)).toEqual(ids);
    // Retour du réseau en fin de journée : synchronisation ; une saisie faite pendant l'envoi n'est jamais perdue.
    now.mockReturnValue(t0 + 11 * 3_600_000);
    const sent = new Set(readQueue<Capture>(k).map((c) => c.id));
    updateQueue<Capture>(k, (q) => [...q, { id: 'CST-PENDANT-ENVOI', observedAt: new Date(Date.now()).toISOString(), state: 'pending', note: 'Saisie pendant la synchronisation' }]);
    const serverReceived: string[] = [];
    for (const c of readQueue<Capture>(k)) if (sent.has(c.id)) serverReceived.push(c.id);
    updateQueue<Capture>(k, (q) => q.filter((c) => !sent.has(c.id)));
    await flushOfflineQueues();
    expect(serverReceived).toEqual(ids);
    expect(new Set(serverReceived).size).toBe(15); // chaque saisie envoyée une seule fois
    expect(readQueue<Capture>(k).map((c) => c.id)).toEqual(['CST-PENDANT-ENVOI']);
    // Une seconde synchronisation n'envoie plus que ce qui reste : aucun doublon.
    const second = readQueue<Capture>(k).filter((c) => sent.has(c.id));
    expect(second).toEqual([]);
  });
});
