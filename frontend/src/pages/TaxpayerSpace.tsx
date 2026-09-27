import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { isCurrencyCode, CURRENCIES, formatMoney, type CurrencyCode, type MapStatusColor } from '@mosolo/shared';
import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { useAutosave } from '../hooks/useAutosave';
import { PageHead } from '../components/Shell';
import { Drawer } from '../components/Drawer';
import { DataTable } from '../components/DataTable';
import { MoneyText } from '../components/MoneyText';
import { StatusBadge } from '../components/StatusBadge';
import { ValidityCountdown } from '../components/ValidityCountdown';
import { MapStatusChip } from '../components/MapStatusChip';
import { AutosaveBar } from '../components/VersionHistory';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { Icon } from '../components/Icon';
import { QrCode } from '../components/QrCode';
import { ReceiptPdfButton } from '../components/ReceiptPdfButton';
import { categoryLabel, levelLabel } from '../lib/labels';
import { api, ApiError, describeError, newIdempotencyKey, safeGet, serverNow } from '../lib/api';
import { OBLIGATION_TONE, PAYMENT_TONE, RECEIPT_TONE, obligationKey } from '../lib/status';
import type { UIKey } from '../lib/i18n';
import { asMoney } from '../lib/normalize';
import type { Obligation, ObligationDetail, ObligationExplanation, PaymentOrder, Receipt, TaxpayerProfile } from '../lib/types';
import '../modules/fiscal/fiscal.css';
import { SeptQuestionsPanel } from '../modules/chaine/SeptQuestions';

/** Accès aux démarches fiscales (module fiscal) depuis l'espace contribuable. */
const FISCAL_LINKS: { to: string; icon: string; title: string; text: string }[] = [
  { to: '/fiscal/biens', icon: 'building', title: 'Mes biens et relations', text: 'Identifiant géofiscal, QR par bien, rattachements et quotes-parts.' },
  { to: '/fiscal/declarations', icon: 'file', title: 'Déclaration pré-remplie', text: 'Confirmer ou corriger, déposer, recevoir l’accusé de réception.' },
  { to: '/fiscal/exonerations', icon: 'scale', title: 'Demande d’exonération', text: 'Pièces, durée ; décision en double validation.' },
  { to: '/fiscal/quitus', icon: 'shieldCheck', title: 'Quitus fiscal', text: 'Attestation de régularité vérifiable par QR.' },
  { to: '/fiscal/baux', icon: 'ticket', title: 'Attestation de bail', text: 'Pour le bailleur et le locataire d’un bail enregistré.' },
  { to: '/fiscal/carte', icon: 'pin', title: 'Carte de mes biens', text: 'Situation fiscale et vérification, en couleurs.' },
];

/** Agrégateurs candidats (canaux Monnaie mobile et QR) : le règlement va toujours au compte public du coffre. */
const PROVIDERS: { id: '' | 'bitripay' | 'koda'; label: string; hint: string }[] = [
  { id: '', label: 'Opérateur direct', hint: 'Référence à saisir dans votre application ou par USSD' },
  { id: 'bitripay', label: 'BitriPay', hint: 'Page de paiement hébergée et QR BitriPay' },
  { id: 'koda', label: 'KODA', hint: 'Page de paiement KODA (Orange Money, M-Pesa)' },
];

const CHANNELS: { id: string; icon: string; key: UIKey }[] = [
  { id: 'MOBILE_MONEY', icon: 'phone', key: 'pay.channel.MOBILE_MONEY' },
  { id: 'QR', icon: 'qr', key: 'pay.channel.QR' },
  { id: 'BANK', icon: 'bank', key: 'pay.channel.BANK' },
  { id: 'CARD', icon: 'card', key: 'pay.channel.CARD' },
  { id: 'USSD', icon: 'keypad', key: 'pay.channel.USSD' },
  { id: 'AGENT_POINT', icon: 'store', key: 'pay.channel.AGENT_POINT' },
];

/** Couleur de situation (§ 16.6) déduite du statut probant quand le backend ne la fournit pas. */
function mapFromProbative(s?: string): MapStatusColor {
  if (s === 'VERIFIE') return 'green';
  if (s === 'CONTESTE') return 'red';
  if (s === 'DECLARE' || s === 'OBSERVE') return 'amber';
  return 'grey';
}

