import { useState } from 'react';
import { CityLogo, PrintFooterMark, PrintLetterhead } from '../../components/Brand';
import { Link, useParams } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { QrCode } from '../../components/QrCode';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { cardVerifyUrl, hasRole, Pictogram, type CardView } from './shared';
import { AvisVisuel, CartesEtat, IndicateursAgent } from './visuels';
import { ChartGrid } from '../../components/viz';
import './canaux.css';

interface Notice {
  title: string; language: string; generatedAt: string;
  holder: { initials: string; iuc: string; level: string; cardNumber: string | null; commune: string };
  dues: { obligationId: string; revenue: string; label: string; amount: MoneyJSON; dueDate: string; pictogram: string; activeReference: string | null }[];
  total: MoneyJSON[]; emptyMessage: string | null;
  paymentPlaces: { kind: string; name: string; address: string; hours: string }[];
  actions: { pictogram: string; label: string; how: string }[];
  warnings: { pictogram: string; text: string }[];
  channels: { ussd: string; ivr: string };
}

const STATUS: Record<string, { tone: 'good' | 'warning' | 'critical'; label: string }> = {
  ACTIVE: { tone: 'good', label: 'Active' }, BLOQUEE: { tone: 'warning', label: 'Bloquée' }, REVOQUEE: { tone: 'critical', label: 'Révoquée' },
};

export function MosoloCardFace({ card }: { card: CardView & { taxpayerId?: string } }) {
  const { fmtDate } = useApp();
  return (
    <article className={`cx-card ${card.status !== 'ACTIVE' ? 'cx-card-void' : ''}`} aria-label={`Carte MOSOLO ${card.numberFormatted}`}>
      <header className="cx-card-head">
        <span className="cx-card-brand"><CityLogo height={20} variant="onLight" /> KINSHASA MOSOLO</span>
        <span className="cx-card-kind">Carte MOSOLO</span>
      </header>
      <div className="cx-card-stripe" aria-hidden="true"><span /><span /><span /></div>
      <div className="cx-card-body">
        <div className="cx-card-photo" aria-label="Photographie">{card.photoSha256 ? <Icon name="camera" size={22} /> : <Icon name="user" size={28} />}<span>Photo</span></div>
        <dl className="cx-card-data">
          <div><dt>Titulaire</dt><dd>{card.holderDisplayName}</dd></div>
          <div><dt>N° contribuable</dt><dd className="mono">{card.iuc}</dd></div>
          <div><dt>Commune</dt><dd>{card.commune}</dd></div>
          <div><dt>Émise le</dt><dd>{fmtDate(card.issuedAt)}</dd></div>
        </dl>
        <div className="cx-card-qr"><QrCode value={cardVerifyUrl(card.qrToken)} size={84} alt="QR de vérification de la carte" /></div>
      </div>
      <footer className="cx-card-foot">
        <span className="cx-card-number mono">{card.numberFormatted}</span>
        <span className="cx-card-free">Gratuite · aucun agent ne reçoit d’argent</span>
      </footer>
      {card.status !== 'ACTIVE' && <span className="cx-card-stamp">{card.status === 'REVOQUEE' ? 'RÉVOQUÉE' : 'BLOQUÉE'}</span>}
    </article>
  );
}

export function PictogramNotice({ n }: { n: Notice }) {
  const { fmtDate } = useApp();
  return (
    <article className="cx-notice" aria-label="Avis MOSOLO à pictogrammes">
      <PrintLetterhead document="Avis MOSOLO" />
      <header className="cx-notice-head">
        <div><p className="eyebrow">Ville-Province de Kinshasa</p><h2>Avis MOSOLO</h2></div>
        <div className="cx-notice-holder"><strong>{n.holder.initials}</strong><span className="mono">{n.holder.iuc}</span>{n.holder.cardNumber && <span className="mono">Carte {n.holder.cardNumber}</span>}</div>
      </header>
      <section className="cx-notice-sec">
        <h3><Pictogram code="PAYER" size={30} /> Ce que vous devez</h3>
        {n.dues.length === 0 ? <p className="cx-notice-empty">{n.emptyMessage}</p> : (
          <ul className="cx-dues">{n.dues.map((d) => (
            <li key={d.obligationId}>
              <Pictogram code={d.pictogram} size={44} showLabel />
              <div className="cx-due-main"><MoneyText money={d.amount} showIndicative={false} className="cx-due-amount" /><span className="small">{d.revenue}</span>{d.activeReference && <span className="mono small">Réf. {d.activeReference}</span>}</div>
              <div className="cx-due-date"><Pictogram code="ECHEANCE" size={30} /><span>{fmtDate(d.dueDate)}</span></div>
            </li>
          ))}</ul>
        )}
      </section>
      <section className="cx-notice-sec">
        <h3><Pictogram code="LIEU_PAIEMENT" size={30} /> Où payer</h3>
        <ul className="cx-places">{n.paymentPlaces.slice(0, 4).map((p) => <li key={p.name}><strong>{p.name}</strong><span>{p.address}</span><span className="muted">{p.hours}</span></li>)}</ul>
      </section>
      <section className="cx-notice-actions">
        {n.actions.map((a) => <div key={a.pictogram} className="cx-notice-action"><Pictogram code={a.pictogram} size={38} showLabel /><p>{a.how}</p></div>)}
      </section>
      <footer className="cx-notice-warn">
        {n.warnings.map((w) => <p key={w.pictogram}><Pictogram code={w.pictogram} size={28} /> {w.text}</p>)}
        <p className="small">USSD {n.channels.ussd} · SVI {n.channels.ivr} · édité le {fmtDate(n.generatedAt, true)}</p>
      </footer>
      <PrintFooterMark />
    </article>
  );
}

