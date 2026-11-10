/**
 * « Départements, modules et variables » (27/09/2026, § 12A) — écran de l'administrateur de la plateforme (R26) et de
 * l'administrateur d'entité (R08, son entité et ses sous-entités) :
 *  - arborescence des entités ;
 *  - par entité : modules fonctionnels rattachés (interrupteurs, historique ; modules porteurs de recettes : circuit des
 *    fiches de module, seconde validation par une personne distincte), variables en vigueur avec leur provenance
 *    (entité → parente → globale) et les demandes en attente, comptes par type ;
 *  - graphiques de la trousse de visualisation : modules par entité, comptes par famille.
 * Présentation : le serveur applique toujours les droits (ABAC) ; aucune action n'est ouverte à l'IA.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { PageHead } from '../../components/Shell';
import { Chip } from '../../components/StatusBadge';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { BarChartViz, ChartGrid, DonutViz, fmtNombre } from '../../components/viz';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { countBy } from '../../lib/aggregate';
import { Status, Tabs, useAction } from './common';
import './acces.css';
import './departements.css';

export interface DeptNode {
  id: string; name: string; shortName: string; kind: string; kindLabel: string; parentId: string | null; status: string; demo: boolean;
  modules: number; accounts: number; pendingLinks: number;
}
export interface LinkRow {
  id: string; moduleCode: string; moduleLabel: string; entity: string; revenue: boolean; action: string; status: string; from: string; to?: string;
  motif: string; actReference?: string; circuit?: string; createdBy: string; createdAt: string; history: { at: string; by: string; action: string; note?: string }[];
  moduleConfigId?: string; effectiveNow: boolean; demo?: boolean;
}
export interface EntityModule {
  code: string; label: string; kind: 'MODULE' | 'VERTICALE'; revenue: boolean; revenueScope: string | null; linkable: boolean; screens: string[];
  attached: boolean; inheritedFrom: string[]; source: 'LIEN' | 'FICHE' | null; sharedRead: boolean; pending: { id: string; circuit?: string; action: string }[];
}
export interface EntityView {
  entity: { id: string; name: string; shortName: string; kind: string; kindLabel: string; parentId: string | null; status: string; lineage: string[] };
  modules: EntityModule[];
  history: LinkRow[];
  accountsByType: { role: string; label: string; family: string; familyLabel: string; byStatus: Record<string, number>; total: number }[];
  users: { id: string; fullName: string; roles: string[]; status: string }[];
  contracts: { id: string; reference: string; roles: string[]; status: string }[];
}
export interface EffectiveParam {
  id: string; label: string; category: string; unit: string; owner: string; globalValue: number | boolean; value: number | boolean;
  provenance: 'ENTITE' | 'ENTITE_PARENTE' | 'GLOBAL'; sourceEntity: string | null; modulable: boolean; modulableStatus?: string; consumer?: string;
  min?: number; max?: number; override: { value: number | boolean; effectiveFrom: string } | null; programmed: { entity: string; value: number | boolean; effectiveFrom: string }[];
  pending: { id: string; proposedValue: number | boolean; effectiveFrom?: string; proposedBy: string; removal?: boolean }[];
}
export interface Effectifs { entity: string; lineage: string[]; resolution: string; modulableStatus: string; items: EffectiveParam[]; note: string }

export const PROVENANCE_LABEL: Record<EffectiveParam['provenance'], string> = {
  ENTITE: 'Valeur propre à l’entité', ENTITE_PARENTE: 'Héritée d’une entité parente', GLOBAL: 'Valeur globale du registre',
};

function depthOf(e: DeptNode, byId: Map<string, DeptNode>): number {
  let d = 0; let p = e.parentId;
  while (p && byId.has(p) && d < 4) { d++; p = byId.get(p)!.parentId; }
  return d;
}

/** Arborescence ordonnée (parents avant enfants, ordre alphabétique français). */
export function orderDepts(list: DeptNode[]): DeptNode[] {
  const out: DeptNode[] = [];
  const ids = new Set(list.map((x) => x.id));
  const visit = (parent: string | null) => {
    for (const e of list.filter((x) => (parent === null ? !x.parentId || !ids.has(x.parentId) : x.parentId === parent)).sort((a, b) => a.name.localeCompare(b.name, 'fr'))) {
      if (out.includes(e)) continue;
      out.push(e); visit(e.id);
    }
  };
  visit(null);
  return out;
}

type Tab = 'modules' | 'variables' | 'comptes' | 'historique';

