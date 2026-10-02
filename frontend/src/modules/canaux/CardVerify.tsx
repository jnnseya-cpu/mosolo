import { useSearchParams } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { CartesEtat, IndicateursAgent } from './visuels';
import { ChartGrid, KpiTile } from '../../components/viz';
import './canaux.css';

interface Result { status: 'CARTE_VALIDE' | 'CARTE_BLOQUEE' | 'CARTE_REVOQUEE' | 'INVALIDE'; message: string; commune?: string; issuedOn?: string; verifiedAt: string }

const VIEW: Record<Result['status'], { tone: string; icon: string; title: string }> = {
  CARTE_VALIDE: { tone: 'good', icon: 'check', title: 'Carte authentique et active' },
  CARTE_BLOQUEE: { tone: 'warning', icon: 'lock', title: 'Carte bloquée' },
  CARTE_REVOQUEE: { tone: 'critical', icon: 'ban', title: 'Carte révoquée' },
  INVALIDE: { tone: 'critical', icon: 'alert', title: 'Carte non authentique' },
};

/** Cible du QR de la carte MOSOLO : vérification minimale, sans aucune donnée personnelle. */
export default function CardVerify() {
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const { fmtDate } = useApp();
  const r = useApi(token ? () => api<Result>(`/v1/public/mosolo-cards/verify?t=${encodeURIComponent(token)}`) : null, [token]);
  const v = r.data ? VIEW[r.data.status] : null;
  return (
    <div className="page">
      <PageHead eyebrow="Vérification publique — module 68" title="Vérifier une carte MOSOLO" lead="Le QR porte un jeton signé : seule l’authenticité et l’état de la carte sont affichés, jamais l’identité du titulaire." />
      {!token && <p className="callout callout-info">Scannez le QR d’une carte MOSOLO pour la vérifier.</p>}
      {r.loading && <Loading />}
      {r.error !== null && <ErrorState error={r.error} onRetry={r.reload} />}
      {r.data && v && (
        <div className={`verdict verdict-${v.tone}`}>
          <div className="verdict-icon"><Icon name={v.icon} size={44} /></div>
          <p className="verdict-title">{v.title}</p>
          <p>{r.data.message}</p>
          {r.data.commune && <dl className="kv kv-verdict"><div><dt>Commune</dt><dd>{r.data.commune}</dd></div><div><dt>Émise</dt><dd>{r.data.issuedOn}</dd></div></dl>}
          <p className="small muted">Vérifié le {fmtDate(r.data.verifiedAt, true)}</p>
        </div>
      )}
      <p className="small muted cx-mt cx-inl"><Icon name="lock" size={14} /> Vérifications limitées en fréquence contre l’énumération.</p>
      {/* Agents seulement (canaux:indicators) : état du registre des cartes et vérifications ; le public ne voit que le verdict. */}
      <IndicateursAgent>{(ind) => (
        <ChartGrid min={260}>
          <CartesEtat ind={ind} />
          <KpiTile label="Vérifications par code court" value={ind.verification.total} state={{ label: `${ind.verification.suspectedEnumeration} tentative(s) suspecte(s)`, tone: ind.verification.suspectedEnumeration ? 'critical' : 'good' }} />
        </ChartGrid>
      )}</IndicateursAgent>
    </div>
  );
}
