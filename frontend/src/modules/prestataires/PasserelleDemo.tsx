/**
 * Page de paiement SIMULÉE de BitriPay / KODA (démonstration, 30/09/2026) : « /demo/passerelle/:provider?ref=<référence> ».
 * En production, « Payer » conduit le navigateur vers la page hébergée du prestataire. En démonstration (bac à sable local,
 * aucune clé), cette page en tient lieu pour montrer le parcours complet :
 *   MOSOLO → page du prestataire → paiement → webhook SIGNÉ du prestataire vers la route réelle → retour sur MOSOLO
 *   (/paiement/retour) → quittance provisoire, définitive après rapprochement du relevé.
 * Aucune somme réelle, aucun logo de prestataire ; le serveur refuse cette page dès qu'une vraie clé est configurée.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { ErrorState, Loading } from '../../components/States';

interface PasserelleView {
  provider: string; label: string; paymentReference: string; amount: MoneyJSON; status: string; channel: string;
  intentId: string | null; operateurs: string[]; expiresAt: string; sandbox: true;
}

const OPERATEUR: Record<string, { nom: string; ussd?: string }> = {
  orange_cd: { nom: 'Orange Money', ussd: '*144#' },
  mpesa_cd: { nom: 'M-Pesa (Vodacom)', ussd: '*1222#' },
  airtel_cd: { nom: 'Airtel Money', ussd: '*501#' },
  africell_cd: { nom: 'Africell Money', ussd: '*1000#' },
  card: { nom: 'Carte bancaire (Visa, Mastercard)' },
};
const NOM: Record<string, string> = { bitripay: 'BitriPay', koda: 'KODA' };

export default function PasserelleDemo() {
  const { user, fmtDate } = useApp();
  const { provider = '' } = useParams();
  const [params] = useSearchParams();
  const ref = (params.get('ref') ?? '').trim();
  const navigate = useNavigate();
  const q = useApi(user && ref ? () => api<PasserelleView>(`/v1/demo/passerelle/${encodeURIComponent(provider)}?ref=${encodeURIComponent(ref)}`) : null, [provider, ref, user?.id]);
  const [operateur, setOperateur] = useState('');
  const [etape, setEtape] = useState<'choix' | 'envoi' | 'erreur'>('choix');
  const [err, setErr] = useState<string | null>(null);
  const nom = NOM[provider] ?? provider;
  const d = q.data;
  const choisi = operateur || (d?.operateurs.length === 1 ? d.operateurs[0]! : '');

  async function payer() {
    if (!d || !choisi) return;
    setEtape('envoi'); setErr(null);
    try {
      const r = await api<{ retour: string }>(`/v1/demo/passerelle/${encodeURIComponent(provider)}/payer`, { method: 'POST', body: { paymentReference: d.paymentReference, operateur: choisi } });
      navigate(r.retour);
    } catch (e) { const x = describeError(e); setErr(x.message + (x.code ? ` (${x.code})` : '')); setEtape('erreur'); }
  }

  return (
    <div className="page">
      <div className="callout callout-warn" role="note" data-testid="passerelle-demo-bandeau">
        <Icon name="alert" size={18} />
        <span><strong>Page de paiement SIMULÉE — démonstration, aucune somme réelle.</strong> En service réel, cette étape se passe sur la page de {nom} (ou sur votre téléphone), puis {nom} vous renvoie vers MOSOLO.</span>
      </div>
      <PageHead eyebrow={`${nom} · bac à sable`} title={`Payer avec ${nom}`}
        lead={provider === 'koda'
          ? 'Payez comme d’habitude avec votre opérateur : KODA vérifie la confirmation de l’opérateur et l’envoie, signée, à MOSOLO. KODA ne touche jamais l’argent.'
          : 'BitriPay achemine votre paiement (monnaie mobile ou carte) vers le compte public de la Ville et envoie la confirmation, signée, à MOSOLO.'} />
      {!user ? (
        <p className="callout callout-info"><Icon name="lock" size={18} /> Connectez-vous pour continuer. <Link className="btn btn-primary btn-sm" to="/connexion">Se connecter</Link></p>
      ) : !ref ? (
        <p className="notice notice-err" role="alert">Référence de paiement absente. Revenez à <Link to="/espace">Mon espace</Link>.</p>
      ) : q.loading && !d ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : d && (
        <div className="card stack" data-testid="passerelle-demo">
          <dl className="kv">
            <div><dt>Bénéficiaire</dt><dd>Ville de Kinshasa — compte public</dd></div>
            <div><dt>Montant exact</dt><dd><MoneyText money={d.amount} showIndicative={false} /></dd></div>
            <div><dt>Référence</dt><dd className="mono">{d.paymentReference}</dd></div>
            <div><dt>Frais</dt><dd>Aucun pour vous : les frais de {nom} sont à la charge de la Ville.</dd></div>
            <div><dt>Valable jusqu’au</dt><dd>{fmtDate(d.expiresAt, true)}</dd></div>
          </dl>
          {d.status !== 'INITIE' ? (
            <div className="callout callout-info" role="status"><Icon name="check" size={18} /><span>Ce paiement n’est plus en attente (état : {d.status}). <Link to={`/paiement/retour?ref=${encodeURIComponent(d.paymentReference)}`}>Voir son état</Link></span></div>
          ) : (
            <>
              <fieldset className="field">
                <legend className="label">{d.channel === 'CARD' ? 'Moyen de paiement' : 'Votre opérateur'}</legend>
                <div className="stack-sm" role="radiogroup">
                  {d.operateurs.map((o) => (
                    <label key={o} className="small" style={{ display: 'block' }}>
                      <input type="radio" name="operateur" value={o} checked={choisi === o} onChange={() => setOperateur(o)} /> {OPERATEUR[o]?.nom ?? o}
                    </label>
                  ))}
                </div>
              </fieldset>
              {choisi && choisi !== 'card' && (
                <ol className="steps small" data-testid="passerelle-demo-etapes">
                  {provider === 'koda'
                    ? <>
                        <li>Sur votre téléphone : {OPERATEUR[choisi]?.ussd ? <>composez <span className="mono">{OPERATEUR[choisi]!.ussd}</span> (ou ouvrez l’application {OPERATEUR[choisi]!.nom})</> : 'ouvrez votre application'}, choisissez « Payer », saisissez la référence <span className="mono">{d.paymentReference}</span> et le montant exact.</li>
                        <li>Confirmez avec votre code secret : l’opérateur vous envoie son SMS de confirmation.</li>
                        <li>KODA vérifie la confirmation auprès de l’opérateur et la transmet, signée, à MOSOLO.</li>
                      </>
                    : <>
                        <li>{nom} envoie une demande de paiement sur votre téléphone ({OPERATEUR[choisi]?.nom}).</li>
                        <li>Vous confirmez avec votre code secret.</li>
                        <li>{nom} transmet la confirmation, signée, à MOSOLO.</li>
                      </>}
                </ol>
              )}
              {choisi === 'card' && <p className="small muted">En service réel : saisie de la carte et 3-D Secure sur la page {nom} ; MOSOLO ne voit jamais le numéro de carte.</p>}
              <button type="button" className="btn btn-primary" disabled={!choisi || etape === 'envoi'} onClick={() => void payer()} data-testid="passerelle-demo-payer">
                {etape === 'envoi' ? 'Paiement en cours…' : provider === 'koda' ? 'J’ai payé — simuler la confirmation de l’opérateur' : 'Payer (simulation)'}
              </button>
              {err && <p className="notice notice-err" role="alert">{err}</p>}
              <Link className="btn btn-ghost btn-sm" to={`/paiement/retour?ref=${encodeURIComponent(d.paymentReference)}`}>Annuler et revenir à MOSOLO</Link>
            </>
          )}
          <p className="small muted">Ce qui se passe ensuite est identique au service réel : la confirmation signée arrive sur l’adresse de webhook de MOSOLO (<span className="mono">/v1/providers/{provider}/webhooks</span>), qui vérifie la signature, le montant et la référence ; la quittance est PROVISOIRE, puis définitive au rapprochement du relevé bancaire.</p>
        </div>
      )}
    </div>
  );
}
