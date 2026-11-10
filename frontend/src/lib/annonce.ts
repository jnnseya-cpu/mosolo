/**
 * Annonces globales aux lecteurs d'écran (deuxième passe adverse, 27/09/2026) : zone `aria-live` toujours présente
 * dans le gabarit (components/Shell.tsx). Sert quand l'élément qui portait le message disparaît aussitôt (ex. fiche
 * de décision retirée de la corbeille après la décision) : l'annonce n'est alors jamais perdue.
 */
export const ID_ANNONCES = 'annonces-globales';

export function annoncer(text: string): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(ID_ANNONCES);
  if (!el) return;
  // Vider puis écrire : un même texte répété est de nouveau annoncé.
  el.textContent = '';
  window.setTimeout(() => { el.textContent = text; }, 30);
}
