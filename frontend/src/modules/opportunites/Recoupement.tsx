/**
 * Moteur de recoupement (§ 8.5) : sources partenaires sous protocole signé et vérification Code du numérique
 * (OL n° 23/010), listes de travail priorisées pour les agents (jamais d'avis d'imposition automatique), examen
 * humain puis mission terrain, statut instantané d'une plaque, services bloqués faute de quitus valide.
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
import { ActionError, hasRole, RULE_LABELS, Tabs, useAction, WL_STATUS, WorklistView, type WorklistItem } from './shared';
import './opportunites.css';

interface CrossRule { kind: string; ruleCode: string; signal: string; rule: string; result: string }
interface Source {
  id: string; kind: string; partnerName: string; description: string; status: string; batches: number; rule: CrossRule; demo?: boolean;
  protocol: { reference: string; signedOn: string } | null; compliance: { conclusion: string; framework: string; checkedBy: string } | null;
}
interface Block { id: string; taxpayerId: string; service: string; reference: string; status: 'BLOQUE' | 'LEVE'; opposable: boolean; basisNote: string; createdAt: string; clearanceNumber?: string }
type Tab = 'liste' | 'sources' | 'plaque' | 'blocages';

const SOURCE_STATUS: Record<string, { label: string; tone: 'good' | 'warning' | 'serious' | 'neutral' }> = {
  PROTOCOLE_A_SIGNER: { label: 'Protocole à signer — aucune ingestion', tone: 'warning' }, CONFORMITE_A_VERIFIER: { label: 'Conformité à vérifier — aucune ingestion', tone: 'warning' },
  ACTIVE: { label: 'Active', tone: 'good' }, NON_CONFORME: { label: 'Non conforme — aucune ingestion', tone: 'serious' }, SUSPENDUE: { label: 'Suspendue', tone: 'neutral' },
};

function ItemPanel({ item, roles, onDone }: { item: WorklistItem; roles: string[]; onDone: () => void }) {
  const a = useAction();
  const [rv, setRv] = useState({ decision: 'VERIFICATION_REQUISE', reason: '', rank: '' });
  const [due, setDue] = useState(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
  const review = async () => {
    const body = { decision: rv.decision, reason: rv.reason, ...(rv.rank ? { localityRank: Number(rv.rank) } : {}) };
    if (await a.run(() => api(`/v1/recoupement/liste-travail/${item.id}/examen`, { method: 'POST', body }))) onDone();
  };
  const mission = async () => { if (await a.run(() => api(`/v1/recoupement/liste-travail/${item.id}/mission`, { method: 'POST', body: { dueDate: due } }))) onDone(); };
  return (
    <section className="panel" aria-label={`Élément ${item.id}`}>
      <h2 className="panel-title">{RULE_LABELS[item.ruleCode] ?? item.ruleCode} <StatusBadge tone={WL_STATUS[item.status]?.tone ?? 'neutral'} label={WL_STATUS[item.status]?.label ?? item.status} /></h2>
      <p>{item.explanation}</p>
      {item.variables && <ul className="plain-list small">{item.variables.map((v) => <li key={v.name}>{v.name} : {v.value}</li>)}</ul>}
      {item.priorityFactors && <p className="small muted">Priorité {item.priority} = {item.priorityFactors.map((f) => `${f.label} (${f.points})`).join(' + ')} — pondération de tri par défaut, à confirmer par le maître d’ouvrage.</p>}
      {item.createdObjectId && <p className="small">Objet provisoire créé au registre : <span className="mono">{item.createdObjectId}</span></p>}
      {item.missionId && <p className="small">Mission terrain : <span className="mono">{item.missionId}</span></p>}
      <ActionError error={a.error} />
      {item.status === 'A_EXAMINER' && hasRole(roles, 'R06', 'R07', 'R11') && (
        <div className="stack-sm">
          <h3 className="ig-h3">Examen humain</h3>
          <div className="field-row">
            <label className="field"><span>Conclusion</span><select value={rv.decision} onChange={(e) => setRv({ ...rv, decision: e.target.value })}><option value="VERIFICATION_REQUISE">Vérification requise</option><option value="SANS_SUITE">Sans suite</option></select></label>
            {item.ruleCode === 'BAR_SANS_LICENCE' && <label className="field"><span>Rang de localité déclaré (si quartier non certifié)</span><select value={rv.rank} onChange={(e) => setRv({ ...rv, rank: e.target.value })}><option value="">—</option>{[1, 2, 3, 4].map((r) => <option key={r} value={r}>{r}</option>)}</select></label>}
          </div>
          <label className="field"><span>Motif</span><textarea rows={2} value={rv.reason} onChange={(e) => setRv({ ...rv, reason: e.target.value })} /></label>
          <button type="button" className="btn btn-primary" disabled={a.busy || rv.reason.trim().length < 5} onClick={() => void review()}>Enregistrer l’examen</button>
        </div>
      )}
      {item.status === 'VERIFICATION_REQUISE' && hasRole(roles, 'R07', 'R09') && (
        <div className="input-row">
          <label className="field"><span>Échéance de la mission</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <button type="button" className="btn btn-primary" disabled={a.busy} onClick={() => void mission()}><Icon name="gps" size={18} /> Ouvrir la mission autorisée</button>
        </div>
      )}
    </section>
  );
}

function SourcesTab({ roles }: { roles: string[] }) {
  const q = useApi(() => api<{ items: Source[] }>('/v1/recoupement/sources'), []);
  const a = useAction();
  const [sel, setSel] = useState<string>('');
  const [json, setJson] = useState('');
  const [prot, setProt] = useState({ reference: '', signedOn: new Date().toISOString().slice(0, 10), signatories: '', documentSha256: '' });
  const [conf, setConf] = useState({ personalData: true, lawfulBasis: '', minimisation: '', retention: '', security: '', conclusion: 'CONFORME', note: '' });
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const s = q.data?.items.find((x) => x.id === sel);
  const post = async (path: string, body: unknown) => { if (await a.run(() => api(path, { method: 'POST', body }))) q.reload(); };
  return (
    <div className="stack">
      <p className="callout callout-info"><Icon name="lock" size={18} /><span>Chaque source exige un protocole signé et une vérification au regard du Code du numérique (Ordonnance-loi n° 23/010 du 13 mars 2023) avant tout échange : sinon, aucune donnée n’est reçue.</span></p>
      <DataTable rows={q.data?.items ?? []} rowKey={(x) => x.id} caption="Sources partenaires"
        empty={<EmptyState title="Aucune source" icon="file" />}
        columns={[
          { key: 'n', label: 'Partenaire', primary: true, render: (x) => <button type="button" className="btn btn-ghost btn-sm op-link" aria-pressed={sel === x.id} onClick={() => setSel(x.id)}>{x.partnerName}</button> },
          { key: 'r', label: 'Signal → règle → résultat', full: true, render: (x) => <span className="small">{x.rule.signal} → {x.rule.rule} → {x.rule.result}</span> },
          { key: 's', label: 'État', render: (x) => <StatusBadge tone={SOURCE_STATUS[x.status]?.tone ?? 'neutral'} label={SOURCE_STATUS[x.status]?.label ?? x.status} /> },
          { key: 'b', label: 'Lots', num: true, render: (x) => x.batches },
        ]} />
      <ActionError error={a.error} />
      {s && (
        <section className="panel" aria-label={`Source ${s.partnerName}`}>
          <h2 className="panel-title">{s.partnerName}</h2>
          <p className="small">Protocole : {s.protocol ? `${s.protocol.reference} (${s.protocol.signedOn})` : 'non signé'} · Conformité : {s.compliance ? `${s.compliance.conclusion} — ${s.compliance.checkedBy}` : 'non vérifiée'}</p>
          {!s.protocol && hasRole(roles, 'R05', 'R06') && (
            <div className="stack-sm">
              <h3 className="ig-h3">Enregistrer le protocole signé</h3>
              <div className="field-row">
                <label className="field"><span>Référence</span><input value={prot.reference} onChange={(e) => setProt({ ...prot, reference: e.target.value })} /></label>
                <label className="field"><span>Signé le</span><input type="date" value={prot.signedOn} onChange={(e) => setProt({ ...prot, signedOn: e.target.value })} /></label>
              </div>
              <label className="field"><span>Signataires</span><input value={prot.signatories} onChange={(e) => setProt({ ...prot, signatories: e.target.value })} /></label>
              <label className="field"><span>Empreinte SHA-256 du protocole</span><input className="mono" value={prot.documentSha256} onChange={(e) => setProt({ ...prot, documentSha256: e.target.value })} /></label>
              <button type="button" className="btn btn-primary" disabled={a.busy} onClick={() => void post(`/v1/recoupement/sources/${s.id}/protocole`, prot)}>Enregistrer le protocole</button>
            </div>
          )}
          {s.protocol && !s.compliance && hasRole(roles, 'R25') && (
            <div className="stack-sm">
              <h3 className="ig-h3">Vérification — Code du numérique</h3>
              <label className="check"><input type="checkbox" checked={conf.personalData} onChange={(e) => setConf({ ...conf, personalData: e.target.checked })} /> Données personnelles échangées</label>
              {(['lawfulBasis', 'minimisation', 'retention', 'security'] as const).map((k) => (
                <label key={k} className="field"><span>{{ lawfulBasis: 'Base de licéité', minimisation: 'Minimisation', retention: 'Conservation', security: 'Sécurité' }[k]}</span><input value={conf[k]} onChange={(e) => setConf({ ...conf, [k]: e.target.value })} /></label>
              ))}
              <label className="field"><span>Conclusion</span><select value={conf.conclusion} onChange={(e) => setConf({ ...conf, conclusion: e.target.value })}><option value="CONFORME">Conforme</option><option value="NON_CONFORME">Non conforme</option></select></label>
              <button type="button" className="btn btn-primary" disabled={a.busy} onClick={() => void post(`/v1/recoupement/sources/${s.id}/conformite`, conf)}>Enregistrer la vérification</button>
            </div>
          )}
          {hasRole(roles, 'R06', 'R07', 'R34') && (
            <div className="stack-sm">
              <h3 className="ig-h3">Déposer un lot (JSON : tableau d’enregistrements)</h3>
              <textarea rows={4} className="mono" value={json} onChange={(e) => setJson(e.target.value)} aria-label="Enregistrements du lot" />
              <button type="button" className="btn btn-secondary" disabled={a.busy || !json.trim()} onClick={() => { let records: unknown; try { records = JSON.parse(json); } catch { records = null; } void post(`/v1/recoupement/sources/${s.id}/lots`, { records }); }}>Déposer</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function PlateTab() {
  const a = useAction();
  const [plate, setPlate] = useState('');
  const [res, setRes] = useState<{ plate: string; result: string; message: string; validTitles: number } | null>(null);
  const check = async () => { const r = await a.run(() => api<{ plate: string; result: string; message: string; validTitles: number }>(`/v1/recoupement/plaques/${encodeURIComponent(plate.trim())}`)); if (r) setRes(r); };
  return (
    <section className="panel" aria-labelledby="op-plate">
      <h2 className="panel-title" id="op-plate">Statut instantané d’une plaque</h2>
      <p className="small muted">Réponse minimale (sans nom, adresse ni montant) ; aucune sanction automatique.</p>
      <div className="input-row">
        <input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="KN-0000-XX" aria-label="Plaque" />
        <button type="button" className="btn btn-primary" disabled={a.busy || plate.trim().length < 2} onClick={() => void check()}>Vérifier</button>
      </div>
      <ActionError error={a.error} />
      {res && <p className="op-plate-result"><StatusBadge tone={res.result === 'ROUGE' ? 'serious' : res.result === 'VERT' ? 'good' : 'warning'} label={`${res.plate} — ${res.result}`} /> <span className="small">{res.message}</span></p>}
    </section>
  );
}

function BlocksTab({ roles }: { roles: string[] }) {
  const q = useApi(() => api<{ items: Block[] }>('/v1/recoupement/blocages'), []);
  const a = useAction();
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <>
      <ActionError error={a.error} />
      <DataTable rows={q.data?.items ?? []} rowKey={(b) => b.id} caption="Services bloqués faute de quitus valide"
        empty={<EmptyState title="Aucun blocage" icon="check" />}
        columns={[
          { key: 't', label: 'Contribuable', primary: true, render: (b) => <span className="mono small">{b.taxpayerId}</span> },
          { key: 's', label: 'Service', render: (b) => `${b.service === 'MARCHE_PUBLIC' ? 'Marché provincial' : 'Autorisation'} ${b.reference}` },
          { key: 'e', label: 'État', render: (b) => <StatusBadge tone={b.status === 'BLOQUE' ? 'serious' : 'good'} label={b.status === 'BLOQUE' ? (b.opposable ? 'Bloqué' : 'Bloqué (informatif)') : `Levé — ${b.clearanceNumber ?? ''}`} /> },
          { key: 'n', label: 'Fondement', full: true, render: (b) => <span className="small muted">{b.basisNote}</span> },
          { key: 'a', label: 'Action', render: (b) => b.status === 'BLOQUE' && hasRole(roles, 'R06', 'R07', 'R12', 'R37') ? <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={async () => { if (await a.run(() => api(`/v1/recoupement/blocages/${b.id}/reexamen`, { method: 'POST', body: {} }))) q.reload(); }}>Réexaminer</button> : '—' },
        ]} />
    </>
  );
}

export default function Recoupement() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const canList = hasRole(roles, 'R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24');
  const canSources = hasRole(roles, 'R05', 'R06', 'R07', 'R08', 'R22', 'R23', 'R25', 'R34');
  const canPlate = hasRole(roles, 'R10', 'R11');
  const canBlocks = hasRole(roles, 'R06', 'R07', 'R12', 'R22', 'R37');
  const tabs = ([['liste', 'Liste de travail', canList], ['sources', 'Sources partenaires', canSources], ['plaque', 'Contrôle de plaque', canPlate], ['blocages', 'Services bloqués', canBlocks]] as const)
    .filter(([, , ok]) => ok).map(([id, label]) => ({ id: id as Tab, label }));
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'liste');
  const [sel, setSel] = useState<WorklistItem | null>(null);
  const [rule, setRule] = useState('');
  const wl = useApi(canList ? () => api<{ items: WorklistItem[]; access: string }>(`/v1/recoupement/liste-travail${rule ? `?ruleCode=${rule}` : ''}`) : null, [user?.id, rule]);
  if (!tabs.length) {
    return <div className="page"><PageHead eyebrow="Opportunités · § 8.5" title="Moteur de recoupement" /><EmptyState title="Accès réservé" icon="lock">Réservé à la régie, au terrain, aux contrôleurs, à l’audit, à la protection des données et aux partenaires sous protocole.</EmptyState></div>;
  }
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Opportunités · Cahier v2.9 § 8.5" title="Moteur de recoupement"
        lead="Le recoupement de données obtenues par protocoles d’accord produit une liste de travail priorisée pour les agents — jamais un avis d’imposition automatique." />
      <Tabs value={tab} onChange={(t) => { setTab(t); setSel(null); }} label="Rubrique" items={tabs} />
      {tab === 'liste' && (wl.loading && !wl.data ? <Loading /> : wl.error ? <ErrorState error={wl.error} onRetry={wl.reload} /> : (
        <div className="stack">
          <label className="field op-filter"><span>Règle</span>
            <select value={rule} onChange={(e) => setRule(e.target.value)}><option value="">Toutes</option>{Object.entries(RULE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </label>
          <WorklistView items={wl.data?.items ?? []} onPick={wl.data?.access === 'full' ? setSel : undefined} />
          {sel && <ItemPanel item={sel} roles={roles} onDone={() => { setSel(null); wl.reload(); }} />}
        </div>
      ))}
      {tab === 'sources' && <SourcesTab roles={roles} />}
      {tab === 'plaque' && <PlateTab />}
      {tab === 'blocages' && <BlocksTab roles={roles} />}
    </div>
  );
}
