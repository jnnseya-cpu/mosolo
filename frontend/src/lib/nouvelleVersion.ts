/**
 * Nouvelle version publiée (01/10/2026) : un onglet ouvert avant une mise en ligne demande des fichiers d'écran qui
 * n'existent plus (noms à empreinte). Au lieu d'un écran vide — ex. page de paiement BitriPay / KODA qui « ne s'ouvre
 * pas » —, la page est rechargée UNE fois sur la nouvelle version (garde : un rechargement par minute au plus).
 */
import { lazy, type ComponentType } from 'react';

export function rechargerVersionNeuve(): boolean {
  try {
    const k = 'mosolo.rechargementVersion';
    const dernier = Number(sessionStorage.getItem(k) ?? '0');
    if (Date.now() - dernier < 60_000) return false;
    sessionStorage.setItem(k, String(Date.now()));
  } catch { /* stockage indisponible : on recharge quand même une fois */ }
  window.location.reload();
  return true;
}

/** `lazy` dont l'échec de chargement (fichier d'une ancienne version) déclenche le rechargement sur la nouvelle version. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(charger: () => Promise<{ default: T }>) {
  return lazy(() => charger().catch((e: unknown) => {
    if (rechargerVersionNeuve()) return new Promise<{ default: T }>(() => undefined); // la page se recharge
    throw e;
  }));
}
