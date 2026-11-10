/**
 * « Faire payer (numérique) » — l'agent de terrain fait payer sur place SANS jamais toucher d'argent :
 * il émet la référence officielle au nom du titulaire ; l'usager paie depuis SON téléphone (monnaie mobile, USSD,
 * QR) ou par carte, vers le compte public ; la quittance arrive à l'usager dès la confirmation du prestataire.
 * Espèces : jamais à l'agent — uniquement dans un point de paiement agréé ou au guichet bancaire.
 * Réutilise le circuit commun (ordre de paiement, référence, confirmation signée, quittance) : aucun circuit parallèle.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { api, describeError, isDefinitiveRejection, newIdempotencyKey } from '../lib/api';
import { usePreciseLocation, type PreciseFix } from '../lib/geo';
import { GpsQualityLine } from './GpsQuality';
import { Icon } from './Icon';
import { MoneyText } from './MoneyText';
import { QrCode } from './QrCode';
import { ValidityCountdown } from './ValidityCountdown';

interface Payable { obligationId: string; label: string; status: string; dueDate: string; amount: MoneyJSON; paid: MoneyJSON; activeReference: { paymentReference: string; expiresAt: string; channel: string } | null }
interface Payables { items: Payable[]; channels: string[]; cash: string; notice: string }
interface Issued {
  order: { paymentReference: string; amount: MoneyJSON; createdAt: string; expiresAt: string; status: string; channel: string; ussdInstructions: string; qrPayload?: string | null; checkoutUrl?: string | null; provider?: string };
  record: { reused: boolean }; guidance: string[];
}

const CHANNEL: Record<string, { label: string; icon: string; hint: string }> = {
  MOBILE_MONEY: { label: 'Monnaie mobile', icon: 'phone', hint: 'Depuis le téléphone de l’usager' },
  USSD: { label: 'USSD', icon: 'keypad', hint: 'Tout téléphone, sans internet' },
  QR: { label: 'QR à scanner', icon: 'qr', hint: 'Application de paiement de l’usager' },
  CARD: { label: 'Carte', icon: 'card', hint: 'Carte bancaire de l’usager' },
};

export function AssistedPay({ objectId, obligationIds, onClose, position, title = 'Faire payer maintenant (numérique)' }: {
  objectId?: string; obligationIds?: string[]; onClose?: () => void; title?: string;
  /** Position GPS précise déjà connue de l'écran (ex. « Autour de moi ») : évite une seconde recherche. */
  position?: PreciseFix | null;
}) {
  const own = usePreciseLocation({ targetM: 15, maxWaitMs: 20_000, auto: !position });
  // La position fournie sert tant que l'agent n'a pas relancé le GPS ; dès que la recherche propre a démarré
  // (position fournie inutilisable, relance), c'est le relevé du composant qui compte.
  const loc = position && own.status === 'idle' ? { ...own, fix: position, status: 'ok' as const } : own;
  const [data, setData] = useState<Payables | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [channel, setChannel] = useState('MOBILE_MONEY');
  const [issued, setIssued] = useState<Issued | null>(null);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  useEffect(() => {
    const q = objectId ? `objectId=${encodeURIComponent(objectId)}` : `obligationIds=${encodeURIComponent((obligationIds ?? []).join(','))}`;
    api<Payables>(`/v1/agents/assist/payables?${q}`)
      .then((d) => { setData(d); setSel(d.items[0]?.obligationId ?? null); })
      .catch((e) => setErr(describeError(e).message));
  }, [objectId, (obligationIds ?? []).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps -- justifié : dépendances volontairement restreintes aux valeurs listées (sinon boucle de rendu ou rechargement à chaque rendu)

  // Suivi de la confirmation : l'agent voit « payé » dès que le prestataire confirme (la quittance part à l'usager).
  useEffect(() => {
    if (!issued || paid) return;
    const t = window.setInterval(() => {
      api<{ paid: boolean }>(`/v1/agents/assist/payment-orders/${encodeURIComponent(issued.order.paymentReference)}`).then((s) => { if (s.paid) setPaid(true); }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(t);
  }, [issued, paid]);

  const fix = loc.fix;
  const gpsOk = !!fix && fix.source === 'GPS' && fix.accuracy !== null && fix.accuracy <= 100;

  async function issue() {
    if (!sel || !fix) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<Issued>('/v1/agents/assist/payment-orders', {
        method: 'POST', idempotencyKey: key.current,
        body: { obligationId: sel, channel, ...(channel === 'QR' ? { provider: 'bitripay' } : {}), lat: Number(fix.lat.toFixed(6)), lon: Number(fix.lon.toFixed(6)), accuracyM: Math.max(1, Math.round(fix.accuracy ?? 100)) },
      });
      setIssued(r);
    } catch (e) {
      setErr(describeError(e).message);
      // Nouvelle clé seulement après un refus définitif (4xx) : réseau coupé ou 5xx = même opération à relancer.
      if (isDefinitiveRejection(e)) key.current = newIdempotencyKey();
    } finally { setBusy(false); }
  }

  const item = data?.items.find((i) => i.obligationId === sel);
  return (
    <section className="apay" aria-label="Paiement numérique assisté">
      <header className="apay-head">
        <strong><Icon name="phone" size={16} /> {title}</strong>
        {onClose && <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Fermer"><Icon name="close" size={14} /></button>}
      </header>
      <p className="apay-nocash"><Icon name="ban" size={15} /> <span><strong>Vous ne recevez jamais d’espèces.</strong> Espèces : uniquement dans un <Link to="/points-de-paiement">point de paiement agréé</Link> ou au guichet bancaire, avec la même référence.</span></p>

      {err && <p className="notice notice-err small" role="alert">{err}</p>}
      {!data && !err && <p className="small muted">Recherche de ce qui est à payer…</p>}
      {data && data.items.length === 0 && <p className="small muted"><Icon name="check" size={14} /> Rien à payer maintenant pour ce bien, ou hors de votre secteur.</p>}

      {data && data.items.length > 0 && !issued && (
        <>
          {data.items.length > 1 && (
            <div className="field"><label className="label" htmlFor="apay-ob">Obligation à régler</label>
              <select id="apay-ob" value={sel ?? ''} onChange={(e) => setSel(e.target.value)}>
                {data.items.map((i) => <option key={i.obligationId} value={i.obligationId}>{i.label} — échéance {i.dueDate}</option>)}
              </select></div>
          )}
          {item && (
            <div className="apay-amount">
              <span className="small muted">{item.label}{item.activeReference ? ` · référence active ${item.activeReference.paymentReference}` : ''}</span>
              <strong><MoneyText money={item.amount} /></strong>
              <span className="small muted">Montant fixé par l’obligation : il ne se négocie pas.</span>
            </div>
          )}
          <div className="apay-channels" role="radiogroup" aria-label="Canal de paiement numérique">
            {data.channels.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={channel === c} className={`apay-ch${channel === c ? ' is-on' : ''}`} onClick={() => setChannel(c)}>
                <Icon name={(CHANNEL[c]?.icon ?? 'card') as never} size={18} /><strong>{CHANNEL[c]?.label ?? c}</strong><span className="small muted">{CHANNEL[c]?.hint}</span>
              </button>
            ))}
          </div>
          <GpsQualityLine fix={fix} status={loc.status} targetM={loc.targetM} />
          {!gpsOk && loc.status !== 'searching' && <p className="small" style={{ color: 'var(--warning-ink)' }}>Position GPS précise requise (100 m au plus) : vous devez être sur place. <button type="button" className="btn-link" onClick={loc.start}>Relancer le GPS</button></p>}
          <button type="button" className="btn btn-primary btn-block" disabled={busy || !sel || !gpsOk} onClick={() => void issue()}>
            <Icon name="send" size={16} /> {busy ? 'Émission…' : 'Émettre la référence de paiement'}
          </button>
        </>
      )}

      {issued && (
        <div className={`apay-issued${paid ? ' is-paid' : ''}`} aria-live="polite">
          {paid ? (
            <p className="apay-paid"><Icon name="check" size={20} /> <strong>Paiement confirmé</strong> — la quittance est envoyée à l’usager.</p>
          ) : (
            <>
              <span className="caps-sm muted">Référence de paiement{issued.record.reused ? ' (déjà active, ré-affichée)' : ''}</span>
              <strong className="apay-ref mono">{issued.order.paymentReference}</strong>
              <strong className="apay-sum"><MoneyText money={issued.order.amount} /></strong>
              {(issued.order.qrPayload || issued.order.checkoutUrl) && <QrCode value={issued.order.qrPayload ?? issued.order.checkoutUrl!} size={168} alt="QR de paiement à scanner par l’usager" />}
              {issued.order.channel === 'QR' && !issued.order.qrPayload && !issued.order.checkoutUrl && <p className="small muted">Le QR est fourni par le prestataire de paiement (bac à sable de démonstration : pas de QR réel). L’usager peut payer avec la référence ci-dessus.</p>}
              <ValidityCountdown from={issued.order.createdAt} until={issued.order.expiresAt} compact label="Référence valable" />
              <ul className="apay-guide small">{issued.guidance.map((g) => <li key={g}>{g}</li>)}</ul>
              <p className="small muted"><Icon name="sync" size={14} /> En attente de la confirmation du prestataire…</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
