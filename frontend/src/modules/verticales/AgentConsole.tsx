import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AssistedPay } from '../../components/AssistedPay';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { MoneyText } from '../../components/MoneyText';
import { OverduePenalties, type OverduePenaltiesData } from '../../components/OverduePenalties';
import { DataTable } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { CASE_TONE, fetchCatalogue, OBLIGATION_LABEL, TITLE_LABEL, TITLE_TONE, verifyPath, type AviaDeclaration, type CaseView, type VObligation } from '../../verticals/catalogue';
import './verticales.css';

type Tab = 'demarches' | 'plaques' | 'avia' | 'telecom' | 'indicateurs';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'demarches', label: 'Démarches', icon: 'file' },
  { id: 'plaques', label: 'Plaques', icon: 'qr' },
  { id: 'avia', label: 'AVIA', icon: 'plane' },
  { id: 'telecom', label: 'Télécom', icon: 'antenna' },
  { id: 'indicateurs', label: 'Indicateurs', icon: 'chart' },
];

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true); setError(null); setOk(null);
    try { const r = await fn(); if (success) setOk(success); return r; } catch (e) { setError(describeError(e).message); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, ok, run };
}

function Feedback({ a }: { a: { error: string | null; ok: string | null } }) {
  return <>{a.error && <p className="notice notice-err" role="alert">{a.error}</p>}{a.ok && <p className="notice notice-ok" role="status">{a.ok}</p>}</>;
}

// ------------------------------------------------------------------------------------------------ démarches

function CaseDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<CaseView>(`/v1/verticales/cases/${encodeURIComponent(id)}`), [id]);
  const a = useAction();
  const [note, setNote] = useState('');
  const [visit, setVisit] = useState({ date: new Date().toISOString().slice(0, 10), result: 'CONFORME', observations: '' });
  const [proposal, setProposal] = useState({ outcome: 'ACCEPTER', reason: '' });
  const [decision, setDecision] = useState({ decision: 'ACCEPTE', reason: '' });
  const [liq, setLiq] = useState<VObligation | null>(null);
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const c = q.data;
  const roles = user?.roles ?? [];
  const canInstruct = roles.some((r) => ['R11', 'R07', 'R24'].includes(r));
  const canVisit = roles.some((r) => ['R10', 'R11'].includes(r));
  const canDecide = roles.some((r) => ['R07', 'R06', 'R22'].includes(r));
  const post = (path: string, body: unknown, msg: string) => a.run(async () => { await api(`/v1/verticales/cases/${c.id}/${path}`, { method: 'POST', body }); q.reload(); onChanged(); }, msg);
  const objectId = c.createdObjectId ?? c.objectId;

  return (
    <div className="stack">
      <div className="row-between"><StatusBadge tone={CASE_TONE[c.status] ?? 'neutral'} label={c.statusLabel} /><span className="mono small muted">{c.id}</span></div>
      {c.masked && <p className="notice">Accès minimal : détails et identité du demandeur masqués.</p>}
      <dl className="kv kv-dense">
        <div><dt>Démarche</dt><dd>{c.typeLabel}</dd></div>
        <div><dt>Verticale</dt><dd>{c.vertical}</dd></div>
        {c.commune && <div><dt>Commune</dt><dd>{c.commune}</dd></div>}
        {c.objectId && <div><dt>Objet</dt><dd className="mono">{c.objectId}</dd></div>}
        {c.taxpayerId && <div><dt>Demandeur</dt><dd className="mono">{c.taxpayerId}</dd></div>}
        {c.protectedReport && <div><dt>Signalement</dt><dd>Protégé — identité du déclarant masquée</dd></div>}
        {Object.entries(c.details).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {c.documents.length > 0 && (
        <section><h3 className="panel-title">Pièces (empreintes)</h3>
          <ul className="plain-list small">{c.documents.map((d) => <li key={d.sha256}>{d.label} — <span className="mono">{d.sha256.slice(0, 20)}…</span> · {fmtDate(d.addedAt, true)}</li>)}</ul>
        </section>
      )}
      {c.visits.length > 0 && (
        <section><h3 className="panel-title">Visites</h3>
          <ul className="plain-list small">{c.visits.map((v) => <li key={v.id}>{fmtDate(v.date)} — <strong>{v.result}</strong> — {v.observations} <span className="muted">({v.by})</span></li>)}</ul>
        </section>
      )}
      {c.conditions && c.conditions.length > 0 && (
        <section><h3 className="panel-title">Conditions vérifiées par le système</h3>
          <ul className="vxc-conds">{c.conditions.map((x) => <li key={x.code}><Icon name={x.met ? 'check' : 'x'} size={16} className={x.met ? 'ok' : 'ko'} /> {x.label}</li>)}</ul>
          <p className="hint">Le système constate ; la décision appartient à une personne habilitée, distincte de l’instructeur.</p>
        </section>
      )}
      <ol className="vx-timeline">{c.history.map((h, i) => <li key={i}><span className="small muted">{fmtDate(h.at, true)}</span> <strong>{h.action}</strong> <span className="small muted">par {h.by}</span>{h.note ? <span className="small"> — {h.note}</span> : null}</li>)}</ol>
      {c.certificateCode && <p className="small"><Icon name="shieldCheck" size={14} /> Titre délivré : <Link className="mono" to={verifyPath(c.certificateCode)}>{c.certificateCode}</Link></p>}

      <Feedback a={a} />

      {c.status === 'DEPOSE' && canInstruct && (
        <div className="vxc-actions"><h3>Instruction</h3><button type="button" className="btn btn-primary" disabled={a.busy} onClick={() => void post('take', undefined, 'Dossier pris en charge.')}>Prendre en charge</button></div>
      )}
      {['EN_INSTRUCTION', 'COMPLEMENT_DEMANDE'].includes(c.status) && canVisit && (
        <form className="vxc-actions" onSubmit={(e: FormEvent) => { e.preventDefault(); void post('visits', visit, 'Visite consignée.'); }}>
          <h3>Consigner une visite (constat)</h3>
          <div className="field-row">
            <label className="field"><span className="label">Date</span><input type="date" value={visit.date} onChange={(e) => setVisit({ ...visit, date: e.target.value })} /></label>
            <label className="field"><span className="label">Constat</span><select value={visit.result} onChange={(e) => setVisit({ ...visit, result: e.target.value })}><option value="CONFORME">Conforme</option><option value="NON_CONFORME">Non conforme</option><option value="A_REVOIR">À revoir</option></select></label>
          </div>
          <label className="field"><span className="label">Observations</span><textarea rows={2} value={visit.observations} onChange={(e) => setVisit({ ...visit, observations: e.target.value })} /></label>
          <button type="submit" className="btn btn-secondary" disabled={a.busy || visit.observations.trim().length < 5}>Consigner</button>
        </form>
      )}
      {c.status === 'EN_INSTRUCTION' && canInstruct && c.instructorId === user?.id && (
        <>
          <form className="vxc-actions" onSubmit={(e: FormEvent) => { e.preventDefault(); void post('request-info', { note }, 'Complément demandé au demandeur.'); }}>
            <h3>Demander un complément</h3>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pièce ou précision attendue" />
            <button type="submit" className="btn btn-secondary" disabled={a.busy || note.trim().length < 5}>Demander</button>
          </form>
          <form className="vxc-actions" onSubmit={(e: FormEvent) => { e.preventDefault(); void post('propose', proposal, 'Proposition transmise pour décision.'); }}>
            <h3>Proposer une décision</h3>
            <div className="seg" role="group" aria-label="Proposition">
              <button type="button" aria-pressed={proposal.outcome === 'ACCEPTER'} onClick={() => setProposal({ ...proposal, outcome: 'ACCEPTER' })}>Accepter</button>
              <button type="button" aria-pressed={proposal.outcome === 'REFUSER'} onClick={() => setProposal({ ...proposal, outcome: 'REFUSER' })}>Refuser</button>
            </div>
            <textarea rows={2} value={proposal.reason} onChange={(e) => setProposal({ ...proposal, reason: e.target.value })} placeholder="Motif de la proposition" aria-label="Motif" />
            <button type="submit" className="btn btn-primary" disabled={a.busy || proposal.reason.trim().length < 5}>Proposer</button>
          </form>
        </>
      )}
      {c.status === 'PROPOSE' && canDecide && (
        <form className="vxc-actions" onSubmit={(e: FormEvent) => { e.preventDefault(); void post('decide', decision, 'Décision enregistrée et notifiée.'); }}>
          <h3>Décider (motif obligatoire)</h3>
          {c.proposal && <p className="small">Proposition de l’instructeur : <strong>{c.proposal.outcome === 'ACCEPTER' ? 'accepter' : 'refuser'}</strong> — {c.proposal.reason}</p>}
          <div className="seg" role="group" aria-label="Décision">
            <button type="button" aria-pressed={decision.decision === 'ACCEPTE'} onClick={() => setDecision({ ...decision, decision: 'ACCEPTE' })}>Accepter</button>
            <button type="button" aria-pressed={decision.decision === 'REFUSE'} onClick={() => setDecision({ ...decision, decision: 'REFUSE' })}>Refuser</button>
          </div>
          <textarea rows={2} value={decision.reason} onChange={(e) => setDecision({ ...decision, reason: e.target.value })} placeholder="Motif de la décision (notifié, recours ouvert)" aria-label="Motif de la décision" />
          <button type="submit" className="btn btn-primary" disabled={a.busy || decision.reason.trim().length < 5}>Décider</button>
        </form>
      )}
      {c.status === 'ACCEPTE' && objectId && canInstruct && (
        <div className="vxc-actions">
          <h3>Liquidation sur la règle du registre</h3>
          <p className="small muted">Possible seulement si une règle ACTIVE existe pour ce service ; refusée et journalisée sinon. Aucune double facturation d’un même fait générateur.</p>
          <button type="button" className="btn btn-secondary" disabled={a.busy} onClick={() => void a.run(async () => { setLiq(await api<VObligation>(`/v1/verticales/${c.vertical}/objects/${objectId}/liquidate`, { method: 'POST', body: {} })); }, 'Obligation émise.')}>Liquider</button>
          {liq && <p className="small">{liq.id} — <MoneyText money={liq.amount} /> — {liq.ruleNotice}</p>}
        </div>
      )}
    </div>
  );
}

