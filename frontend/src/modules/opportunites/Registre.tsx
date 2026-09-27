/**
 * Registre des opportunités de recettes (§ 8.1 – § 8.4) : gisements du cahier et signaux versés au registre,
 * grille d'évaluation, hypothèses datées et sourcées, pipeline en huit étapes complétées par les rôles responsables,
 * décision motivée de l'autorité compétente. L'activation exige une base légale ; l'IA ne décide jamais.
 */
import { useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import {
  ActionError, GRID_LABELS, GridView, hasRole, Kpi, ORIGIN_LABELS, OUTCOME_LABELS, outcomeTone, PipelineView, Tabs, TRACK_LABELS, useAction,
  type Opportunity, type OpportunitySummary, type PipelineStep,
} from './shared';
import './opportunites.css';

const READ = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R09', 'R11', 'R13', 'R14', 'R15', 'R22', 'R23', 'R24', 'R25'];
const GRID_WRITE = ['R02', 'R05', 'R06', 'R07', 'R13', 'R14', 'R15', 'R22', 'R24'];
const HYP_WRITE = ['R06', 'R07', 'R13', 'R14', 'R15'];
type Section = 'TOUS' | '8.1' | '8.2' | 'SIGNAL';

interface Scope { agent: { name: string; loaded: boolean; never: string }; domains: { code: string; label: string; verticals: string[]; opportunities: { id: string }[] }[] }
interface IaSignals { available: boolean; items: { id: string; situation: string; insight: string; createdAt: string }[] }

/** Formulaire de l'étape suivante (1 à 7) ou de la décision (8), selon le rôle. */
function NextStepForm({ opp, roles, onDone }: { opp: Opportunity; roles: string[]; onDone: () => void }) {
  const a = useAction();
  const [summary, setSummary] = useState('');
  const [sc, setSc] = useState({ prudent: '', attendu: '', ambitieux: '', currency: 'CDF', hyps: [] as string[] });
  const [dec, setDec] = useState({ outcome: 'REPORT', motivation: '', kind: 'ACTE', ref: '' });
  const next = opp.nextStep;
  if (!next || opp.status === 'DECIDEE') return null;
  if (!hasRole(roles, ...next.roles)) {
    return <p className="callout callout-info"><Icon name="info" size={18} /><span>Étape suivante : <strong>{next.n}. {next.label}</strong> — réservée à {next.responsible} ({next.roles.join(', ')}).</span></p>;
  }
  if (next.n === 8) {
    const submit = async () => {
      const body = { outcome: dec.outcome, motivation: dec.motivation, ...(dec.ref.trim() ? { legalBasis: { kind: dec.kind, ref: dec.ref.trim() } } : {}) };
      if (await a.run(() => api(`/v1/opportunites/${opp.id}/decision`, { method: 'POST', body }))) onDone();
    };
    return (
      <section className="panel" aria-labelledby="op-dec">
        <h3 className="panel-title" id="op-dec">8. Décision de l’autorité compétente</h3>
        <p className="small muted">Activation impossible sans base légale : règle ACTIVE du registre (quatre visas) ou acte EN VIGUEUR. L’activation ne crée ni règle ni obligation.</p>
        <div className="field-row">
          <label className="field"><span>Décision</span>
            <select value={dec.outcome} onChange={(e) => setDec({ ...dec, outcome: e.target.value })}>
              {Object.entries(OUTCOME_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="field"><span>Base légale {dec.outcome === 'ACTIVATION' ? '(obligatoire)' : '(facultative)'}</span>
            <div className="input-row">
              <select value={dec.kind} onChange={(e) => setDec({ ...dec, kind: e.target.value })} aria-label="Nature de la base légale"><option value="ACTE">Acte</option><option value="REGLE">Règle</option></select>
              <input value={dec.ref} onChange={(e) => setDec({ ...dec, ref: e.target.value })} placeholder="Identifiant au registre" aria-label="Référence de la base légale" />
            </div>
          </label>
        </div>
        <label className="field"><span>Motivation</span><textarea rows={3} value={dec.motivation} onChange={(e) => setDec({ ...dec, motivation: e.target.value })} /></label>
        <ActionError error={a.error} />
        <button type="button" className="btn btn-primary" disabled={a.busy || dec.motivation.trim().length < 20 || (dec.outcome === 'ACTIVATION' && !dec.ref.trim())} onClick={() => void submit()}>Rendre la décision</button>
      </section>
    );
  }
  const submit = async () => {
    const amt = (v: string) => (v.trim() ? { amount: v.trim(), currency: sc.currency } : null);
    const body = { summary, ...(next.n === 3 ? { scenarios: { prudent: amt(sc.prudent), attendu: amt(sc.attendu), ambitieux: amt(sc.ambitieux), hypothesisIds: sc.hyps } } : {}) };
    if (await a.run(() => api(`/v1/opportunites/${opp.id}/etapes/${next.n}`, { method: 'POST', body }))) { setSummary(''); onDone(); }
  };
  return (
    <section className="panel" aria-labelledby="op-next">
      <h3 className="panel-title" id="op-next">Étape {next.n} — {next.label}</h3>
      <label className="field"><span>Conclusions de l’étape</span><textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
      {next.n === 3 && (
        <fieldset className="field">
          <legend>Scénarios (laisser vide = {`« à estimer par le recensement pilote »`})</legend>
          <div className="field-row field-row-3">
            {(['prudent', 'attendu', 'ambitieux'] as const).map((k) => (
              <label key={k} className="field"><span>{k === 'prudent' ? 'Prudent' : k === 'attendu' ? 'Attendu' : 'Ambitieux'}</span>
                <input inputMode="decimal" value={sc[k]} onChange={(e) => setSc({ ...sc, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <label className="field"><span>Devise</span><select value={sc.currency} onChange={(e) => setSc({ ...sc, currency: e.target.value })}><option>CDF</option><option>USD</option></select></label>
          <p className="small">Hypothèses citées (obligatoires si un montant est saisi) :</p>
          {opp.hypotheses.filter((h) => h.status === 'ACTIVE').map((h) => (
            <label key={h.id} className="check small"><input type="checkbox" checked={sc.hyps.includes(h.id)} onChange={(e) => setSc({ ...sc, hyps: e.target.checked ? [...sc.hyps, h.id] : sc.hyps.filter((x) => x !== h.id) })} /> {h.id} — {h.text}</label>
          ))}
        </fieldset>
      )}
      <ActionError error={a.error} />
      <button type="button" className="btn btn-primary" disabled={a.busy || summary.trim().length < 10} onClick={() => void submit()}>Compléter l’étape {next.n}</button>
    </section>
  );
}

function GridEditor({ opp, onDone }: { opp: Opportunity; onDone: () => void }) {
  const a = useAction();
  const [f, setF] = useState({ field: 'faisabiliteJuridique', value: '', reason: '' });
  const submit = async () => { if (await a.run(() => api(`/v1/opportunites/${opp.id}/grille/${f.field}`, { method: 'PUT', body: { value: f.value.trim() || null, reason: f.reason } }))) { setF({ ...f, value: '', reason: '' }); onDone(); } };
  return (
    <details className="op-details"><summary>Renseigner une rubrique de la grille</summary>
      <div className="field-row">
        <label className="field"><span>Rubrique</span><select value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}>{Object.entries(GRID_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field"><span>Motif</span><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
      </div>
      <label className="field"><span>Valeur</span><textarea rows={2} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></label>
      <ActionError error={a.error} />
      <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || f.reason.trim().length < 5} onClick={() => void submit()}>Enregistrer (versionné)</button>
    </details>
  );
}

function HypothesisForm({ opp, onDone }: { opp: Opportunity; onDone: () => void }) {
  const a = useAction();
  const [h, setH] = useState({ text: '', source: '', date: new Date().toISOString().slice(0, 10), revises: '' });
  const submit = async () => { if (await a.run(() => api(`/v1/opportunites/${opp.id}/hypotheses`, { method: 'POST', body: { text: h.text, source: h.source, date: h.date, ...(h.revises ? { revises: h.revises } : {}) } }))) { setH({ ...h, text: '', source: '', revises: '' }); onDone(); } };
  return (
    <details className="op-details"><summary>Ajouter ou réviser une hypothèse</summary>
      <label className="field"><span>Hypothèse</span><textarea rows={2} value={h.text} onChange={(e) => setH({ ...h, text: e.target.value })} /></label>
      <div className="field-row">
        <label className="field"><span>Source</span><input value={h.source} onChange={(e) => setH({ ...h, source: e.target.value })} /></label>
        <label className="field"><span>Date</span><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} /></label>
      </div>
      <label className="field"><span>Révise (facultatif)</span><select value={h.revises} onChange={(e) => setH({ ...h, revises: e.target.value })}><option value="">— nouvelle hypothèse —</option>{opp.hypotheses.filter((x) => x.status === 'ACTIVE').map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}</select></label>
      <ActionError error={a.error} />
      <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || h.text.trim().length < 10 || h.source.trim().length < 3} onClick={() => void submit()}>Enregistrer</button>
    </details>
  );
}

/** Fiche : légalité / coût / impact / risque / pilote (§ 8.4), instruite selon la grille (§ 8.3). */
export function OpportunitySheet({ opp, roles, onChange }: { opp: Opportunity; roles: string[]; onChange: () => void }) {
  return (
    <div className="stack">
      <div className="op-sheet-head">
        <p className="caps-sm">{opp.code} · {TRACK_LABELS[opp.track] ?? opp.track} · {ORIGIN_LABELS[opp.origin] ?? opp.origin}</p>
        <h2 className="op-title">{opp.title}</h2>
        {opp.decision ? <StatusBadge tone={outcomeTone(opp.decision.outcome)} label={`Décision : ${OUTCOME_LABELS[opp.decision.outcome]}`} /> : <StatusBadge tone="info" label={`En instruction — ${opp.completed}/8`} />}
      </div>
      <dl className="op-facts">
        {opp.nature && <><dt>Nature</dt><dd>{opp.nature}</dd></>}
        {opp.condition && <><dt>Condition</dt><dd>{opp.condition}</dd></>}
        {opp.objective && <><dt>Objectif de politique publique</dt><dd>{opp.objective}</dd></>}
        {opp.legalPath && <><dt>Voie juridique</dt><dd>{opp.legalPath}</dd></>}
        {opp.risksToControl && <><dt>Risques à maîtriser</dt><dd>{opp.risksToControl}</dd></>}
        {opp.decision?.legalBasis && <><dt>Base légale</dt><dd>{opp.decision.legalBasis.label} ({opp.decision.legalBasis.status})</dd></>}
        {opp.decision && <><dt>Motivation</dt><dd>{opp.decision.motivation} <span className="small muted">— effet : aucune obligation créée</span></dd></>}
      </dl>
      <p className="callout callout-info"><Icon name="shieldCheck" size={18} /><span>Garde-fou : aucune opportunité ne devient une taxe par simple décision algorithmique ; chaque étape est complétée par une personne habilitée et journalisée.</span></p>
      <NextStepForm opp={opp} roles={roles} onDone={onChange} />
      <section className="panel" aria-labelledby="op-pipe"><h3 className="panel-title" id="op-pipe">Pipeline (§ 8.4)</h3><PipelineView steps={opp.stepsView} /></section>
      <section className="panel" aria-labelledby="op-grid">
        <h3 className="panel-title" id="op-grid">Grille d’évaluation (§ 8.3)</h3>
        <GridView opp={opp} />
        {hasRole(roles, ...GRID_WRITE) && opp.status !== 'DECIDEE' && <GridEditor opp={opp} onDone={onChange} />}
      </section>
      <section className="panel" aria-labelledby="op-hyp">
        <h3 className="panel-title" id="op-hyp">Hypothèses (datées, sourcées, révisables)</h3>
        <ul className="plain-list stack-sm">
          {opp.hypotheses.map((h) => (
            <li key={h.id} className={h.status === 'REVISEE' ? 'muted' : ''}>
              <span className="mono small">{h.id}</span> {h.text} <span className="small muted">— {h.source}, {h.date}{h.status === 'REVISEE' ? ' · révisée' : ''}</span>
            </li>
          ))}
        </ul>
        {hasRole(roles, ...HYP_WRITE) && opp.status !== 'DECIDEE' && <HypothesisForm opp={opp} onDone={onChange} />}
      </section>
    </div>
  );
}

function IaSignalsPanel({ onImported }: { onImported: (id: string) => void }) {
  const q = useApi(() => api<IaSignals>('/v1/opportunites/decouverte/signaux-ia'), []);
  const a = useAction();
  if (!q.data?.available || q.data.items.length === 0) return null;
  const importIt = async (id: string, insight: string) => {
    const r = await a.run(() => api<Opportunity>('/v1/opportunites', { method: 'POST', body: { title: `Signal de découverte — ${insight.slice(0, 120)}`, origin: 'IA_DECOUVERTE', originRef: id, summary: 'Signal de l’agent « Découverte des recettes » confirmé et versé au registre.', domains: ['IMMOBILIER_LOCATIF'] } }));
    if (r) { q.reload(); onImported(r.id); }
  };
  return (
    <section className="panel" aria-labelledby="op-ia">
      <h2 className="panel-title" id="op-ia">Signaux de l’agent « Découverte des recettes »</h2>
      <p className="small muted">L’agent propose ; une personne habilitée verse le signal au registre (étape 1).</p>
      <ActionError error={a.error} />
      <ul className="plain-list stack-sm">
        {q.data.items.map((s) => (
          <li key={s.id} className="op-signal">
            <span className="small">{s.situation} {s.insight}</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={() => void importIt(s.id, s.insight)}>Verser au registre</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Registre() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const allowed = hasRole(roles, ...READ);
  const [section, setSection] = useState<Section>('TOUS');
  const [sel, setSel] = useState<string | null>(null);
  const list = useApi(allowed ? () => api<{ items: OpportunitySummary[] }>('/v1/opportunites') : null, [user?.id]);
  const scope = useApi(allowed ? () => api<Scope>('/v1/opportunites/decouverte/champ') : null, [user?.id]);
  const pipe = useApi(allowed ? () => api<{ steps: PipelineStep[]; guardrail: string }>('/v1/opportunites/pipeline') : null, [user?.id]);
  const detail = useApi(sel ? () => api<Opportunity>(`/v1/opportunites/${sel}`) : null, [sel]);

  if (!allowed) {
    return <div className="page"><PageHead eyebrow="Opportunités · § 8" title="Registre des opportunités" /><EmptyState title="Accès réservé" icon="lock">Réservé aux autorités, à la régie, aux juristes, au contrôle interne et à l’audit.</EmptyState></div>;
  }
  const items = (list.data?.items ?? []).filter((o) => section === 'TOUS' || o.section === section);
  const all = list.data?.items ?? [];
  const reload = () => { list.reload(); detail.reload(); };
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Opportunités · Cahier v2.9 § 8.1 – 8.4" title="Registre des opportunités de recettes"
        lead="Gisements licites classés par faisabilité. Aucune piste n’est activée sans base légale ; les potentiels restent « à estimer par le recensement pilote » tant qu’aucune hypothèse documentée ne les fonde." />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
        <>
          <div className="kpi-row">
            <Kpi label="Sans texte nouveau (§ 8.1)" value={all.filter((o) => o.section === '8.1').length} />
            <Kpi label="Acte provincial requis (§ 8.2)" value={all.filter((o) => o.section === '8.2').length} />
            <Kpi label="Signaux versés" value={all.filter((o) => o.section === 'SIGNAL').length} />
            <Kpi label="Décidées" value={all.filter((o) => o.status === 'DECIDEE').length} sub="activation, report ou abandon" />
          </div>
          {pipe.data && <p className="callout callout-info"><Icon name="shieldCheck" size={18} /><span>{pipe.data.guardrail} Étapes : {pipe.data.steps.map((s) => s.label).join(' → ')}.</span></p>}
          <IaSignalsPanel onImported={(id) => { list.reload(); setSel(id); }} />
          <Tabs value={section} onChange={setSection} label="Section du cahier" items={[
            { id: 'TOUS', label: 'Toutes', count: all.length }, { id: '8.1', label: '§ 8.1 — sans texte' }, { id: '8.2', label: '§ 8.2 — acte provincial' }, { id: 'SIGNAL', label: 'Signaux' },
          ]} />
          <DataTable rows={items} rowKey={(o) => o.id} caption="Opportunités"
            empty={<EmptyState title="Aucune opportunité" icon="file" />}
            columns={[
              { key: 'c', label: 'Piste', primary: true, render: (o) => <button type="button" className="btn btn-ghost btn-sm op-link" aria-pressed={sel === o.id} onClick={() => setSel(o.id)}>{o.code} — {o.title}</button> },
              { key: 't', label: 'Voie', render: (o) => <span className="small">{TRACK_LABELS[o.track] ?? o.track}</span> },
              { key: 'p', label: 'Priorité', num: true, render: (o) => o.cahierPriority ?? '—' },
              { key: 's', label: 'Avancement', render: (o) => o.decision ? <StatusBadge tone={outcomeTone(o.decision)} label={OUTCOME_LABELS[o.decision] ?? o.decision} /> : <span className="small">{o.completed}/8 · {o.nextStep ? `${o.nextStep.n}. ${o.nextStep.label}` : ''}</span> },
            ]} />
          {sel && (detail.loading && !detail.data ? <Loading /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : detail.data && (
            <section className="panel op-sheet" aria-label="Fiche d’opportunité"><OpportunitySheet opp={detail.data} roles={roles} onChange={reload} /></section>
          ))}
          {scope.data && (
            <section className="panel" aria-labelledby="op-scope">
              <h2 className="panel-title" id="op-scope">Champ du moteur de découverte (§ 8.4) — {scope.data.domains.length} domaines</h2>
              <p className="small muted">Agent « {scope.data.agent.name} » : {scope.data.agent.never}</p>
              <ul className="op-chips">
                {scope.data.domains.map((d) => <li key={d.code}><span className="op-chip">{d.label}{d.opportunities.length ? ` · ${d.opportunities.length}` : ''}</span></li>)}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
