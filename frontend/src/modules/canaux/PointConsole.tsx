import { useEffect, useState, type FormEvent } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi, type ApiState } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { QrCode } from '../../components/QrCode';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api, describeError, newIdempotencyKey } from '../../lib/api';
import { hasRole, kinshasaToday, Pictogram, POINT_STATUS, POINT_TYPE_LABEL, type ReceiptPrint } from './shared';
import './canaux.css';

interface MyPoint { id: string; name: string; type: string; operator: string; commune: string; status: string; hours: string; settlementDelayHours: number; limits: { perTransaction: MoneyJSON[]; perDay: MoneyJSON[] }; approval: { reference: string } }
interface Lookup { paymentReference: string; amount: MoneyJSON; amountEditable: false; expiresAt: string; revenue: string; revenueLabel: string; administration: string; dueDate: string; taxpayerRefSuffix: string; holderInitials: string }
interface CardSituation { card: { numberSuffix: string; holderInitials: string; commune: string }; obligations: { obligationId: string; revenue: string; amount: MoneyJSON; dueDate: string; activeReference: string | null }[] }
interface CashDay {
  pointId: string; day: string; status: 'OUVERTE' | 'CLOTUREE' | 'DECLAREE' | 'VERSEE' | 'ECART'; expected: MoneyJSON[]; expectedByAccount: { accountAlias: string; amount: MoneyJSON }[];
  counted: MoneyJSON[] | null; closedAt: string | null; deposit: { bankSlipRef: string; depositedAt: string } | null; depositDeadline: string;
  collections: { id: string; paymentReference: string; amount: MoneyJSON; collectedAt: string; receiptNumber: string; shortCode: string; orderStatus: string; receiptStatus: string | null }[];
  reconciledCount: number; exceptions: { id: string; type: string; detail: string }[];
}

const DAY_STATUS: Record<string, { tone: 'good' | 'warning' | 'critical' | 'info'; label: string }> = {
  OUVERTE: { tone: 'info', label: 'Caisse ouverte' }, CLOTUREE: { tone: 'warning', label: 'Clôturée — versement à déclarer' },
  DECLAREE: { tone: 'warning', label: 'Versement déclaré — en attente du relevé bancaire' },
  VERSEE: { tone: 'good', label: 'Versée au compte public (relevé bancaire rapproché)' }, ECART: { tone: 'critical', label: 'Écart — exception ouverte' },
};

export function PrintableReceipt({ r }: { r: ReceiptPrint }) {
  const { fmtDate } = useApp();
  return (
    <article className="cx-receipt" aria-label={`Reçu ${r.receiptNumber}`}>
      {r.duplicata && <span className="cx-dup">DUPLICATA</span>}
      <header className="cx-receipt-head">
        <div><span className="cx-card-brand">KINSHASA MOSOLO</span><h3>Quittance {r.receiptStatus === 'DEFINITIVE' ? 'définitive' : 'provisoire'}</h3></div>
        <QrCode value={r.qrPayload} size={96} alt="QR signé de la quittance" />
      </header>
      <dl className="kv kv-dense">
        <div><dt>N° de quittance</dt><dd className="mono">{r.receiptNumber}</dd></div>
        <div><dt>Montant</dt><dd><MoneyText money={r.amount} showIndicative={false} className="cx-receipt-amount" /></dd></div>
        <div><dt>Objet</dt><dd>{r.revenue} — {r.revenueCategory}</dd></div>
        <div><dt>Référence de paiement</dt><dd className="mono">{r.paymentReference}</dd></div>
        <div><dt>Administration</dt><dd>{r.administration} · compte public {r.beneficiaryAlias}</dd></div>
        <div><dt>Contribuable</dt><dd className="mono">{r.taxpayerRefSuffix}</dd></div>
        <div><dt>Encaissé le</dt><dd>{fmtDate(r.collectedAt, true)}</dd></div>
        <div><dt>Point agréé</dt><dd>{r.point.name} ({r.point.commune}) · agrément {r.point.approvalReference}</dd></div>
      </dl>
      <div className="cx-shortcode"><span>Code de vérification</span><strong className="mono">{r.shortCode}</strong></div>
      <div className="cx-receipt-pictos">{r.pictograms.map((p) => <Pictogram key={p} code={p} size={30} showLabel />)}</div>
      <ul className="cx-receipt-notes">{r.notices.map((n) => <li key={n}>{n}</li>)}</ul>
      <p className="small muted">{r.mention}</p>
    </article>
  );
}