export default function CardPrint() {
  const { number = '' } = useParams();
  const { user } = useApp();
  const card = useApi(() => api<CardView & { taxpayerId: string }>(`/v1/mosolo-cards/${encodeURIComponent(number)}`), [number, user?.id]);
  const tpId = card.data?.taxpayerId;
  const notice = useApi(tpId ? () => api<Notice>(`/v1/pictogram-notices/${tpId}`) : null, [tpId, user?.id]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const guichet = hasRole(user?.roles, 'R12');

  async function act(path: string, body: unknown, ok: string) {
    setErr(null); setMsg(null);
    try { await api(path, { method: 'POST', body }); setMsg(ok); card.reload(); } catch (e) { setErr(describeError(e).message); }
  }

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Carte MOSOLO — module 65" title="Carte et avis à imprimer" lead="La carte identifie la personne sans téléphone ; l’avis indique, en pictogrammes, ce qui est dû, l’échéance et les lieux de paiement.">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}><Icon name="download" size={18} /> Imprimer</button>
      </PageHead>
      <ExampleNotice text="Données fictives ; montants issus d’une règle de démonstration non opposable." />
      {card.loading && <Loading />}
      {card.error !== null && <ErrorState error={card.error} onRetry={card.reload} />}
      {card.data && (
        <div className="cx-print-grid">
          <div className="cx-print-area">
            <MosoloCardFace card={card.data} />
            {notice.data && <PictogramNotice n={notice.data} />}
            {notice.error !== null && <ErrorState error={notice.error} />}
          </div>
          <aside className="panel cx-noprint">
            <header className="panel-head"><h2 className="panel-title">État de la carte</h2><StatusBadge tone={STATUS[card.data.status]?.tone ?? 'neutral'} label={STATUS[card.data.status]?.label ?? card.data.status} /></header>
            <dl className="kv kv-dense">
              <div><dt>Numéro</dt><dd className="mono">{card.data.numberFormatted}</dd></div>
              {card.data.previousCardNumber && <div><dt>Remplace</dt><dd className="mono">{card.data.previousCardNumber}</dd></div>}
              {card.data.replacedByNumber && <div><dt>Remplacée par</dt><dd><Link to={`/canaux/carte/${card.data.replacedByNumber}`} className="mono">{card.data.replacedByNumber}</Link></dd></div>}
              <div><dt>Vérification</dt><dd><Link to={`/canaux/verifier-carte?t=${encodeURIComponent(card.data.qrToken)}`}>Vérifier le QR</Link></dd></div>
            </dl>
            <p className="small muted">{card.data.mention}</p>
            <div className="btn-row">
              {card.data.status === 'ACTIVE' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void act(`/v1/mosolo-cards/${card.data!.number}/block`, { reason: 'Perte ou vol déclaré au guichet' }, 'Carte bloquée immédiatement.')}><Icon name="lock" size={16} /> Bloquer (perte, vol)</button>}
              {guichet && card.data.status !== 'REVOQUEE' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { const motif = window.prompt('Motif de la réémission (10 caractères min.) :'); if (motif) void act(`/v1/mosolo-cards/${card.data!.number}/reissue-requests`, { motif }, 'Demande de réémission enregistrée : validation par une seconde personne requise.'); }}><Icon name="replace" size={16} /> Demander la réémission</button>}
              {guichet && card.data.status === 'ACTIVE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const pin = window.prompt('Code secret choisi par la personne (4 chiffres), saisi par elle-même :'); if (pin) void act(`/v1/mosolo-cards/${card.data!.number}/pin`, { pin }, 'Code secret activé (conservé uniquement sous forme d’empreinte).'); }}><Icon name="keypad" size={16} /> Activer le code secret USSD/SVI</button>}
            </div>
            {msg && <p className="notice notice-ok">{msg}</p>}
            {err && <p className="notice notice-err" role="alert">{err}</p>}
            {guichet && <ReissueQueue onDone={card.reload} />}
          </aside>
        </div>
      )}
      {card.data && (
        <div className="cx-noprint cx-mt">
          {notice.data && <AvisVisuel notice={notice.data} />}
          <IndicateursAgent>{(ind) => <ChartGrid min={280}><CartesEtat ind={ind} /></ChartGrid>}</IndicateursAgent>
        </div>
      )}
    </div>
  );
}

function ReissueQueue({ onDone }: { onDone: () => void }) {
  const { user } = useApp();
  const q = useApi(() => api<{ id: string; cardNumber: string; motif: string; requestedBy: string; status: string }[]>('/v1/mosolo-cards/reissue-requests'), [user?.id]);
  const [err, setErr] = useState<string | null>(null);
  const pending = (q.data ?? []).filter((r) => r.status === 'EN_ATTENTE');
  if (pending.length === 0) return null;
  return (
    <section className="cx-reissue">
      <h3 className="panel-title">Réémissions à valider (seconde personne)</h3>
      <ul className="list-rows compact-rows">{pending.map((r) => (
        <li key={r.id} className="list-row list-row-stack">
          <span className="small">••••{r.cardNumber.slice(-4)} · {r.motif} · demandée par {r.requestedBy}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={async () => {
            setErr(null);
            try { await api(`/v1/mosolo-cards/reissue-requests/${r.id}/approve`, { method: 'POST' }); q.reload(); onDone(); } catch (e) { setErr(describeError(e).message); }
          }}>Valider la réémission</button>
        </li>
      ))}</ul>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </section>
  );
}
