/**
 * Reprise de l'existant — e-DGRK, télédéclaration, données administratives (§ 2, § 7.5, § 17.4 vague 0) : dépôt d'un
 * lot CSV ou JSON, validation à blanc avec rapport ligne par ligne, intégration par une SECONDE personne, provenance
 * « e-DGRK » sur chaque donnée, doublons proposés (jamais de fusion silencieuse), historique repris sans obligation.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { FiscalTabs, ReasonAction, useViewer } from './common';
import './fiscal.css';

interface Line { line: number; type: string; ref: string; ok: boolean; errors: string[]; outcome?: string; createdId?: string }
interface Dedup { line: number; ref: string; kind: string; candidateId: string; status: string; mergeId?: string }
interface Batch {
  id: string; sourceLabel: string; format: string; uploadedBy: string; uploadedAt: string; status: string; committedBy?: string; notice: string;
  report: { total: number; valid: number; invalid: number; lines: Line[]; byType: Record<string, number> };
  dedup: Dedup[]; history: { ref: string; fiscalYear: string; revenueLabel: string; amount: { amount: string; currency: string }; paymentStatus: string; note: string }[];
}

const DEDUP_LABEL: Record<string, string> = {
  COMPTE_MEME_TELEPHONE: 'Compte existant avec le même téléphone', COMPTE_MEME_NIF: 'Compte existant avec le même NIF', COMPTE_NOM_PROCHE: 'Compte existant au nom identique',
  OBJET_MEME_IGF: 'Objet existant (même IGF)', OBJET_MEME_EMPLACEMENT: 'Objet existant au même emplacement',
};
const SAMPLE = 'type;ref_externe;nom;telephone;nif;forme;categorie;commune;quartier;rang;lat;lon;superficie_m2;compte_ref;exercice;recette;montant;devise;statut_paiement\nCOMPTE;E-EXEMPLE-1;Nom fictif;+243800000000;;PP;;;;;;;;;;;;;';

function BatchCard({ b, onChanged }: { b: Batch; onChanged: () => void }) {
  const { user, fmtDate } = useApp();
  const { has } = useViewer();
  const [err, setErr] = useState<string | null>(null);
  async function commit() {
    setErr(null);
    try { await api(`/v1/fiscal/imports/${b.id}/commit`, { method: 'POST' }); onChanged(); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <li className="panel stack-sm">
      <div className="panel-head">
        <div className="min0"><p className="panel-title">Lot <span className="mono">{b.id}</span> — {b.sourceLabel}</p><p className="panel-sub">{b.format} · déposé par {b.uploadedBy} le {fmtDate(b.uploadedAt, true)}{b.committedBy ? ` · intégré par ${b.committedBy}` : ''}</p></div>
        <StatusBadge tone={b.status === 'INTEGRE' ? 'good' : 'warning'} label={b.status === 'INTEGRE' ? 'Intégré' : 'Validé à blanc — intégration par une seconde personne'} />
      </div>
      <p className="small">{b.report.total} ligne(s) : {b.report.valid} valide(s), {b.report.invalid} rejetée(s) · {Object.entries(b.report.byType).map(([k, v]) => `${k} ${v}`).join(', ')}</p>
      <div className="rtable-wrap"><table className="data-table rtable compact">
        <thead><tr><th>Ligne</th><th>Type</th><th>Référence</th><th>Résultat</th></tr></thead>
        <tbody>{b.report.lines.map((l) => (
          <tr key={l.line}><td data-label="Ligne">{l.line}</td><td data-label="Type">{l.type}</td><td data-label="Référence" className="mono">{l.ref}</td>
            <td data-label="Résultat">{l.ok ? (l.outcome ?? 'Valide') : <strong>Rejetée : {l.errors.join(' ; ')}</strong>}</td></tr>))}</tbody>
      </table></div>
      {b.dedup.length > 0 && (
        <div className="stack-sm">
          <p className="h-sub">Doublons probables — aucune fusion silencieuse</p>
          {b.dedup.map((d) => (
            <div key={d.line} className="stack-sm">
              <p className="small">Ligne {d.line} ({d.ref}) : {DEDUP_LABEL[d.kind] ?? d.kind} <span className="mono">{d.candidateId}</span> — {d.status === 'PROPOSITION_DE_FUSION' ? `fusion proposée ${d.mergeId} (registre d’identité, double validation)` : d.status}</p>
              {b.status === 'INTEGRE' && d.status === 'A_EXAMINER' && has('R06', 'R07', 'R11') && (
                <div className="btn-row">
                  <ReasonAction label="Rattacher à l’existant" confirmLabel="Rattacher (sans écraser)" onSubmit={(reason) => api(`/v1/fiscal/imports/${b.id}/duplicates/${d.line}/decision`, { method: 'POST', body: { decision: 'RATTACHER', reason } }).then(onChanged)} />
                  <ReasonAction label="Créer distinct" confirmLabel="Créer un enregistrement distinct" tone="secondary" onSubmit={(reason) => api(`/v1/fiscal/imports/${b.id}/duplicates/${d.line}/decision`, { method: 'POST', body: { decision: 'CREER_DISTINCT', reason } }).then(onChanged)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {b.history.length > 0 && <p className="small">Historique repris (information, aucune obligation) : {b.history.map((h) => `${h.fiscalYear} ${h.revenueLabel} ${h.amount.amount} ${h.amount.currency} ${h.paymentStatus === 'PAYE' ? 'payé' : 'impayé'}`).join(' ; ')}</p>}
      {b.status === 'VALIDE_A_BLANC' && has('R06', 'R07', 'R11') && user?.id !== b.uploadedBy && <button type="button" className="btn btn-primary btn-sm" onClick={() => void commit()}>Intégrer le lot</button>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <p className="small muted">{b.notice}</p>
    </li>
  );
}

export default function Reprise() {
  const { user } = useApp();
  const { has } = useViewer();
  const q = useApi(() => api<Batch[]>('/v1/fiscal/imports'), [user?.id]);
  const [f, setF] = useState({ source: 'E_DGRK', format: 'CSV', content: '' });
  const [err, setErr] = useState<string | null>(null);
  async function upload(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      const content = f.format === 'JSON' ? (JSON.parse(f.content) as unknown) : f.content;
      await api('/v1/fiscal/imports', { method: 'POST', body: { source: f.source, format: f.format, content } }); setF({ ...f, content: '' }); q.reload();
    } catch (x) { setErr(x instanceof SyntaxError ? 'JSON invalide.' : describeError(x).message); }
  }
  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Reprise de l’existant" title="Reprise e-DGRK et import par lots"
        lead="Comptes, objets et historique de la télédéclaration et d’e-DGRK sont repris sans système parallèle : validation à blanc, rapport par ligne, intégration par une seconde personne, provenance « e-DGRK » sur chaque donnée. Les doublons deviennent des propositions ; l’historique ne crée aucune dette." />
      <FiscalTabs />
      {has('R06', 'R07', 'R11', 'R12') && (
        <form className="panel stack-sm" onSubmit={(e) => void upload(e)}>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="im-src">Source</label><select id="im-src" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="E_DGRK">e-DGRK</option><option value="TELEDECLARATION">Télédéclaration DGRK</option><option value="DONNEES_ADMINISTRATIVES">Données administratives existantes</option></select></div>
            <div className="field"><label className="label" htmlFor="im-fmt">Format</label><select id="im-fmt" value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}><option value="CSV">CSV (en-tête, « ; » ou « , »)</option><option value="JSON">JSON (tableau d’objets)</option></select></div>
          </div>
          <div className="field"><label className="label" htmlFor="im-c">Contenu du lot</label><textarea id="im-c" rows={6} className="mono" placeholder={SAMPLE} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} required /></div>
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-primary btn-sm">Valider à blanc (rien n’est créé)</button>
        </form>
      )}
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && <EmptyState title="Aucun lot déposé." />}
      <ul className="stack">{(q.data ?? []).map((b) => <BatchCard key={b.id} b={b} onChanged={q.reload} />)}</ul>
    </div>
  );
}
