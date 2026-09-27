import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { verifyStaticOffline } from '../src/modules/titres/Controle';
import { purgeUserQueues, queueKey, readQueue, updateQueue } from '../src/lib/offlineQueue';
import { ApiError, NetworkError, authHeaders, isDefinitiveRejection, readStoredSession, setDemoUser, writeStoredSession } from '../src/lib/api';
import { localDateTimeInput } from '../src/modules/canaux/PointConsole';
import { usePreciseLocation } from '../src/lib/geo';
import { QrScanner } from '../src/components/QrScanner';
import { EvidencePhotos, type EvidencePhotoMeta } from '../src/modules/parking/EvidencePhotos';
import { parsePosition } from '../src/modules/parking/shared';

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('QR statique hors ligne : seule une signature vérifiée vaut VALIDE', () => {
  const subtle = webcrypto.subtle;
  async function signed() {
    const kp = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = Buffer.from(await subtle.exportKey('spki', kp.publicKey)).toString('base64');
    const pem = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`;
    const payload = b64url(new TextEncoder().encode(JSON.stringify({ id: 'T1', n: 'N1', f: '2026-01-01', u: '2027-01-01' })));
    const sig = b64url(await subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(payload)));
    return { pem, token: `MT1.${payload}.${sig}`, payload, sig };
  }
  afterEach(() => vi.restoreAllMocks());

  it('authentique → true ; falsifié ou malformé → false', async () => {
    const { pem, token, payload, sig } = await signed();
    expect(await verifyStaticOffline(token, pem)).toBe(true);
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ id: 'T1', n: 'N1', f: '2026-01-01', u: '2099-01-01' })));
    expect(await verifyStaticOffline(`MT1.${forged}.${sig}`, pem)).toBe(false);
    expect(await verifyStaticOffline(`MT1.${payload}.%%%`, pem)).toBe(false);
    expect(await verifyStaticOffline(`MT1.${payload}`, pem)).toBe(false);
  });

  it('Ed25519 indisponible → null (jamais accepté comme authentique)', async () => {
    const { pem, token } = await signed();
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new DOMException('NotSupportedError'));
    expect(await verifyStaticOffline(token, pem)).toBeNull();
  });
});

describe('Files hors ligne par utilisateur', () => {
  beforeEach(() => localStorage.clear());

  it('pas de file sans utilisateur ; une écriture relit la file (aucune saisie écrasée)', () => {
    expect(queueKey('q', null)).toBeNull();
    const k = queueKey('q', 'u1')!;
    updateQueue<{ id: string }>(k, (q) => [...q, { id: 'a' }]);
    // Saisie enregistrée « pendant » une synchronisation, par un autre écran.
    localStorage.setItem(k, JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    const sent = new Set(['a']);
    expect(updateQueue<{ id: string }>(k, (q) => q.filter((x) => !sent.has(x.id)))).toEqual([{ id: 'b' }]);
    expect(readQueue(queueKey('q', 'u2'))).toEqual([]);
    purgeUserQueues('u1', ['q']);
    expect(localStorage.getItem(k)).toBeNull();
  });
});

describe('Session sur appareil partagé', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it('le jeton ne va jamais dans localStorage et reste utilisable par les appels', () => {
    const s = JSON.stringify({ accessToken: 'tok', session: { expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    writeStoredSession(s, true);
    expect(localStorage.getItem('mosolo.session')).toBeNull();
    expect(readStoredSession()).toBe(s);
    setDemoUser('u-demo');
    expect(authHeaders()).toMatchObject({ Authorization: 'Bearer tok', 'x-demo-user': 'u-demo' });
    writeStoredSession(null);
    expect(readStoredSession()).toBeNull();
    setDemoUser(null);
  });
});

describe('Clés d’idempotence, heure locale, position', () => {
  it('seul un refus 4xx définitif autorise une nouvelle clé', () => {
    expect(isDefinitiveRejection(new ApiError(422, 'Refus'))).toBe(true);
    expect(isDefinitiveRejection(new ApiError(503, 'Indisponible'))).toBe(false);
    expect(isDefinitiveRejection(new ApiError(429, 'Trop de requêtes'))).toBe(false);
    expect(isDefinitiveRejection(new NetworkError())).toBe(false);
  });

  it('datetime-local à l’heure locale de l’appareil', () => {
    expect(localDateTimeInput(new Date(2026, 8, 7, 5, 3))).toBe('2026-09-07T05:03');
  });

  it('aucune position par défaut : vide ou invalide → null', () => {
    expect(parsePosition('', '')).toBeNull();
    expect(parsePosition('abc', '15.3')).toBeNull();
    expect(parsePosition('-4.3', '15.3')).toEqual({ lat: -4.3, lon: 15.3 });
  });
});

describe('Géolocalisation : une erreur passagère garde le meilleur relevé', () => {
  const orig = navigator.geolocation;
  afterEach(() => { Object.defineProperty(navigator, 'geolocation', { value: orig, configurable: true }); });

  it('délai dépassé après un relevé → « timeout » avec la position conservée', () => {
    let onPos: PositionCallback = () => undefined; let onErr: PositionErrorCallback = () => undefined;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { watchPosition: (s: PositionCallback, e: PositionErrorCallback) => { onPos = s; onErr = e; return 1; }, getCurrentPosition: () => undefined, clearWatch: () => undefined },
    });
    const { result } = renderHook(() => usePreciseLocation({ targetM: 10, maxWaitMs: 30_000 }));
    act(() => onPos({ coords: { latitude: -4.3, longitude: 15.3, accuracy: 40 } } as GeolocationPosition));
    act(() => onErr({ code: 3, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'timeout' } as GeolocationPositionError));
    expect(result.current.status).toBe('timeout');
    expect(result.current.fix?.lat).toBeCloseTo(-4.3);
  });
});

describe('Lecteur de QR : la caméra ne redémarre pas à chaque rendu du parent', () => {
  const orig = navigator.mediaDevices;
  afterEach(() => { Object.defineProperty(navigator, 'mediaDevices', { value: orig, configurable: true }); });

  it('un nouveau rappel onResult ne relance pas getUserMedia', () => {
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => undefined));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const { rerender } = render(<QrScanner onResult={() => undefined} onClose={() => undefined} />);
    rerender(<QrScanner onResult={() => undefined} onClose={() => undefined} />);
    rerender(<QrScanner onResult={() => undefined} onClose={() => undefined} />);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('Photos de preuve : agrandissement accessible', () => {
  it('modal, focus sur « Fermer », Échap ferme et rend le focus à la vignette', async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Blob(['x'], { type: 'image/jpeg' }))) as unknown as typeof fetch;
    const created = vi.fn(() => 'blob:photo');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const p: EvidencePhotoMeta = {
      id: 'P1', slot: 'AUTRE', slotLabel: 'Autre vue', sha256: 'a'.repeat(64), url: '/v1/parking/evidence-photos/P1', lat: -4.3, lon: 15.3, accuracyM: 5,
      gpsSource: 'GPS', place: 'Bd du 30 Juin', stampedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), agentId: 'a', agentName: 'Agent', clockWarning: false,
    };
    render(<EvidencePhotos photos={[p]} />);
    const thumb = screen.getByRole('button', { name: /Agrandir/ });
    await waitFor(() => expect((thumb as HTMLButtonElement).disabled).toBe(false));
    thumb.focus();
    fireEvent.click(thumb);
    const dlg = screen.getByRole('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.textContent).toMatch(/Fermer/);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });
});
