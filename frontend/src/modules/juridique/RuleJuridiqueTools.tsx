/**
 * Outils juridiques d'une fiche de règle (registre § 6.2, § 11.2, § 44) :
 *  - vue technique : la même fiche sous les attributs techniques du Cahier (snake_case), avec la table de correspondance ;
 *  - cas de tests juridiques (entrées → résultat attendu, validés par un juriste vérificateur distinct de l'auteur) et
 *    simulation sur échantillon réel, exigés avant la publication d'une catégorie exécutable.
 */
import { useState } from 'react';
import { ficheTechnique, RULE_TECHNICAL_ATTRIBUTES, TAXABLE_EVENT_LABELS, type LegalTestCase, type LegalTestRun, type RuleSheet } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState } from '../../components/States';

/** Vue technique (attributs du registre, noms du Cahier). */
export function RuleTechnicalView({ rule }: { rule: RuleSheet }) {
  // Conversion justifiée : affichage générique clé → valeur de la fiche technique.
  const fiche = ficheTechnique(rule) as unknown as Record<string, unknown>;
  const show = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : v === null ? 'null' : JSON.stringify(v));
  return (
    <div className="stack">
      <p className="small muted">Vue technique : chaque champ de la fiche est porté par un attribut du registre des règles de recettes (Revenue Rule Registry), lisible par le juriste et exécutable par le moteur.</p>
      {rule.taxableEventKind && <p className="small">Fait générateur typé : <strong>{TAXABLE_EVENT_LABELS[rule.taxableEventKind]}</strong></p>}
      <DataTable
        caption="Attributs techniques du registre"
        rows={[...RULE_TECHNICAL_ATTRIBUTES]}
        rowKey={(a) => a.attribut}
        columns={[
          { key: 'a', label: 'Attribut technique', primary: true, render: (a) => <code className="mono">{a.attribut}</code> },
          { key: 'c', label: 'Champ de la fiche', render: (a) => a.champ },
          { key: 'v', label: 'Valeur', full: true, render: (a) => <code className="mono small lr-tech-value">{show(fiche[a.attribut])}</code> },
        ]}
      />
    </div>
  );
}

interface GateStatus {
  required: boolean; dispense: boolean; cases: number; validated: number; lastRun: LegalTestRun | null;
  sample: { id: string; at: string; size: number; computed: number; errors: number } | null;
  blocker: { code: string; detail: string } | null;
}
interface SampleSimulation { id: string; at: string; by: string; source: string; size: number; computed: number; errors: number; totals: { amount: string; previousAmount: string | null; currency: string } }
interface TestsView { gate: GateStatus; cases: LegalTestCase[]; runs: LegalTestRun[]; sampleSimulations: SampleSimulation[] }

const FROZEN = ['PUBLIEE', 'ACTIVE', 'SUSPENDUE', 'EXPIREE', 'ABROGEE', 'ARCHIVEE'];
const expectedText = (e: LegalTestCase['expected']) => ('amount' in e ? e.amount : `erreur ${e.errorCode}`);

/** « clé = valeur » séparés par des virgules → entrées de la formule. */
function parseInputs(s: string): Record<string, string> {
  return Object.fromEntries(s.split(/[,;\n]/).map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]).map((p) => [p[0]!, p[1]!]));
}