function CasesTab() {
  const { fmtDate } = useApp();
  const cat = useApi(fetchCatalogue, []);
  const [vertical, setVertical] = useState('');
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams({ ...(vertical ? { vertical } : {}), ...(status ? { status } : {}) }).toString();
  const q = useApi(() => api<CaseView[]>(`/v1/verticales/cases${qs ? `?${qs}` : ''}`), [qs]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="panel">
      <div className="vxc-toolbar">
        <select value={vertical} onChange={(e) => setVertical(e.target.value)} aria-label="Verticale">
          <option value="">Toutes les verticales</option>{cat.data?.items.map((v) => <option key={v.slug} value={v.slug}>{v.short}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut">
          <option value="">Tous les statuts</option>
          {['DEPOSE', 'EN_INSTRUCTION', 'COMPLEMENT_DEMANDE', 'PROPOSE', 'ACCEPTE', 'REFUSE'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
        </select>
        <button type="button" className="btn btn-ghost btn-sm" onClick={q.reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </div>
      {q.loading && <Loading />}
      {!!q.error && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <DataTable rows={q.data} rowKey={(c) => c.id} caption="Démarches de l’entité"
          empty={<EmptyState title="Aucune démarche dans votre périmètre" />}
          columns={[
            { key: 'type', label: 'Démarche', primary: true, render: (c) => <span><strong>{c.typeLabel}</strong><br /><span className="mono small muted">{c.id}</span></span> },
            { key: 'v', label: 'Service', render: (c) => c.vertical },
            { key: 'commune', label: 'Commune', render: (c) => c.commune ?? '—' },
            { key: 'status', label: 'Statut', render: (c) => <StatusBadge tone={CASE_TONE[c.status] ?? 'neutral'} label={c.statusLabel} /> },
            { key: 'date', label: 'Déposée', render: (c) => fmtDate(c.createdAt) },
            { key: 'open', label: '', render: (c) => <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(c.id)}>Ouvrir</button> },
          ]} />
      )}
      <Drawer open={!!open} title="Instruction de la démarche" onClose={() => setOpen(null)}>
        {open && <CaseDetail id={open} onChanged={q.reload} />}
      </Drawer>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ plaques

interface ScanResult {
  plate: { code: string; label: string; status: string; commune: string; quartier: string };
  access: 'full' | 'minimal'; object: { id: string; category: string; probativeStatus: string };
  occupation: string | null; situation: { color: string; label: string; lastPaymentAt: string | null };
  stallTitle: { status: string; statusLabel: string; validFrom?: string | null; validUntil: string | null } | null; lastFinding: { date: string; result: string } | null;
  obligations?: VObligation[]; notice: string;
  penalitesImpayees?: OverduePenaltiesData;
}

function PlatesTab() {
  const { user, fmtDate } = useApp();
  const a = useAction();
  const [objectId, setObjectId] = useState('');
  const [code, setCode] = useState('');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [counter, setCounter] = useState<{ obligations: VObligation[] } | null>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const report = useApi(() => api<{ totals: { platesIssued: number; scans: number }; agents: { agentId: string; agentName: string; platesIssued: number; scans: number; communes: string[] }[] }>(`/v1/verticales/plates-report/daily?date=${date}`), [date, user?.id]);
  const isCounter = !!user?.roles.includes('R12');
  return (
    <div className="vxc-grid2">
      <div className="stack">
        <form className="panel form" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { const p = await api<{ code: string }>('/v1/verticales/plates', { method: 'POST', body: { objectId: objectId.trim() } }); setCode(p.code); report.reload(); }, 'Plaque posée et journalisée.'); }}>
          <h2 className="panel-title"><Icon name="building" size={18} /> Poser une plaque</h2>
          <p className="small muted">NFIU pour les parcelles et bâtiments ; plaques d’étal, de site, d’embarcation ou de chantier. Dans votre territoire seulement.</p>
          <div className="input-row"><input value={objectId} onChange={(e) => setObjectId(e.target.value)} placeholder="Identifiant de l’objet (ex. OBJ-DEMO-PARCELLE-01)" aria-label="Identifiant de l’objet" /><button type="submit" className="btn btn-primary" disabled={a.busy || !objectId.trim()}>Poser</button></div>
        </form>
        <form className="panel form" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { setCounter(null); setScan(isCounter ? null : await api<ScanResult>(`/v1/verticales/plates/${encodeURIComponent(code.trim())}/scan`)); if (isCounter) setCounter(await api(`/v1/verticales/plates/${encodeURIComponent(code.trim())}/counter`)); report.reload(); }); }}>
          <h2 className="panel-title"><Icon name="qr" size={18} /> {isCounter ? 'Paiement au guichet par plaque' : 'Scanner une plaque'}</h2>
          <div className="input-row"><input className="mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Code de la plaque" aria-label="Code de la plaque" /><button type="submit" className="btn btn-secondary" disabled={a.busy || !code.trim()}>{isCounter ? 'Rechercher' : 'Scanner'}</button></div>
        </form>
        <Feedback a={a} />
        {scan && (
          <section className="panel">
            <div className="panel-head"><h2 className="panel-title">{scan.plate.label}</h2><span className="mono small">{scan.plate.code}</span></div>
            <dl className="kv kv-dense">
              <div><dt>Localisation</dt><dd>{scan.plate.commune} · {scan.plate.quartier}</dd></div>
              <div><dt>Objet</dt><dd className="mono">{scan.object.id} — {scan.object.category}</dd></div>
              {scan.occupation && <div><dt>Occupation</dt><dd>{scan.occupation === 'MIS_EN_BAIL' ? 'Mis en bail' : 'Occupé par le propriétaire ou non déclaré'}</dd></div>}
              <div><dt>Situation</dt><dd><StatusBadge tone={scan.situation.color === 'green' ? 'good' : scan.situation.color === 'red' ? 'serious' : scan.situation.color === 'amber' ? 'warning' : 'neutral'} label={scan.situation.label} /></dd></div>
              {scan.stallTitle && <div><dt>Titre d’étal</dt><dd><StatusBadge tone={TITLE_TONE[scan.stallTitle.status] ?? 'neutral'} label={scan.stallTitle.statusLabel ?? TITLE_LABEL[scan.stallTitle.status]} />{scan.stallTitle.validUntil && <> <ValidityCountdown compact from={scan.stallTitle.validFrom} until={scan.stallTitle.validUntil} /></>}</dd></div>}
              {scan.lastFinding && <div><dt>Dernier constat</dt><dd>{fmtDate(scan.lastFinding.date)} — {scan.lastFinding.result}</dd></div>}
            </dl>
            {scan.obligations && scan.obligations.map((o) => <p key={o.id} className="small">{o.id} — <MoneyText money={o.amount} /> — {OBLIGATION_LABEL[o.status] ?? o.status}</p>)}
            <p className="hint"><Icon name="lock" size={13} /> {scan.notice}</p>
            {(scan.situation.color === 'red' || scan.situation.color === 'amber') && <AssistedPay objectId={scan.object.id} title="Faire payer ce bien maintenant (numérique)" />}
            <OverduePenalties data={scan.penalitesImpayees} />
          </section>
        )}
        {counter && (
          <section className="panel">
            <h2 className="panel-title">Obligations payables</h2>
            {counter.obligations.length === 0 ? <EmptyState title="Aucune obligation payable" /> : counter.obligations.map((o) => <p key={o.id} className="small"><span className="mono">{o.id}</span> — <MoneyText money={o.amount as MoneyJSON} /> — émettre la référence depuis l’obligation (compte public).</p>)}
          </section>
        )}
      </div>
      <section className="panel">
        <div className="panel-head"><h2 className="panel-title"><Icon name="history" size={18} /> Rapport journalier des agents</h2><input type="date" className="input-sm" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date du rapport" /></div>
        {report.loading && <Loading />}
        {!!report.error && <ErrorState error={report.error} onRetry={report.reload} />}
        {report.data && (
          <DataTable rows={report.data.agents} rowKey={(r) => r.agentId} empty={<EmptyState title="Aucune activité ce jour" />}
            columns={[
              { key: 'a', label: 'Agent', primary: true, render: (r) => r.agentName },
              { key: 'p', label: 'Plaques posées', num: true, render: (r) => r.platesIssued },
              { key: 's', label: 'Scans', num: true, render: (r) => r.scans },
              { key: 'c', label: 'Communes', render: (r) => r.communes.join(', ') || '—' },
            ]} />
        )}
        <p className="hint">Rapport automatique, sans montant : aucun agent ne peut modifier, négocier ni estimer un montant.</p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ AVIA

function AviaTab() {
  const { fmtDate } = useApp();
  const list = useApi(() => api<AviaDeclaration[]>('/v1/verticales/avia/declarations'), []);
  const ov = useApi(() => api<{ notice: string; periods: { period: string; declarations: number; passengersDeclared: number; passengersBoarded: number; withGap: number; validated: number }[] }>('/v1/verticales/avia/overview'), []);
  const a = useAction();
  const [reason, setReason] = useState<Record<string, string>>({});
  const act = (id: string, path: string, body: unknown, msg: string) => a.run(async () => { await api(`/v1/verticales/avia/declarations/${id}/${path}`, { method: 'POST', body }); list.reload(); ov.reload(); }, msg);
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="scale" size={18} /><p>{ov.data?.notice ?? 'Taxes aériennes provinciales : acte requis (J23).'} Aucune facturation automatique ; mesures contraignantes seulement après arrêté et décision de l’autorité compétente.</p></div>
      <Feedback a={a} />
      {list.loading && <Loading />}
      {!!list.error && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && (
        <section className="panel">
          <h2 className="panel-title">Déclarations mensuelles</h2>
          <ul className="list-rows">
            {list.data.map((d) => (
              <li key={d.id} className="list-row list-row-stack">
                <div className="row-between">
                  <div className="min0"><p className="row-title">{d.period} — <span className="mono small">{d.taxpayerId}</span></p><p className="small muted">{d.declared.passengersDeparting.toLocaleString('fr-FR')} passagers déclarés · {d.declared.flights} vols</p></div>
                  <StatusBadge tone={d.status === 'ECART_CONSTATE' ? 'warning' : ['VALIDEE', 'RAPPROCHEE'].includes(d.status) ? 'good' : 'info'} label={d.statusLabel} />
                </div>
                {d.reconciliation && <p className="small">Exploitant : {d.reconciliation.observed.passengersBoarded.toLocaleString('fr-FR')} embarqués · écart {d.reconciliation.gaps.passengers} ({d.reconciliation.passengerGapRate} %){d.contradictory ? ` · contradictoire jusqu’au ${fmtDate(d.contradictory.deadline)}` : ''}</p>}
                {d.contradictory?.observations.map((o, i) => <p key={i} className="small"><Icon name="message" size={13} /> Observation de la compagnie : {o.text}</p>)}
                {d.billing.map((b, i) => <p key={i} className="small muted">Facturation {b.outcome === 'REFUSEE' ? 'refusée' : 'émise'} — {b.reason}</p>)}
                <div className="row-actions">
                  {d.status === 'DECLAREE' && <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={() => void act(d.id, 'reconcile', undefined, 'Rapprochement effectué.')}>Rapprocher</button>}
                  {['RAPPROCHEE', 'ECART_CONSTATE', 'OBSERVATIONS_RECUES'].includes(d.status) && (
                    <div className="input-row"><input value={reason[d.id] ?? ''} onChange={(e) => setReason({ ...reason, [d.id]: e.target.value })} placeholder="Motif de validation" aria-label="Motif de validation" />
                      <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || (reason[d.id] ?? '').trim().length < 5} onClick={() => void act(d.id, 'validate', { reason: reason[d.id] }, 'Déclaration validée.')}>Valider</button></div>
                  )}
                  {d.status === 'VALIDEE' && <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={() => void act(d.id, 'billing', undefined, 'Avis émis.')}>Demander la facturation</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {ov.data && (
        <section className="panel">
          <h2 className="panel-title">Passagers tracés par mois (agrégats)</h2>
          <DataTable rows={ov.data.periods} rowKey={(p) => p.period}
            columns={[
              { key: 'p', label: 'Mois', primary: true, render: (p) => p.period },
              { key: 'd', label: 'Déclarés', num: true, render: (p) => p.passengersDeclared.toLocaleString('fr-FR') },
              { key: 'b', label: 'Embarqués (exploitant)', num: true, render: (p) => p.passengersBoarded.toLocaleString('fr-FR') },
              { key: 'g', label: 'Avec écart', num: true, render: (p) => p.withGap },
              { key: 'v', label: 'Validées', num: true, render: (p) => p.validated },
            ]} />
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ télécom et indicateurs

function TelecomTab() {
  const q = useApi(() => api<{ declared: number; observed: number; matched: number; observedNotDeclared: { objectId: string; commune: string; quartier: string; proposal: string }[]; declaredNotObserved: { objectId: string; reference: string | null; commune: string; proposal: string }[] }>('/v1/verticales/telecom/reconciliation'), []);
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  return (
    <div className="stack">
      <div className="vxc-kpis">
        <div className="vxc-kpi"><strong>{d.declared}</strong><span>Sites déclarés par les opérateurs</span></div>
        <div className="vxc-kpi"><strong>{d.observed}</strong><span>Sites relevés sur le terrain</span></div>
        <div className="vxc-kpi"><strong>{d.matched}</strong><span>Concordants</span></div>
        <div className="vxc-kpi"><strong>{d.observedNotDeclared.length}</strong><span>Observés non déclarés</span></div>
      </div>
      <section className="panel">
        <h2 className="panel-title">Sites observés absents des listes</h2>
        {d.observedNotDeclared.length === 0 ? <EmptyState title="Aucun écart" /> : <ul className="list-rows">{d.observedNotDeclared.map((s) => <li key={s.objectId} className="list-row"><div className="min0"><p className="row-title mono">{s.objectId}</p><p className="small muted">{s.commune} · {s.quartier}</p></div><span className="small">{s.proposal}</span></li>)}</ul>}
      </section>
      <section className="panel">
        <h2 className="panel-title">Sites déclarés non encore relevés</h2>
        {d.declaredNotObserved.length === 0 ? <EmptyState title="Aucun" /> : <ul className="list-rows">{d.declaredNotObserved.map((s) => <li key={s.objectId} className="list-row"><div className="min0"><p className="row-title mono">{s.reference ?? s.objectId}</p><p className="small muted">{s.commune}</p></div><span className="small">{s.proposal}</span></li>)}</ul>}
      </section>
    </div>
  );
}

function IndicatorsTab() {
  const q = useApi(() => api<{ byVertical: { slug: string; objects: number; cases: number; open: number; accepted: number; refused: number }[]; markets: { stalls: number; occupied: number; paidOccupied: number; paidOccupancyRate: string }; events: { authorized: number; ticketingDeclared: number }; plates: { platesInService: number; nfiuInService: number; buildingsRegistered: number } }>('/v1/verticales/indicators'), []);
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  return (
    <div className="stack">
      <div className="vxc-kpis">
        <div className="vxc-kpi"><strong>{d.markets.paidOccupancyRate} %</strong><span>Étals occupés avec titre valide ({d.markets.paidOccupied}/{d.markets.occupied})</span></div>
        <div className="vxc-kpi"><strong>{d.plates.nfiuInService}</strong><span>Plaques NFIU en service / {d.plates.buildingsRegistered} biens</span></div>
        <div className="vxc-kpi"><strong>{d.events.authorized}</strong><span>Événements autorisés</span></div>
        <div className="vxc-kpi"><strong>{d.plates.platesInService}</strong><span>Plaques en service (tous types)</span></div>
      </div>
      <section className="panel">
        <h2 className="panel-title">Activité par verticale (agrégats, sans données nominatives)</h2>
        <DataTable rows={d.byVertical} rowKey={(r) => r.slug}
          columns={[
            { key: 's', label: 'Verticale', primary: true, render: (r) => r.slug },
            { key: 'o', label: 'Objets', num: true, render: (r) => r.objects },
            { key: 'c', label: 'Démarches', num: true, render: (r) => r.cases },
            { key: 'op', label: 'En cours', num: true, render: (r) => r.open },
            { key: 'a', label: 'Acceptées', num: true, render: (r) => r.accepted },
            { key: 'r', label: 'Refusées', num: true, render: (r) => r.refused },
          ]} />
      </section>
    </div>
  );
}

/** Console d'instruction des verticales : démarches, plaques, AVIA, télécom, indicateurs. */
export default function AgentConsole() {
  const { user } = useApp();
  const [tab, setTab] = useState<Tab>('demarches');
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Verticales" title="Console d’instruction"
        lead="Instruire, constater, proposer : une personne habilitée et distincte décide, avec motif. Aucun encaissement, aucune sanction automatique.">
        <Link to="/autour-de-moi" className="btn btn-secondary btn-sm"><Icon name="gps" size={16} /> Autour de moi</Link>
      </PageHead>
      <ExampleNotice text="Démonstration : dossiers et objets fictifs. Choisissez un agent de l’entité dans l’en-tête (ex. instructeur ou cheffe de service DGTK)." />
      {!user && <EmptyState title="Connexion d’un agent requise" icon="lock" />}
      {user && (
        <>
          <div className="seg seg-wrap" role="tablist" aria-label="Rubriques">
            {TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}><Icon name={t.icon} size={16} /> {t.label}</button>)}
          </div>
          {tab === 'demarches' && <CasesTab />}
          {tab === 'plaques' && <PlatesTab />}
          {tab === 'avia' && <AviaTab />}
          {tab === 'telecom' && <TelecomTab />}
          {tab === 'indicateurs' && <IndicatorsTab />}
        </>
      )}
    </div>
  );
}
