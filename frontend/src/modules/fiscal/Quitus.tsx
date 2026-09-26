/**
 * Quitus fiscal numérique : conditions examinées par le serveur, demande, affichage avec QR de vérification
 * publique (sans donnée sensible), validité limitée, révocation motivée ; vérification par les services (R37).
 * Quitus INFORMATIF tant que l'acte de conditionnalité n'est pas certifié (J6).
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, ApiError, describeError } from '../../lib/api';
import { DemoNote, FiscalTabs, ReasonAction, useViewer, VerifyQr } from './common';
import type { Clearance, Eligibility } from './types';
import './fiscal.css';
import { PrintProofLink } from '../preuves/PrintLink';

export const CLEARANCE_CHECK: Record<string, { label: string; tone: Tone; icon: string }> = {
  VALIDE: { label: 'Valide', tone: 'good', icon: 'check' },
  BIENTOT_EXPIRE: { label: 'Valide — expire bientôt', tone: 'warning', icon: 'clock' },
  CRITIQUE: { label: 'Valide — expire très bientôt', tone: 'critical', icon: 'alert' },
  EXPIRE: { label: 'Expiré', tone: 'critical', icon: 'x' },
  REVOQUE: { label: 'Révoqué', tone: 'critical', icon: 'ban' },
  SIGNATURE_INVALIDE: { label: 'Signature invalide', tone: 'serious', icon: 'alert' },
  INCONNU: { label: 'Inconnu', tone: 'neutral', icon: 'question' },
};
const BLOCKER: Record<string, string> = {
  IMPAYEE: 'Obligation exigible impayée',
  EN_ATTENTE_DE_RAPPROCHEMENT: 'Paiement confirmé, en attente de rapprochement (quittance provisoire insuffisante)',
  CONTESTEE_SANS_EFFET_SUSPENSIF: 'Contestée, effet suspensif refusé',
};

function ClearanceCard({ c, canRevoke, onChanged }: { c: Clearance; canRevoke: boolean; onChanged: () => void }) {
  const { fmtDate } = useApp();
  const st = CLEARANCE_CHECK[c.check] ?? CLEARANCE_CHECK.INCONNU!;
  return (
    <article className="panel fs-quitus">
      <div className="fs-quitus-doc">
        <div className="min0">
          <p className="eyebrow">Ville-Province de Kinshasa — Quitus fiscal numérique</p>
          <h3 className="fs-igf mono">{c.number}</h3>
          <StatusBadge tone={st.tone} icon={st.icon} label={st.label} />
          <dl className="kv kv-dense">
            <div><dt>Délivré le</dt><dd>{fmtDate(c.issuedAt, true)}</dd></div>
            <div><dt>Valide jusqu’au</dt><dd><strong>{fmtDate(c.validUntil)}</strong></dd></div>
            <div><dt>Obligations examinées</dt><dd>{c.basis.obligationsExamined} — soldées sur quittance définitive : {c.basis.settledOnDefinitiveReceipt.length} · non encore exigibles : {c.basis.notYetDue.length} · contestées (recours en cours) : {c.basis.contestedExcluded.length}</dd></div>
            <div><dt>Niveau de vérification</dt><dd>{c.verificationLevel}</dd></div>
            {c.revocation && <div><dt>Révocation</dt><dd>{fmtDate(c.revocation.at, true)} — {c.revocation.reason}</dd></div>}
          </dl>
          <ValidityCountdown from={c.validFrom} until={c.validUntil} blocked={c.check === 'REVOQUE' || c.status === 'REVOQUE' ? 'Quitus révoqué' : null} label="Validité du quitus" />
        </div>
        <div className="stack-sm"><VerifyQr path={c.verifyPath} code={c.shortCodeDisplay} caption={c.number} size={128} />{c.status === 'ACTIF' && <PrintProofLink code={c.shortCode} label="Imprimer le quitus" />}</div>
      </div>
      <p className="small muted">{c.notice}</p>
      {canRevoke && c.status === 'ACTIF' && (
        <ReasonAction label="Révoquer" confirmLabel="Révoquer ce quitus" tone="secondary" onSubmit={(reason) => api(`/v1/fiscal/clearances/${encodeURIComponent(c.id)}/revoke`, { method: 'POST', body: { reason } }).then(onChanged)} />
      )}
    </article>
  );
}

function TaxpayerQuitus() {
  const { user } = useApp();
  const elig = useApi(() => api<Eligibility>('/v1/fiscal/clearances/eligibility'), [user?.id]);
  const list = useApi(() => api<Clearance[]>('/v1/fiscal/clearances'), [user?.id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function request() {
    setBusy(true); setErr(null);
    try { await api('/v1/fiscal/clearances', { method: 'POST', body: {} }); list.reload(); elig.reload(); }
    catch (x) { setErr(x instanceof ApiError && x.code === 'CLEARANCE_NOT_ELIGIBLE' ? 'Quitus impossible : régularisez d’abord les obligations listées ci-dessus.' : describeError(x).message); }
    finally { setBusy(false); }
  }
  const e = elig.data;
  const current = (list.data ?? []).find((c) => c.status === 'ACTIF' && c.check !== 'EXPIRE');
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head"><div><p className="panel-title"><Icon name="shieldCheck" size={18} /> Conditions de délivrance</p><p className="panel-sub">Examinées par le serveur à l’instant de la demande.</p></div>
          {e && <StatusBadge tone={e.eligible ? 'good' : 'critical'} label={e.eligible ? 'Conditions réunies' : 'Conditions non réunies'} />}</div>
        {elig.loading && <Loading />}
        {elig.error !== null && <ErrorState error={elig.error} onRetry={elig.reload} />}
        {e && (
          <>
            {e.blockers.length > 0 && (
              <ul className="list-rows compact-rows">
                {e.blockers.map((b) => <li key={b.obligationId} className="list-row"><div><p className="row-title">{b.label}</p><p className="small muted mono">{b.obligationId} · échéance {b.dueDate}</p></div><StatusBadge tone="critical" label={BLOCKER[b.reason] ?? b.reason} /></li>)}
              </ul>
            )}
            {e.blockers.length > 0 && <p className="small"><Link to="/espace">Régulariser dans mon espace</Link> — ou contester : un recours en cours suspend l’effet bloquant.</p>}
            {e.levelNote && <p className="small muted">{e.levelNote}</p>}
            <p className="callout callout-info"><Icon name="info" size={16} /><span>{e.notice}</span></p>
            {!current && <button type="button" className="btn btn-primary" onClick={() => void request()} disabled={busy || !e.eligible}>{busy ? 'Délivrance…' : 'Obtenir mon quitus fiscal'}</button>}
            {err && <p className="notice notice-err" role="alert">{err}</p>}
          </>
        )}
      </section>
      {list.loading && <Loading />}
      {(list.data ?? []).length === 0 && !list.loading && <EmptyState title="Aucun quitus délivré." icon="shieldCheck" />}
      <div className="fs-grid">{(list.data ?? []).map((c) => <ClearanceCard key={c.id} c={c} canRevoke={false} onChanged={list.reload} />)}</div>
    </div>
  );
}

function ServiceCheck() {
  const [code, setCode] = useState('');
  const [res, setRes] = useState<{ valid: boolean; result: string; number?: string; validFrom?: string; validUntil?: string; taxpayerRef?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null); setRes(null);
    try { setRes(await api(`/v1/fiscal/clearances/verify/${encodeURIComponent(code.trim())}`)); } catch (x) { setErr(describeError(x).message); }
  }
  const st = res ? CLEARANCE_CHECK[res.result] ?? CLEARANCE_CHECK.INCONNU! : null;
  return (
    <section className="panel">
      <div className="panel-head"><div><p className="panel-title"><Icon name="building" size={18} /> Vérification par un service (API R37)</p><p className="panel-sub">Réponse oui / non et validité ; le contribuable est informé de chaque vérification.</p></div></div>
      <form className="input-row" onSubmit={(e) => void go(e)}>
        <input aria-label="Code du quitus" className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-X" />
        <button type="submit" className="btn btn-primary" disabled={!code.trim()}>Vérifier</button>
      </form>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {res && st && (
        <div className={`verdict verdict-${st.tone}`}>
          <div className="verdict-icon"><Icon name={st.icon} size={36} /></div>
          <p className="verdict-title">{res.valid ? 'Quitus valide' : 'Quitus non valide'}</p>
          {res.number && <p className="small">{res.number} · jusqu’au {res.validUntil} · contribuable {res.taxpayerRef}</p>}
          {res.validUntil && res.result !== 'SIGNATURE_INVALIDE' && <ValidityCountdown from={res.validFrom} until={res.validUntil} blocked={res.result === 'REVOQUE' ? 'Quitus révoqué' : null} label="Validité du quitus" />}
        </div>
      )}
    </section>
  );
}

function Review() {
  const q = useApi(() => api<{ clearanceId: string; number: string; taxpayerId: string; blockers: { obligationId: string; reason: string }[]; proposal: string }[]>('/v1/fiscal/clearances/review'), []);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const rows = q.data ?? [];
  return (
    <section className="panel">
      <div className="panel-head"><div><p className="panel-title">Revue des quitus actifs</p><p className="panel-sub">Le système PROPOSE ; une personne habilitée décide avec motif. Aucune révocation automatique.</p></div><span className="count">{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState title="Tous les quitus actifs remplissent encore leurs conditions." /> : (
        <ul className="list-rows">
          {rows.map((r) => (
            <li key={r.clearanceId} className="list-row">
              <div><p className="row-title mono">{r.number}</p><p className="small muted">{r.taxpayerId} · {r.blockers.map((b) => `${b.obligationId} (${BLOCKER[b.reason] ?? b.reason})`).join(' ; ')}</p></div>
              <ReasonAction label="Révoquer" confirmLabel="Révoquer ce quitus" tone="secondary" onSubmit={(reason) => api(`/v1/fiscal/clearances/${encodeURIComponent(r.clearanceId)}/revoke`, { method: 'POST', body: { reason } }).then(q.reload)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function Quitus() {
  const { user } = useApp();
  const { isTaxpayer, has } = useViewer();
  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Démarches fiscales" title="Quitus fiscal numérique"
        lead="Délivré lorsqu’aucune obligation exigible n’est impayée (les obligations en recours sont exclues), sur quittances définitives uniquement. Validité limitée, vérifiable par QR sans donnée sensible, révocable par décision motivée." />
      <FiscalTabs />
      <DemoNote />
      {!user && <EmptyState title="Choisissez un utilisateur de démonstration." icon="user" />}
      {isTaxpayer && <TaxpayerQuitus />}
      {has('R37') && <ServiceCheck />}
      {has('R06', 'R07') && <Review />}
      <p className="small fs-public-link"><Icon name="shieldCheck" size={16} /> Vérification publique : <Link to="/fiscal/verifier/quitus">vérifier un quitus</Link></p>
    </div>
  );
}
