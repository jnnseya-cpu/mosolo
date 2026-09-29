/**
 * Page de retour après la page de paiement du prestataire (29/09/2026) : « /paiement/retour?ref=<référence> ».
 * Le retour du navigateur est une COMMODITÉ, jamais une preuve : cette page n'interprète AUCUN paramètre de l'URL autre
 * que la référence, et affiche l'état RÉEL du paiement lu dans MOSOLO (GET /v1/payment-orders/{ref}/status), établi
 * après le webhook signé du prestataire et la vérification serveur à serveur. Actualisation automatique tant que l'état
 * n'est pas final.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { Loading } from '../../components/States';

interface PaymentStatusView {
  paymentReference: string; obligationId: string; status: string; state: 'EN_ATTENTE' | 'VERIFICATION_MANUELLE' | 'CONFIRME' | 'ECHEC';
  stateLabel: string; amount: MoneyJSON; provider: string | null; expiresAt: string; confirmedAt: string | null;
  receipt: { number: string; code: string; status: string } | null; final: boolean; notice: string; checkedAt: string;
}

const TONE: Record<PaymentStatusView['state'], 'warning' | 'info' | 'good' | 'critical'> = {
  EN_ATTENTE: 'warning', VERIFICATION_MANUELLE: 'info', CONFIRME: 'good', ECHEC: 'critical',
};
const ICON: Record<PaymentStatusView['state'], string> = { EN_ATTENTE: 'clock', VERIFICATION_MANUELLE: 'shieldCheck', CONFIRME: 'check', ECHEC: 'alert' };
const PROVIDER: Record<string, string> = { bitripay: 'BitriPay', koda: 'KODA' };
/** Intervalle d'actualisation de l'état (confort d'affichage, sans effet sur le paiement). */
const POLL_MS = 4_000;

export default function RetourPaiement() {
  const { user, fmtDate } = useApp();
  const [params] = useSearchParams();
  // Seule la référence est lue dans l'URL (« ref », ou « reference » des anciens liens) — jamais un statut.
  const ref = (params.get('ref') ?? params.get('reference') ?? '').trim();
  const valid = /^[A-Z0-9-]{3,64}$/.test(ref);
  const q = useApi(user && valid ? () => api<PaymentStatusView>(`/v1/payment-orders/${encodeURIComponent(ref)}/status`) : null, [ref, user?.id]);
  const [tick, setTick] = useState(0);
  const d = q.data;
  const final = !!d?.final;
  const reload = q.reload;

  useEffect(() => {
    if (!user || !valid || final) return;
    const t = window.setInterval(() => { setTick((n) => n + 1); reload(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [user, valid, final, reload]);

  return (
    <div className="page">
      <PageHead eyebrow="Paiement" title="Retour de la page de paiement"
        lead="L’état affiché ci-dessous est celui enregistré par MOSOLO après la confirmation signée du prestataire — pas celui transmis par votre navigateur." />
      {!valid && <p className="notice notice-err" role="alert">Référence de paiement absente ou invalide dans l’adresse de retour. Retrouvez vos paiements dans <Link to="/espace">Mon espace</Link>.</p>}
      {valid && !user && (
        <div className="callout callout-info">
          <Icon name="lock" size={18} />
          <p>Connectez-vous pour voir l’état réel du paiement <span className="mono">{ref}</span>. <Link className="btn btn-primary btn-sm" to="/connexion">Se connecter</Link></p>
        </div>
      )}
      {valid && user && q.loading && !d && <Loading />}
      {valid && user && !!q.error && !d && <p className="notice notice-err" role="alert">{describeError(q.error).message}</p>}
      {d && (
        <section className="panel" aria-labelledby="retour-etat" aria-live="polite">
          <div className="panel-head">
            <div className="min0">
              <p className="label">Référence de paiement</p>
              <p className="ref-big mono">{d.paymentReference}</p>
            </div>
            <StatusBadge tone={TONE[d.state]} label={d.stateLabel} />
          </div>
          <h2 id="retour-etat" className="h-sub"><Icon name={ICON[d.state]} size={18} /> {d.stateLabel}</h2>
          <dl className="kv">
            <div><dt>Montant</dt><dd><MoneyText money={d.amount} /></dd></div>
            {d.provider && <div><dt>Passerelle</dt><dd>{PROVIDER[d.provider] ?? d.provider}</dd></div>}
            {d.confirmedAt && <div><dt>Confirmé le</dt><dd>{fmtDate(d.confirmedAt, true)}</dd></div>}
            {d.receipt && <div><dt>Quittance</dt><dd><span className="mono">{d.receipt.number}</span> — {d.receipt.status === 'DEFINITIVE' ? 'définitive' : 'provisoire'} <Link className="btn btn-ghost btn-sm" to={`/verifier/${encodeURIComponent(d.receipt.code)}`}>Vérifier</Link></dd></div>}
            {!d.final && <div><dt>Référence valable jusqu’au</dt><dd>{fmtDate(d.expiresAt, true)}</dd></div>}
            <div><dt>Dernière vérification</dt><dd>{fmtDate(d.checkedAt, true)}{!d.final && <span className="small muted"> — actualisation automatique{tick > 0 ? ` (${tick})` : ''}</span>}</dd></div>
          </dl>
          {d.state === 'EN_ATTENTE' && <p className="small">Le prestataire n’a pas encore confirmé votre paiement à MOSOLO. Ne payez pas une seconde fois : cette page se met à jour d’elle-même.</p>}
          {d.state === 'VERIFICATION_MANUELLE' && <p className="small">Le résultat de l’opérateur est incertain : le prestataire vérifie le paiement. Aucun nouveau paiement n’est nécessaire ; vous serez informé dès la décision.</p>}
          {d.state === 'CONFIRME' && <p className="small">Paiement confirmé par le prestataire et vérifié par MOSOLO. La quittance devient définitive au rapprochement avec le relevé du compte public.</p>}
          {d.state === 'ECHEC' && <p className="small">Aucun paiement n’a été confirmé sur cette référence. Vous pouvez recommencer depuis votre espace.</p>}
          <p className="small muted">{d.notice}</p>
          <div className="row-actions">
            <Link className="btn btn-primary btn-sm" to={`/espace?obligation=${encodeURIComponent(d.obligationId)}`}>Voir l’obligation</Link>
            <Link className="btn btn-ghost btn-sm" to="/espace">Mon espace</Link>
            {!d.final && <button type="button" className="btn btn-ghost btn-sm" onClick={reload}><Icon name="refresh" size={16} /> Actualiser</button>}
          </div>
        </section>
      )}
      <p className="small muted"><Icon name="cash" size={14} /> Aucun agent ne vous demandera d’espèces : les paiements vont uniquement au compte public de la Ville.</p>
    </div>
  );
}