function AttachForm({ entity, m, onDone, act }: { entity: string; m: EntityModule; onDone: () => void; act: ReturnType<typeof useAction> }) {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ motif: '', from: today, to: '', actReference: '' });
  const detach = m.attached;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = detach
      ? await act.run(() => api<{ effect: string }>(`/v1/acces/departements/${entity}/modules/${m.code}/detachement`, { method: 'POST', body: { motif: f.motif, ...(f.to ? { to: f.to } : {}) } }),
        (x) => (x.effect === 'SECONDE_VALIDATION_REQUISE' ? 'Retrait proposé : décision par une personne distincte (Gouverneur, Cabinet ou ministre des Finances).' : 'Module détaché ; acte journalisé.'))
      : await act.run(() => api<{ effect: string }>(`/v1/acces/departements/${entity}/modules`, {
        method: 'POST', body: { moduleCode: m.code, motif: f.motif, from: f.from, ...(f.to ? { to: f.to } : {}), ...(f.actReference ? { actReference: f.actReference } : {}) },
      }), (x) => ({
        EN_VIGUEUR: 'Module rattaché ; acte journalisé.', PROGRAMME: 'Rattachement programmé à la date d’effet.',
        SECONDE_VALIDATION_REQUISE: 'Réattribution proposée : décision par le Gouverneur ou le Cabinet (personne distincte).',
        CIRCUIT_DE_LA_FICHE: 'Fiche de module créée en brouillon : visas programme et juridique, recette, activation par le comité.',
        BLOQUE_ARBITRAGE: 'Compétence déjà revendiquée : fiche bloquée, dossier d’arbitrage ouvert.',
      } as Record<string, string>)[x.effect] ?? 'Demande enregistrée.');
    if (r) onDone();
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      {m.revenue && (
        <p className="ac-guard"><Icon name="scale" size={16} /> <span>Module porteur de recettes (compétence {m.revenueScope}) : {detach ? 'le retrait' : 'le rattachement'} suit le circuit des fiches de module — référence de l’acte, puis seconde validation par une personne distincte. Aucun effet avant cette décision.</span></p>
      )}
      <div className="field"><label className="label" htmlFor="dp-motif">Motif</label><textarea id="dp-motif" rows={3} value={f.motif} onChange={(e) => setF({ ...f, motif: e.target.value })} required minLength={5} /></div>
      {!detach && (
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="dp-from">Date d’effet</label><input id="dp-from" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} required /></div>
          <div className="field"><label className="label" htmlFor="dp-to">Date de fin (facultative)</label><input id="dp-to" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
        </div>
      )}
      {detach && !m.revenue && <div className="field"><label className="label" htmlFor="dp-to2">Date de fin (par défaut : aujourd’hui)</label><input id="dp-to2" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>}
      {!detach && m.revenue && <div className="field"><label className="label" htmlFor="dp-act">Référence de l’acte (arrêté, décision)</label><input id="dp-act" value={f.actReference} onChange={(e) => setF({ ...f, actReference: e.target.value })} required /></div>}
      {act.node}
      <button type="submit" className="btn btn-primary" disabled={act.busy || f.motif.trim().length < 5}>
        <Icon name={detach ? 'ban' : 'check'} size={18} /> {detach ? (m.revenue ? 'Proposer le retrait' : 'Détacher') : m.revenue ? 'Proposer le rattachement' : 'Rattacher'}
      </button>
    </form>
  );
}

