/**
 * Exonérations et remises : demande du contribuable (pièces, durée) ; file de validation des agents —
 * instruction avec base légale obligatoire (instrument du registre), visa juridique, décision : deux validations
 * par des personnes distinctes. Jamais décidée par l'IA ; jamais rétroactive sans décision expresse.
 */
import { useState, type FormEvent } from 'react';
import { formatMoney } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { DemoNote, FiscalTabs, ReasonAction, useViewer } from './common';
import type { Exemption, FiscalObjectView, Reference } from './types';
import './fiscal.css';
import { RegistreExonerations } from './RegistreExonerations';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  DEMANDEE: { label: 'Demandée — à instruire', tone: 'neutral' }, INSTRUITE: { label: 'Instruite — visa juridique attendu', tone: 'info' },
  VISA_JURIDIQUE: { label: 'Visa juridique — décision attendue', tone: 'warning' }, APPROUVEE: { label: 'Approuvée', tone: 'good' },
  REFUSEE: { label: 'Refusée', tone: 'critical' }, REVOQUEE: { label: 'Révoquée', tone: 'serious' }, EXPIREE: { label: 'Expirée', tone: 'neutral' },
};
const STEP: Record<string, string> = { INSTRUCTION: 'Instruction (agent de régie)', VISA_JURIDIQUE: 'Visa juridique (juriste)', DECISION: 'Décision (chef de service / direction)', REVOCATION: 'Révocation' };

function Steps({ x }: { x: Exemption }) {
  const { fmtDate } = useApp();
  return (
    <ol className="fs-steps">
      <li className="done"><span className="fs-step-dot" aria-hidden="true" /><div><p className="small"><strong>Demande</strong> — {x.requestedBy} · {fmtDate(x.requestedAt, true)}</p></div></li>
      {x.steps.map((s, i) => (
        <li key={i} className={s.decision === 'FAVORABLE' ? 'done' : 'ko'}>
          <span className="fs-step-dot" aria-hidden="true" />
          <div><p className="small"><strong>{STEP[s.step] ?? s.step}</strong> — {s.decision === 'FAVORABLE' ? 'favorable' : 'défavorable'} · {s.userId} · {fmtDate(s.at, true)}</p><p className="small muted">{s.reason}</p></div>
        </li>
      ))}
    </ol>
  );
}

