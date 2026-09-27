/**
 * Modules sectoriels « acte requis » (§ 11 : 11, 13, 16, 17/56, 21, 22, 23, 24, 25) sur le socle commun, et plan des
 * emprises du domaine public (modules 19, 20). Déclarations du redevable, relevés de terrain, données tierces,
 * rapprochement par un contrôleur puis décision d'une AUTRE personne ; contrôle d'un véhicule par plaque (réponse
 * minimale). Aucun montant : ACTE_REQUIS.
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
import { COMMUNES } from '../../verticals/catalogue';
import '../referentiel/referentiel.css';
import './verticales.css';
import { SecteursVisuels } from './visuels';

interface CredType { code: string; label: string; activable: boolean; reason: string | null }
interface KindDef { kind: string; label: string; keys: Record<string, string> }
interface SectorModule {
  module: string; name: string; function: string; vertical: string; verticalName: string; legal: string; prerequisites: string[]; revenueCodes: string[];
  credentialTypes: CredType[]; declarationKinds: KindDef[]; observationSources: string[]; routes: string[]; note?: string; counts: { references: number; declarations: number; observations: number };
}
interface Declaration {
  id: string; module: string; kind: string; period: string; lines: Record<string, string>; status: string; declaredAt: string;
  reconciliation?: { by: string; proposal: string; note: string; bySource: { source: string; observed: Record<string, string>; gaps: Record<string, string>; records: number }[] };
  decision?: { by: string; decision: string; motif: string }; liquidation: { status: string; note: string };
}
interface VehicleControl { plate: string; registered: boolean; vehicle: { category: string; usage: string | null; commune: string } | null; titles: { typeCode: string; label: string; valid: boolean; text: string }[]; transportAuthorizations: { code: string; status: string }[]; mutationPending: boolean; credentialTypes: CredType[]; notice: string }
interface Emprise { objectId: string; objectType: string; commune: string; quartier: string; usage: string | null; surfaceM2: string | null; authorization: { code: string; status: string; validUntil: string | null } | null; freed: string | null }

const STATUS: Record<string, { label: string; tone: 'good' | 'warning' | 'info' | 'neutral' | 'critical' }> = {
  DEPOSEE: { label: 'Déposée', tone: 'info' }, RAPPROCHEE: { label: 'Rapprochée — sans écart', tone: 'good' }, ECART_A_INSTRUIRE: { label: 'Écart à instruire', tone: 'warning' },
  SANS_DONNEE_TIERCE: { label: 'Sans donnée observée', tone: 'neutral' }, VALIDEE: { label: 'Validée', tone: 'good' }, EN_CONTRADICTOIRE: { label: 'Procédure contradictoire', tone: 'warning' },
};
const SOURCE_KEYS: Record<string, Record<string, string>> = {
  COMPTAGE_SORTIES: { camions: 'Camions', volume_m3: 'Volume (m³)' }, POINT_CONTROLE: { quantite_kg: 'Quantité (kg)' }, PASSAGE_PEAGE: { passages: 'Passages' },
  RELEVE_EMBARQUEMENT: { passagers: 'Passagers' }, RELEVE_ACCOSTAGE: { accostages: 'Accostages', passagers: 'Passagers' },
};

function useAction(reload: () => void) {
  const [err, setErr] = useState<string | null>(null);
  const run = async (path: string, body?: unknown) => {
    setErr(null);
    try { await api(path, { method: 'POST', body: body ?? {} }); reload(); return true; } catch (e) { setErr(describeError(e).message); return false; }
  };
  return { err, run };
}

function DeclareForm({ modules, onDone }: { modules: SectorModule[]; onDone: () => void }) {
  const kinds = modules.flatMap((m) => m.declarationKinds);
  const [kind, setKind] = useState(kinds[0]?.kind ?? '');
  const [period, setPeriod] = useState('');
  const [objectId, setObjectId] = useState('');
  const [lines, setLines] = useState<Record<string, string>>({});
  const { err, run } = useAction(onDone);
  const def = kinds.find((k) => k.kind === kind);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const filled = Object.fromEntries(Object.entries(lines).filter(([, v]) => v.trim()));
    if (await run('/v1/verticales/secteurs/declarations', { kind, period, lines: filled, ...(objectId ? { objectId } : {}) })) setLines({});
  };
  return (
    <form className="panel stack-sm" onSubmit={submit} aria-labelledby="sec-decl">
      <h2 className="panel-title" id="sec-decl"><Icon name="file" size={18} /> Déposer une déclaration</h2>
      <label className="label" htmlFor="sec-kind">Déclaration</label>
      <select id="sec-kind" value={kind} onChange={(e) => { setKind(e.target.value); setLines({}); }}>{kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select>
      <div className="row-wrap">
        <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Période AAAA-MM" aria-label="Période" />
        {kind === 'SORTIES_CARRIERE' && <input value={objectId} onChange={(e) => setObjectId(e.target.value)} placeholder="Identifiant du site de carrière" aria-label="Site de carrière" />}
      </div>
      <div className="row-wrap">
        {def && Object.entries(def.keys).map(([k, label]) => <input key={k} value={lines[k] ?? ''} onChange={(e) => setLines({ ...lines, [k]: e.target.value })} placeholder={label} aria-label={label} inputMode="decimal" />)}
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary btn-sm" disabled={!/^\d{4}-\d{2}$/.test(period)}>Déclarer</button>
      <p className="hint">Acte requis : la déclaration est enregistrée et rapprochée ; aucun montant n’est émis. Un écart ouvre une procédure contradictoire.</p>
    </form>
  );
}

function Declarations({ canReconcile, canDecide }: { canReconcile: boolean; canDecide: boolean }) {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<{ items: Declaration[] }>('/v1/verticales/secteurs/declarations'), [user?.id]);
  const { err, run } = useAction(q.reload);
  const decide = (id: string, decision: string) => {
    const motif = window.prompt('Motif de la décision (obligatoire)');
    if (motif && motif.trim().length >= 5) void run(`/v1/verticales/secteurs/declarations/${id}/decision`, { decision, motif });
  };
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="panel-title"><Icon name="sync" size={18} /> Déclarations et rapprochements</h2><span className="count">{q.data?.items.length ?? 0}</span></div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {!q.data?.items.length ? <EmptyState title="Aucune déclaration" /> : (
        <ul className="list-rows">
          {q.data.items.map((d) => (
            <li key={d.id} className="list-row list-row-stack">
              <div className="row-between">
                <div className="min0">
                  <p className="row-title"><span className="mono">{d.id}</span> · module {d.module} · {d.period}</p>
                  <p className="small muted">{Object.entries(d.lines).map(([k, v]) => `${k} : ${v}`).join(' · ')} — déposée le {fmtDate(d.declaredAt, true)}</p>
                  {d.reconciliation && <p className="small">{d.reconciliation.note} {d.reconciliation.bySource.filter((s) => s.records).map((s) => `${s.source} : écarts ${Object.entries(s.gaps).map(([k, g]) => `${k} ${g}`).join(', ')}`).join(' ; ')}</p>}
                  {d.decision && <p className="small">Décision : {d.decision.decision === 'VALIDER' ? 'validée' : 'procédure contradictoire'} — {d.decision.motif}</p>}
                  <p className="small muted">{d.liquidation.note}</p>
                </div>
                <div className="row-side">
                  <StatusBadge tone={STATUS[d.status]?.tone ?? 'neutral'} label={STATUS[d.status]?.label ?? d.status} />
                  {canReconcile && d.status !== 'VALIDEE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(`/v1/verticales/secteurs/declarations/${d.id}/rapprochement`)}>Rapprocher</button>}
                  {canDecide && d.reconciliation && !['VALIDEE', 'EN_CONTRADICTOIRE'].includes(d.status) && (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => decide(d.id, 'VALIDER')}>Valider</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => decide(d.id, 'OUVRIR_CONTRADICTOIRE')}>Ouvrir le contradictoire</button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">La personne qui décide est toujours distincte de celle qui a rapproché ; aucune taxation automatique.</p>
    </section>
  );
}

function FieldTools({ modules }: { modules: SectorModule[] }) {
  const [plate, setPlate] = useState('');
  const [commune, setCommune] = useState('Gombe');
  const [ctl, setCtl] = useState<VehicleControl | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const withSources = modules.filter((m) => m.observationSources.some((s) => SOURCE_KEYS[s]));
  const [mod, setMod] = useState(withSources[0]?.module ?? '');
  const sources = withSources.find((m) => m.module === mod)?.observationSources.filter((s) => SOURCE_KEYS[s]) ?? [];
  const [source, setSource] = useState('');
  const [ref, setRef] = useState('');
  const [obsPlate, setObsPlate] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const src = source || sources[0] || '';
  const check = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setCtl(null);
    try { setCtl(await api<VehicleControl>(`/v1/verticales/vehicules/${encodeURIComponent(plate)}/controle?commune=${encodeURIComponent(commune)}`)); } catch (ex) { setErr(describeError(ex).message); }
  };
  const observe = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setDone(null);
    const lines = Object.fromEntries(Object.entries(qty).filter(([, v]) => v.trim()));
    const isObject = mod === '22';
    try {
      const r = await api<{ id: string; titleCheck?: { detail: string } }>(`/v1/verticales/secteurs/${mod}/releves`, { method: 'POST', body: { source: src, lines, ...(ref ? (isObject ? { objectId: ref } : { referenceId: ref }) : { commune }), ...(obsPlate ? { plate: obsPlate } : {}) } });
      setDone(`Relevé ${r.id} enregistré. ${r.titleCheck?.detail ?? ''}`); setQty({});
    } catch (ex) { setErr(describeError(ex).message); }
  };
  return (
    <section className="panel stack-sm">
      <h2 className="panel-title"><Icon name="car" size={18} /> Terrain : contrôle par plaque et relevés</h2>
      <form className="row-wrap" onSubmit={check}>
        <input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="Plaque (ex. KN-1234-AB)" aria-label="Plaque du véhicule" />
        <select value={commune} onChange={(e) => setCommune(e.target.value)} aria-label="Commune du contrôle">{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select>
        <button type="submit" className="btn btn-secondary btn-sm" disabled={plate.trim().length < 4}>Contrôler le véhicule</button>
      </form>
      {ctl && (
        <div className="callout callout-info">
          <Icon name="car" size={18} />
          <div>
            <p><strong className="mono">{ctl.plate}</strong> — {ctl.registered ? `véhicule enregistré (${ctl.vehicle?.commune ?? ''})` : 'aucun véhicule enregistré'}{ctl.mutationPending ? ' · mutation en cours' : ''}</p>
            <p className="small">Titres : {ctl.titles.length ? ctl.titles.map((t) => `${t.label} — ${t.text}`).join(' ; ') : 'aucun'} · Autorisations de transport : {ctl.transportAuthorizations.length ? ctl.transportAuthorizations.map((a) => `${a.code} (${a.status.toLowerCase()})`).join(', ') : 'aucune'}</p>
            <p className="small muted">{ctl.credentialTypes.filter((t) => !t.activable).map((t) => t.label).join(', ')} : acte requis.</p>
            <p className="small muted">{ctl.notice}</p>
          </div>
        </div>
      )}
      <form className="stack-sm" onSubmit={observe}>
        <div className="row-wrap">
          <select value={mod} onChange={(e) => { setMod(e.target.value); setSource(''); setQty({}); }} aria-label="Module">{withSources.map((m) => <option key={m.module} value={m.module}>{m.module} — {m.name}</option>)}</select>
          <select value={src} onChange={(e) => { setSource(e.target.value); setQty({}); }} aria-label="Source du relevé">{sources.map((s) => <option key={s}>{s}</option>)}</select>
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={mod === '22' ? 'Site de carrière (identifiant)' : 'Axe, quai ou point (identifiant)'} aria-label="Référence du relevé" />
          <input value={obsPlate} onChange={(e) => setObsPlate(e.target.value)} placeholder="Plaque (facultatif)" aria-label="Plaque relevée" />
        </div>
        <div className="row-wrap">{Object.entries(SOURCE_KEYS[src] ?? {}).map(([k, label]) => <input key={k} value={qty[k] ?? ''} onChange={(e) => setQty({ ...qty, [k]: e.target.value })} placeholder={label} aria-label={label} inputMode="decimal" />)}</div>
        <button type="submit" className="btn btn-secondary btn-sm" disabled={!src}>Enregistrer le relevé</button>
      </form>
      {done && <p className="notice notice-ok" role="status">{done}</p>}
      {err && <p className="err" role="alert">{err}</p>}
    </section>
  );
}

function EmprisesPlan() {
  const { user } = useApp();
  const q = useApi(() => api<{ items: Emprise[]; notice: string }>('/v1/verticales/domaine-public/emprises'), [user?.id]);
  if (q.loading) return <Loading />;
  if (q.error) return null;
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="panel-title"><Icon name="pin" size={18} /> Domaine public — plan des emprises</h2><span className="count">{q.data?.items.length ?? 0}</span></div>
      <DataTable rows={q.data?.items ?? []} rowKey={(e) => e.objectId} empty={<EmptyState title="Aucune emprise" />}
        columns={[
          { key: 'o', label: 'Emprise', primary: true, render: (e) => <span className="mono">{e.objectId}</span> },
          { key: 't', label: 'Type', render: (e) => e.objectType === 'EMPRISE_PERMANENTE' ? 'Permanente' : e.objectType === 'EMPRISE_TEMPORAIRE' ? 'Temporaire' : 'Emprise (marchés)' },
          { key: 'c', label: 'Lieu', render: (e) => `${e.commune} · ${e.quartier}` },
          { key: 'u', label: 'Usage et surface', render: (e) => [e.usage, e.surfaceM2 ? `${e.surfaceM2} m²` : null].filter(Boolean).join(' · ') || '—' },
          { key: 'a', label: 'Autorisation', render: (e) => e.freed ? `Libérée le ${e.freed}` : e.authorization ? `${e.authorization.code} — ${e.authorization.status.toLowerCase()}` : 'Aucune' },
        ]} />
      <p className="hint">{q.data?.notice}</p>
    </section>
  );
}

export default function Secteurs() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const cat = useApi(() => api<{ items: SectorModule[]; notice: string }>('/v1/verticales/secteurs'), []);
  const taxpayer = roles.includes('R30') || roles.includes('R31');
  const agent = roles.some((r) => ['R06', 'R07', 'R11', 'R22', 'R24'].includes(r));
  const field = roles.some((r) => ['R09', 'R10', 'R11', 'R35'].includes(r));
  const plan = roles.some((r) => ['R06', 'R07', 'R09', 'R10', 'R11', 'R22'].includes(r));
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Catalogue des modules (§ 11)" title="Modules sectoriels — acte requis"
        lead="Véhicules, embarquement et ports, antennes, boissons et tabac, grands redevables, spectacles, carrières, forêts, péage : sur le socle commun, sans aucun montant avant l’acte." />
      {cat.loading && <Loading />}
      {!!cat.error && <ErrorState error={cat.error} onRetry={cat.reload} />}
      {cat.data && (
        <div className="stack">
          <div className="callout callout-info"><Icon name="info" size={18} /><p>{cat.data.notice}</p></div>
          <SecteursVisuels modules={cat.data.items} withDeclarations={agent || taxpayer} />
          <div className="g3-cards">
            {cat.data.items.map((m) => (
              <article key={m.module} className="g3-card">
                <h3>{m.module} — {m.name}</h3>
                <p className="small muted">{m.function} · verticale {m.verticalName}</p>
                <StatusBadge tone="info" label="Acte requis avant tout paiement" />
                {m.credentialTypes.length > 0 && <p className="small">Titres : {m.credentialTypes.map((t) => t.label).join(', ')} (non activables)</p>}
                <p className="small muted">Prérequis : {m.prerequisites.join(' ; ')}</p>
                {m.note && <p className="small">{m.note}</p>}
                <p className="small muted">{m.counts.declarations} déclaration(s) · {m.counts.observations} relevé(s) · {m.counts.references} référence(s)</p>
              </article>
            ))}
          </div>
          {taxpayer && <DeclareForm modules={cat.data.items} onDone={() => cat.reload()} />}
          {(agent || taxpayer) && <Declarations canReconcile={roles.includes('R11')} canDecide={roles.some((r) => r === 'R06' || r === 'R07')} />}
          {field && <FieldTools modules={cat.data.items} />}
          {plan && <EmprisesPlan />}
        </div>
      )}
    </div>
  );
}
