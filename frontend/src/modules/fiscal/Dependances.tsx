/**
 * Conditions des services (§ 8.1, § 10A.3) : chaque service dépendant (permis de bâtir, mutations foncières et de
 * véhicules, marchés publics, autorisation de transport) affiche ses conditions (quitus, vignette) comme règles
 * versionnées, visibles de tous. « Informatif » tant que l'acte n'est pas publié ; « obligatoire » après activation
 * sur acte certifié et approbation par une seconde personne.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { FiscalTabs, ReasonAction, useViewer } from './common';
import './fiscal.css';
import { DependancesVisuels } from './visuels';

interface Condition { code: string; version: number; condition: string; label: string; citizenText: string; mode: 'INFORMATIF' | 'BLOQUANT'; legal: { jPoint: string; instrumentId?: string; article?: string }; effectiveFrom: string }
interface ServiceRow { service: string; label: string; conditions: Condition[]; history: { code: string; version: number; mode: string; status: string; effectiveFrom: string }[] }
interface CheckResult { serviceLabel: string; blocked: boolean; notice: string; conditions: { code: string; label: string; mode: string; satisfied: boolean; detail: string }[] }
interface AgentDep { id: string; code: string; version: number; mode: string; status: string; pendingChange?: { targetMode: string; instrumentId: string; proposedBy: string; reason: string } }

export const MODE_LABEL: Record<string, string> = { INFORMATIF: 'Informatif — ne bloque pas', BLOQUANT: 'Obligatoire — bloque la démarche' };

function Check({ services }: { services: ServiceRow[] }) {
  const { isTaxpayer } = useViewer();
  const [service, setService] = useState(services[0]?.service ?? 'PERMIS_DE_BATIR');
  const [taxpayerId, setTaxpayerId] = useState('');
  const [plate, setPlate] = useState('');
  const [res, setRes] = useState<CheckResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null); setRes(null);
    try { setRes(await api<CheckResult>('/v1/fiscal/dependencies/check', { method: 'POST', body: { service, ...(taxpayerId ? { taxpayerId } : {}), ...(plate ? { plate } : {}) } })); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <form className="panel stack-sm" onSubmit={(e) => void go(e)}>
      <p className="panel-title">{isTaxpayer ? 'Vérifier mes conditions' : 'Vérifier les conditions d’un demandeur'}</p>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="dp-svc">Service</label><select id="dp-svc" value={service} onChange={(e) => setService(e.target.value)}>{services.map((s) => <option key={s.service} value={s.service}>{s.label}</option>)}</select></div>
        {!isTaxpayer && <div className="field"><label className="label" htmlFor="dp-tp">Identifiant du contribuable</label><input id="dp-tp" value={taxpayerId} onChange={(e) => setTaxpayerId(e.target.value)} /></div>}
      </div>
      {service === 'AUTORISATION_TRANSPORT' && <div className="field"><label className="label" htmlFor="dp-pl">Plaque</label><input id="dp-pl" value={plate} onChange={(e) => setPlate(e.target.value)} /></div>}
      <button type="submit" className="btn btn-primary btn-sm">Vérifier</button>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {res && (
        <div className="stack-sm" role="status">
          <StatusBadge tone={res.blocked ? 'critical' : res.conditions.every((c) => c.satisfied) ? 'good' : 'warning'} label={res.notice} />
          <ul className="plain-list small">{res.conditions.map((c) => <li key={c.code}>{c.label} — {c.satisfied ? 'remplie' : 'non remplie'} ({MODE_LABEL[c.mode] ?? c.mode}) : {c.detail}</li>)}</ul>
        </div>
      )}
    </form>
  );
}

function AgentPanel() {
  const { user } = useApp();
  const { has } = useViewer();
  const q = useApi(() => api<AgentDep[]>('/v1/fiscal/dependencies'), [user?.id]);
  const [f, setF] = useState({ code: '', instrumentId: '', article: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  async function propose(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api(`/v1/fiscal/dependencies/${encodeURIComponent(f.code)}/change`, { method: 'POST', body: { targetMode: 'BLOQUANT', instrumentId: f.instrumentId, reason: f.reason, ...(f.article ? { article: f.article } : {}) } }); q.reload(); } catch (x) { setErr(describeError(x).message); }
  }
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const current = (q.data ?? []).filter((d) => d.status === 'EN_VIGUEUR');
  return (
    <section className="stack-sm">
      <h2 className="h-sub">Activation sur acte (quatre yeux)</h2>
      <ul className="stack-sm">{current.filter((d) => d.pendingChange).map((d) => (
        <li key={d.id} className="panel">
          <p className="small"><span className="mono">{d.code}</span> v{d.version} : passage en mode {d.pendingChange!.targetMode} proposé par {d.pendingChange!.proposedBy} (acte {d.pendingChange!.instrumentId}) — {d.pendingChange!.reason}</p>
          {has('R16', 'R05') && user?.id !== d.pendingChange!.proposedBy && (
            <div className="btn-row">
              <ReasonAction label="Approuver" confirmLabel="Approuver l’activation" onSubmit={(reason) => api(`/v1/fiscal/dependencies/${d.code}/change/decision`, { method: 'POST', body: { approve: true, reason } }).then(q.reload)} />
              <ReasonAction label="Refuser" confirmLabel="Refuser" tone="secondary" onSubmit={(reason) => api(`/v1/fiscal/dependencies/${d.code}/change/decision`, { method: 'POST', body: { approve: false, reason } }).then(q.reload)} />
            </div>
          )}
        </li>))}</ul>
      {has('R13', 'R06') && (
        <form className="panel stack-sm" onSubmit={(e) => void propose(e)}>
          <p className="small muted">L’acte doit être certifié « en vigueur » au registre juridique ; sinon la proposition est refusée (acte requis).</p>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="dp-code">Dépendance</label><select id="dp-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required><option value="">—</option>{current.filter((d) => d.mode === 'INFORMATIF').map((d) => <option key={d.code} value={d.code}>{d.code}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="dp-inst">Acte (identifiant au registre)</label><input id="dp-inst" required value={f.instrumentId} onChange={(e) => setF({ ...f, instrumentId: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="dp-art">Article</label><input id="dp-art" value={f.article} onChange={(e) => setF({ ...f, article: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="dp-rs">Motif</label><input id="dp-rs" required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></div>
          </div>
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-primary btn-sm">Proposer l’activation</button>
        </form>
      )}
    </section>
  );
}

export default function Dependances() {
  const { user } = useApp();
  const { has } = useViewer();
  const q = useApi(() => api<{ services: ServiceRow[]; notice: string }>('/v1/public/fiscal/dependances'), []);
  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Quitus et conditions" title="Conditions des services"
        lead="Certains services provinciaux dépendent d’une autre obligation : permis de bâtir, mutations et marchés publics (quitus fiscal), autorisation de transport (vignette). Chaque condition est une règle versionnée, visible de tous ; elle ne bloque une démarche qu’après publication de l’acte qui l’institue." />
      <FiscalTabs />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          <p className="small muted">{q.data.notice}</p>
          <DependancesVisuels services={q.data.services} />
          <div className="fs-grid">{q.data.services.map((s) => (
            <article key={s.service} className="panel stack-sm">
              <p className="panel-title">{s.label}</p>
              {s.conditions.map((c) => (
                <div key={c.code} className="stack-sm">
                  <StatusBadge tone={c.mode === 'BLOQUANT' ? 'serious' : 'info'} label={`${c.label} — ${MODE_LABEL[c.mode]}`} />
                  <p className="small">{c.citizenText}</p>
                  <p className="small muted"><span className="mono">{c.code}</span> v{c.version} · en vigueur depuis le {c.effectiveFrom} · acte {c.legal.jPoint}{c.legal.instrumentId ? ` (${c.legal.instrumentId}${c.legal.article ? `, ${c.legal.article}` : ''})` : ' non publié'}</p>
                </div>
              ))}
              {s.history.length > s.conditions.length && <p className="small muted">Versions : {s.history.map((h) => `${h.code} v${h.version} (${h.mode}, ${h.status === 'REMPLACEE' ? 'remplacée' : 'en vigueur'})`).join(' · ')}</p>}
            </article>))}</div>
          {user && <Check services={q.data.services} />}
          {has('R13', 'R06', 'R16', 'R05', 'R07', 'R11', 'R12', 'R37') && <AgentPanel />}
        </>
      )}
    </div>
  );
}