function OverrideForm({ entity, p, onDone, act }: { entity: string; p: EffectiveParam; onDone: () => void; act: ReturnType<typeof useAction> }) {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ value: String(p.value), effectiveFrom: today, motif: '', removal: false });
  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = typeof p.globalValue === 'boolean' ? f.value === 'true' : Number(f.value);
    const r = await act.run(() => api('/v1/parametres/surcharges', {
      method: 'POST', body: { parameterId: p.id, entity, motif: f.motif, effectiveFrom: f.effectiveFrom, ...(f.removal ? { removal: true } : { value }) },
    }), 'Demande enregistrée : elle prend effet après approbation par une personne distincte (circuit du registre des seuils).');
    if (r) onDone();
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <p className="small muted">Valeur globale : <strong>{String(p.globalValue)} {p.unit}</strong> · bornes {p.min ?? '—'} à {p.max ?? '—'} · {p.modulableStatus}</p>
      {p.override && (
        <label className="dp-check"><input type="checkbox" checked={f.removal} onChange={(e) => setF({ ...f, removal: e.target.checked })} /> Retirer la surcharge (retour à la valeur héritée)</label>
      )}
      {!f.removal && (
        <div className="field"><label className="label" htmlFor="ov-v">Valeur pour l’entité ({p.unit})</label>
          {typeof p.globalValue === 'boolean'
            ? <select id="ov-v" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })}><option value="true">Oui</option><option value="false">Non</option></select>
            : <input id="ov-v" type="number" inputMode="numeric" value={f.value} min={p.min} max={p.max} onChange={(e) => setF({ ...f, value: e.target.value })} required />}
        </div>
      )}
      <div className="field"><label className="label" htmlFor="ov-d">Date d’effet</label><input id="ov-d" type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} required /></div>
      <div className="field"><label className="label" htmlFor="ov-m">Motif</label><textarea id="ov-m" rows={3} value={f.motif} onChange={(e) => setF({ ...f, motif: e.target.value })} minLength={10} required /></div>
      {act.node}
      <button type="submit" className="btn btn-primary" disabled={act.busy || f.motif.trim().length < 10}><Icon name="send" size={18} /> Proposer (quatre yeux)</button>
    </form>
  );
}

