/**
 * Revue d'un jour de caisse d'un point agréé par le Trésor : clôture (comptage), versement déclaré (bordereau),
 * constatation au relevé du compte public — proposée par R17/R18, approuvée par un R17 distinct (quatre yeux),
 * ou appariée automatiquement à l'import du relevé quand bordereau, montants et comptes sont identiques.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { DAY_STATUS, hasRole, kinshasaToday } from './shared';
import './canaux.css';

type Line = { accountAlias: string; amount: MoneyJSON };
export interface BankMatch { statementId: string; valueDate: string; lines: Line[]; proposedBy: string; proposedAt: string; approvedBy?: string; approvedAt?: string; auto?: boolean }
export interface ReviewCashDay {
  pointId: string; day: string; status: string; expected: MoneyJSON[]; expectedByAccount: Line[]; counted: MoneyJSON[] | null; closedAt: string | null; depositDeadline: string;
  deposit: { bankSlipRef: string; lines: Line[]; depositedAt: string; declaredBy: string; declaredAt: string; bankMatch?: BankMatch } | null;
  collections: { id: string; paymentReference: string; amount: MoneyJSON; receiptStatus: string | null; orderStatus: string }[];
  reconciledCount: number; exceptions: { id: string; type: string; detail: string }[];
}

/** Règle affichée telle qu'appliquée par le serveur (canaux:point.decision.request / canaux:point.deposit.confirm). */
export const FOUR_EYES_RULE = 'Quatre yeux : la constatation au relevé est proposée par un membre du Trésor (R17 ou R18), puis approuvée par un R17 distinct du proposant et du déclarant du versement.';

/** Garde côté écran (le serveur refait tous les contrôles) : qui peut proposer, qui peut approuver, et pourquoi pas. */
export function bankMatchGuard(cd: ReviewCashDay, user: { id: string; roles: string[] } | null) {
  const bm = cd.deposit?.bankMatch;
  const canPropose = !!user && hasRole(user.roles, 'R17', 'R18') && !!cd.deposit && !bm;
  let approveBlock: string | null = null;
  if (!user || !hasRole(user.roles, 'R17')) approveBlock = 'Approbation réservée au Trésor (R17).';
  else if (!bm) approveBlock = 'Aucune constatation proposée.';
  else if (bm.approvedAt) approveBlock = 'Constatation déjà approuvée.';
  else if (user.id === bm.proposedBy) approveBlock = 'Vous avez proposé cette constatation : une autre personne doit l’approuver.';
  else if (user.id === cd.deposit!.declaredBy) approveBlock = 'Vous avez déclaré ce versement : une autre personne doit l’approuver.';
  return { canPropose, canApprove: approveBlock === null, approveBlock };
}

const money = (xs: MoneyJSON[]) => (xs.length ? xs.map((m) => <MoneyText key={m.currency} money={m} showIndicative={false} />) : '—');
const lineList = (xs: Line[]) => <ul className="cx-lines">{xs.map((l) => <li key={`${l.accountAlias}|${l.amount.currency}`}><span className="mono">{l.accountAlias}</span> <MoneyText money={l.amount} showIndicative={false} /></li>)}</ul>;

