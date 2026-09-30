/**
 * Traduction automatique de l'écran (30/09/2026) : les textes affichés (et les attributs placeholder, title, aria-label)
 * sont envoyés par lots au serveur (POST /v1/traduction → Google Cloud Translation), puis remplacés à l'écran ; les
 * nouveaux textes sont suivis (MutationObserver). Le français d'origine est conservé et remis dès le retour au français.
 * Jamais traduits : champs de saisie, codes (classe « mono »), éléments marqués translate="no" ou data-no-translate.
 */
import { api } from './api';

type Cible = { node: Text; original: string; applique: string } | { el: Element; attr: string; original: string; applique: string };

const ATTRS = ['placeholder', 'title', 'aria-label'] as const;
const EXCLUS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'NOSCRIPT']);
const CLE_CACHE = 'mosolo.traduction.';

/** Texte à traduire : au moins deux lettres minuscules (pas un code, un nombre, une plaque, un montant seul). */
const traduisible = (t: string) => /[a-zà-ÿ]{2}/.test(t) && t.trim().length > 1;

function exclu(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (EXCLUS.has(e.tagName.toUpperCase())) return true;
    if (e.getAttribute('translate') === 'no' || e.hasAttribute('data-no-translate') || e.classList.contains('mono')) return true;
  }
  return false;
}

export class TraducteurEcran {
  private cibles: Cible[] = [];
  private readonly parNoeud = new WeakMap<Text, Cible>();
  private readonly parAttr = new WeakMap<Element, Map<string, Cible>>();
  private actif = false;
  private cache: Record<string, string> = {};
  private observer: MutationObserver | null = null;
  private minuterie: number | null = null;
  private enCours = false;
  onErreur?: (message: string) => void;

  constructor(private readonly langue: string, private readonly racine: HTMLElement = document.body) {
    try { this.cache = JSON.parse(localStorage.getItem(CLE_CACHE + langue) ?? '{}') as Record<string, string>; } catch { this.cache = {}; }
  }

  demarrer(): void {
    this.actif = true;
    document.documentElement.lang = this.langue;
    void this.passe();
    this.observer = new MutationObserver(() => this.planifier());
    this.observer.observe(this.racine, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  }

  arreter(): void {
    this.actif = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.minuterie) window.clearTimeout(this.minuterie);
    // Retour au français : chaque texte remplacé retrouve sa version d'origine.
    for (const c of this.cibles) {
      if ('node' in c) { if (c.node.isConnected && c.node.nodeValue === c.applique) c.node.nodeValue = c.original; }
      else if (c.el.isConnected && c.el.getAttribute(c.attr) === c.applique) c.el.setAttribute(c.attr, c.original);
    }
    this.cibles = [];
    document.documentElement.lang = 'fr';
  }

  private planifier(): void {
    if (this.minuterie) window.clearTimeout(this.minuterie);
    this.minuterie = window.setTimeout(() => void this.passe(), 250);
  }

  private collecter(): { a: Cible[]; textes: Set<string> } {
    const a: Cible[] = [];
    const textes = new Set<string>();
    const walker = document.createTreeWalker(this.racine, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const v = n.nodeValue ?? '';
      const t = v.trim();
      if (!traduisible(t) || exclu(n.parentElement)) continue;
      const suivi = this.parNoeud.get(n);
      if (suivi && suivi.applique === v) continue; // déjà traduit ; sinon React a remis un nouveau texte français
      a.push({ node: n, original: v, applique: v });
      textes.add(t);
    }
    for (const el of Array.from(this.racine.querySelectorAll('[placeholder],[title],[aria-label]'))) {
      if (exclu(el) && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
      for (const attr of ATTRS) {
        const v = el.getAttribute(attr);
        if (!v || !traduisible(v)) continue;
        const suivi = this.parAttr.get(el)?.get(attr);
        if (suivi && suivi.applique === v) continue;
        a.push({ el, attr, original: v, applique: v });
        textes.add(v.trim());
      }
    }
    return { a, textes };
  }

  private async passe(): Promise<void> {
    if (this.enCours) { this.planifier(); return; }
    this.enCours = true;
    try {
      const { a, textes } = this.collecter();
      const manquants = [...textes].filter((t) => !(t in this.cache));
      for (let i = 0; i < manquants.length; i += 100) {
        const lot = manquants.slice(i, i + 100);
        const r = await api<{ traductions: string[] }>('/v1/traduction', { method: 'POST', body: { langue: this.langue, textes: lot } });
        lot.forEach((t, k) => { this.cache[t] = r.traductions[k] ?? t; });
      }
      try { localStorage.setItem(CLE_CACHE + this.langue, JSON.stringify(this.cache)); } catch { /* stockage plein : sans effet */ }
      if (!this.actif) return;
      this.observer?.disconnect();
      for (const c of a) {
        const src = c.original.trim();
        const tr = this.cache[src];
        if (!tr) continue;
        const val = c.original.replace(src, tr);
        if ('node' in c) { if (c.node.isConnected) { c.node.nodeValue = val; c.applique = val; this.cibles.push(c); this.parNoeud.set(c.node, c); } }
        else if (c.el.isConnected) {
          c.el.setAttribute(c.attr, val); c.applique = val; this.cibles.push(c);
          const m = this.parAttr.get(c.el) ?? new Map<string, Cible>(); m.set(c.attr, c); this.parAttr.set(c.el, m);
        }
      }
      // Suivi : textes retirés de l'écran oubliés (pas d'accumulation).
      if (this.cibles.length > 20_000) this.cibles = this.cibles.filter((c) => ('node' in c ? c.node.isConnected : c.el.isConnected));
      this.observer?.observe(this.racine, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
    } catch (e) {
      this.onErreur?.(e instanceof Error ? e.message : String(e));
    } finally {
      this.enCours = false;
    }
  }
}
