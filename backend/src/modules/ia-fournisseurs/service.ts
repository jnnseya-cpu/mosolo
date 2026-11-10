/**
 * Fournisseurs d'IA externes (01/10/2026) — Claude (Anthropic), OpenAI, Gemini (Google). FACULTATIFS :
 *  - sans clé, rien n'est envoyé nulle part : les agents fonctionnent avec leurs règles internes (moteur déterministe) ;
 *  - clés saisies par le super-administrateur seul (R26) dans « Clés et raccordements », approuvées par une seconde
 *    personne, chiffrées au repos, jamais renvoyées ; la variable d'environnement prévaut ;
 *  - ordre d'essai configurable (MOSOLO_IA_ORDRE) : en cas d'échec ou de refus, le fournisseur suivant prend le relais ;
 *  - données envoyées : AGRÉGATS ou textes caviardés (numéros de téléphone, courriels, identifiants fiscaux masqués) ;
 *    jamais de nom ni de numéro issus du registre ;
 *  - chaque appel est journalisé SANS contenu (qui, tâche, fournisseur, modèle, taille, durée, résultat) ;
 *  - l'IA propose, une personne décide : aucune réponse n'a d'effet par elle-même.
 * Claude : SDK officiel Anthropic. OpenAI et Gemini : leurs API REST publiques.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { ApiError } from '../../core/errors.js';
import { kinshasaDay } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';

export type FournisseurId = 'claude' | 'openai' | 'gemini';

export const FOURNISSEURS: Record<FournisseurId, { nom: string; cle: string; modeleVar: string; modeleDefaut: string }> = {
  claude: { nom: 'Claude (Anthropic)', cle: 'ANTHROPIC_API_KEY', modeleVar: 'MOSOLO_IA_MODELE_CLAUDE', modeleDefaut: 'claude-opus-5-5' },
  openai: { nom: 'OpenAI', cle: 'OPENAI_API_KEY', modeleVar: 'MOSOLO_IA_MODELE_OPENAI', modeleDefaut: 'gpt-4.1-mini' },
  gemini: { nom: 'Gemini (Google)', cle: 'GEMINI_API_KEY', modeleVar: 'MOSOLO_IA_MODELE_GEMINI', modeleDefaut: 'gemini-2.5-flash' },
};
export const ORDRE_DEFAUT: FournisseurId[] = ['claude', 'openai', 'gemini'];
export const STATUT_DEFAUTS = 'Modèles et ordre par défaut — à confirmer par le maître d’ouvrage';
/** Appels par personne et par heure (maîtrise des coûts) — par défaut, à confirmer. */
export const LIMITE_APPELS_HEURE = 10;
/**
 * PLAFOND GLOBAL d'appels payants par jour pour TOUTE la plateforme (01/10/2026 : « la plateforme doit rapporter de
 * l'argent, pas en gaspiller ») — par défaut 100, à confirmer ; réglable par le super-administrateur
 * (MOSOLO_IA_PLAFOND_JOUR). Plafond atteint : règles internes jusqu'au lendemain (jour de Kinshasa).
 */
export const PLAFOND_JOUR_DEFAUT = 100;
const DELAI_MS = 45_000;
/** Modèles Claude qui acceptent le relais côté serveur en cas de refus (« fallbacks: default »). */
const CLAUDE_RELAIS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** Masque ce qui pourrait identifier une personne avant tout envoi externe. */
export function caviarder(texte: string): string {
  return texte
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[courriel]')
    .replace(/\b[A-Z]{2,5}-[A-Z0-9-]{4,}\b/g, '[identifiant]')
    .replace(/\+?\d[\d\s.()-]{6,}\d/g, '[numéro]');
}

export interface Demande { tache: string; consigne: string; contenu: string; maxTokens?: number }
export interface Reponse { texte: string; fournisseur: FournisseurId; nom: string; modele: string }
type FetchFn = typeof fetch;

