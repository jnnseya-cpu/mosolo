/**
 * Élargissement d'assiette de l'édit budgétaire 2026 (§ 16.3) : baux emphytéotiques, loyers des sociétés immobilières,
 * indemnités de logement. Formulaire propre à chaque cas, contrôle de cohérence, voie de recours identifiée. Les règles
 * sont « À VÉRIFIER » : la déclaration est enregistrée et instruite, sans aucune liquidation.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { FiscalTabs, useViewer } from './common';
import './fiscal.css';
import { AssietteVisuels } from './visuels';

interface Field { name: string; label: string; type: string; required: boolean; choices?: string[]; objectAttribute?: boolean }
interface CaseDef { code: string; label: string; ruleCode: string; appealPath: string; fields: Field[]; coherence: string[]; rules: { code: string; version: number; status: string }[]; active: boolean; notice: string }
interface Decl { id: string; case: string; period: string; status: string; liquidation: string; coherence: { check: string; ok: boolean; detail: string }[]; acknowledgement: { number: string; at: string }; appealPath: string }

function Form({ c, onDone }: { c: CaseDef; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [period, setPeriod] = useState(String(new Date().getFullYear()));
  const [attest, setAttest] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Decl | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { setRes(await api<Decl>('/v1/fiscal/assiette-2026/declarations', { method: 'POST', body: { case: c.code, period, values, attest } })); onDone(); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <form className="stack-sm" onSubmit={(e) => void go(e)}>
      <div className="field"><label className="label" htmlFor={`a26-${c.code}-p`}>Exercice</label><input id={`a26-${c.code}-p`} value={period} onChange={(e) => setPeriod(e.target.value)} pattern="\d{4}" required /></div>
      {c.fields.map((f) => (
        <div key={f.name} className="field">
          <label className="label" htmlFor={`a26-${c.code}-${f.name}`}>{f.label}{f.required ? '' : ' (facultatif)'}{f.objectAttribute ? ' — attribut de l’objet' : ''}</label>
          {f.choices ? (
            <select id={`a26-${c.code}-${f.name}`} value={values[f.name] ?? ''} required={f.required} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}><option value="">—</option>{f.choices.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ').toLowerCase()}</option>)}</select>
          ) : <input id={`a26-${c.code}-${f.name}`} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'nombre' ? 'decimal' : undefined} value={values[f.name] ?? ''} required={f.required} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />}
        </div>
      ))}
      <label className="small"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> J’atteste l’exactitude de ma déclaration.</label>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary btn-sm" disabled={!attest}>Déposer (aucune liquidation)</button>
      {res && (
        <div className="stack-sm" role="status">
          <p className="small">Accusé de réception <span className="mono">{res.acknowledgement.number}</span> — {res.status === 'ENREGISTREE_A_INSTRUIRE' ? 'enregistrée, à instruire' : res.status}.</p>
          <ul className="plain-list small">{res.coherence.map((k) => <li key={k.check}>{k.ok ? 'Cohérent' : 'À vérifier'} — {k.check} : {k.detail}</li>)}</ul>
        </div>
      )}
    </form>
  );
}

export default function Assiette2026() {
  const { user } = useApp();
  const { isTaxpayer } = useViewer();
  const q = useApi(() => api<{ cases: CaseDef[]; notice: string }>('/v1/fiscal/assiette-2026'), []);
  const mine = useApi(user ? () => api<Decl[]>('/v1/fiscal/assiette-2026/declarations') : null, [user?.id]);
  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Édit budgétaire 2026" title="Élargissement de l’assiette"
        lead="Trois nouveaux cas prévus par l’édit 2026. Tant que les règles ne sont pas certifiées et actives (quatre visas), vos déclarations sont enregistrées et instruites, sans calcul ni dette." />
      <FiscalTabs />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && <p className="small muted">{q.data.notice}</p>}
      {q.data && <AssietteVisuels cases={q.data.cases} decls={user ? mine.data ?? null : null} />}
      <div className="fs-grid">{(q.data?.cases ?? []).map((c) => (
        <article key={c.code} className="panel stack-sm">
          <div className="panel-head"><p className="panel-title">{c.label}</p><StatusBadge tone={c.active ? 'good' : 'warning'} label={c.active ? 'Règle active' : `Règle ${c.rules[0]?.status === 'A_VERIFIER' ? 'À VÉRIFIER' : c.rules[0]?.status ?? 'absente'} — rien d’actif`} /></div>
          <p className="small muted"><span className="mono">{c.ruleCode}</span> · Voie de recours : {c.appealPath}</p>
          <p className="small">Contrôles de cohérence : {c.coherence.join(' ; ')}.</p>
          {isTaxpayer && <Form c={c} onDone={mine.reload} />}
        </article>))}</div>
      {mine.data && mine.data.length > 0 && (
        <section className="stack-sm"><h2 className="h-sub">Déclarations déposées</h2>
          <ul className="plain-list small">{mine.data.map((d) => <li key={d.id}><span className="mono">{d.acknowledgement.number}</span> — {d.case} {d.period} — {d.coherence.filter((k) => !k.ok).length} point(s) à vérifier — liquidation : aucune</li>)}</ul>
        </section>
      )}
    </div>
  );
}
