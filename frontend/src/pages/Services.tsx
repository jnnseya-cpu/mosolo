import { Link } from 'react-router-dom';
import { PageHead } from '../components/Shell';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/StatusBadge';
import { ExampleNotice } from '../components/States';
import { LEGAL_LABEL, VERTICALS, type LegalStatus } from '../verticals/catalogue';

export const LEGAL_TONE: Record<LegalStatus, 'good' | 'warning' | 'info'> = { CONFIRME: 'good', A_VERIFIER: 'warning', ACTE_REQUIS: 'info' };

/** Portail des verticales : un seul compte, un seul circuit de paiement, seize services. */
export default function Services() {
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Services de la Ville" title="Tous vos services, un seul compte"
        lead="Seize services sectoriels partagent le même compte unique, le même registre des règles et le même circuit de paiement vers le compte public." />
      <ExampleNotice text="Démonstration : objets, montants et références sont des exemples, non opposables. Un service marqué « Acte requis » n’exige aucun paiement." />
      <ul className="vx-grid">
        {VERTICALS.map((v, i) => (
          <li key={v.slug} className={i === 0 ? 'vx-card vx-card-lead' : 'vx-card'} style={{ ['--vx' as string]: v.accent }}>
            <Link to={`/services/${v.slug}`} className="vx-card-link">
              <span className="vx-card-icon"><Icon name={v.icon} size={i === 0 ? 30 : 24} /></span>
              <span className="vx-card-body">
                <span className="vx-card-name">{v.name}</span>
                <span className="vx-card-promise">{v.promise}</span>
                <span className="vx-card-foot">
                  <StatusBadge tone={LEGAL_TONE[v.legal]} label={LEGAL_LABEL[v.legal]} />
                  <span className="mono small muted">Modules {v.modules}</span>
                </span>
              </span>
              <Icon name="chevronRight" size={18} className="vx-card-arrow" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
