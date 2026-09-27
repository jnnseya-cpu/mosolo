/**
 * Référentiel des recettes (Cahier ch. 7) : § 7.1 impôts provinciaux, § 7.2 taxes d'intérêt commun (clé à certifier),
 * § 7.3 recettes spécifiques à Kinshasa, ancien IPM (recette ETD non activée), recettes administratives § 7.5,
 * inventaire de référence § 7.4 (« non renseigné » tant que non documenté) et registre des codes non réutilisables.
 * Aucun taux ni montant n'est affiché : le montant vient d'une règle ACTIVE du registre (quatre visas).
 */
import { useState, type FormEvent } from 'react';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import './referentiel.css';

interface InventoryAttr { key: string; label: string; expected: string; value: string; renseigne: boolean; source: string | null }
export interface RevenueLineView {
  code: string; section: string; label: string; object: string; liableWhere: string; capture: string; yield: string; competence: string; competenceLabel: string;
  sharingKey?: string; revenueCategory: string; status: string; space: string; provincialScope: boolean; modules: number[]; vertical?: string; credentialTypes?: string[]; note?: string;
  codeStatus: string; activation: { activable: boolean; reasons: string[] }; inventory?: InventoryAttr[];
}
interface AdminRevenue { code: string; label: string; nature: string; linkedTo: { kind: string; ref: string; label: string }; status: string; linkResolved: boolean }
interface PublicPayload { items: RevenueLineView[]; administrative: AdminRevenue[]; spaces: { id: string; label: string; active: boolean; note: string }[]; notice: string }
interface CodeEntry { code: string; label: string; origin: string; status: string; reservedBy: string; retirement?: { motif: string; at: string } }

const SECTIONS: { id: string; title: string }[] = [
  { id: '7.1', title: '§ 7.1 — Impôts provinciaux' },
  { id: '7.2', title: '§ 7.2 — Taxes d’intérêt commun' },
  { id: '7.3', title: '§ 7.3 — Taxes, droits et redevances spécifiques à Kinshasa' },
  { id: '6.3', title: 'Recettes des entités territoriales décentralisées (§ 6.3)' },
];
const AGENTS = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R11', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R22', 'R23'];

function Inventory({ line, canEdit, onSaved }: { line: RevenueLineView; canEdit: boolean; onSaved: () => void }) {
  const [key, setKey] = useState(line.inventory?.[0]?.key ?? 'administration');
  const [value, setValue] = useState('');
  const [source, setSource] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try { await api(`/v1/referentiel/recettes/${line.code}/inventaire`, { method: 'POST', body: { key, value, source } }); setValue(''); setSource(''); onSaved(); } catch (ex) { setErr(describeError(ex).message); }
  };
  return (
    <details className="panel-sub">
      <summary>Inventaire de référence (§ 7.4) — {line.inventory?.filter((a) => a.renseigne).length ?? 0}/{line.inventory?.length ?? 0} attributs renseignés</summary>
      <dl className="kv">
        {line.inventory?.map((a) => (
          <div key={a.key}><dt>{a.label}</dt><dd className={a.renseigne ? '' : 'muted'}>{a.value}{a.source ? <span className="small muted"> — source : {a.source}</span> : null}</dd></div>
        ))}
      </dl>
      {canEdit && (
        <form className="stack-sm" onSubmit={submit}>
          <label className="label" htmlFor={`inv-k-${line.code}`}>Attribut</label>
          <select id={`inv-k-${line.code}`} value={key} onChange={(e) => setKey(e.target.value)}>{line.inventory?.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</select>
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Valeur documentée" aria-label="Valeur documentée" />
          <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source (texte, relevé, rapport…)" aria-label="Source" />
          {err && <p className="err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-secondary btn-sm" disabled={!value.trim() || source.trim().length < 3}>Enregistrer (tracé)</button>
          <p className="hint">Une valeur inconnue reste « non renseigné » : rien n’est estimé à la place de la source.</p>
        </form>
      )}
    </details>
  );
}

function Codes() {
  const { user } = useApp();
  const q = useApi(() => api<{ items: CodeEntry[] }>('/v1/referentiel/codes'), [user?.id]);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const roles = user?.roles ?? [];
  const reserve = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await api('/v1/referentiel/codes', { method: 'POST', body: { code, label } }); setCode(''); setLabel(''); q.reload(); } catch (ex) { setErr(describeError(ex).message); }
  };
  const retire = async (c: string) => {
    const motif = window.prompt('Motif du retrait (le code ne pourra jamais être réutilisé)');
    if (!motif || motif.trim().length < 5) return;
    setErr(null);
    try { await api(`/v1/referentiel/codes/${encodeURIComponent(c)}/retrait`, { method: 'POST', body: { motif } }); q.reload(); } catch (ex) { setErr(describeError(ex).message); }
  };
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="panel-title"><Icon name="lock" size={18} /> Codes de recette stables et non réutilisables (§ 6.2)</h2><span className="count">{q.data?.items.length ?? 0}</span></div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {(roles.includes('R13') || roles.includes('R14')) && (
        <form className="row-wrap" onSubmit={reserve}>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Nouveau code (ex. R73-XXX)" aria-label="Nouveau code" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Libellé" aria-label="Libellé" />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={code.length < 3 || label.trim().length < 3}>Réserver le code</button>
        </form>
      )}
      <DataTable rows={q.data?.items ?? []} rowKey={(c) => c.code} empty={<EmptyState title="Aucun code" />}
        columns={[
          { key: 'c', label: 'Code', primary: true, render: (c) => <span className="mono">{c.code}</span> },
          { key: 'l', label: 'Libellé', render: (c) => c.label },
          { key: 's', label: 'Statut', render: (c) => <StatusBadge tone={c.status === 'RETIRE' ? 'neutral' : 'good'} label={c.status === 'RETIRE' ? `Retiré — jamais réutilisé${c.retirement ? ` (${c.retirement.motif})` : ''}` : 'Actif'} /> },
          { key: 'x', label: '', render: (c) => (roles.includes('R14') || roles.includes('R16')) && c.status !== 'RETIRE' ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void retire(c.code)}>Retirer</button> : null },
        ]} />
    </section>
  );
}