function ExemptionCard({ x, refData, onChanged }: { x: Exemption; refData: Reference | null; onChanged: () => void }) {
  const { fmtDate } = useApp();
  const { has } = useViewer();
  const st = STATUS[x.effectiveStatus] ?? STATUS[x.status] ?? { label: x.status, tone: 'neutral' as Tone };
  const [basis, setBasis] = useState({ instrumentId: x.legalBasis?.instrumentId ?? refData?.legalBases[0]?.id ?? '', article: x.legalBasis?.article ?? '' });
  const [retro, setRetro] = useState({ ref: '', reason: '' });
  const today = new Date().toISOString().slice(0, 10);
  const post = (path: string, body: unknown) => api(`/v1/fiscal/exemptions/${encodeURIComponent(x.id)}/${path}`, { method: 'POST', body }).then(onChanged);
  return (
    <article className="panel fs-exo">
      <div className="panel-head">
        <div>
          <p className="panel-title">{x.kind === 'REMISE' ? 'Remise' : 'Exonération'} <span className="mono small">{x.id}</span></p>
          <p className="panel-sub">{x.taxpayerName ? `${x.taxpayerName} · ` : ''}{x.kind === 'REMISE' ? `Obligation ${x.obligationId} — ${x.amount ? formatMoney(x.amount) : ''}` : `${x.rate} % · ${x.ruleCode ?? x.revenueCategory ?? ''}${x.objectId ? ` · objet ${x.objectId}` : ''}`}</p>
        </div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <dl className="kv kv-dense">
        <div><dt>Motif</dt><dd>{x.grounds}</dd></div>
        <div><dt>Pièces</dt><dd>{x.proofs.map((p) => `${p.type} — ${p.reference}`).join(' ; ')}</dd></div>
        <div><dt>Base légale</dt><dd>{x.legalBasis ? <>{x.legalBasis.title}, {x.legalBasis.article}{x.legalBasis.demo && <span className="tag fs-tag-demo">Instrument fictif</span>}</> : <span className="muted">À établir à l’instruction — aucune exonération sans base légale.</span>}</dd></div>
        <div><dt>Effet</dt><dd>du {fmtDate(x.validFrom)}{x.validTo ? ` au ${fmtDate(x.validTo)}` : ''}{x.retroactivity && <> — rétroactivité décidée : {x.retroactivity.decisionReference}</>}{(x.effectiveStatus === 'APPROUVEE' || x.effectiveStatus === 'EXPIREE' || x.effectiveStatus === 'REVOQUEE') && <> <ValidityCountdown compact from={x.validFrom} until={x.validTo} blocked={x.effectiveStatus === 'REVOQUEE' ? 'Révoquée' : null} /></>}</dd></div>
        {x.rectifiedObligationId && <div><dt>Obligation rectifiée</dt><dd className="mono">{x.rectifiedObligationId}</dd></div>}
      </dl>
      <Steps x={x} />
      <div className="row-actions fs-exo-actions">
        {x.status === 'DEMANDEE' && has('R11', 'R12') && refData && (
          <ReasonAction label="Instruire" confirmLabel="Transmettre au juriste" onSubmit={(reason) => post('instruction', { decision: 'FAVORABLE', reason, ...(basis.instrumentId && basis.article ? { legalBasis: basis } : {}) })}>
            <div className="field-row">
              <div className="field"><label className="label" htmlFor={`lb-${x.id}`}>Instrument du registre</label>
                <select id={`lb-${x.id}`} value={basis.instrumentId} onChange={(e) => setBasis({ ...basis, instrumentId: e.target.value })}>
                  {refData.legalBases.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
                </select></div>
              <div className="field"><label className="label" htmlFor={`la-${x.id}`}>Article</label><input id={`la-${x.id}`} value={basis.article} onChange={(e) => setBasis({ ...basis, article: e.target.value })} required /></div>
            </div>
          </ReasonAction>
        )}
        {x.status === 'DEMANDEE' && has('R11', 'R12') && <ReasonAction label="Avis défavorable" confirmLabel="Refuser à l’instruction" tone="secondary" onSubmit={(reason) => post('instruction', { decision: 'DEFAVORABLE', reason })} />}
        {x.status === 'INSTRUITE' && has('R13', 'R14') && <>
          <ReasonAction label="Viser (fondement vérifié)" confirmLabel="Donner le visa juridique" onSubmit={(reason) => post('legal-visa', { decision: 'FAVORABLE', reason })} />
          <ReasonAction label="Visa défavorable" confirmLabel="Refuser le visa" tone="secondary" onSubmit={(reason) => post('legal-visa', { decision: 'DEFAVORABLE', reason })} />
        </>}
        {x.status === 'VISA_JURIDIQUE' && has('R06', 'R07') && <>
          <ReasonAction label="Approuver" confirmLabel="Approuver (seconde validation)"
            onSubmit={(reason) => post('decision', { decision: 'APPROUVEE', reason, ...(x.validFrom < today && retro.ref ? { retroactivity: { decisionReference: retro.ref, reason: retro.reason || reason } } : {}) })}>
            {x.validFrom < today && (
              <div className="callout callout-warn"><Icon name="alert" size={16} /><div className="field">
                <label className="label" htmlFor={`rt-${x.id}`}>Effet antérieur à la décision : référence de la décision de rétroactivité</label>
                <input id={`rt-${x.id}`} value={retro.ref} onChange={(e) => setRetro({ ...retro, ref: e.target.value })} placeholder="Sans décision expresse, l’approbation est refusée" />
              </div></div>
            )}
          </ReasonAction>
          <ReasonAction label="Refuser" confirmLabel="Refuser" tone="secondary" onSubmit={(reason) => post('decision', { decision: 'REFUSEE', reason })} />
        </>}
        {x.status === 'APPROUVEE' && x.effectiveStatus === 'APPROUVEE' && has('R06', 'R07') && <ReasonAction label="Révoquer" confirmLabel="Révoquer (effet à compter d’aujourd’hui)" tone="secondary" onSubmit={(reason) => post('revoke', { reason })} />}
      </div>
    </article>
  );
}

function RequestForm({ objects, onDone }: { objects: FiscalObjectView[]; onDone: () => void }) {
  const year = new Date().getFullYear();
  const [v, setV] = useState({ objectId: objects[0]?.id ?? '', ruleCode: 'DEMO-IF-BATI', rate: '100', grounds: '', proofType: 'ATTESTATION', proofRef: '', validFrom: `${year + 1}-01-01`, validTo: `${year + 1}-12-31` });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const r = await api<Exemption>('/v1/fiscal/exemptions', { method: 'POST', body: {
        kind: 'EXONERATION', ...(v.objectId ? { objectId: v.objectId } : {}), ruleCode: v.ruleCode.trim(), rate: v.rate, grounds: v.grounds.trim(),
        proofs: [{ type: v.proofType.trim(), reference: v.proofRef.trim() }], validFrom: v.validFrom, validTo: v.validTo,
      } });
      setMsg({ ok: true, text: `Demande ${r.id} enregistrée. Elle sera instruite (base légale), visée par un juriste puis décidée par une autre personne.` });
      onDone();
    } catch (x) { setMsg({ ok: false, text: describeError(x).message }); } finally { setBusy(false); }
  }
  return (
    <form className="form" onSubmit={(e) => void go(e)}>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="rq-obj">Bien concerné</label>
          <select id="rq-obj" value={v.objectId} onChange={(e) => setV({ ...v, objectId: e.target.value })}>
            {objects.map((o) => <option key={o.id} value={o.id}>{o.categoryLabel} — {o.igf?.code ?? o.id}</option>)}
          </select></div>
        <div className="field"><label className="label" htmlFor="rq-rule">Recette visée (code de règle)</label><input id="rq-rule" className="mono" value={v.ruleCode} onChange={(e) => setV({ ...v, ruleCode: e.target.value })} required /></div>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="rq-rate">Taux demandé (%)</label><input id="rq-rate" inputMode="decimal" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} required pattern="^\d{1,3}(\.\d{1,2})?$" /></div>
        <div className="field"><label className="label" htmlFor="rq-from">Du</label><input id="rq-from" type="date" value={v.validFrom} onChange={(e) => setV({ ...v, validFrom: e.target.value })} required /></div>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="rq-to">Au (durée obligatoire)</label><input id="rq-to" type="date" value={v.validTo} onChange={(e) => setV({ ...v, validTo: e.target.value })} required /></div>
        <div className="field"><label className="label" htmlFor="rq-pr">Pièce justificative (référence)</label><input id="rq-pr" value={v.proofRef} onChange={(e) => setV({ ...v, proofRef: e.target.value })} required minLength={3} /></div>
      </div>
      <div className="field"><label className="label" htmlFor="rq-gr">Motif de la demande</label><textarea id="rq-gr" rows={3} value={v.grounds} onChange={(e) => setV({ ...v, grounds: e.target.value })} required minLength={10} /></div>
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Envoi…' : 'Demander l’exonération'}</button>
    </form>
  );
}

