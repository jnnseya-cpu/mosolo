/**
 * Fond de carte OpenStreetMap de Kinshasa (auto-hébergé) : la carte affiche le fond et l'attribution ODbL visible
 * quand /tiles/kinshasa.pmtiles est servi ; sinon le message « non encore installé » et les seules couches MOSOLO.
 * MapLibre (WebGL) est remplacé par un double : jsdom n'a pas de WebGL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const cartes: { style: { sources: Record<string, { attribution?: string }> } }[] = [];
vi.mock('maplibre-gl', () => {
  class Map {
    constructor(o: { style: { sources: Record<string, { attribution?: string }> } }) { cartes.push(o); }
    addControl() { return this; }
    on() { return this; }
    remove() { /* rien */ }
  }
  class Control { }
  return { Map, NavigationControl: Control, ScaleControl: Control, setWorkerUrl: () => undefined, addProtocol: () => undefined };
});
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/worker.js' }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

function reponse(octets: string, status: number) {
  return { status, arrayBuffer: async () => new TextEncoder().encode(octets).buffer } as unknown as Response;
}

describe('Fond de carte OpenStreetMap de Kinshasa', () => {
  beforeEach(() => { vi.resetModules(); cartes.length = 0; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('fichier de tuiles servi (signature PMTiles, 206) : fond affiché, attribution ODbL visible, pas de message', async () => {
    const fetchMock = vi.fn(async () => reponse('PMTiles\u0003xxxxxxxx', 206));
    vi.stubGlobal('fetch', fetchMock);
    const { default: GeoMap, OSM_ATTRIBUTION, TILES_URL } = await import('../src/components/GeoMap');
    render(<GeoMap center={[15.31, -4.32]} />);
    await waitFor(() => expect(screen.getByText(OSM_ATTRIBUTION)).toBeTruthy());
    expect(OSM_ATTRIBUTION).toBe('© contributeurs OpenStreetMap');
    expect(fetchMock).toHaveBeenCalledWith(TILES_URL, expect.objectContaining({ headers: { Range: 'bytes=0-15' } }));
    expect(screen.queryByText(/non encore installé/)).toBeNull();
    // La carte (double de MapLibre) peut être construite juste après l'affichage de l'attribution : on l'attend.
    await waitFor(() => expect(cartes.at(-1)?.style.sources.protomaps?.attribution).toBe(OSM_ATTRIBUTION));
  });

  it('fichier absent (404) ou page HTML de repli : message « non encore installé », aucune source de tuiles', async () => {
    for (const r of [reponse('', 404), reponse('<!doctype html>', 200)]) {
      vi.resetModules(); cartes.length = 0; cleanup();
      vi.stubGlobal('fetch', vi.fn(async () => r));
      const { default: GeoMap, OSM_ATTRIBUTION } = await import('../src/components/GeoMap');
      render(<GeoMap center={[15.31, -4.32]} />);
      await waitFor(() => expect(screen.getByText(/Fond OpenStreetMap de Kinshasa non encore installé/)).toBeTruthy());
      expect(screen.getByText(/fabrique automatiquement à la construction/)).toBeTruthy();
      expect(screen.queryByText(OSM_ATTRIBUTION)).toBeNull();
      await waitFor(() => expect(cartes.length).toBeGreaterThan(0));
      expect(Object.keys(cartes.at(-1)!.style.sources)).toEqual([]);
    }
  });

  it('style : la source OpenStreetMap porte toujours l’attribution', async () => {
    const { style, OSM_ATTRIBUTION } = await import('../src/components/GeoMap');
    const s = style(true);
    expect((s.sources.protomaps as { attribution?: string }).attribution).toBe(OSM_ATTRIBUTION);
    expect(style(false).sources).toEqual({});
  });
});
