/**
 * Liens d'écran envoyés par le serveur (audit fonctionnel du 24/10/2026) : trois liens menaient à la page
 * « introuvable » (`/fiscal/enrolement`, `/pilotage/salle-controle`, `/fourrieres`). Balayage de tout le code du
 * serveur : chaque chemin d'écran littéral (`lien`, `link`, `ecran`, `to`, `href`, `path` d'écran) doit correspondre à
 * une route de l'application (App.tsx ou registre des modules), paramètres `:x` compris.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const racine = path.resolve(__dirname, '../..');
const lire = (f: string) => fs.readFileSync(path.join(racine, f), 'utf8');
const routes = [...(lire('frontend/src/App.tsx') + lire('frontend/src/modules/registry.tsx')).matchAll(/path[:=] ?['"](\/[^'"]*)['"]/g)].map((m) => m[1]!).filter((p) => p !== '*');
const motif = (r: string) => new RegExp(`^${r.replace(/:[^/]+/g, '[^/]+').replace(/[.]/g, '\\.')}$`);
const RES = routes.map(motif);
const existe = (p: string) => RES.some((re) => re.test(p.split(/[?#]/)[0]!.replace(/\/$/, '') || '/'));

function fichiers(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? fichiers(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

describe('Liens d’écran envoyés par le serveur', () => {
  it('chaque chemin d’écran littéral du serveur existe dans l’application', () => {
    const casses: string[] = [];
    for (const f of fichiers(path.join(racine, 'backend/src'))) {
      const texte = fs.readFileSync(f, 'utf8');
      for (const m of texte.matchAll(/\b(?:lien|link|ecran|écran|to|href|route|chemin)\s*:\s*'(\/[a-z0-9][^'\s]*)'/gi)) {
        const p = m[1]!;
        if (/^\/(v1|api|l|\.well-known|health|tiles|assets|icons|media|ocr|demo|paiement\/retour)(\/|$)/.test(p)) continue;
        if (!existe(p)) casses.push(`${path.relative(racine, f)} → ${p}`);
      }
    }
    expect(casses).toEqual([]);
  });
});
