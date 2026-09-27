/**
 * Espaces d'entité et fiches de configuration de module (§ 10A.2, § 10A.4, § 12A.3 ; H.4.3, H.6.5) :
 * arborescence des entités, fiche normalisée validée en maker-checker (programme, juridique), recette,
 * activation par le comité de pilotage sur référence d'arrêté, rattachement unique et historisé.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { Chip } from '../../components/StatusBadge';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { hasRole, ModuleSteps, splitList, Status, useAction, type EntityRow, type LevelsRef, type ModuleConfig } from './common';
import './acces.css';

const KIND_ICON: Record<string, string> = {
  PLATEFORME: 'gauge', EXECUTIF: 'star', MINISTERE: 'building', REGIE: 'bank', TRESOR: 'ledger', AUDIT: 'shieldCheck', COMMUNE: 'pin',
  SERVICE_TECHNIQUE: 'crane', OPERATEUR_DELEGUE: 'store', SOUS_TRAITANT: 'users', BANQUE_PSP: 'card', PARTENAIRE: 'globe',
};
const VALIDITY = ['HORAIRE', 'JOURNALIER', 'HEBDOMADAIRE', 'MENSUEL', 'ANNUEL', 'PAR_USAGE', 'PAR_EVENEMENT', 'ABONNEMENT', 'CONDITIONNEL', 'SANS_TITRE'];
const PROOFS = ['QR_DYNAMIQUE', 'QR_STATIQUE', 'PLAQUE', 'VIGNETTE', 'SMS', 'CARTE', 'RECU_IMPRIME', 'LECTURE_PLAQUE'];
const CHANNELS = ['APPLICATION', 'USSD', 'SVI', 'GUICHET', 'POINT_PAIEMENT_AGREE', 'AGENT_SANS_ENCAISSEMENT', 'TERMINAL'];
const human = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function depthOf(e: EntityRow, byId: Map<string, EntityRow>): number {
  let d = 0; let p = e.parentId;
  while (p && byId.has(p) && d < 4) { d++; p = byId.get(p)!.parentId; }
  return d;
}

function orderTree(list: EntityRow[]): EntityRow[] {
  const out: EntityRow[] = [];
  const visit = (parent: string | null) => {
    for (const e of list.filter((x) => x.parentId === parent).sort((a, b) => a.name.localeCompare(b.name, 'fr'))) { out.push(e); visit(e.id); }
  };
  visit(null);
  for (const e of list) if (!out.includes(e)) out.push(e);
  return out;
}

function NewEntity({ entities, kinds, onDone, act }: { entities: EntityRow[]; kinds: Record<string, string>; onDone: () => void; act: ReturnType<typeof useAction> }) {
  const [f, setF] = useState({ id: '', name: '', shortName: '', kind: 'COMMUNE', parentId: 'GOUVERNORAT', decisionRef: '' });
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await act.run(() => api('/v1/acces/entities', { method: 'POST', body: { ...f, id: f.id.trim().toUpperCase(), parentId: f.parentId || null } }), 'Espace d’entité créé et journalisé (visible de l’audit).');
    if (r) onDone();
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      {act.node}
      <p className="small muted">L’administrateur de la plateforme exécute la création sur décision écrite du Comité de pilotage (ARB-63). Il n’obtient aucun droit sur les données fiscales de l’entité.</p>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="ne-id">Code</label><input id="ne-id" className="mono" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} placeholder="COMMUNE-NGALIEMA" required /></div>
        <div className="field"><label className="label" htmlFor="ne-short">Nom court</label><input id="ne-short" value={f.shortName} onChange={(e) => setF({ ...f, shortName: e.target.value })} required /></div>
      </div>
      <div className="field"><label className="label" htmlFor="ne-name">Nom complet</label><input id="ne-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="ne-kind">Nature</label>
          <select id="ne-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(kinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label className="label" htmlFor="ne-parent">Entité de rattachement</label>
          <select id="ne-parent" value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}><option value="">— aucune —</option>{entities.map((x) => <option key={x.id} value={x.id}>{x.shortName}</option>)}</select></div>
      </div>
      <div className="field"><label className="label" htmlFor="ne-dec">Référence de la décision du Comité de pilotage</label><input id="ne-dec" value={f.decisionRef} onChange={(e) => setF({ ...f, decisionRef: e.target.value })} required /></div>
      <button type="submit" className="btn btn-primary" disabled={act.busy}><Icon name="building" size={18} /> Créer l’espace</button>
    </form>
  );
}

function NewModule({ entities, userEntity, onDone, act }: { entities: EntityRow[]; userEntity: string; onDone: (m: ModuleConfig) => void; act: ReturnType<typeof useAction> }) {
  const [f, setF] = useState({
    code: '', label: '', revenueScope: '', responsibleEntity: userEntity, beneficiaryAliases: '', ruleCodes: '', objectTypes: '', credentialTypes: '',
    validityModel: 'SANS_TITRE', proofMechanisms: [] as string[], channels: ['APPLICATION', 'USSD', 'POINT_PAIEMENT_AGREE'] as string[], dependencies: '', dependencyRefs: '', usageRules: '',
  });
  const toggle = (k: 'proofMechanisms' | 'channels', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await act.run(() => api<{ module: ModuleConfig; blocked: boolean; arbitrationId?: string }>('/v1/acces/modules', {
      method: 'POST',
      body: {
        code: f.code.trim().toUpperCase(), label: f.label.trim(), revenueScope: f.revenueScope.trim().toUpperCase().replace(/\s+/g, '_'), responsibleEntity: f.responsibleEntity,
        beneficiaryAliases: splitList(f.beneficiaryAliases), ruleCodes: splitList(f.ruleCodes), objectTypes: splitList(f.objectTypes), credentialTypes: splitList(f.credentialTypes),
        validityModel: f.validityModel, proofMechanisms: f.proofMechanisms, channels: f.channels, dependencies: splitList(f.dependencies), ...(splitList(f.dependencyRefs).length ? { dependencyRefs: splitList(f.dependencyRefs).map((x) => x.toUpperCase()) } : {}), usageRules: f.usageRules,
      },
    }), (r) => (r.blocked ? `Compétence déjà revendiquée par une autre entité : fiche bloquée, dossier d’arbitrage ${r.arbitrationId} ouvert.` : 'Fiche enregistrée en brouillon.'));
    if (r) onDone(r.module);
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      {act.node}
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="nm-code">Code du module</label><input id="nm-code" className="mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="MARCHES-LIMETE" required /></div>
        <div className="field"><label className="label" htmlFor="nm-scope">Domaine de compétence</label><input id="nm-scope" className="mono" value={f.revenueScope} onChange={(e) => setF({ ...f, revenueScope: e.target.value })} placeholder="MARCHES" required /></div>
      </div>
      <div className="field"><label className="label" htmlFor="nm-label">Intitulé</label><input id="nm-label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required /></div>
      <div className="field"><label className="label" htmlFor="nm-ent">Entité responsable (une seule à la fois)</label>
        <select id="nm-ent" value={f.responsibleEntity} onChange={(e) => setF({ ...f, responsibleEntity: e.target.value })}>{entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="nm-alias">Comptes bénéficiaires (alias du coffre)</label><input id="nm-alias" className="mono" value={f.beneficiaryAliases} onChange={(e) => setF({ ...f, beneficiaryAliases: e.target.value })} placeholder="KIN-DGTK-RECETTES-01" />
        <span className="hint">Comptes publics du coffre uniquement ; aucun compte privé n’est accepté.</span></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="nm-rules">Règles de recettes (codes du registre)</label><input id="nm-rules" className="mono" value={f.ruleCodes} onChange={(e) => setF({ ...f, ruleCodes: e.target.value })} />
          <span className="hint">Activation possible seulement si chaque règle est ACTIVE (4 visas).</span></div>
        <div className="field"><label className="label" htmlFor="nm-obj">Types d’objets</label><input id="nm-obj" value={f.objectTypes} onChange={(e) => setF({ ...f, objectTypes: e.target.value })} placeholder="ETAL, MARCHE" /></div>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="nm-cred">Types de titres</label><input id="nm-cred" value={f.credentialTypes} onChange={(e) => setF({ ...f, credentialTypes: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor="nm-val">Modèle de validité</label>
          <select id="nm-val" value={f.validityModel} onChange={(e) => setF({ ...f, validityModel: e.target.value })}>{VALIDITY.map((v) => <option key={v} value={v}>{human(v)}</option>)}</select></div>
      </div>
      <fieldset className="field"><legend className="label">Mécanismes de preuve</legend>
        <div className="ac-checks">{PROOFS.map((p) => <label key={p} className="ac-check"><input type="checkbox" checked={f.proofMechanisms.includes(p)} onChange={() => toggle('proofMechanisms', p)} /> {human(p)}</label>)}</div></fieldset>
      <fieldset className="field"><legend className="label">Canaux</legend>
        <div className="ac-checks">{CHANNELS.map((p) => <label key={p} className="ac-check"><input type="checkbox" checked={f.channels.includes(p)} onChange={() => toggle('channels', p)} /> {human(p)}</label>)}</div></fieldset>
      <div className="field"><label className="label" htmlFor="nm-dep">Dépendances (quitus, vignette…)</label><input id="nm-dep" value={f.dependencies} onChange={(e) => setF({ ...f, dependencies: e.target.value })} /></div>
      <div className="field"><label className="label" htmlFor="nm-depref">Dépendances structurées (codes du moteur, ex. DEP-PERMIS-QUITUS — voir « Conditions des services »)</label><input id="nm-depref" value={f.dependencyRefs} onChange={(e) => setF({ ...f, dependencyRefs: e.target.value })} /></div>
      <div className="field"><label className="label" htmlFor="nm-use">Règles d’usage</label><textarea id="nm-use" rows={2} value={f.usageRules} onChange={(e) => setF({ ...f, usageRules: e.target.value })} /></div>
      <button type="submit" className="btn btn-primary" disabled={act.busy}><Icon name="file" size={18} /> Enregistrer la fiche</button>
    </form>
  );
}

function ModuleDetail({ m, roles, userEntity, entities, onChanged, act }: {
  m: ModuleConfig; roles: string[]; userEntity: string; entities: EntityRow[]; onChanged: () => void; act: ReturnType<typeof useAction>;
}) {
  const { fmtDate } = useApp();
  const [note, setNote] = useState('');
  const [acts, setActs] = useState('');
  const [report, setReport] = useState('');
  const [reatt, setReatt] = useState({ newEntity: '', beneficiaryAliases: '', actReference: '', motif: '' });
  const post = (path: string, body: unknown, ok: string) => act.run(() => api(`/v1/acces/modules/${m.id}/${path}`, { method: 'POST', body }), ok).then((r) => { if (r) onChanged(); });
  const canDraft = hasRole(roles, 'R26') || (hasRole(roles, 'R06', 'R08') && userEntity === m.responsibleEntity);
  const committee = hasRole(roles, 'R01', 'R02', 'R05');
  const rows: [string, string][] = [
    ['Entité responsable', m.responsibleEntity], ['Domaine de compétence', m.revenueScope], ['Comptes bénéficiaires', m.beneficiaryAliases.join(', ') || '— (requis avant activation)'],
    ['Règles', m.ruleCodes.join(', ') || '— (tarif : acte requis)'], ['Types d’objets', m.objectTypes.join(', ') || '—'], ['Types de titres', m.credentialTypes.join(', ') || '—'],
    ['Modèle de validité', human(m.validityModel)], ['Mécanismes de preuve', m.proofMechanisms.map(human).join(', ') || '—'], ['Canaux', m.channels.map(human).join(', ') || '—'],
    ['Règles d’usage', m.usageRules || '—'], ['Workflows terrain', m.fieldWorkflows.join(', ') || '—'], ['Tableaux de bord', m.dashboards.join(', ') || '—'],
    ['Dépendances', m.dependencies.join(', ') || '—'], ['Dépendances structurées', (m.dependencyRefs ?? []).join(', ') || '—'], ['Partage en lecture', m.sharedReadWith.join(', ') || '—'], ['Références d’actes', m.actReferences.join(' ; ') || '—'],
  ];
  return (
    <div className="stack">
      {m.demo && <ExampleNotice text="Fiche de démonstration : références d’actes fictives, aucune valeur juridique." />}
      <div className="row-between"><Status s={m.status} /><span className="mono small">{m.code}</span></div>
      {m.status !== 'BLOQUE_ARBITRAGE' && m.status !== 'RETIRE' && <ModuleSteps status={m.status} />}
      {m.status === 'BLOQUE_ARBITRAGE' && (
        <p className="ac-guard ac-guard-crit"><Icon name="scale" size={16} /> <span>Compétence revendiquée par une autre entité : aucune activation possible avant la décision motivée du dossier {m.arbitrationId} (écran « Arbitrages »).</span></p>
      )}
      <dl className="ac-kv">{rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>

      <h3 className="ac-section-title">Visas (personnes distinctes)</h3>
      {m.visas.length === 0 ? <p className="small muted">Aucun visa.</p> : (
        <ol className="ac-timeline">{m.visas.map((v, i) => <li key={i}><strong>{human(v.step)}</strong> — <span className="mono">{v.by}</span> ({v.role}) · {fmtDate(v.at, true)}{v.note ? ` · ${v.note}` : ''}</li>)}</ol>
      )}
      <h3 className="ac-section-title">Historique des rattachements</h3>
      {m.attachments.length === 0 ? <p className="small muted">Pas encore rattaché (effet après seconde validation).</p> : (
        <ol className="ac-timeline">{m.attachments.map((a, i) => <li key={i}><strong>{a.entity}</strong> depuis le {fmtDate(a.from)}{a.to ? ` jusqu’au ${fmtDate(a.to)}` : ' (en vigueur)'} · {a.actReference} · validé par <span className="mono">{a.validatedBy}</span></li>)}</ol>
      )}

      <div className="ac-inline-form">
        <p className="ac-section-title">Action suivante</p>
        {m.status === 'BROUILLON' && (canDraft
          ? <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void post('submit', {}, 'Fiche soumise au visa programme.')}><Icon name="send" size={18} /> Soumettre la fiche</button>
          : <p className="small muted">Soumission par l’entité responsable ou l’administrateur de la plateforme.</p>)}
        {m.status === 'VALIDATION_PROGRAMME' && (hasRole(roles, 'R02', 'R03')
          ? <><div className="field"><label className="label" htmlFor="md-n1">Observation</label><input id="md-n1" value={note} onChange={(e) => setNote(e.target.value)} /></div>
            <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void post('visa-programme', note ? { note } : {}, 'Visa programme donné.')}><Icon name="check" size={18} /> Viser (programme)</button></>
          : <p className="small muted">Visa du programme : Cabinet ou Secrétariat général.</p>)}
        {m.status === 'VALIDATION_JURIDIQUE' && (hasRole(roles, 'R13', 'R14')
          ? <><div className="field"><label className="label" htmlFor="md-acts">Références d’actes</label><input id="md-acts" value={acts} onChange={(e) => setActs(e.target.value)} placeholder="Arrêté n° …" /></div>
            <button type="button" className="btn btn-primary" disabled={act.busy || !acts.trim()} onClick={() => void post('visa-juridique', { actReferences: splitList(acts) }, 'Visa juridique donné : fiche en recette.')}><Icon name="scale" size={18} /> Viser (juridique)</button></>
          : <p className="small muted">Visa juridique : juriste rédacteur ou vérificateur.</p>)}
        {m.status === 'RECETTE' && (hasRole(roles, 'R27', 'R26')
          ? <><div className="field"><label className="label" htmlFor="md-rep">Procès-verbal de recette</label><textarea id="md-rep" rows={2} value={report} onChange={(e) => setReport(e.target.value)} /></div>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" disabled={act.busy || report.trim().length < 5} onClick={() => void post('recette', { passed: true, report }, 'Recette réussie : seconde validation attendue.')}>Recette réussie</button>
              <button type="button" className="btn btn-secondary" disabled={act.busy || report.trim().length < 5} onClick={() => void post('recette', { passed: false, report }, 'Échec motivé : la fiche revient en brouillon.')}>Échec motivé</button>
            </div></>
          : <p className="small muted">Recette constatée par l’exploitation technique.</p>)}
        {m.status === 'SECONDE_VALIDATION' && (committee
          ? <><div className="field"><label className="label" htmlFor="md-arr">Référence de l’arrêté</label><input id="md-arr" value={acts} onChange={(e) => setActs(e.target.value)} /></div>
            <button type="button" className="btn btn-primary" disabled={act.busy || acts.trim().length < 3} onClick={() => void post('activate', { actReference: acts.trim() }, 'Module activé et rattaché.')}><Icon name="shieldCheck" size={18} /> Activer (comité de pilotage)</button></>
          : <p className="small muted">Seconde validation : comité de pilotage (Gouverneur, Cabinet, ministre des Finances).</p>)}
        {['ACTIF', 'SUSPENDU'].includes(m.status) && committee && (
          <><div className="field"><label className="label" htmlFor="md-mot">Motif de la décision</label><input id="md-mot" value={note} onChange={(e) => setNote(e.target.value)} /></div>
            <div className="btn-row">
              {m.status === 'ACTIF' && <button type="button" className="btn btn-secondary" disabled={act.busy || note.trim().length < 5} onClick={() => void post('status', { to: 'SUSPENDU', motif: note }, 'Module suspendu (décision motivée).')}>Suspendre</button>}
              {m.status === 'SUSPENDU' && <button type="button" className="btn btn-secondary" disabled={act.busy || note.trim().length < 5} onClick={() => void post('status', { to: 'ACTIF', motif: note }, 'Suspension levée.')}>Lever la suspension</button>}
              <button type="button" className="btn btn-ghost" disabled={act.busy || note.trim().length < 5} onClick={() => void post('status', { to: 'RETIRE', motif: note }, 'Module retiré.')}>Retirer</button>
            </div></>
        )}
        {m.status === 'ACTIF' && !m.pendingReattachment && hasRole(roles, 'R26') && (
          <details><summary className="small">Préparer un changement de rattachement</summary>
            <div className="form" style={{ marginTop: 8 }}>
              <div className="field"><label className="label" htmlFor="ra-e">Nouvelle entité</label><select id="ra-e" value={reatt.newEntity} onChange={(e) => setReatt({ ...reatt, newEntity: e.target.value })}><option value="">—</option>{entities.filter((x) => x.id !== m.responsibleEntity).map((x) => <option key={x.id} value={x.id}>{x.shortName}</option>)}</select></div>
              <div className="field"><label className="label" htmlFor="ra-a">Comptes bénéficiaires (coffre)</label><input id="ra-a" className="mono" value={reatt.beneficiaryAliases} onChange={(e) => setReatt({ ...reatt, beneficiaryAliases: e.target.value })} /></div>
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="ra-r">Référence de l’arrêté</label><input id="ra-r" value={reatt.actReference} onChange={(e) => setReatt({ ...reatt, actReference: e.target.value })} /></div>
                <div className="field"><label className="label" htmlFor="ra-m">Motif</label><input id="ra-m" value={reatt.motif} onChange={(e) => setReatt({ ...reatt, motif: e.target.value })} /></div>
              </div>
              <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={() => void post('reattachments', { ...reatt, beneficiaryAliases: splitList(reatt.beneficiaryAliases) }, 'Changement proposé : effet après seconde validation.')}>Proposer</button>
            </div>
          </details>
        )}
        {m.pendingReattachment && (
          <div className="stack-sm">
            <p className="ac-guard ac-guard-warn"><Icon name="replace" size={16} /> <span>Transfert proposé vers {m.pendingReattachment.newEntity} ({m.pendingReattachment.actReference}) par {m.pendingReattachment.proposedBy} — seconde validation requise.</span></p>
            {hasRole(roles, 'R01', 'R02') && (
              <div className="btn-row">
                <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void post('reattachments/decision', { approve: true }, 'Rattachement transféré ; historique conservé.')}>Approuver</button>
                <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={() => void post('reattachments/decision', { approve: false }, 'Proposition rejetée.')}>Rejeter</button>
              </div>
            )}
          </div>
        )}
      </div>
      {act.node}
    </div>
  );
}

export default function EntitesModules() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const ents = useApi(() => api<{ items: EntityRow[] }>('/v1/acces/entities'), [user?.id]);
  const mods = useApi(() => api<{ items: ModuleConfig[] }>('/v1/acces/modules'), [user?.id]);
  const ref = useApi(() => api<LevelsRef>('/v1/acces/levels'), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<'entity' | 'module' | 'suspend' | null>(null);
  const [susp, setSusp] = useState({ motif: '', decisionRef: '' });
  const act = useAction(user?.id);
  const actD = useAction(user?.id);

  const list = useMemo(() => orderTree(ents.data?.items ?? []), [ents.data]);
  const byId = useMemo(() => new Map(list.map((e) => [e.id, e])), [list]);
  const modules = (mods.data?.items ?? []).filter((m) => !selected || m.responsibleEntity === selected);
  const current = (mods.data?.items ?? []).find((m) => m.id === open) ?? null;
  const sel = selected ? byId.get(selected) : undefined;
  const reload = () => { ents.reload(); mods.reload(); };

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Accès et entités" title="Espaces d’entité et modules" lead="Un socle commun, des espaces propres : chaque entité ne voit et ne gère que ce que la loi lui attribue ; chaque module a une seule entité responsable à un instant donné.">
        <div className="page-head-tools">
          {hasRole(roles, 'R26') && <button type="button" className="btn btn-secondary" onClick={() => setDrawer('entity')}><Icon name="building" size={18} /> Nouvel espace</button>}
          {hasRole(roles, 'R26', 'R06', 'R08') && <button type="button" className="btn btn-primary" onClick={() => setDrawer('module')}><Icon name="file" size={18} /> Nouvelle fiche de module</button>}
        </div>
      </PageHead>
      {(ents.error !== null || mods.error !== null) && <ErrorState error={ents.error ?? mods.error} onRetry={reload} />}
      {(ents.loading || mods.loading) && <Loading />}
      {ents.data && mods.data && (
        <div className="ac-grid">
          <section className="panel" aria-labelledby="ent-title">
            <header className="panel-head"><h2 className="panel-title" id="ent-title">Entités</h2><span className="count">{list.length}</span></header>
            <ul className="ac-tree">
              <li><button type="button" className="ac-node" aria-pressed={!selected} onClick={() => setSelected(null)}><span className="ac-node-main"><span className="ac-kind"><Icon name="grid" size={16} /></span><span className="ac-node-name">Toutes les entités</span></span></button></li>
              {list.map((e) => (
                <li key={e.id} className={`ac-indent-${Math.min(3, depthOf(e, byId))}`}>
                  <button type="button" className="ac-node" aria-pressed={selected === e.id} onClick={() => setSelected(e.id)}>
                    <span className="ac-node-main">
                      <span className="ac-kind"><Icon name={KIND_ICON[e.kind] ?? 'building'} size={16} /></span>
                      <span className="min0"><span className="ac-node-name">{e.shortName}</span><br /><span className="ac-node-sub">{ref.data?.entityKinds[e.kind] ?? e.kind} · {e.modules.length} module(s) · {e.accounts} compte(s) actif(s)</span></span>
                    </span>
                    {e.status === 'SUSPENDUE' ? <Status s="SUSPENDUE" /> : null}
                  </button>
                </li>
              ))}
            </ul>
            {sel && (
              <div className="ac-card" style={{ marginTop: 16 }}>
                <p className="ac-card-title">{sel.name}</p>
                <div className="ac-meta"><span className="mono">{sel.id}</span><span>Créé par {sel.createdBy}</span>{sel.decisionRef && <span>{sel.decisionRef}</span>}</div>
                {sel.demo && <p className="small example-inline">Entité de démonstration</p>}
                {hasRole(roles, 'R26') && sel.status === 'ACTIVE' && sel.kind !== 'PLATEFORME' && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDrawer('suspend')}><Icon name="ban" size={16} /> Suspendre l’entité</button>
                )}
                {sel.status === 'SUSPENDUE' && <p className="small">Suspendue : {sel.suspensionReason}</p>}
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="mod-title">
            <header className="panel-head">
              <div><h2 className="panel-title" id="mod-title">Fiches de configuration de module</h2><p className="panel-sub">{sel ? sel.name : 'Toutes les entités'} — circuit : fiche → programme → juridique → recette → comité de pilotage</p></div>
              <span className="count">{modules.length}</span>
            </header>
            {modules.length === 0 ? <EmptyState title="Aucune fiche pour cette entité" icon="file" /> : (
              <div className="ac-card-list">
                {modules.map((m) => (
                  <button key={m.id} type="button" className="ac-card list-button" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => setOpen(m.id)}>
                    <div className="ac-card-head">
                      <div className="min0"><p className="ac-card-title">{m.label}</p><div className="ac-meta"><span className="mono">{m.code}</span><span>{m.responsibleEntity}</span><span>Compétence : {m.revenueScope}</span></div></div>
                      <Status s={m.status} />
                    </div>
                    {m.status !== 'BLOQUE_ARBITRAGE' && m.status !== 'RETIRE' && <ModuleSteps status={m.status} />}
                    <div className="ac-chips">
                      {m.ruleCodes.map((r) => <Chip key={r}>{r}</Chip>)}
                      {m.ruleCodes.length === 0 && <Chip>Tarif : acte requis</Chip>}
                      {m.demo && <Chip>Démonstration</Chip>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      <Drawer open={!!current} title={current?.label ?? ''} onClose={() => { setOpen(null); act.clear(); }}>
        {current && <ModuleDetail m={current} roles={roles} userEntity={user?.entity ?? ''} entities={list} onChanged={mods.reload} act={act} />}
      </Drawer>
      <Drawer open={drawer === 'entity'} title="Nouvel espace d’entité" onClose={() => setDrawer(null)}>
        <NewEntity entities={list} kinds={ref.data?.entityKinds ?? {}} act={actD} onDone={() => { setDrawer(null); reload(); }} />
      </Drawer>
      <Drawer open={drawer === 'module'} title="Nouvelle fiche de configuration de module" onClose={() => setDrawer(null)}>
        <NewModule entities={list} userEntity={user?.entity ?? ''} act={actD} onDone={(m) => { setDrawer(null); mods.reload(); setOpen(m.id); }} />
      </Drawer>
      <Drawer open={drawer === 'suspend' && !!sel} title={`Suspendre ${sel?.shortName ?? ''}`} onClose={() => setDrawer(null)}>
        <div className="form">
          <p className="ac-guard ac-guard-crit"><Icon name="alert" size={16} /> <span>La suspension d’une entité révoque immédiatement tous ses comptes et ceux de ses sous-entités, ainsi que les invitations en cours (§ 12A.5). Décision motivée, journalisée et visible de l’audit.</span></p>
          <div className="field"><label className="label" htmlFor="su-m">Motif</label><textarea id="su-m" rows={3} value={susp.motif} onChange={(e) => setSusp({ ...susp, motif: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="su-d">Référence de la décision</label><input id="su-d" value={susp.decisionRef} onChange={(e) => setSusp({ ...susp, decisionRef: e.target.value })} /></div>
          {actD.node}
          <button type="button" className="btn btn-primary" disabled={actD.busy || susp.motif.trim().length < 5 || susp.decisionRef.trim().length < 3}
            onClick={() => void actD.run(() => api<{ revokedAccounts: number }>(`/v1/acces/entities/${sel!.id}/suspend`, { method: 'POST', body: susp }), (r) => `Entité suspendue : ${r.revokedAccounts} compte(s) révoqué(s) en cascade.`).then((r) => { if (r) reload(); })}>
            Confirmer la suspension
          </button>
        </div>
      </Drawer>
    </div>
  );
}
