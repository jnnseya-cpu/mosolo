import { Link } from 'react-router-dom';
import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { PageHead } from '../components/Shell';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/StatusBadge';
import { ErrorState, ExampleNotice, Loading } from '../components/States';
import { fetchCatalogue, fetchSummary, LEGAL_TONE } from '../verticals/catalogue';
import '../modules/verticales/verticales.css';

export { LEGAL_TONE };

const AGENT_ROLES = ['R06', 'R07', 'R09', 'R10', 'R11', 'R12', 'R22', 'R24'];

/** Portail des verticales : un seul compte, un seul circuit de paiement — catalogue servi par l'API. */
export default function Services() {
  const { user } = useApp();
  const cat = useApi(fetchCatalogue, []);
  const isTaxpayer = !!user?.roles.includes('R30');
  const sum = useApi(isTaxpayer ? fetchSummary : null, [user?.id]);
  const counts = new Map((sum.data?.items ?? []).map((s) => [s.slug, s]));
  const isAgent = !!user?.roles.some((r) => AGENT_ROLES.includes(r));

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Services de la Ville" title="Tous vos services, un seul compte"
        lead="Chaque service sectoriel partage le même compte unique, le même registre des règles et le même circuit de paiement vers le compte public.">
        <Link className="btn btn-secondary btn-sm" to="/verifier-plaque"><Icon name="qr" size={16} /> Vérifier une plaque ou un titre</Link>
        {isAgent && <Link className="btn btn-primary btn-sm" to="/verticales/console"><Icon name="table" size={16} /> Console d’instruction</Link>}
      </PageHead>
      <ExampleNotice text="Démonstration : objets et références sont fictifs. Aucune règle sectorielle n’est encore certifiée : les montants proviennent de règles fictives de démonstration, non opposables. Un service « acte requis » n’exige aucun paiement." />
      {cat.loading && <Loading />}
      {!!cat.error && <ErrorState error={cat.error} onRetry={cat.reload} />}
      {cat.data && (
        <ul className="vx-grid">
          {cat.data.items.map((v, i) => {
            const c = counts.get(v.slug);
            return (
              <li key={v.slug} className={i === 0 ? 'vx-card vx-card-lead' : 'vx-card'} style={{ ['--vx' as string]: v.accent }}>
                <Link to={`/services/${v.slug}`} className="vx-card-link">
                  <span className="vx-card-icon"><Icon name={v.icon} size={i === 0 ? 30 : 24} /></span>
                  <span className="vx-card-body">
                    <span className="vx-card-name">{v.name}</span>
                    <span className="vx-card-promise">{v.promise}</span>
                    {c && (c.objects > 0 || c.openCases > 0) && (
                      <span className="vx-card-mine">
                        {c.objects > 0 && <span>{c.objects} objet{c.objects > 1 ? 's' : ''}</span>}
                        {c.toPay > 0 && <span className="vx-card-due">{c.toPay} à payer</span>}
                        {c.openCases > 0 && <span>{c.openCases} démarche{c.openCases > 1 ? 's' : ''} en cours</span>}
                      </span>
                    )}
                    <span className="vx-card-foot">
                      <StatusBadge tone={LEGAL_TONE[v.legal]} label={v.legalLabel} />
                      <span className="mono small muted">Modules {v.modules.join(' · ')}</span>
                    </span>
                  </span>
                  <Icon name="chevronRight" size={18} className="vx-card-arrow" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