export default function Departements() {
  const { user } = useApp();
  const tree = useApi(() => api<{ items: DeptNode[] }>('/v1/acces/departements'), [user?.id]);
  const list = useMemo(() => orderDepts(tree.data?.items ?? []), [tree.data]);
  const byId = useMemo(() => new Map(list.map((e) => [e.id, e])), [list]);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked && byId.has(picked) ? picked : (list.find((e) => e.id === user?.entity)?.id ?? list[0]?.id ?? null);
  const view = useApi(selected ? () => api<EntityView>(`/v1/acces/departements/${selected}`) : null, [selected, user?.id]);
  const eff = useApi(selected ? () => api<Effectifs>(`/v1/parametres/effectifs?entity=${encodeURIComponent(selected)}&modulables=1`) : null, [selected, user?.id]);
  const [tab, setTab] = useState<Tab>('modules');
  const [q, setQ] = useState('');
  const [onlyAttached, setOnlyAttached] = useState(false);
  const [editModule, setEditModule] = useState<EntityModule | null>(null);
  const [editParam, setEditParam] = useState<EffectiveParam | null>(null);
  const act = useAction(user?.id);

  const modules = useMemo(() => (view.data?.modules ?? []).filter((m) => (!onlyAttached || m.attached || m.inheritedFrom.length > 0 || m.pending.length > 0)
    && (!q.trim() || `${m.code} ${m.label}`.toLowerCase().includes(q.trim().toLowerCase()))), [view.data, onlyAttached, q]);
  const barRows = useMemo(() => [...list].sort((a, b) => b.modules - a.modules).slice(0, 12).map((e) => ({ key: e.id, label: e.shortName, values: { modules: e.modules } })), [list]);
  const familySlices = useMemo(() => {
    const rows = (view.data?.accountsByType ?? []).flatMap((a) => Array.from({ length: a.total }, () => a));
    return countBy(rows, 'familyLabel').map((r) => ({ key: r.key, label: r.key, value: r.count }));
  }, [view.data]);
  const reloadAll = () => { tree.reload(); view.reload(); eff.reload(); };
  const v = view.data;

  return (
    <div className="page page-wide dp-page">
      <PageHead eyebrow="Accès et entités (§ 12A)" title="Départements, modules et variables"
        lead="Rattacher à chaque entité ses modules fonctionnels et ses variables. Les modules porteurs de recettes passent par le circuit des fiches de module ; toute variable passe par le circuit à deux personnes du registre des seuils." />
      {tree.error !== null && <ErrorState error={tree.error} onRetry={tree.reload} />}
      {tree.loading && <Loading />}
      {tree.data && (
        <div className="stack">
          <ChartGrid min={300}>
            <BarChartViz title="Modules rattachés par entité" subtitle="Rattachements en vigueur (liens directs et fiches de module actives)" orientation="horizontal" format={fmtNombre} tickFormat={(n) => (Number.isInteger(n) ? fmtNombre(n) : '')}
              series={[{ key: 'modules', label: 'Modules rattachés' }]} rows={barRows} emptyText="Aucune entité dans votre périmètre" />
            <DonutViz title={`Comptes par famille — ${v?.entity.shortName ?? '…'}`} centerLabel="comptes (par rôle)" format={fmtNombre} slices={familySlices}
              loading={view.loading} emptyText="Aucun compte dans cette entité" />
          </ChartGrid>

          <div className="ac-grid">
            <section className="panel" aria-labelledby="dp-tree">
              <header className="panel-head"><h2 className="panel-title" id="dp-tree">Entités</h2><span className="count">{list.length}</span></header>
              <ul className="ac-tree">
                {list.map((e) => (
                  <li key={e.id} className={`ac-indent-${Math.min(3, depthOf(e, byId))}`}>
                    <button type="button" className="ac-node" aria-pressed={selected === e.id} onClick={() => { setPicked(e.id); act.clear(); }}>
                      <span className="ac-node-main min0">
                        <span className="min0"><span className="ac-node-name">{e.shortName}</span><br />
                          <span className="ac-node-sub">{e.kindLabel} · {e.modules} module(s) · {e.accounts} compte(s) actif(s)</span></span>
                      </span>
                      {e.pendingLinks > 0 ? <span className="ac-count" title="Demandes en attente">{e.pendingLinks}</span> : e.status === 'SUSPENDUE' ? <Status s="SUSPENDUE" /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel" aria-labelledby="dp-ent">
              <header className="panel-head">
                <div className="min0"><h2 className="panel-title" id="dp-ent">{v?.entity.name ?? 'Entité'}</h2>
                  {v && <p className="panel-sub">{v.entity.kindLabel} · lignée : {v.entity.lineage.join(' → ')}</p>}</div>
              </header>
              {view.error !== null && <ErrorState error={view.error} onRetry={view.reload} />}
              {view.loading && <Loading />}
              {v && (
                <>
                  <Tabs<Tab> label="Volet de l’entité" value={tab} onChange={setTab} items={[
                    ['modules', 'Modules', v.modules.filter((m) => m.attached).length], ['variables', 'Variables', eff.data?.items.filter((i) => i.provenance !== 'GLOBAL').length],
                    ['comptes', 'Comptes', v.users.length], ['historique', 'Historique', v.history.length],
                  ]} />
                  {!editModule && !editParam && act.node}

                  {tab === 'modules' && (
                    <div className="stack-sm">
                      <div className="dp-filters">
                        <div className="field dp-search"><label className="label" htmlFor="dp-q">Rechercher un module</label><input id="dp-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="M38, stationnement…" /></div>
                        <label className="dp-check"><input type="checkbox" checked={onlyAttached} onChange={(e) => setOnlyAttached(e.target.checked)} /> Rattachés, hérités ou en attente</label>
                      </div>
                      <ul className="dp-modules" aria-label="Modules fonctionnels">
                        {modules.map((m) => {
                          const inherited = !m.attached && m.inheritedFrom.length > 0;
                          return (
                            <li key={m.code} className="dp-module">
                              <div className="min0">
                                <p className="dp-module-title"><span className="mono">{m.code}</span> {m.label}</p>
                                <p className="ac-meta">
                                  {m.revenue ? <span>Recettes : {m.revenueScope}</span> : <span>Sans recette</span>}
                                  {inherited && <span>Hérité de {m.inheritedFrom.join(', ')}</span>}
                                  {m.sharedRead && <span>Lecture partagée</span>}
                                  {m.pending.map((p) => <span key={p.id}>En attente : {p.circuit === 'RETRAIT' ? 'retrait' : p.circuit === 'FICHE' ? 'circuit de la fiche' : 'seconde validation'}</span>)}
                                  {!m.linkable && <span>Transverse (non rattachable)</span>}
                                </p>
                              </div>
                              <button type="button" role="switch" aria-checked={m.attached} aria-label={`${m.attached ? 'Détacher' : 'Rattacher'} ${m.code} ${m.label}`}
                                className={`dp-switch ${m.attached ? 'on' : ''}`} disabled={!m.linkable || m.pending.length > 0} onClick={() => { act.clear(); setEditModule(m); }}>
                                <span className="dp-switch-knob" aria-hidden="true" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      {modules.length === 0 && <EmptyState title="Aucun module pour ce filtre" icon="grid" />}
                    </div>
                  )}

                  {tab === 'variables' && (
                    <div className="stack-sm">
                      {eff.error !== null && <ErrorState error={eff.error} onRetry={eff.reload} />}
                      {eff.data && (
                        <>
                          <p className="small muted">Résolution : {eff.data.resolution}. Paramètres modulables : {eff.data.modulableStatus}. {eff.data.note}</p>
                          <ul className="dp-vars" aria-label="Variables de l’entité">
                            {eff.data.items.map((p) => (
                              <li key={p.id} className="ac-card">
                                <div className="ac-card-head">
                                  <div className="min0"><p className="ac-card-title">{p.label}</p><p className="ac-meta"><span className="mono">{p.id}</span><span>{p.category}</span></p></div>
                                  <span className="dp-value">{String(p.value)} <small>{p.unit}</small></span>
                                </div>
                                <div className="ac-chips">
                                  <Chip>{PROVENANCE_LABEL[p.provenance]}{p.sourceEntity && p.provenance !== 'ENTITE' ? ` (${p.sourceEntity})` : ''}</Chip>
                                  <Chip>Globale : {String(p.globalValue)}</Chip>
                                  {p.programmed.map((x) => <Chip key={`${x.entity}-${x.effectiveFrom}`}>Programmée : {String(x.value)} au {x.effectiveFrom}</Chip>)}
                                  {p.pending.map((x) => <Chip key={x.id}>En attente : {x.removal ? 'retrait' : String(x.proposedValue)} ({x.id})</Chip>)}
                                </div>
                                {p.consumer && <p className="small muted">Appliquée par : {p.consumer}</p>}
                                <button type="button" className="btn btn-secondary btn-sm" disabled={p.pending.length > 0} onClick={() => { act.clear(); setEditParam(p); }}>
                                  <Icon name="replace" size={14} /> Proposer une valeur pour l’entité
                                </button>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}

                  {tab === 'comptes' && (
                    <div className="stack-sm">
                      {v.accountsByType.length === 0 ? <EmptyState title="Aucun compte dans cette entité" icon="users" /> : (
                        <table className="dp-table">
                          <caption className="sr-only">Comptes par type</caption>
                          <thead><tr><th scope="col">Rôle</th><th scope="col">Famille</th><th scope="col">Actifs</th><th scope="col">Total</th></tr></thead>
                          <tbody>{v.accountsByType.map((a) => (
                            <tr key={a.role}><th scope="row"><span className="mono">{a.role}</span> {a.label}</th><td>{a.familyLabel}</td><td>{a.byStatus.ACTIF ?? 0}</td><td>{a.total}</td></tr>
                          ))}</tbody>
                        </table>
                      )}
                      {v.contracts.length > 0 && <p className="small">Contrats de partenariat : {v.contracts.map((c) => `${c.reference} (${c.status})`).join(' · ')}</p>}
                      <ExampleNotice text="Comptes de démonstration : fictifs, non contractuels." />
                    </div>
                  )}

                  {tab === 'historique' && (
                    v.history.length === 0 ? <EmptyState title="Aucun rattachement enregistré pour cette entité" icon="history" /> : (
                      <ol className="dp-history">
                        {v.history.map((h) => (
                          <li key={h.id} className="ac-card">
                            <div className="ac-card-head">
                              <div className="min0"><p className="ac-card-title"><span className="mono">{h.moduleCode}</span> {h.moduleLabel}</p>
                                <p className="ac-meta"><span>{h.action === 'RATTACHEMENT' ? 'Rattachement' : 'Détachement'}</span><span>Du {h.from}{h.to ? ` au ${h.to}` : ''}</span>{h.actReference && <span>{h.actReference}</span>}{h.demo && <span>Démonstration</span>}</p></div>
                              <Status s={h.status === 'EN_ATTENTE' ? 'EN_ATTENTE' : h.status === 'ACTIF' ? 'ACTIF' : h.status === 'REFUSE' ? 'REJETEE' : 'RETIRE'} />
                            </div>
                            <ul className="dp-steps">{h.history.map((s, i) => <li key={i}><span className="mono small">{s.at.slice(0, 16).replace('T', ' ')}</span> {s.action.replace(/_/g, ' ').toLowerCase()} — {s.by}{s.note ? ` : ${s.note}` : ''}</li>)}</ul>
                          </li>
                        ))}
                      </ol>
                    )
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      )}

      <Drawer open={!!editModule} title={editModule ? `${editModule.attached ? 'Détacher' : 'Rattacher'} ${editModule.code}` : ''} onClose={() => setEditModule(null)}>
        {editModule && selected && <AttachForm entity={selected} m={editModule} act={act} onDone={() => { setEditModule(null); reloadAll(); }} />}
      </Drawer>
      <Drawer open={!!editParam} title={editParam ? editParam.label : ''} onClose={() => setEditParam(null)}>
        {editParam && selected && <OverrideForm entity={selected} p={editParam} act={act} onDone={() => { setEditParam(null); eff.reload(); }} />}
      </Drawer>
    </div>
  );
}
