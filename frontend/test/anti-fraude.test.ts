import { describe, expect, it } from 'vitest';
import { withPresence } from '../src/lib/geo';
import { sha256Hex, toBase64 } from '../src/lib/evidenceJpeg';
import { adPhotoView, evidenceBody } from '../src/modules/publicite/AdPhotoUpload';

describe('présence du terminal jointe aux contrôles', () => {
  const gps = { lat: -4.3217123, lon: 15.3125987, accuracy: 12.34, source: 'GPS' as const };
  it('ajoute lat, lon et accuracyM pour un relevé GPS mesuré', () => {
    expect(withPresence('/v1/parking/control/KN-0777-DM?zoneId=Z1', gps)).toBe('/v1/parking/control/KN-0777-DM?zoneId=Z1&lat=-4.321712&lon=15.312599&accuracyM=12.3');
    expect(withPresence('/v1/verticales/plates/NFIU-1/scan', gps)).toBe('/v1/verticales/plates/NFIU-1/scan?lat=-4.321712&lon=15.312599&accuracyM=12.3');
  });
  it('n’envoie rien sans relevé, sans précision ou pour une position ajustée à la main', () => {
    expect(withPresence('/p', null)).toBe('/p');
    expect(withPresence('/p', { ...gps, accuracy: null })).toBe('/p');
    expect(withPresence('/p', { ...gps, source: 'MANUEL' })).toBe('/p');
    expect(withPresence('/p', { ...gps, source: 'ZONE' })).toBe('/p');
  });
});

describe('photos de preuve de la publicité', () => {
  it('corps de versement : JPEG en base64, empreinte, position, heure', async () => {
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer;
    const b = evidenceBody(buf, 'ab'.repeat(32), { lat: -4.3, lon: 15.3, accuracy: 8, source: 'GPS' }, Date.UTC(2026, 8, 27, 10, 0, 0));
    expect(b).toEqual({ imageBase64: '/9j/4AECAw==', sha256: 'ab'.repeat(32), lat: -4.3, lon: 15.3, accuracyM: 8, gpsSource: 'GPS', stampedAt: '2026-09-27T10:00:00.000Z' });
    expect('accuracyM' in evidenceBody(buf, 'x', { lat: 0, lon: 0, source: 'MANUEL' }, 0)).toBe(false);
    expect(toBase64(new TextEncoder().encode('abc').buffer)).toBe('YWJj');
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('photo conservée au serveur présentée au vérificateur', () => {
    const v = adPhotoView({
      id: 'ADP-1', sha256: 'cd'.repeat(32), mime: 'image/jpeg', sizeBytes: 1000, lat: -4.3, lon: 15.3, accuracyM: null, gpsSource: 'MANUEL', stampedAt: '2026-09-27T10:00:00Z',
      receivedAt: '2026-09-27T10:00:05Z', clockSkewSeconds: 5, agentId: 'pb-inspecteur-1', inspectionId: 'ADI-1', url: '/v1/publicite/evidence-photos/ADP-1', clockWarning: false, lowAccuracy: true,
    }, 1);
    expect(v.slotLabel).toBe('Photo 2');
    expect(v.url).toBe('/v1/publicite/evidence-photos/ADP-1');
    expect(v.lowAccuracy).toBe(true);
  });
});