export default function PointConsole() {
  const { user, fmtDate } = useApp();
  const mine = useApi(hasRole(user?.roles, 'R32') ? () => api<MyPoint[]>('/v1/payment-points/mine') : null, [user?.id]);
  const [pointId, setPointId] = useState<string>('');
  const point = mine.data?.find((p) => p.id === pointId) ?? mine.data?.[0];
  useEffect(() => { if (!pointId && mine.data?.[0]) setPointId(mine.data[0].id); }, [mine.data, pointId]);

  const [mode, setMode] = useState<'ref' | 'card'>('ref');
  const [ref, setRef] = useState('');
  const [cardNo, setCardNo] = useState('');
  const [situation, setSituation] = useState<CardSituation | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [receipt, setReceipt] = useState<ReceiptPrint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [day, setDay] = useState(kinshasaToday());
  const cash = useApi(point ? () => api<CashDay>(`/v1/payment-points/${point.id}/cash-days/${day}`) : null, [point?.id, day, receipt?.collectionId]);

  const run = async (f: () => Promise<void>) => { setBusy(true); setErr(null); try { await f(); } catch (e) { setErr(describeError(e).message); } finally { setBusy(false); } };

  const doLookup = (e?: FormEvent) => { e?.preventDefault(); void run(async () => {
    setReceipt(null);
    setLookup(await api<Lookup>(`/v1/payment-points/${point!.id}/references/${encodeURIComponent(ref.trim())}`));
    setIdemKey(newIdempotencyKey());
  }); };
  const doCard = (e?: FormEvent) => { e?.preventDefault(); void run(async () => {
    setReceipt(null); setLookup(null);
    setSituation(await api<CardSituation>(`/v1/payment-points/${point!.id}/cards/${encodeURIComponent(cardNo.replace(/\s/g, ''))}`));
  }); };
  const cardRef = (obligationId: string) => void run(async () => {
    const l = await api<Lookup>(`/v1/payment-points/${point!.id}/card-references`, { method: 'POST', body: { cardNumber: cardNo.replace(/\s/g, ''), obligationId }, idempotencyKey: newIdempotencyKey() });
    setLookup(l); setRef(l.paymentReference); setIdemKey(newIdempotencyKey());
  });
  const collect = () => void run(async () => {
    const r = await api<{ receipt: ReceiptPrint }>(`/v1/payment-points/${point!.id}/collections`, { method: 'POST', body: { paymentReference: lookup!.paymentReference }, idempotencyKey: idemKey });
    setReceipt(r.receipt); setLookup(null); setSituation(null); setRef('');
  });
  const print = () => void run(async () => {
    const r = await api<ReceiptPrint>(`/v1/payment-points/${point!.id}/collections/${receipt!.collectionId}/print`, { method: 'POST' });
    setReceipt(r);
    setTimeout(() => window.print(), 50);
  });

  if (!hasRole(user?.roles, 'R32')) {
    return <div className="page"><PageHead eyebrow="Point de paiement agréé" title="Console du point agréé" /><div className="callout callout-warn">Réservé à l’opérateur d’un point de paiement agréé (R32). Choisissez par exemple « Point agréé Limete — opérateur (démo) ».</div></div>;
  }

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Point de paiement agréé — module 66" title="Console d’encaissement" lead="Saisissez la seule référence : le montant est fixé par MOSOLO et ne peut pas être modifié. La quittance est émise par MOSOLO après confirmation signée ; le point n’émet aucun numéro." >
        {mine.data && mine.data.length > 1 && (
          <select aria-label="Point" value={point?.id ?? ''} onChange={(e) => setPointId(e.target.value)} className="input-sm">{mine.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        )}
      </PageHead>
      <ExampleNotice text="Démonstration : point, opérateur et montants fictifs ; espèces simulées." />
      {mine.loading && <Loading />}
      {mine.error !== null && <ErrorState error={mine.error} onRetry={mine.reload} />}
      {point && (
        <>
          <div className="cx-point-head">
            <div><strong>{point.name}</strong><span className="small muted">{POINT_TYPE_LABEL[point.type]} · {point.operator} · agrément {point.approval.reference}</span></div>
            <StatusBadge tone={POINT_STATUS[point.status]?.tone ?? 'neutral'} label={POINT_STATUS[point.status]?.label ?? point.status} />
          </div>
          {point.status !== 'ACTIF' && <div className="callout callout-danger">Point non actif : aucun encaissement ni aucune preuve valable ne peut être produit. Orientez la personne vers un autre point agréé.</div>}
          <div className="cx-two">
            <section className="panel" aria-labelledby="cx-collect">
              <header className="panel-head"><h2 className="panel-title" id="cx-collect"><Icon name="cash" size={18} /> Encaisser</h2>
                <div className="seg seg-sm" role="group" aria-label="Présentation"><button type="button" aria-pressed={mode === 'ref'} onClick={() => setMode('ref')}>Référence</button><button type="button" aria-pressed={mode === 'card'} onClick={() => setMode('card')}>Carte MOSOLO</button></div>
              </header>
              {mode === 'ref' ? (
                <form className="input-row" onSubmit={doLookup}>
                  <input aria-label="Référence de paiement" className="mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="PR-XXXX-XXXX" autoCapitalize="characters" />
                  <button type="submit" className="btn btn-secondary" disabled={busy || ref.trim().length < 8}>Afficher</button>
                </form>
              ) : (
                <>
                  <form className="input-row" onSubmit={doCard}>
                    <input aria-label="Numéro de carte MOSOLO" className="mono" value={cardNo} onChange={(e) => setCardNo(e.target.value)} placeholder="4821 7730 1595" inputMode="numeric" />
                    <button type="submit" className="btn btn-secondary" disabled={busy || cardNo.replace(/\D/g, '').length !== 12}>Situation</button>
                  </form>
                  {situation && (
                    <div className="cx-mt">
                      <p className="small">Titulaire {situation.card.holderInitials} · carte ••••{situation.card.numberSuffix} · {situation.card.commune}</p>
                      {situation.obligations.length === 0 ? <EmptyState title="Aucune somme à payer" /> : (
                        <ul className="list-rows compact-rows">{situation.obligations.map((o) => (
                          <li key={o.obligationId} className="list-row"><span>{o.revenue} · échéance {fmtDate(o.dueDate)}</span><span className="row-side"><MoneyText money={o.amount} showIndicative={false} /> <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => cardRef(o.obligationId)}>{o.activeReference ? 'Reprendre la référence' : 'Générer la référence'}</button></span></li>
                        ))}</ul>
                      )}
                    </div>
                  )}
                </>
              )}
              {lookup && (
                <div className="cx-amount-box">
                  <p className="small muted">Référence {lookup.paymentReference} · {lookup.revenue} · {lookup.administration} · contribuable {lookup.taxpayerRefSuffix} ({lookup.holderInitials})</p>
                  <div className="cx-amount"><Icon name="lock" size={20} /><MoneyText money={lookup.amount} className="cx-amount-value" /></div>
                  <p className="small cx-inl"><Icon name="info" size={14} /> Montant fixé par MOSOLO — non modifiable. Référence valable jusqu’au {fmtDate(lookup.expiresAt, true)}.</p>
                  <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={collect}><Icon name="check" size={18} /> Espèces reçues : confirmer l’encaissement</button>
                </div>
              )}
              {err && <p className="notice notice-err" role="alert">{err}</p>}
            </section>

            <section className="panel" aria-labelledby="cx-receipt-t">
              <header className="panel-head"><h2 className="panel-title" id="cx-receipt-t"><Icon name="ticket" size={18} /> Reçu à remettre</h2>{receipt && <button type="button" className="btn btn-secondary btn-sm" onClick={print}><Icon name="download" size={16} /> Imprimer</button>}</header>
              {receipt ? <div className="cx-print-area"><PrintableReceipt r={receipt} /></div> : <p className="muted small">Le reçu apparaît ici après confirmation signée. Aucune preuve n’existe avant.</p>}
            </section>
          </div>
          <CashDayPanel point={point} day={day} setDay={setDay} cash={cash} />
        </>
      )}
    </div>
  );
}