function fmtInput(v: unknown): string {
  const m = asMoney(v);
  if (m) return formatMoney(m);
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

function Explanation({ id }: { id: string }) {
  const { tr, fmtDate } = useApp();
  const q = useApi(() => api<ObligationDetail>(`/v1/obligations/${encodeURIComponent(id)}`), [id]);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d) return null;
  const ex: ObligationExplanation = d.explanation ?? (d as unknown as ObligationExplanation);
  const rule = typeof ex.rule === 'string' ? { code: ex.rule } : ex.rule ?? {};
  const version = ex.ruleVersion ?? ex.version ?? rule.version;
  const basisRaw: unknown[] = Array.isArray(ex.legalBasis) ? ex.legalBasis : ex.legalBasis ? [ex.legalBasis] : [];
  const basis = [
    ...basisRaw.map((b) => (typeof b === 'string' ? b : `${(b as { title?: string; id?: string }).title ?? (b as { id?: string }).id ?? ''}${(b as { status?: string }).status ? ` — ${(b as { status?: string }).status}` : ''}`)),
    ...(ex.articles ?? []),
  ];
  const inputs = Object.entries({ ...(ex.inputs ?? {}), ...(ex.base ?? {}), ...(ex.rates ?? {}) });
  return (
    <div className="stack">
      <dl className="kv">
        <div><dt>{tr('explain.rule')}</dt><dd>{rule.label ?? d.label ?? '—'} <span className="mono muted">{rule.code ?? ex.ruleCode ?? d.ruleCode ?? ''}</span></dd></div>
        <div><dt>{tr('taxpayer.ruleVersion')}</dt><dd className="mono">{version !== undefined ? `v${version}` : '—'}</dd></div>
        <div><dt>{tr('taxpayer.legalBasis')}</dt><dd>{basis.length ? <ul className="plain-list">{basis.map((b) => <li key={b}>{b}</li>)}</ul> : '—'}</dd></div>
        <div><dt>{tr('taxpayer.formula')}</dt><dd><code className="formula">{ex.formula ?? '—'}</code></dd></div>
      </dl>
      <div>
        <h3 className="h-sub">{tr('explain.inputs')}</h3>
        {inputs.length ? (
          <table className="data-table compact">
            <tbody>{inputs.map(([k, v]) => <tr key={k}><th scope="row" className="mono">{k}</th><td className="num">{fmtInput(v)}</td></tr>)}</tbody>
          </table>
        ) : <p className="muted">—</p>}
      </div>
      <dl className="kv">
        <div><dt>{tr('explain.amount')}</dt><dd>{(ex.amount ?? d.amount) ? <MoneyText money={(ex.amount ?? d.amount)!} indicative={asMoney(d.indicativeAmount)} /> : '—'}</dd></div>
        <div><dt>{tr('taxpayer.dueDate')}</dt><dd>{fmtDate(ex.dueDate ?? d.dueDate)}</dd></div>
        <div><dt>{tr('taxpayer.appealPath')}</dt><dd>{ex.appealPath ?? '—'}</dd></div>
        {d.attribution && (
          <div><dt>{tr('attribution.label')}</dt><dd>{d.attribution.commune
            ? <>{d.attribution.commune}{d.attribution.quartier ? ` · ${d.attribution.quartier}` : ''} <span className="small muted">— {tr(`attribution.basis.${d.attribution.basis}` as UIKey)}</span></>
            : tr('attribution.none')}</dd></div>
        )}
      </dl>
      <p className="small muted">{tr('explain.note')}</p>
    </div>
  );
}