export class FournisseursIA {
  private readonly appels = new Map<string, number[]>();
  /** Compteur global du jour (jour de Kinshasa) et réponses déjà payées du jour (réutilisées sans nouvel appel). */
  private jour = { date: '', appels: 0 };
  private readonly cache = new Map<string, Reponse>();
  private raisonDerniere: 'AUCUNE_CLE' | 'PLAFOND' | null = null;

  constructor(
    private readonly resolve: (name: string) => string | undefined,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    /** Injectable en test ; sinon `fetch` global (Node 22). */
    private readonly fetchImpl: FetchFn = (...a) => fetch(...a),
  ) {}

  private modele(id: FournisseurId) { return this.resolve(FOURNISSEURS[id].modeleVar)?.trim() || FOURNISSEURS[id].modeleDefaut; }
  private cle(id: FournisseurId) { const v = this.resolve(FOURNISSEURS[id].cle)?.trim(); return v ? v : undefined; }

  ordre(): FournisseurId[] {
    const brut = this.resolve('MOSOLO_IA_ORDRE')?.split(',').map((x) => x.trim().toLowerCase()).filter((x): x is FournisseurId => x in FOURNISSEURS) ?? [];
    return [...new Set([...brut, ...ORDRE_DEFAUT])];
  }
  configures(): FournisseurId[] { return this.ordre().filter((id) => !!this.cle(id)); }
  actif(): boolean { return this.configures().length > 0; }
  doleancesAutorisees(): boolean { return /^(true|1|oui|yes)$/i.test(this.resolve('MOSOLO_IA_DOLEANCES')?.trim() ?? ''); }

  /** État affichable : jamais de clé, seulement présence, ordre et modèles. */
  etat() {
    return {
      actif: this.actif(),
      mode: this.actif() ? 'FOURNISSEUR_EXTERNE' : 'REGLES_INTERNES',
      fournisseurs: this.ordre().map((id) => ({ id, nom: FOURNISSEURS[id].nom, cleConfiguree: !!this.cle(id), modele: this.modele(id), variableCle: FOURNISSEURS[id].cle })),
      doleances: this.doleancesAutorisees(),
      limiteAppelsHeure: LIMITE_APPELS_HEURE,
      plafondJour: this.plafond(), appelsAujourdhui: this.compteur().appels, reste: Math.max(0, this.plafond() - this.compteur().appels),
      economies: 'Réponses identiques du jour réutilisées sans nouvel appel ; usagers et public n’appellent jamais l’IA.',
      statut: STATUT_DEFAUTS,
      regle: 'Sans clé : règles internes, aucun envoi externe. Clés saisies par le super-administrateur dans « Clés et raccordements », approuvées par une seconde personne.',
    };
  }

  plafond(): number {
    const v = Number.parseInt(this.resolve('MOSOLO_IA_PLAFOND_JOUR')?.trim() ?? '', 10);
    return Number.isFinite(v) && v >= 0 ? v : PLAFOND_JOUR_DEFAUT;
  }
  private compteur() {
    const d = kinshasaDay(this.clock.now().toISOString());
    if (this.jour.date !== d) { this.jour = { date: d, appels: 0 }; this.cache.clear(); }
    return this.jour;
  }
  /** Pourquoi la dernière demande n'est pas allée à un fournisseur externe (null : elle y est allée ou a été réutilisée). */
  raison() { return this.raisonDerniere; }
  /** Texte à afficher quand les règles internes répondent à la place de l'IA externe. */
  motifReglesInternes(): string {
    return this.raisonDerniere === 'PLAFOND'
      ? `Plafond journalier d’appels à l’IA atteint (${this.plafond()} par jour pour toute la plateforme) : règles internes jusqu’à demain.`
      : 'Aucun fournisseur d’IA externe n’est configuré : un super-administrateur peut ajouter une clé Claude, OpenAI ou Gemini dans « Clés et raccordements ».';
  }