/** Valeur « AAAA-MM-JJTHH:MM » d'un champ datetime-local, à l'heure locale de l'appareil. */
export function localDateTimeInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function CashDayPanel({ point, day, setDay, cash }: { point: MyPoint; day: string; setDay: (d: string) => void; cash: ApiState<CashDay> }) {
  const { fmtDate } = useApp();
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [slip, setSlip] = useState('');
  // Heure LOCALE de l'appareil (le champ datetime-local ne connaît pas de fuseau ; toISOString donnerait l'heure UTC).
  const [depositAt, setDepositAt] = useState(() => localDateTimeInput(new Date()));
  const [lines, setLines] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const c = cash.data;

  async function post(path: string, body: unknown) {
    if (posting) return; // pas de double clôture ni de double déclaration de versement
    setErr(null); setPosting(true);
    try { cash.setData(await api<CashDay>(path, { method: 'POST', body })); } catch (e) { setErr(describeError(e).message); } finally { setPosting(false); }
  }

  return (
    <section className="panel cx-mt" aria-labelledby="cx-cash">
      <header className="panel-head">
        <div><h2 className="panel-title" id="cx-cash"><Icon name="ledger" size={18} /> Caisse du jour et versement bancaire</h2><p className="panel-sub">Espèces versées chaque jour au compte public du coffre, dans le délai contractuel de {point.settlementDelayHours} h. Tout écart ouvre une exception ; le Trésor décide.</p></div>
        <input type="date" aria-label="Jour de caisse" value={day} onChange={(e) => setDay(e.target.value)} className="input-sm" />
      </header>
      {cash.loading && <Loading />}
      {cash.error !== null && <ErrorState error={cash.error} onRetry={cash.reload} />}
      {c && (
        <>
          <div className="cx-cash-head">
            <StatusBadge tone={DAY_STATUS[c.status]?.tone ?? 'info'} label={DAY_STATUS[c.status]?.label ?? c.status} />
            <span className="small">Attendu : {c.expected.length ? c.expected.map((m) => <MoneyText key={m.currency} money={m} showIndicative={false} />) : '—'}</span>
            <span className="small muted">Versement au plus tard le {fmtDate(c.depositDeadline, true)} · {c.reconciledCount}/{c.collections.length} rapproché(s) au compte public</span>
          </div>
          {c.collections.length === 0 ? <p className="muted small">Aucun encaissement ce jour.</p> : (
            <div className="table-scroll"><table className="data-table">
              <thead><tr><th>Heure</th><th>Référence</th><th className="num">Montant</th><th>Code</th><th>Quittance</th></tr></thead>
              <tbody>{c.collections.map((x) => (
                <tr key={x.id}><td>{fmtDate(x.collectedAt, true)}</td><td className="mono">{x.paymentReference}</td><td className="num"><MoneyText money={x.amount} showIndicative={false} /></td><td className="mono">{x.shortCode}</td>
                  <td><StatusBadge tone={x.receiptStatus === 'DEFINITIVE' ? 'good' : 'warning'} label={x.receiptStatus === 'DEFINITIVE' ? 'Définitive' : 'Provisoire'} /></td></tr>
              ))}</tbody>
            </table></div>
          )}
          {c.exceptions.length > 0 && <ul className="cx-exc">{c.exceptions.map((e) => <li key={e.id}><Icon name="alert" size={16} /> <strong>{e.type.replace(/_/g, ' ').toLowerCase()}</strong> — {e.detail}</li>)}</ul>}
          <div className="cx-two cx-mt">
            <form className="form" onSubmit={(e) => { e.preventDefault(); void post(`/v1/payment-points/${point.id}/cash-days/${day}/close`, { counted: c.expected.map((m) => ({ currency: m.currency, amount: counted[m.currency] || '0.00' })) }); }}>
              <h3 className="panel-title">1. Clôturer la caisse</h3>
              {c.expected.length === 0 && <p className="small muted">Aucun montant attendu.</p>}
              {c.expected.map((m) => (
                <div className="field" key={m.currency}><label className="label" htmlFor={`cx-count-${m.currency}`}>Espèces comptées ({m.currency})</label><input id={`cx-count-${m.currency}`} inputMode="decimal" className="mono" value={counted[m.currency] ?? ''} onChange={(e) => setCounted({ ...counted, [m.currency]: e.target.value })} placeholder={m.amount} disabled={c.status !== 'OUVERTE'} /></div>
              ))}
              <button type="submit" className="btn btn-secondary" disabled={posting || c.status !== 'OUVERTE'}>Clôturer le {day}</button>
            </form>
            <form className="form" onSubmit={(e) => { e.preventDefault(); void post(`/v1/payment-points/${point.id}/cash-days/${day}/deposit`, { bankSlipRef: slip, depositedAt: new Date(depositAt).toISOString(), lines: c.expectedByAccount.map((l) => ({ accountAlias: l.accountAlias, amount: { currency: l.amount.currency, amount: lines[`${l.accountAlias}|${l.amount.currency}`] || '0.00' } })) }); }}>
              <h3 className="panel-title">2. Déclarer le versement bancaire</h3>
              <div className="field"><label className="label" htmlFor="cx-slip">Bordereau de versement</label><input id="cx-slip" value={slip} onChange={(e) => setSlip(e.target.value)} disabled={(c.status !== 'CLOTUREE' && c.status !== 'ECART') || !!c.deposit} /></div>
              <div className="field"><label className="label" htmlFor="cx-dat">Date et heure du versement</label><input id="cx-dat" type="datetime-local" value={depositAt} onChange={(e) => setDepositAt(e.target.value)} /></div>
              {c.expectedByAccount.map((l) => (
                <div className="field" key={`${l.accountAlias}|${l.amount.currency}`}><label className="label" htmlFor={`cx-dep-${l.accountAlias}`}>Versé sur {l.accountAlias} ({l.amount.currency}) — compte public du coffre</label>
                  <input id={`cx-dep-${l.accountAlias}`} inputMode="decimal" className="mono" placeholder={l.amount.amount} value={lines[`${l.accountAlias}|${l.amount.currency}`] ?? ''} onChange={(e) => setLines({ ...lines, [`${l.accountAlias}|${l.amount.currency}`]: e.target.value })} /></div>
              ))}
              <button type="submit" className="btn btn-secondary" disabled={posting || !!c.deposit || c.status === 'OUVERTE' || slip.length < 3}>Déclarer le versement</button>
              {c.deposit && <p className="small">Versement {c.deposit.bankSlipRef} déclaré le {fmtDate(c.deposit.depositedAt, true)}.</p>}
            </form>
          </div>
          {err && <p className="notice notice-err" role="alert">{err}</p>}
        </>
      )}
    </section>
  );
}
