/**
 * Traduction automatique de l'interface (30/09/2026, demande du maître d'ouvrage : « la traduction complète ne fonctionne
 * pas ») : l'interface est rédigée en français (version qui fait foi) ; quand l'usager choisit une autre langue, les textes
 * affichés sont traduits AUTOMATIQUEMENT par Google Cloud Translation (lingala, kiswahili, kikongo, tshiluba, anglais),
 * dans le projet Google Cloud de la plateforme, et marqués « traduction automatique ».
 *
 * Accès au service, sans clé dans le dépôt : sur Cloud Run, jeton du compte de service (serveur de métadonnées) ; ailleurs,
 * clé `GOOGLE_TRANSLATE_API_KEY` si fournie. Sans l'un ni l'autre : indisponible (l'interface reste en français).
 * `MOSOLO_TRADUCTION=off` désactive le service. Cache en mémoire (les libellés d'interface sont traduits une seule fois).
 */
export const LANGUES_TRADUITES = ['ln', 'sw', 'kg', 'lua', 'en'] as const;
export type LangueTraduite = (typeof LANGUES_TRADUITES)[number];

export type Traducteur = (textes: string[], cible: LangueTraduite) => Promise<string[]>;

const API = 'https://translation.googleapis.com/language/translate/v2';
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const MAX_CACHE = 60_000;

/** Jeton du compte de service Cloud Run (serveur de métadonnées), mis en cache jusqu'à son expiration. */
function jetonMetadonnees(): () => Promise<{ token: string; projet: string | null }> {
  let cache: { token: string; exp: number; projet: string | null } | null = null;
  return async () => {
    if (cache && cache.exp > Date.now() + 60_000) return cache;
    const h = { 'Metadata-Flavor': 'Google' };
    const r = await fetch(`${METADATA}/instance/service-accounts/default/token`, { headers: h });
    if (!r.ok) throw new Error(`Jeton du compte de service indisponible (${r.status})`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    const p = await fetch(`${METADATA}/project/project-id`, { headers: h }).then((x) => (x.ok ? x.text() : null)).catch(() => null);
    cache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000, projet: p };
    return cache;
  };
}

/** Fournisseur Google Cloud Translation v2 selon l'environnement ; null si aucun accès n'est configuré. */
export function traducteurGoogle(env: NodeJS.ProcessEnv = process.env): Traducteur | null {
  if ((env.MOSOLO_TRADUCTION ?? '').toLowerCase() === 'off') return null;
  const cle = env.GOOGLE_TRANSLATE_API_KEY?.trim();
  const surCloudRun = !!env.K_SERVICE;
  if (!cle && !surCloudRun) return null;
  const jeton = surCloudRun && !cle ? jetonMetadonnees() : null;
  return async (textes, cible) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let url = API;
    if (cle) url += `?key=${encodeURIComponent(cle)}`;
    else if (jeton) {
      const j = await jeton();
      headers.authorization = `Bearer ${j.token}`;
      if (j.projet) headers['x-goog-user-project'] = j.projet;
    }
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ q: textes, source: 'fr', target: cible, format: 'text' }) });
    if (!r.ok) throw new Error(`Service de traduction : ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { data: { translations: { translatedText: string }[] } };
    return j.data.translations.map((t) => t.translatedText);
  };
}

export class TraductionService {
  private readonly cache = new Map<string, string>();
  private derniereErreur: string | null = null;

  constructor(private readonly traducteur: Traducteur | null) {}

  get disponible(): boolean { return !!this.traducteur; }

  etat() {
    return {
      disponible: this.disponible, langues: LANGUES_TRADUITES, source: 'fr', fournisseur: this.disponible ? 'Google Cloud Translation' : null,
      mention: 'Traduction automatique — la version française fait foi.', derniereErreur: this.derniereErreur,
    };
  }

  async traduire(textes: string[], cible: LangueTraduite): Promise<string[]> {
    if (!this.traducteur) throw new Error('INDISPONIBLE');
    const manquants = [...new Set(textes.filter((t) => !this.cache.has(`${cible}|${t}`)))];
    for (let i = 0; i < manquants.length; i += 100) {
      const lot = manquants.slice(i, i + 100);
      try {
        const out = await this.traducteur(lot, cible);
        lot.forEach((t, k) => { if (out[k] !== undefined) this.cache.set(`${cible}|${t}`, out[k]!); });
        this.derniereErreur = null;
      } catch (e) {
        this.derniereErreur = e instanceof Error ? e.message : String(e);
        throw e;
      }
    }
    if (this.cache.size > MAX_CACHE) for (const k of [...this.cache.keys()].slice(0, this.cache.size - MAX_CACHE)) this.cache.delete(k);
    return textes.map((t) => this.cache.get(`${cible}|${t}`) ?? t);
  }
}
