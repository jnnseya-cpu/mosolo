/**
 * Page propre publique (Veille des tendances, 10/11/2026) : seule la révision approuvée et active est servie. La mesure
 * est agrégée côté serveur (visites, clics sur l'appel) : aucun identifiant de visiteur, aucun traceur externe.
 */
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { ErrorState, Loading } from '../../components/States';

interface Vue { slug: string; revision: number; titre: string; description: string; accroche: string; ctaLibelle: string; bloc: string; ctaCible: string }

function signaler(slug: string, evenement: 'VISITE' | 'CTA', revision?: number) {
  void api(`/v1/public/tendances/pages/${encodeURIComponent(slug)}/evenements`, { method: 'POST', body: { evenement, ...(revision ? { revision } : {}) } }).catch(() => undefined);
}

export default function PagePropre() {
  const { slug = '' } = useParams();
  const q = useApi(() => api<Vue>(`/v1/public/tendances/pages/${encodeURIComponent(slug)}`), [slug]);
  const v = q.data;
  useEffect(() => {
    if (!v) return;
    document.title = `${v.titre} — KINSHASA MOSOLO`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', v.description);
    signaler(v.slug, 'VISITE', v.revision);
  }, [v]);
  return (
    <div className="page">
      {q.loading && !v ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : v && (
        <article data-testid="page-propre">
          <PageHead eyebrow="Ville de Kinshasa" title={v.titre} lead={v.accroche} />
          <p>{v.description}</p>
          {v.bloc.split(/\n{2,}/).map((p) => <p key={p}>{p}</p>)}
          <div className="btn-row">
            <Link className="btn btn-primary" to={v.ctaCible} onClick={() => signaler(v.slug, 'CTA', v.revision)}>{v.ctaLibelle}</Link>
          </div>
        </article>
      )}
    </div>
  );
}