function PayFlow({ ob }: { ob: Obligation }) {
  const { tr, currency, fmtDate } = useApp();
  const [channel, setChannel] = useState('MOBILE_MONEY');
  const [provider, setProvider] = useState<'' | 'bitripay' | 'koda'>('');
  const providerAllowed = channel === 'MOBILE_MONEY' || channel === 'QR';
  const [idem] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const display: CurrencyCode | undefined = currency !== ob.amount.currency && isCurrencyCode(currency) && CURRENCIES[currency].payable ? currency : undefined;

  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api<PaymentOrder>(`/v1/obligations/${encodeURIComponent(ob.id)}/payment-orders`, {
        method: 'POST', idempotencyKey: idem, body: { channel, ...(display ? { displayCurrency: display } : {}), ...(providerAllowed && provider ? { provider } : {}) },
      });
      setOrder({ createdAt: new Date(serverNow()).toISOString(), ...r });
    } catch (x) {
      // Une référence active existe déjà : on la réaffiche au lieu d'une erreur
      if (x instanceof ApiError && x.code === 'ACTIVE_PAYMENT_REFERENCE_EXISTS' && x.body) {
        const b = x.body as Partial<PaymentOrder> & { existing?: Partial<PaymentOrder> };
        const ref = b.paymentReference ?? b.existing?.paymentReference;
        if (ref) {
          setOrder({ ...(b.existing ?? {}), paymentReference: ref, amount: b.amount ?? b.existing?.amount ?? ob.amount, status: b.status ?? b.existing?.status ?? 'INITIE' } as PaymentOrder);
          setReused(true);
          return;
        }
      }
      setErr(describeError(x).message);
    } finally {
      setBusy(false);
    }
  }

  const ussd = order?.ussdInstructions ? (Array.isArray(order.ussdInstructions) ? order.ussdInstructions : [order.ussdInstructions]) : [];
  return (
    <div className="stack">
      <div className="callout callout-warn"><Icon name="cash" size={18} /><p><strong>{tr('pay.noCash')}</strong></p></div>
      <p><MoneyText money={ob.amount} indicative={asMoney(ob.indicativeAmount)} showDisplay /></p>
      {!order ? (
        <form onSubmit={(e) => void go(e)} className="form">
          <fieldset className="field">
            <legend className="label">{tr('pay.chooseChannel')}</legend>
            <div className="choice-grid">
              {CHANNELS.map((c) => (
                <label key={c.id} className={`choice ${channel === c.id ? 'checked' : ''}`}>
                  <input type="radio" name="channel" value={c.id} checked={channel === c.id} onChange={() => setChannel(c.id)} />
                  <Icon name={c.icon} size={20} /> <span>{tr(c.key)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {providerAllowed && (
            <fieldset className="field">
              <legend className="label">Passerelle de paiement</legend>
              <div className="choice-grid">
                {PROVIDERS.map((p) => (
                  <label key={p.id || 'direct'} className={`choice ${provider === p.id ? 'checked' : ''}`}>
                    <input type="radio" name="provider" value={p.id} checked={provider === p.id} onChange={() => setProvider(p.id)} />
                    <span><strong>{p.label}</strong><br /><span className="small muted">{p.hint}</span></span>
                  </label>
                ))}
              </div>
              <span className="hint">BitriPay et KODA sont des prestataires candidats : ils règlent le compte public de la Ville, aucun frais n’est prélevé sur votre paiement.</span>
            </fieldset>
          )}
          <p className="small muted">{tr('pay.idempotency')} <span className="mono">{idem.slice(0, 8)}…</span></p>
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? tr('common.sending') : tr('pay.getReference')}</button>
        </form>
      ) : (
        <div className="result-card" role="status">
          {reused && <p className="notice notice-ok">{tr('pay.reused')}</p>}
          <p className="label">{tr('payment.reference')}</p>
          <p className="ref-big mono">{order.paymentReference}</p>
          <dl className="kv">
            <div><dt>{tr('explain.amount')}</dt><dd><MoneyText money={order.amount} indicative={asMoney(order.indicativeAmount)} /></dd></div>
            {order.beneficiaryAlias && <div><dt>{tr('pay.beneficiary')}</dt><dd className="mono">{order.beneficiaryAlias}</dd></div>}
            {order.expiresAt && <div><dt>{tr('pay.expires')}</dt><dd>{fmtDate(order.expiresAt, true)}{order.createdAt && order.status === 'INITIE' && <> <ValidityCountdown compact from={order.createdAt} until={order.expiresAt} label={tr('payment.reference')} /></>}</dd></div>}
            <div><dt>{tr('pay.status')}</dt><dd><StatusBadge tone={PAYMENT_TONE[order.status] ?? 'neutral'} label={tr(`payment.status.${order.status}` as UIKey)} /></dd></div>
          </dl>
          {order.provider && (
            <div className="provider-box">
              <p className="label">Payer via {order.provider === 'bitripay' ? 'BitriPay' : 'KODA'} {order.sandbox && <StatusBadge tone="warning" label="Bac à sable" />}</p>
              <div className="provider-row">
                {(order.qrPayload || order.checkoutUrl) && <QrCode value={order.qrPayload ?? order.checkoutUrl!} size={132} alt={`Code QR de paiement ${order.provider}`} />}
                <div className="min0 stack-sm">
                  <p className="small">Intention <span className="mono">{order.providerIntentId}</span></p>
                  {order.checkoutUrl
                    ? <a className="btn btn-primary btn-sm" href={order.checkoutUrl} target="_blank" rel="noreferrer">Ouvrir la page de paiement <Icon name="external" size={14} /></a>
                    : <p className="small muted">Bac à sable local : aucune page réelle n’est ouverte ; la confirmation signée est simulée par le Trésor.</p>}
                  <p className="small muted">La quittance n’est émise qu’à réception de la confirmation signée du prestataire — jamais sur capture d’écran ou SMS.</p>
                </div>
              </div>
            </div>
          )}
          {ussd.length > 0 && (
            <div>
              <h3 className="h-sub">{tr('pay.ussdTitle')}</h3>
              <ol className="steps">{ussd.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </div>
          )}
          <p className="small">{tr('payment.ussdHint')}</p>
        </div>
      )}
    </div>
  );
}

interface AppealDraft { reason: string; grounds: string; requestSuspension: boolean }

function ContestForm({ ob }: { ob: Obligation }) {
  const { tr } = useApp();
  const draft = useAutosave<AppealDraft>(`appeal-${ob.id}`, { reason: '', grounds: '', requestSuspension: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const v = draft.value;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (v.reason.trim().length < 10) { setErr(tr('appeal.err.reason')); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id?: string; appealId?: string }>('/v1/appeals', { method: 'POST', body: { obligationId: ob.id, ...v } });
      setDone(r?.id ?? r?.appealId ?? '—');
      draft.reset();
    } catch (x) {
      setErr(describeError(x).message);
    } finally {
      setBusy(false);
    }
  }
  if (done) return <div className="result-card" role="status"><StatusBadge tone="good" label={tr('appeal.sent')} /><p>{tr('appeal.sentRef', { ref: done })}</p></div>;
  return (
    <form onSubmit={(e) => void submit(e)} className="form">
      <p className="small muted">{tr('appeal.lead')}</p>
      <div className="field">
        <label className="label" htmlFor="ap-reason">{tr('appeal.reason')}</label>
        <textarea id="ap-reason" rows={4} value={v.reason} onChange={(e) => draft.setValue((p) => ({ ...p, reason: e.target.value }))} />
      </div>
      <div className="field">
        <label className="label" htmlFor="ap-grounds">{tr('appeal.grounds')}</label>
        <textarea id="ap-grounds" rows={3} value={v.grounds} onChange={(e) => draft.setValue((p) => ({ ...p, grounds: e.target.value }))} />
        <span className="hint">{tr('appeal.groundsHint')}</span>
      </div>
      <label className="check">
        <input type="checkbox" checked={v.requestSuspension} onChange={(e) => draft.setValue((p) => ({ ...p, requestSuspension: e.target.checked }))} />
        <span>{tr('appeal.suspension')}</span>
      </label>
      <AutosaveBar draft={draft} />
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? tr('common.sending') : tr('appeal.submit')}</button>
    </form>
  );
}

type Panel = { kind: 'explain' | 'pay' | 'contest' | 'chaine'; ob: Obligation } | null;

export default function TaxpayerSpace() {
  const { tr, user, users, setUserId, fmtDate, lang } = useApp();
  const isTaxpayer = !!user?.roles.some((r) => r === 'R30' || r === 'R31');
  const demoTaxpayer = users.find((u) => u.roles.includes('R30'));
  const taxpayerId = (isTaxpayer ? user?.taxpayerId ?? user?.id : null) ?? safeGet('mosolo.taxpayerId') ?? demoTaxpayer?.taxpayerId ?? demoTaxpayer?.id ?? null;
  const q = useApi(taxpayerId ? async () => {
    // Le backend renvoie { taxpayer, objects, obligations, receipts, … } ; on aplatit le profil.
    const raw = await api<TaxpayerProfile & { taxpayer?: Partial<TaxpayerProfile> }>(`/v1/taxpayers/${encodeURIComponent(taxpayerId)}`);
    return { ...(raw.taxpayer ?? {}), ...raw, id: raw.taxpayer?.id ?? raw.id } as TaxpayerProfile;
  } : null, [taxpayerId, user?.id]);
  const [panel, setPanel] = useState<Panel>(null);
  const p = q.data;
  const obligations = useMemo(() => p?.obligations ?? [], [p]);

  return (
    <div className="page">
      <PageHead eyebrow={tr('nav.taxpayer')} title={p && (p.fullName ?? p.name) ? tr('space.title', { name: p.fullName ?? p.name ?? '' }) : tr('nav.taxpayer')}
        lead={tr('space.lead')}>
        {p && (
          <dl className="head-facts">
            {p.iuc && <div><dt>{tr('reg.iuc')}</dt><dd className="mono">{p.iuc}</dd></div>}
            {p.verificationLevel && <div><dt>{tr('reg.level')}</dt><dd>{levelLabel(lang, p.verificationLevel)}</dd></div>}
          </dl>
        )}
      </PageHead>

      {!isTaxpayer && demoTaxpayer && (
        <div className="callout callout-info">
          <Icon name="user" size={18} />
          <p>{tr('space.notTaxpayer')} <button type="button" className="btn-link" onClick={() => setUserId(demoTaxpayer.id)}>{tr('space.switchTo', { name: demoTaxpayer.name })}</button></p>
        </div>
      )}
      {!taxpayerId && !q.loading && (
        <EmptyState title={tr('space.noTaxpayer')} icon="user"><Link className="btn btn-primary" to="/inscription">{tr('taxpayer.register')}</Link></EmptyState>
      )}
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}

      {p && (
        <>
          <section className="section" aria-labelledby="sec-obl">
            <div className="section-head"><h2 id="sec-obl">{tr('taxpayer.obligations')}</h2><span className="count">{obligations.length}</span></div>
            <DataTable
              caption={tr('taxpayer.obligations')}
              rows={obligations}
              rowKey={(o) => o.id}
              empty={<EmptyState title={tr('space.noObligations')} />}
              columns={[
                { key: 'label', label: tr('space.col.obligation'), primary: true, render: (o) => <><strong>{o.label ?? o.ruleCode ?? o.id}</strong>{o.period && <span className="muted small"> · {o.period}</span>}</> },
                { key: 'amount', label: tr('explain.amount'), num: true, render: (o) => <MoneyText money={o.amount} indicative={asMoney(o.indicativeAmount)} /> },
                { key: 'due', label: tr('taxpayer.dueDate'), render: (o) => fmtDate(o.dueDate) },
                { key: 'status', label: tr('space.col.status'), render: (o) => <StatusBadge tone={OBLIGATION_TONE[o.status] ?? 'neutral'} label={tr(obligationKey(o.status))} /> },
                {
                  key: 'actions', label: tr('space.col.actions'), full: true, render: (o) => (
                    <div className="row-actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel({ kind: 'explain', ob: o })}><Icon name="info" size={16} /> {tr('taxpayer.explain')}</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel({ kind: 'chaine', ob: o })}><Icon name="sync" size={16} /> Sept questions</button>
                      {o.status !== 'SOLDEE' && o.status !== 'ANNULEE' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setPanel({ kind: 'pay', ob: o })}>{tr('taxpayer.pay')}</button>}
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPanel({ kind: 'contest', ob: o })}>{tr('taxpayer.contest')}</button>
                    </div>
                  ),
                },
              ]}
            />
          </section>

          <section className="section" aria-labelledby="sec-fiscal">
            <div className="section-head"><h2 id="sec-fiscal">Mes démarches fiscales</h2></div>
            <nav className="fs-space-links" aria-label="Démarches fiscales">
              {FISCAL_LINKS.map((l) => (
                <Link key={l.to} to={l.to} className="fs-space-link">
                  <Icon name={l.icon} size={20} />
                  <span><strong>{l.title}</strong><span className="small muted">{l.text}</span></span>
                </Link>
              ))}
            </nav>
          </section>

          <section className="section" aria-labelledby="sec-obj">
            <div className="section-head"><h2 id="sec-obj">{tr('taxpayer.objects')}</h2><span className="count">{p.objects?.length ?? 0}</span></div>
            {(p.objects?.length ?? 0) === 0 ? <EmptyState title={tr('space.noObjects')} /> : (
              <ul className="list-rows">
                {p.objects!.map((o) => (
                  <li key={o.id} className="list-row">
                    <div>
                      <p className="row-title">{o.label ?? categoryLabel(lang, o.category)}</p>
                      <p className="small muted">{[o.commune, o.quartier].filter(Boolean).join(' · ')}{o.localityRank ? ` · ${tr('space.rank', { n: o.localityRank })}` : ''} · <span className="mono">{o.identifier ?? o.id}</span></p>
                    </div>
                    <div className="row-side">
                      <MapStatusChip status={o.mapStatus ?? mapFromProbative(o.probativeStatus)} />
                      {o.probativeStatus && <span className="tag">{tr(`probative.${o.probativeStatus}` as UIKey)}</span>}
                      <Link className="btn btn-ghost btn-sm" to={`/chaine/${encodeURIComponent(o.id)}`}><Icon name="sync" size={16} /> Sept questions</Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="section" aria-labelledby="sec-rc">
            <div className="section-head"><h2 id="sec-rc">{tr('taxpayer.receipts')}</h2><span className="count">{p.receipts?.length ?? 0}</span></div>
            {(p.receipts?.length ?? 0) === 0 ? <EmptyState title={tr('space.noReceipts')} /> : (
              <ul className="list-rows">
                {p.receipts!.map((r: Receipt) => {
                  const st = RECEIPT_TONE[r.status] ?? { tone: 'neutral' as const, key: 'receipt.provisional' as UIKey };
                  const verifyUrl = `${window.location.origin}/verifier/${encodeURIComponent(r.code)}`;
                  const tech = r.qrPayload ?? r.qr;
                  return (
                    <li key={r.id} className="list-row receipt-row">
                      <figure className="receipt-qr">
                        <QrCode value={verifyUrl} alt={tr('receipt.qrAlt', { code: r.code })} />
                        <figcaption className="mono small">{r.code}</figcaption>
                      </figure>
                      <div className="min0">
                        <p className="row-title">{r.number ?? r.code}</p>
                        <p className="small muted">{fmtDate(r.issuedAt, true)}{r.category ? ` · ${r.category}` : ''}</p>
                        {tech && (
                          <details className="tech">
                            <summary className="small">{tr('receipt.tech')}</summary>
                            <p className="mono small hash">{tech}</p>
                          </details>
                        )}
                      </div>
                      <div className="row-side">
                        {r.amount && <MoneyText money={r.amount} />}
                        <StatusBadge tone={st.tone} label={tr(st.key)} />
                        <Link className="btn btn-ghost btn-sm" to={`/verifier/${encodeURIComponent(r.code)}`}>{tr('verify.button')}</Link>
                        {r.number && <ReceiptPdfButton receipt={r.number} />}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}

      <Drawer open={panel !== null} onClose={() => setPanel(null)}
        title={panel ? (panel.kind === 'chaine' ? 'Sept questions et chaîne opératoire' : tr(panel.kind === 'explain' ? 'taxpayer.explain' : panel.kind === 'pay' ? 'taxpayer.pay' : 'taxpayer.contest')) : ''}>
        {panel?.kind === 'explain' && <Explanation id={panel.ob.id} />}
        {panel?.kind === 'pay' && <PayFlow ob={panel.ob} />}
        {panel?.kind === 'contest' && <ContestForm ob={panel.ob} />}
        {panel?.kind === 'chaine' && <SeptQuestionsPanel obligationId={panel.ob.id} />}
      </Drawer>
    </div>
  );
}