export default function Exonerations() {
  const { user } = useApp();
  const { isTaxpayer, has } = useViewer();
  const agent = has('R06', 'R07', 'R11', 'R12', 'R13', 'R14', 'R22', 'R24');
  const list = useApi(user && (isTaxpayer || agent) ? () => api<{ items: Exemption[]; alerts: { message: string; key: string }[] }>('/v1/fiscal/exemptions') : null, [user?.id]);
  const refData = useApi(() => api<Reference>('/v1/fiscal/reference'), []);
  const objs = useApi(isTaxpayer ? () => api<FiscalObjectView[]>('/v1/fiscal/objects') : null, [user?.id]);
  const [filter, setFilter] = useState<'A_TRAITER' | 'TOUTES'>('A_TRAITER');
  const items = (list.data?.items ?? []).slice().reverse();
  const shown = isTaxpayer || filter === 'TOUTES' ? items : items.filter((x) => ['DEMANDEE', 'INSTRUITE', 'VISA_JURIDIQUE'].includes(x.status));

  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Démarches fiscales" title={isTaxpayer ? 'Demande d’exonération' : 'Registre des exonérations et remises'}
        lead="Chaque exonération a une base légale (instrument en vigueur du registre juridique), des pièces, une durée et deux validations par des personnes distinctes. Elle n’est jamais décidée par l’IA et ne rétroagit jamais sans décision expresse." />
      <FiscalTabs />
      <DemoNote />
      {!isTaxpayer && !agent && <EmptyState title="Réservé aux contribuables et aux agents habilités." icon="lock" />}
      {isTaxpayer && (
        <section className="section panel">
          <div className="panel-head"><p className="panel-title"><Icon name="scale" size={18} /> Nouvelle demande</p></div>
          {objs.data ? <RequestForm objects={objs.data.filter((o) => o.holder && o.holder !== 'autre')} onDone={list.reload} /> : <Loading />}
        </section>
      )}
      {!isTaxpayer && agent && <RegistreExonerations />}
      {!isTaxpayer && list.data && list.data.alerts.length > 0 && (
        <div className="callout callout-warn" role="note"><Icon name="alert" size={18} /><div>{list.data.alerts.map((a) => <p key={a.key}>{a.message}</p>)}<p className="small muted">Alerte de concentration : proposition d’examen pour l’audit, aucune mesure automatique.</p></div></div>
      )}
      {(isTaxpayer || agent) && (
        <section className="section">
          <div className="section-head">
            <h2>{isTaxpayer ? 'Mes demandes' : 'File de validation'}</h2><span className="count">{shown.length}</span>
            {!isTaxpayer && (
              <div className="seg seg-sm" role="group" aria-label="Filtre">
                <button type="button" aria-pressed={filter === 'A_TRAITER'} onClick={() => setFilter('A_TRAITER')}>À traiter</button>
                <button type="button" aria-pressed={filter === 'TOUTES'} onClick={() => setFilter('TOUTES')}>Toutes</button>
              </div>
            )}
          </div>
          {list.loading && <Loading />}
          {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
          {!list.loading && shown.length === 0 && <EmptyState title="Aucune demande." />}
          <div className="fs-grid">{shown.map((x) => <ExemptionCard key={x.id} x={x} refData={refData.data} onChanged={list.reload} />)}</div>
        </section>
      )}
    </div>
  );
}