export function CashDayDetail({ cd, onPropose, onApprove, busy = false }: { cd: ReviewCashDay; onPropose: (statementId: string) => void; onApprove: () => void; busy?: boolean }) {
  const { user, fmtDate } = useApp();
  const [statementId, setStatementId] = useState('');
  const g = bankMatchGuard(cd, user);
  const bm = cd.deposit?.bankMatch;
  return (
    <>
      <div className="cx-cash-head">
        <StatusBadge tone={DAY_STATUS[cd.status]?.tone ?? 'info'} label={DAY_STATUS[cd.status]?.label ?? cd.status} />
        <span className="small">Attendu : {money(cd.expected)}</span>
        <span className="small muted">Versement au plus tard le {fmtDate(cd.depositDeadline, true)} · {cd.reconciledCount}/{cd.collections.length} encaissement(s) rapproché(s)</span>
      </div>
      {cd.exceptions.length > 0 && <ul className="cx-exc">{cd.exceptions.map((e) => <li key={e.id}><Icon name="alert" size={16} /> <strong>{e.type.replace(/_/g, ' ').toLowerCase()}</strong> — {e.detail}</li>)}</ul>}
      <div className="cx-two cx-mt">
        <section className="panel" aria-labelledby="cd-close">
          <h3 className="panel-title" id="cd-close"><Icon name="ledger" size={18} /> 1. Clôture de caisse</h3>
          {cd.closedAt ? (
            <dl className="cx-dl">
              <dt>Clôturée le</dt><dd>{fmtDate(cd.closedAt, true)}</dd>
              <dt>Espèces comptées</dt><dd>{money(cd.counted ?? [])}</dd>
              <dt>Attendu par compte public</dt><dd>{lineList(cd.expectedByAccount)}</dd>
            </dl>
          ) : <p className="small muted">Caisse non clôturée par l’opérateur du point.</p>}
        </section>
        <section className="panel" aria-labelledby="cd-dep">
          <h3 className="panel-title" id="cd-dep"><Icon name="upload" size={18} /> 2. Versement bancaire déclaré</h3>
          {cd.deposit ? (
            <dl className="cx-dl">
              <dt>Bordereau</dt><dd className="mono">{cd.deposit.bankSlipRef}</dd>
              <dt>Versé le</dt><dd>{fmtDate(cd.deposit.depositedAt, true)}</dd>
              <dt>Déclaré par</dt><dd>{cd.deposit.declaredBy} · {fmtDate(cd.deposit.declaredAt, true)}</dd>
              <dt>Lignes déclarées</dt><dd>{lineList(cd.deposit.lines)}</dd>
            </dl>
          ) : <p className="small muted">Aucun versement déclaré : rien à constater au relevé.</p>}
        </section>
      </div>
      <section className="panel cx-mt" aria-labelledby="cd-match">
        <h3 className="panel-title" id="cd-match"><Icon name="scale" size={18} /> 3. Constatation au relevé du compte public</h3>
        <p className="callout callout-info small" data-testid="four-eyes-rule"><Icon name="users" size={16} /> {FOUR_EYES_RULE} Un relevé importé dont la ligne porte le bordereau, avec montants et comptes identiques, est apparié automatiquement ; tout écart ouvre une exception dans la file du Trésor.</p>
        {bm ? (
          <dl className="cx-dl">
            <dt>Relevé</dt><dd className="mono">{bm.statementId} (valeur {bm.valueDate})</dd>
            <dt>Lignes créditées</dt><dd>{lineList(bm.lines)}</dd>
            <dt>{bm.auto ? 'Appariement' : 'Proposée par'}</dt><dd>{bm.auto ? `Automatique à l’import (relevé importé par ${bm.proposedBy})` : `${bm.proposedBy} · ${fmtDate(bm.proposedAt, true)}`}</dd>
            <dt>Approbation</dt><dd>{bm.approvedAt ? (bm.auto ? `Sans décision humaine (identité bordereau, montants, comptes) · ${fmtDate(bm.approvedAt, true)}` : `${bm.approvedBy} · ${fmtDate(bm.approvedAt, true)}`) : <StatusBadge tone="warning" label="En attente d’une seconde personne" />}</dd>
          </dl>
        ) : cd.deposit ? <p className="small muted">Aucune constatation proposée.</p> : null}
        {g.canPropose && (
          <form className="form cx-mt" onSubmit={(e) => { e.preventDefault(); if (statementId.trim()) onPropose(statementId.trim()); }}>
            <div className="field"><label className="label" htmlFor="cd-stmt">Identifiant du relevé importé portant le bordereau</label><input id="cd-stmt" className="mono" value={statementId} onChange={(e) => setStatementId(e.target.value)} /></div>
            <button type="submit" className="btn btn-secondary" disabled={busy || statementId.trim().length === 0}>Proposer la constatation</button>
          </form>
        )}
        {bm && !bm.approvedAt && (
          <div className="btn-row cx-mt">
            <button type="button" className="btn btn-primary" disabled={busy || !g.canApprove} onClick={onApprove}>Approuver (seconde personne)</button>
            {g.approveBlock && <span className="small muted" role="note">{g.approveBlock}</span>}
          </div>
        )}
      </section>
    </>
  );
}

export default function CashDayReview() {
  const { user } = useApp();
  const [params, setParams] = useSearchParams();
  const pointId = params.get('point') ?? '';
  const day = params.get('day') ?? kinshasaToday();
  const pts = useApi(() => api<{ points: { id: string; name: string }[] }>('/v1/payment-points'), [user?.id]);
  const cash = useApi(pointId ? () => api<ReviewCashDay>(`/v1/payment-points/${pointId}/cash-days/${day}`) : null, [user?.id, pointId, day]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = (p: string, d: string) => setParams({ ...(p ? { point: p } : {}), day: d });

  async function act(path: string, body: unknown, ok: string) {
    if (busy) return;
    setErr(null); setMsg(null); setBusy(true);
    try { await api(path, { method: 'POST', body }); setMsg(ok); cash.reload(); } catch (e) { setErr(describeError(e).message); } finally { setBusy(false); }
  }

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Trésor — points de paiement agréés" title="Jour de caisse d’un point agréé" lead="Clôture, versement bancaire déclaré et constatation au relevé du compte public. Le système apparie et signale ; le Trésor décide des écarts." />
      <ExampleNotice text="Données de démonstration : points, bordereaux, relevés et montants fictifs, sans valeur contractuelle." />
      {!hasRole(user?.roles, 'R17', 'R18', 'R22', 'R24') && <div className="callout callout-warn">Réservé au Trésor (R17), à l’analyste de rapprochement (R18), à l’audit (R22) et à l’enquête anti-fraude (R24).</div>}
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="cd-pt">Point de paiement</label>
          <select id="cd-pt" value={pointId} onChange={(e) => pick(e.target.value, day)}>
            <option value="">— Choisir un point —</option>
            {pts.data?.points.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
          </select></div>
        <div className="field"><label className="label" htmlFor="cd-day">Jour de caisse</label><input id="cd-day" type="date" value={day} onChange={(e) => pick(pointId, e.target.value)} /></div>
      </div>
      {msg && <p className="notice notice-ok">{msg}</p>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {!pointId && <EmptyState title="Choisissez un point et un jour de caisse" icon="store" />}
      {cash.loading && <Loading />}
      {cash.error !== null && <ErrorState error={cash.error} onRetry={cash.reload} />}
      {cash.data && (
        <CashDayDetail
          cd={cash.data} busy={busy}
          onPropose={(statementId) => void act(`/v1/payment-points/${pointId}/cash-days/${day}/bank-match`, { statementId }, 'Constatation proposée : approbation par une seconde personne (R17) requise.')}
          onApprove={() => void act(`/v1/payment-points/${pointId}/cash-days/${day}/bank-match/approve`, {}, 'Constatation approuvée et journalisée.')}
        />
      )}
    </div>
  );
}
