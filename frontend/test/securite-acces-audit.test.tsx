import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import {
  __resetOfflineQueuesForTests, flushOfflineQueues, onQueueChange, OFFLINE_MISSION_TTL_HOURS, purgeUserQueues, queueKey, readQueue, updateQueue,
} from '../src/lib/offlineQueue';
import Elevations from '../src/modules/acces/Elevations';
import Scellement, { type ScellementStatus } from '../src/modules/integrite/Scellement';
import SurveillanceTechnique from '../src/modules/integrite/SurveillanceTechnique';
import Extractions from '../src/modules/socle/Extractions';

describe('File hors ligne chiffrée (§ 15.1, § 15.4, ARB-68)', () => {
  beforeEach(() => { localStorage.clear(); __resetOfflineQueuesForTests({ dropKeys: true }); });
  afterEach(() => vi.restoreAllMocks());

  it('les données de mission sont chiffrées au repos (AES-GCM) et relues après rechargement', async () => {
    const k = queueKey('mosolo.fieldQueue.v2', 'agent-1')!;
    expect(updateQueue<{ id: string; nom: string }>(k, (q) => [...q, { id: 'a', nom: 'Parcelle Kingabwa 12' }])).toEqual([{ id: 'a', nom: 'Parcelle Kingabwa 12' }]);
    await flushOfflineQueues();
    const raw = localStorage.getItem(k)!;
    expect(raw).not.toContain('Kingabwa');
    expect(JSON.parse(raw)).toMatchObject({ v: 'mosolo-file-chiffree/1', alg: 'AES-GCM-256' });
    // Rechargement de la page (la clé non exportable reste dans le magasin de clés) : déchiffrement asynchrone.
    __resetOfflineQueuesForTests();
    const changed = vi.fn();
    const off = onQueueChange(k, changed);
    expect(readQueue(k)).toEqual([]);
    // Une saisie faite pendant le déchiffrement n'écrase rien : elle est rejouée sur la file relue.
    updateQueue<{ id: string; nom: string }>(k, (q) => [...q, { id: 'b', nom: 'Étal 7' }]);
    await flushOfflineQueues();
    expect(changed).toHaveBeenCalled();
    expect(readQueue<{ id: string }>(k).map((x) => x.id)).toEqual(['a', 'b']);
    off();
  });

  it('une file recopiée sous une autre clé ne se déchiffre pas ; la déconnexion efface la file et détruit la clé', async () => {
    const k = queueKey('mosolo.titres.queue', 'agent-2')!;
    updateQueue(k, () => [{ id: 'c1' }]);
    await flushOfflineQueues();
    const other = queueKey('mosolo.titres.queue', 'agent-3')!;
    localStorage.setItem(other, localStorage.getItem(k)!);
    __resetOfflineQueuesForTests();
    readQueue(other);
    await flushOfflineQueues();
    expect(readQueue(other)).toEqual([]);
    const copy = localStorage.getItem(k)!;
    purgeUserQueues('agent-2');
    expect(localStorage.getItem(k)).toBeNull();
    // Copie résiduelle (sauvegarde du navigateur) : illisible, la clé est détruite.
    await flushOfflineQueues();
    localStorage.setItem(k, copy);
    __resetOfflineQueuesForTests();
    readQueue(k);
    await flushOfflineQueues();
    expect(readQueue(k)).toEqual([]);
  });

  it(`expiration automatique des données de mission après ${OFFLINE_MISSION_TTL_HOURS} h`, async () => {
    const k = queueKey('mosolo.fieldQueue.v2', 'agent-4')!;
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    updateQueue(k, () => [{ id: 'vieux' }]);
    now.mockReturnValue(t0 + 10 * 3_600_000);
    updateQueue<{ id: string }>(k, (q) => [...q, { id: 'recent' }]);
    now.mockReturnValue(t0 + (OFFLINE_MISSION_TTL_HOURS + 1) * 3_600_000);
    expect(readQueue<{ id: string }>(k).map((x) => x.id)).toEqual(['recent']);
    await flushOfflineQueues();
  });

  it('file historique en clair : relue puis rechiffrée', async () => {
    const k = queueKey('q', 'u9')!;
    localStorage.setItem(k, JSON.stringify([{ id: 'ancien' }]));
    expect(readQueue(k)).toEqual([{ id: 'ancien' }]);
    await flushOfflineQueues();
    expect(localStorage.getItem(k)).not.toContain('ancien');
  });
});

