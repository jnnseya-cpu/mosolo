import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../context';
import { PageHead } from '../components/Shell';

/** Script principal d'une page d'accueil (identifie la version de l'application). */
const scriptPrincipal = (html: string) => /<script type="module"[^>]*src="([^"]+)"/.exec(html)?.[1] ?? null;

/**
 * Version en cache périmée (30/09/2026) : l'application hors ligne garde l'ancienne version dans le navigateur ; après
 * une mise en ligne, une adresse nouvelle (ex. page de paiement /demo/passerelle/…) tombait sur « Page introuvable ».
 * Une fois par adresse et par session : si le serveur publie une version plus récente, le cache de l'application est
 * vidé et la page rechargée (sans effet sur les données : le serveur reste la référence).
 */
function useMiseAJourSiPerimee(): boolean {
  const loc = useLocation();
  const [enCours, setEnCours] = useState(false);
  useEffect(() => {
    const cle = `mosolo.maj404:${loc.pathname}`;
    try { if (sessionStorage.getItem(cle)) return; sessionStorage.setItem(cle, '1'); } catch { return; }
    const actuel = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? null;
    let annule = false;
    void fetch(`/index.html?v=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : null))
      .then(async (html) => {
        const publie = html ? scriptPrincipal(html) : null;
        if (annule || !publie || !actuel || publie === actuel) return;
        setEnCours(true);
        try {
          const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
          await Promise.all(regs.map((r) => r.unregister()));
          if ('caches' in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
        } catch { /* rechargement quand même */ }
        window.location.reload();
      })
      .catch(() => { /* hors ligne : page 404 ordinaire */ });
    return () => { annule = true; };
  }, [loc.pathname]);
  return enCours;
}

export default function NotFound() {
  const { tr } = useApp();
  const maj = useMiseAJourSiPerimee();
  if (maj) return <div className="page"><PageHead eyebrow="MOSOLO" title="Mise à jour de l’application…" lead="Une nouvelle version est disponible : chargement en cours." /></div>;
  return (
    <div className="page">
      <PageHead eyebrow="404" title={tr('notFound.title')} lead={tr('notFound.body')} />
      <div className="btn-row">
        <Link className="btn btn-primary" to="/">{tr('nav.home')}</Link>
        <Link className="btn btn-secondary" to="/verifier">{tr('nav.verify')}</Link>
      </div>
    </div>
  );
}
