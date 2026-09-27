/**
 * Module 18 — Contribution plastique et environnement : désactivée tant que la règle n'est pas publiée (aucune
 * obligation sans texte en vigueur). Registre des assujettis, données d'étude d'impact, simulation NON OPPOSABLE d'une
 * fiche de règle (brouillon ou acte requis) ; déclarations et reversements seulement après activation.
 */
import { useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';

interface PlasticView {
  active: boolean; ruleCode: string | null; ruleStatus: string; notice: string; roles: string[]; categories: Record<string, string>;
  liable: { taxpayerId: string; name: string; roles: string[]; categories: string[]; source: string }[];
  study: { id: string; taxpayerId: string | null; period: string; lines: Record<string, string>; source: string }[];
  simulations: { id: string; ruleCode: string; ruleVersion: number; ruleStatus: string; scenario: string; total: string; currency: string; lines: number; at: string }[];
  declarations: { id: string; taxpayerId: string; period: string; lines: Record<string, string>; status: string; payment: string | null }[];
  rules: { id: string; code: string; version: number; status: string; label: string }[];
  indicators: { assujettis: number; simulations: number; declarations: number };
}

export default function Plastique() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const q = useApi(() => api<PlasticView>('/v1/verticales/plastique'), [user?.id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (path: string, body: unknown, ok: string) => {
    setMsg(null);
    try { await api(path, { method: 'POST', body }); setMsg({ ok: true, text: ok }); q.reload(); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  };
  const [tp, setTp] = useState('');
  const [role, setRole] = useState('PRODUCTEUR');
  const [period, setPeriod] = useState('');
  const [lines, setLines] = useState<Record<string, string>>({});
  const [ruleId, setRuleId] = useState('');
  const [scenario, setScenario] = useState('');
  const [objectId, setObjectId] = useState('');
  const study = roles.some((r) => r === 'R06' || r === 'R11');
  const taxpayer = roles.some((r) => r === 'R30' || r === 'R31');
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data!;
  const filled = () => Object.fromEntries(Object.entries(lines).filter(([, v]) => v.trim()));
  return (
    <div className="stack">
      <div className={`callout ${d.active ? 'callout-info' : 'callout-warn'}`}>
        <Icon name="leaf" size={18} />
        <div><p><strong>{d.active ? 'Module activé' : 'Module désactivé'}</strong> — {d.notice}</p><p className="small">Assujettis identifiés : {d.indicators.assujettis} · simulations réalisées : {d.indicators.simulations} · déclarations : {d.indicators.declarations}</p></div>
      </div>
      {msg && <p className={msg.ok ? 'notice notice-ok' : 'err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      {study && (
        <section className="panel stack-sm">
          <h2 className="panel-title"><Icon name="users" size={18} /> Registre des assujettis (identification, sans obligation)</h2>
          <form className="row-wrap" onSubmit={(e: FormEvent) => { e.preventDefault(); void run('/v1/verticales/plastique/assujettis', { taxpayerId: tp, roles: [role], categories: Object.keys(filled()), source: 'Registre des metteurs en marché', motif: 'Identification pour l’étude d’impact' }, 'Assujetti identifié.'); }}>
            <input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="Compte contribuable" aria-label="Assujetti" />
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Qualité">{d.roles.map((r) => <option key={r}>{r}</option>)}</select>
            <button type="submit" className="btn btn-secondary btn-sm" disabled={!tp}>Identifier</button>
          </form>
          <ul className="list-plain small">{d.liable.map((l) => <li key={l.taxpayerId}>{l.name} — {l.roles.join(', ')} ({l.source})</li>)}</ul>
          <h3>Données d’étude d’impact</h3>
          <div className="row-wrap">
            <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Période AAAA ou AAAA-MM" aria-label="Période de l’étude" />
            {Object.entries(d.categories).map(([k, l]) => <input key={k} value={lines[k] ?? ''} onChange={(e) => setLines({ ...lines, [k]: e.target.value })} placeholder={l} aria-label={l} inputMode="decimal" />)}
            <button type="button" className="btn btn-secondary btn-sm" disabled={!period} onClick={() => void run('/v1/verticales/plastique/etude', { ...(tp ? { taxpayerId: tp } : {}), period, lines: filled(), source: 'Enquête d’étude d’impact' }, 'Données d’étude enregistrées.')}>Enregistrer</button>
          </div>
          <h3>Simulation d’impact (non opposable)</h3>
          <div className="row-wrap">
            <select value={ruleId} onChange={(e) => setRuleId(e.target.value)} aria-label="Fiche de règle simulée"><option value="">Choisir une fiche</option>{d.rules.map((r) => <option key={r.id} value={r.id}>{r.code} v{r.version} ({r.status})</option>)}</select>
            <input value={scenario} onChange={(e) => setScenario(e.target.value)} placeholder="Scénario" aria-label="Scénario" />
            <button type="button" className="btn btn-secondary btn-sm" disabled={!ruleId || scenario.length < 3} onClick={() => void run('/v1/verticales/plastique/simulations', { ruleId, scenario }, 'Simulation enregistrée (non opposable).')}>Simuler</button>
          </div>
          <ul className="list-plain small">{d.simulations.map((s) => <li key={s.id}>{s.at.slice(0, 10)} — {s.scenario} : {s.ruleCode} v{s.ruleVersion} ({s.ruleStatus}) → total {s.total} {s.currency} sur {s.lines} ligne(s) · non opposable</li>)}</ul>
        </section>
      )}
      {taxpayer && (
        <section className="panel stack-sm">
          <h2 className="panel-title"><Icon name="file" size={18} /> Déclarer (module activé seulement)</h2>
          <div className="row-wrap">
            <input value={objectId} onChange={(e) => setObjectId(e.target.value)} placeholder="Établissement (objet)" aria-label="Établissement déclaré" />
            <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Période AAAA-MM" aria-label="Période déclarée" />
            {Object.entries(d.categories).map(([k, l]) => <input key={k} value={lines[k] ?? ''} onChange={(e) => setLines({ ...lines, [k]: e.target.value })} placeholder={l} aria-label={`Déclaré — ${l}`} inputMode="decimal" />)}
            <button type="button" className="btn btn-primary btn-sm" disabled={!d.active || !objectId || !period} onClick={() => void run('/v1/verticales/plastique/declarations', { objectId, period, lines: filled() }, 'Déclaration déposée.')}>Déclarer</button>
          </div>
        </section>
      )}
      <section className="panel">
        <h2 className="panel-title"><Icon name="ledger" size={18} /> Déclarations et reversements</h2>
        {d.declarations.length ? (
          <ul className="list-rows">{d.declarations.map((x) => (
            <li key={x.id} className="list-row">
              <span className="mono">{x.id}</span> · {x.period} · {Object.entries(x.lines).map(([k, v]) => `${k} ${v}`).join(', ')}
              <StatusBadge tone={x.status === 'LIQUIDEE' ? 'good' : 'info'} label={x.status === 'LIQUIDEE' ? `Reversement liquidé${x.payment ? ` — ${x.payment}` : ''}` : 'Déposée'} />
              {roles.includes('R11') && x.status === 'DEPOSEE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(`/v1/verticales/plastique/declarations/${x.id}/reversement`, {}, 'Reversement liquidé.')}>Liquider le reversement</button>}
            </li>
          ))}</ul>
        ) : <EmptyState title={d.active ? 'Aucune déclaration' : 'Aucune déclaration : module désactivé'} />}
      </section>
    </div>
  );
}