const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } }));
function mockApi(user: { id: string; roles: string[] }, routes: Record<string, unknown>) {
  globalThis.fetch = vi.fn((url: string) => {
    if (String(url).includes('/v1/demo/users')) return json([{ ...user, name: `${user.id} (démo)`, entity: 'PLATEFORME' }]);
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return json(hit[1]);
  }) as unknown as typeof fetch;
  localStorage.removeItem('mosolo.demoUser');
}
const renderApp = (el: JSX.Element) => render(<AppProvider initialLang="fr">{el}</AppProvider>);

describe('Écrans sécurité, accès et audit', () => {
  it('accès privilégiés : l’élévation demandée est à approuver par la sécurité', async () => {
    mockApi({ id: 'u-rssi', roles: ['R28'] }, {
      '/v1/acces/elevations': {
        items: [{ id: 'ELV-00001', userId: 'acces-u-exploitation', role: 'R26', roleLabel: 'Super-administrateur de la plateforme', motif: 'Incident INC-42', durationMinutes: 30, status: 'DEMANDEE', requestedAt: '2026-09-29T09:00:00Z', actions: 0, remainingSeconds: 0 }],
        elevatableRoles: [{ code: 'R26', label: 'Super-administrateur de la plateforme' }], maxMinutes: 120,
      },
    });
    renderApp(<Elevations />);
    expect(await screen.findByText('ELV-00001')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approuver' })).toBeTruthy();
    expect(screen.getByText('Demandée')).toBeTruthy();
  });

  it('scellement : racines publiées et contrôles affichés ; accès réservé sinon', async () => {
    const status: ScellementStatus = {
      signer: { kind: 'LOGICIEL', keyId: 'abc', note: 'Signature logicielle (HMAC).' },
      chain: { length: 42, head: { seq: 42, hash: 'f'.repeat(64) } },
      worm: { kind: 'MEMOIRE', location: 'memoire', lastSeq: 40, segments: [] },
      timestampAuthority: { name: 'Horodatage local', external: false, note: 'Adaptateur local non qualifié.' },
      publication: { kind: 'MEMOIRE', location: 'memoire', published: 1 },
      roots: [{ id: 'RAC-2026-09-28', day: '2026-09-28', partial: false, fromSeq: 1, toSeq: 40, count: 40, merkleRoot: 'a'.repeat(64), timestamp: { genTime: '2026-09-29T00:10:00Z', policy: 'urn:mosolo:tsa:local' }, publication: { kind: 'MEMOIRE', ref: 'memoire#1' }, createdAt: '2026-09-29T00:10:00Z' }],
      lastCheck: null, checks: [],
    };
    mockApi({ id: 'u-auditeur', roles: ['R22'] }, { '/v1/integrite/scellement': status });
    renderApp(<Scellement />);
    expect(await screen.findByText('2026-09-28')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Contrôler maintenant/ })).toBeTruthy();
  });

  it('surveillance technique et extractions : écrans réservés aux rôles habilités', async () => {
    mockApi({ id: 'u-guichet', roles: ['R12'] }, {});
    renderApp(<SurveillanceTechnique />);
    expect(await screen.findByText('Accès réservé')).toBeTruthy();
  });

  it('extractions : visa du responsable des données proposé au DPO', async () => {
    mockApi({ id: 'integrite-u-dpo', roles: ['R25'] }, {
      '/v1/socle/exports/requests': { threshold: 5000, items: [{ id: 'EXM-00001', requestedBy: 'u-superadmin', reason: 'Audit externe', finalite: 'Audit externe', repos: [], rowsAtRequest: 12000, threshold: 5000, status: 'DEMANDEE', requestedAt: '2026-09-29T09:00:00Z', packageAvailable: false, packageRows: null }] },
    });
    renderApp(<Extractions />);
    expect(await screen.findByText('EXM-00001')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Viser' })).toBeTruthy();
  });
});