export function RuleLegalTests({ rule, onChanged }: { rule: RuleSheet & { status: string }; onChanged?: () => void }) {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<TestsView>(`/v1/legal-rules/${encodeURIComponent(rule.id)}/test-cases`), [rule.id, user?.id]);
  const [form, setForm] = useState({ label: '', inputs: '', rank: '1', expected: '', errorCode: '' });
  const [sample, setSample] = useState({ source: '', rows: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const roles = user?.roles ?? [];
  const frozen = FROZEN.includes(rule.status);
  const canWrite = !frozen && roles.some((r) => r === 'R13' || r === 'R14');
  const canValidate = !frozen && roles.includes('R14');
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); q.reload(); onChanged?.(); } catch (x) { const d = describeError(x); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); } finally { setBusy(false); }
  };
  const base = `/v1/legal-rules/${encodeURIComponent(rule.id)}`;
  const v = q.data;
  return (
    <div className="stack">
      {q.error !== null && <p className="small muted">Cas de tests indisponibles hors ligne.</p>}
      {v && (
        <>
          {!v.gate.required ? <p className="small muted">Catégorie non exécutable (acte requis ou recette centrale) : aucun cas exigé, aucune liquidation possible.</p>
            : v.gate.blocker ? <p className="callout callout-warn small" role="note">Publication bloquée : {v.gate.blocker.detail} ({v.gate.blocker.code})</p>
              : <p className="notice notice-ok small">{v.gate.dispense && !v.gate.cases ? 'Règle de démonstration (textes fictifs) : dispense tracée.' : 'Cas validés et en succès, échantillon joint : contrôle fiscal satisfait.'}</p>}
          <p className="small">Cas : {v.gate.cases} · validés : {v.gate.validated}{v.gate.lastRun ? ` · dernière exécution ${fmtDate(v.gate.lastRun.at, true)} : ${v.gate.lastRun.passed}/${v.gate.lastRun.total} en succès` : ''}{v.gate.sample ? ` · échantillon ${v.gate.sample.size} dossier(s)` : ''}</p>
          {v.cases.length === 0 ? <EmptyState title="Aucun cas de test juridique" /> : (
            <DataTable
              caption="Cas de tests juridiques"
              rows={v.cases}
              rowKey={(c) => c.id}
              columns={[
                { key: 'l', label: 'Cas', primary: true, render: (c) => <><span className="row-title">{c.label}</span><span className="account-code">{c.id}</span></> },
                { key: 'i', label: 'Entrées', render: (c) => <span className="mono small">{Object.entries(c.inputs).map(([k, x]) => `${k} = ${x}`).join(' · ') || '—'} · rang {c.localityRank}</span> },
                { key: 'e', label: 'Attendu', num: true, render: (c) => <span className="mono">{expectedText(c.expected)}</span> },
                { key: 'r', label: 'Résultat', render: (c) => { const r = v.runs.at(-1)?.results.find((x) => x.caseId === c.id); return r ? <StatusBadge tone={r.passed ? 'good' : 'critical'} label={r.passed ? 'Succès' : 'Échec'} /> : <span className="small muted">Non exécuté</span>; } },
                { key: 'v', label: 'Validation', render: (c) => (c.validatedBy ? <span className="small">Validé par {c.validatedBy}</span>
                  : canValidate && c.addedBy !== user?.id ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => api(`${base}/test-cases/${encodeURIComponent(c.id)}/validate`, { method: 'POST' }), 'Cas validé.')}>Valider (juriste)</button>
                    : <span className="small muted">À valider par un juriste vérificateur distinct de l’auteur</span>) },
              ]}
            />
          )}
          <div className="btn-row">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !v.cases.length} onClick={() => void act(() => api(`${base}/test-cases/run`, { method: 'POST' }), 'Cas exécutés ; résultat conservé avec la version.')}>Exécuter les cas</button>
          </div>
          {canWrite && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void act(() => api(`${base}/test-cases`, { method: 'POST', body: {
              label: form.label, inputs: parseInputs(form.inputs), localityRank: Number(form.rank) || 1,
              expected: form.errorCode.trim() ? { errorCode: form.errorCode.trim() } : { amount: form.expected.trim() },
            } }), 'Cas ajouté : à valider par un juriste vérificateur.'); }}>
              <p className="small muted">Ajouter un cas (entrées de la formule seulement : les taux viennent de la table certifiée).</p>
              <div className="field"><label className="label" htmlFor="tc-label">Libellé du cas</label><input id="tc-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></div>
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="tc-inputs">Entrées (clé = valeur)</label><input id="tc-inputs" className="mono" value={form.inputs} onChange={(e) => setForm({ ...form, inputs: e.target.value })} placeholder="superficie_m2 = 100" /></div>
                <div className="field"><label className="label" htmlFor="tc-rank">Rang de localité</label><select id="tc-rank" value={form.rank} onChange={(e) => setForm({ ...form, rank: e.target.value })}>{['1', '2', '3', '4'].map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
              </div>
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="tc-exp">Montant attendu</label><input id="tc-exp" className="mono" value={form.expected} onChange={(e) => setForm({ ...form, expected: e.target.value })} /></div>
                <div className="field"><label className="label" htmlFor="tc-err">ou code d’erreur attendu (cas négatif)</label><input id="tc-err" className="mono" value={form.errorCode} onChange={(e) => setForm({ ...form, errorCode: e.target.value })} /></div>
              </div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || form.label.trim().length < 3 || (!form.expected.trim() && !form.errorCode.trim())}>Ajouter le cas</button>
            </form>
          )}
          <h4 className="h-sub">Simulation sur échantillon réel</h4>
          {v.sampleSimulations.length ? (
            <ul className="plain-list small">{v.sampleSimulations.map((s) => <li key={s.id}>{fmtDate(s.at, true)} — {s.source} : {s.computed}/{s.size} calculé(s), {s.errors} erreur(s), total {s.totals.amount} {s.totals.currency}{s.totals.previousAmount ? ` (antérieur ${s.totals.previousAmount})` : ''} · non opposable</li>)}</ul>
          ) : <p className="small muted">Aucune simulation jointe.</p>}
          {!frozen && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void act(() => api(`${base}/sample-simulations`, { method: 'POST', body: {
              source: sample.source,
              ...(sample.rows.trim() ? { rows: sample.rows.split('\n').filter((l) => l.trim()).map((l) => { const [ref, inputs, rank, prev] = l.split('|').map((x) => x.trim()); return { ref: ref ?? '', inputs: parseInputs(inputs ?? ''), localityRank: Number(rank) || 1, ...(prev ? { previousAmount: prev } : {}) }; }) } : {}),
            } }), 'Simulation jointe à la version (non opposable).'); }}>
              <div className="field"><label className="label" htmlFor="ss-src">Provenance de l’échantillon</label><input id="ss-src" value={sample.source} onChange={(e) => setSample({ ...sample, source: e.target.value })} placeholder="Dossiers réels anonymisés de la campagne précédente" /></div>
              <div className="field"><label className="label" htmlFor="ss-rows">Dossiers versés (facultatif ; une ligne : référence | clé = valeur | rang | montant antérieur)</label><textarea id="ss-rows" rows={3} className="mono" value={sample.rows} onChange={(e) => setSample({ ...sample, rows: e.target.value })} /></div>
              <span className="hint">Les liquidations antérieures du même code sont reprises automatiquement (traces figées).</span>
              <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || sample.source.trim().length < 10}>Simuler sur l’échantillon</button>
            </form>
          )}
        </>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
    </div>
  );
}