  private limiter(user: User) {
    const now = this.clock.now().getTime();
    const recents = (this.appels.get(user.id) ?? []).filter((t) => now - t < 3_600_000);
    if (recents.length >= LIMITE_APPELS_HEURE) throw new ApiError(429, 'IA_LIMITE', `Limite de ${LIMITE_APPELS_HEURE} appels à l’IA par heure atteinte (par défaut — à confirmer).`);
    recents.push(now);
    this.appels.set(user.id, recents);
  }

  /** Appelle le premier fournisseur configuré qui répond ; `null` si aucun n'est configuré (les règles internes s'appliquent). */
  async generer(user: User | { id: string; roles?: string[] }, d: Demande): Promise<Reponse | null> {
    const ordre = this.configures();
    this.raisonDerniere = null;
    if (!ordre.length) { this.raisonDerniere = 'AUCUNE_CLE'; return null; }
    const contenu = caviarder(d.contenu).slice(0, 60_000);
    const cle = sha256Hex(`${d.tache}\n${d.consigne}\n${contenu}`);
    const deja = (this.compteur(), this.cache.get(cle));
    if (deja) return deja; // déjà payée aujourd'hui : aucun nouvel appel
    const j = this.compteur();
    if (j.appels >= this.plafond()) { this.raisonDerniere = 'PLAFOND'; return null; }
    if ('kind' in user) this.limiter(user as User);
    j.appels += 1;
    const erreurs: string[] = [];
    for (const id of ordre) {
      const modele = this.modele(id);
      const debut = Date.now();
      try {
        const texte = (await this.appeler(id, this.cle(id)!, modele, d.consigne, contenu, d.maxTokens ?? 2000)).trim();
        if (!texte) throw new Error('réponse vide');
        this.trace(user, d.tache, id, modele, contenu.length, Date.now() - debut, 'OK');
        const rep = { texte, fournisseur: id, nom: FOURNISSEURS[id].nom, modele };
        this.cache.set(cle, rep);
        return rep;
      } catch (e) {
        const motif = e instanceof Error ? e.message.slice(0, 200) : 'erreur';
        erreurs.push(`${FOURNISSEURS[id].nom} : ${motif}`);
        this.trace(user, d.tache, id, modele, contenu.length, Date.now() - debut, 'ECHEC', motif);
      }
    }
    throw new ApiError(502, 'IA_INDISPONIBLE', `Aucun fournisseur d’IA n’a répondu (${erreurs.join(' ; ')}). Les agents restent disponibles avec leurs règles internes.`);
  }

  private trace(user: { id: string; roles?: string[] }, tache: string, id: FournisseurId, modele: string, taille: number, dureeMs: number, resultat: string, motif?: string) {
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: (user.roles ?? []) as never }, action: 'ia.fournisseur.appel', resourceType: 'ia_fournisseur', resourceId: id,
      details: { tache, modele, caracteresEnvoyes: taille, dureeMs, resultat, ...(motif ? { motif } : {}) },
    });
  }

  private async appeler(id: FournisseurId, cle: string, modele: string, consigne: string, contenu: string, maxTokens: number): Promise<string> {
    if (id === 'claude') {
      const client = new Anthropic({ apiKey: cle, timeout: DELAI_MS, maxRetries: 1, fetch: this.fetchImpl });
      const r = await client.beta.messages.create({
        model: modele, max_tokens: maxTokens, system: consigne,
        messages: [{ role: 'user', content: contenu }],
        output_config: { effort: 'low' },
        ...(CLAUDE_RELAIS.has(modele) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      if (r.stop_reason === 'refusal') throw new Error('demande déclinée par le modèle');
      return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    }
    if (id === 'openai') {
      const res = await this.fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(DELAI_MS),
        headers: { authorization: `Bearer ${cle}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: modele, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: consigne }, { role: 'user', content: contenu }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json() as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
      return j.choices?.[0]?.message?.content ?? '';
    }
    const res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modele)}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(DELAI_MS),
      headers: { 'x-goog-api-key': cle, 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: consigne }] }, contents: [{ role: 'user', parts: [{ text: contenu }] }], generationConfig: { maxOutputTokens: maxTokens } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  }
}
