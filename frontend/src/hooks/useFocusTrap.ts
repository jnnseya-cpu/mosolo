import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Éléments focalisables visibles d'un conteneur, dans l'ordre du document. */
export function focusables(root: HTMLElement): HTMLElement[] {
  // Sans moteur de mise en page (tests), la visibilité n'est pas mesurable : seuls les attributs sont pris en compte.
  const layout = root.getClientRects().length > 0;
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !e.closest('[hidden], [inert]') && e.getAttribute('aria-hidden') !== 'true' && (!layout || e.getClientRects().length > 0));
}

/**
 * Piège de focus d'une fenêtre modale (deuxième passe adverse, 27/09/2026) : Tab et Maj+Tab restent dans la fenêtre
 * (retour au premier élément après le dernier, et inversement). Auparavant, au clavier, le focus sortait du panneau
 * vers la page masquée derrière lui (WCAG 2.4.3, fenêtre `aria-modal`).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = ref.current;
      if (!root) return;
      const items = focusables(root);
      if (items.length === 0) { e.preventDefault(); root.focus(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement as HTMLElement | null;
      const inside = !!current && root.contains(current);
      if (e.shiftKey) {
        if (!inside || current === first || current === root) { e.preventDefault(); last.focus(); }
      } else if (!inside || current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref, active]);
}