export default function Recettes() {
  const { user } = useApp();
  const agent = !!user?.roles.some((r) => AGENTS.includes(r));
  const pub = useApi(() => api<PublicPayload>('/v1/public/referentiel/recettes'), []);
  const full = useApi(agent ? () => api<{ items: RevenueLineView[] }>('/v1/referentiel/recettes') : null, [user?.id, agent]);
  const canEdit = !!user?.roles.some((r) => ['R05', 'R06', 'R07', 'R13', 'R14'].includes(r));
  const lines = full.data?.items ?? pub.data?.items ?? [];
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Paysage des recettes (Cahier ch. 7)" title="Référentiel des recettes"
        lead="Chaque recette avec son objet, ses assujettis, son mécanisme de capture, son rendement et sa compétence. Toutes les lignes sont à vérifier : aucune n’est exigible sans règle active du registre." />
      {pub.loading && <Loading />}
      {!!pub.error && <ErrorState error={pub.error} onRetry={pub.reload} />}
      {pub.data && (
        <div className="stack">
          <div className="callout callout-info"><Icon name="info" size={18} /><p>{pub.data.notice} Aucun taux n’est porté par le référentiel.</p></div>
          {SECTIONS.map((s) => {
            const rows = lines.filter((l) => l.section === s.id);
            return (
              <section key={s.id} className="panel" aria-labelledby={`sec-${s.id}`}>
                <div className="panel-head"><h2 className="panel-title" id={`sec-${s.id}`}>{s.title}</h2><span className="count">{rows.length}</span></div>
                <ul className="list-rows">
                  {rows.map((l) => (
                    <li key={l.code} className="list-row list-row-stack">
                      <div className="row-between">
                        <div className="min0">
                          <p className="row-title">{l.label} <span className="mono small muted">{l.code}</span></p>
                          <p className="small"><strong>Objet :</strong> {l.object} · <strong>Rendement :</strong> {l.yield}</p>
                          <p className="small"><strong>Où sont les assujettis :</strong> {l.liableWhere} · <strong>Capture :</strong> {l.capture}</p>
                          <p className="small muted">{l.competenceLabel}{l.sharingKey ? ` — ${l.sharingKey}` : ''}{l.note ? ` — ${l.note}` : ''}</p>
                        </div>
                        <div className="row-side">
                          <StatusBadge tone="warning" label="À vérifier" />
                          {l.space === 'COMMUNAL' && <StatusBadge tone="neutral" label="Espace communal — non activé" />}
                        </div>
                      </div>
                      {!l.activation.activable && <p className="small muted">Non activable : {l.activation.reasons.join(' ')}</p>}
                      {l.inventory && <Inventory line={l} canEdit={canEdit} onSaved={full.reload} />}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <section className="panel">
            <div className="panel-head"><h2 className="panel-title"><Icon name="file" size={18} /> § 7.5 — Recettes administratives</h2><span className="count">{pub.data.administrative.length}</span></div>
            <DataTable rows={pub.data.administrative} rowKey={(a) => a.code}
              columns={[
                { key: 'l', label: 'Recette', primary: true, render: (a) => <span>{a.label} <span className="mono small muted">{a.code}</span></span> },
                { key: 'n', label: 'Nature', render: (a) => a.nature.toLowerCase() },
                { key: 'r', label: 'Rattachée à', render: (a) => `${a.linkedTo.kind === 'DEMARCHE' ? 'Démarche' : a.linkedTo.kind === 'ACTE' ? 'Acte' : 'Prestation'} : ${a.linkedTo.label}` },
                { key: 's', label: 'Statut', render: () => <StatusBadge tone="warning" label="À vérifier" /> },
              ]} />
          </section>
          <section className="panel">
            <h2 className="panel-title"><Icon name="users" size={18} /> Espaces de recettes</h2>
            <ul className="list-rows">{pub.data.spaces.map((s) => <li key={s.id} className="list-row"><div className="min0"><p className="row-title">{s.label}</p><p className="small muted">{s.note}</p></div><StatusBadge tone={s.active ? 'good' : 'neutral'} label={s.active ? 'Actif' : 'Non activé'} /></li>)}</ul>
          </section>
          {agent && <Codes />}
        </div>
      )}
    </div>
  );
}
