/**
 * Déclaration pré-remplie : période, données connues (bien, baux déclarés, rang), saisie du contribuable,
 * dépôt avec accusé de réception, liquidation par règle ACTIVE seulement (sinon simulation NON OPPOSABLE),
 * corrections. Agents : instruction des corrections sur déclarations déjà liquidées.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatMoney } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { DemoNote, FiscalTabs, PROBATIVE, ReasonAction, useViewer } from './common';
import type { CalculAffiche, Declaration, FiscalObjectView, Prefill } from './types';
import { sha256Hex } from '../../lib/crypto';
import './fiscal.css';

const KIND_LABEL: Record<string, string> = { IF: 'Impôt foncier', IRL: 'Impôt sur les revenus locatifs' };
const STATUS: Record<string, { label: string; tone: 'good' | 'warning' | 'neutral' | 'info' | 'critical' | 'serious' }> = {
  DEPOSEE: { label: 'Déposée', tone: 'info' }, LIQUIDEE: { label: 'Liquidée', tone: 'good' }, A_INSTRUIRE: { label: 'Correction en instruction', tone: 'warning' },
  CORRECTION_REJETEE: { label: 'Correction rejetée', tone: 'critical' }, REMPLACEE: { label: 'Remplacée par une correction', tone: 'neutral' },
};
const MODE: Record<string, string> = {
  OPPOSABLE: 'Obligation émise (règle ACTIVE)', SIMULATION_NON_OPPOSABLE: 'Simulation NON OPPOSABLE — aucune obligation',
  DEJA_LIQUIDEE: 'Déjà liquidée pour cette période — aucune double facturation', EN_INSTRUCTION: 'En instruction', AUCUNE: '—',
};

/** Calcul affiché au déclarant : taux, retenue et référence de l'arrêté (lus dans la fiche de règle, jamais saisis). */
export function CalculBox({ c }: { c: CalculAffiche }) {
  return (
    <div className="callout callout-info" role="note">
      <span>
        <strong>Calcul :</strong> {c.formule}{c.taux !== null && <> · taux {c.taux} %</>}{c.tauxRetenue !== null && <> · retenue à la source {c.tauxRetenue} %</>}
        <br /><span className="small">Base : {c.base}</span>
        <br /><span className="small">Arrêté : {c.arretes.length ? c.arretes.map((a) => `${a.titre} (${a.statut === 'EN_VIGUEUR' ? 'en vigueur' : a.statut === 'A_VERIFIER' ? 'à vérifier' : a.statut})`).join(' ; ') : 'non cité'} — {c.mention}</span>
      </span>
    </div>
  );
}

function LiquidationBox({ d }: { d: Declaration }) {
  const t = d.liquidation.trace;
  const opposable = d.liquidation.mode === 'OPPOSABLE';
  return (
    <div className={`fs-liq ${opposable ? 'fs-liq-ok' : 'fs-liq-sim'}`}>
      <p className="row-title"><Icon name={opposable ? 'check' : 'info'} size={16} /> {MODE[d.liquidation.mode] ?? d.liquidation.mode}</p>
      <p className="small">{d.liquidation.message}</p>
      {t && (
        <dl className="kv kv-dense">
          <div><dt>Règle</dt><dd className="mono">{t.ruleCode} v{t.ruleVersion}{t.executable ? '' : ` — ${t.executabilityReason ?? 'non exécutable'}`}</dd></div>
          <div><dt>Formule</dt><dd><code className="formula">{t.formula}</code></dd></div>
          {t.grossResult && <div><dt>Montant avant exonération</dt><dd>{formatMoney(t.grossResult)}</dd></div>}
          {t.adjustments?.map((a) => <div key={a.sourceId}><dt>{a.label}</dt><dd>− {formatMoney(a.reduction)} <span className="small muted">({a.legalBasis.title}, {a.legalBasis.article})</span></dd></div>)}
          <div><dt>{opposable ? 'Montant liquidé' : 'Montant simulé'}</dt><dd><strong>{formatMoney(t.result)}</strong>{t.nonOpposable && <span className="tag fs-tag-demo">Non opposable</span>}</dd></div>
        </dl>
      )}
      {d.liquidation.obligationId && <p className="small">Obligation <span className="mono">{d.liquidation.obligationId}</span> — <Link to="/espace">voir l’explication et payer dans mon espace</Link></p>}
    </div>
  );
}

function DeclarationCard({ d, onChanged, canInstruct }: { d: Declaration; onChanged: () => void; canInstruct: boolean }) {
  const { fmtDate } = useApp();
  const { isTaxpayer } = useViewer();
  const [editing, setEditing] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>(d.inputs);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const st = STATUS[d.status] ?? { label: d.status, tone: 'neutral' as const };
  async function correct(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api(`/v1/fiscal/declarations/${encodeURIComponent(d.id)}/corrections`, { method: 'POST', body: { inputs, reason: reason.trim(), attest: true } }); setEditing(false); onChanged(); }
    catch (x) { setErr(describeError(x).message); }
  }
  return (
    <article className="panel fs-decl">
      <div className="panel-head">
        <div>
          <p className="panel-title">{KIND_LABEL[d.kind] ?? d.kind} {d.period} <span className="small muted">v{d.version}</span></p>
          <p className="panel-sub mono">{d.id} · objet {d.objectId}</p>
        </div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <dl className="kv kv-dense">
        <div><dt>Accusé de réception</dt><dd><span className="mono">{d.acknowledgement.number}</span> — {fmtDate(d.acknowledgement.receivedAt, true)}<br /><span className="small muted mono fs-hash">empreinte {d.acknowledgement.contentHash.slice(0, 16)}…</span></dd></div>
        {Object.entries(d.inputs).map(([k, v]) => <div key={k}><dt>{d.prefilled.find((f) => f.name === k)?.label ?? k}</dt><dd className="mono">{v}</dd></div>)}
        {d.calcul && <div><dt>Taux, retenue, arrêté</dt><dd>{d.calcul.taux !== null ? `Taux ${d.calcul.taux} %` : d.calcul.formule}{d.calcul.tauxRetenue !== null ? ` · retenue ${d.calcul.tauxRetenue} %` : ''} · {d.calcul.arretes.map((a) => a.titre).join(' ; ') || 'arrêté non cité'}<br /><span className="small muted">{d.calcul.mention}</span></dd></div>}
        {d.piece && <div><dt>Pièce justificative</dt><dd>{d.piece.name} <span className="small muted mono fs-hash">{d.piece.sha256.slice(0, 16)}…</span></dd></div>}
        {d.verificationRequired && <div><dt>Vérification</dt><dd>Correction à la baisse d’un élément vérifié : vérification ouverte (le dépôt n’est pas bloqué).</dd></div>}
        {d.correctionReason && <div><dt>Motif de correction</dt><dd>{d.correctionReason}</dd></div>}
        {d.instruction && <div><dt>Instruction</dt><dd>{d.instruction.decision === 'ACCEPTEE' ? 'Acceptée' : 'Rejetée'} — {d.instruction.reason}</dd></div>}
      </dl>
      <LiquidationBox d={d} />
      {isTaxpayer && !d.supersededBy && d.status !== 'REMPLACEE' && d.status !== 'A_INSTRUIRE' && d.prefilled.length > 0 && (
        editing ? (
          <form className="form fs-correct" onSubmit={(e) => void correct(e)}>
            {d.prefilled.map((f) => (
              <div className="field" key={f.name}>
                <label className="label" htmlFor={`c-${d.id}-${f.name}`}>{f.label}</label>
                <input id={`c-${d.id}-${f.name}`} inputMode="decimal" className="mono" value={inputs[f.name] ?? ''} onChange={(e) => setInputs({ ...inputs, [f.name]: e.target.value })} pattern="^\d{1,15}(\.\d{1,6})?$" required />
              </div>
            ))}
            <div className="field"><label className="label" htmlFor={`cr-${d.id}`}>Motif de la correction</label><textarea id={`cr-${d.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} /></div>
            {err && <p className="notice notice-err" role="alert">{err}</p>}
            <div className="btn-row"><button type="submit" className="btn btn-primary btn-sm">Déposer la correction</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Annuler</button></div>
          </form>
        ) : <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>Corriger</button>
      )}
      {canInstruct && d.status === 'A_INSTRUIRE' && (
        <div className="row-actions">
          <ReasonAction label="Accepter la correction" confirmLabel="Accepter (obligation rectificative)" onSubmit={(reason) => api(`/v1/fiscal/declarations/${encodeURIComponent(d.id)}/instruction`, { method: 'POST', body: { decision: 'ACCEPTEE', reason } }).then(onChanged)} />
          <ReasonAction label="Rejeter" confirmLabel="Rejeter la correction" tone="secondary" onSubmit={(reason) => api(`/v1/fiscal/declarations/${encodeURIComponent(d.id)}/instruction`, { method: 'POST', body: { decision: 'REJETEE', reason } }).then(onChanged)} />
        </div>
      )}
    </article>
  );
}

function NewDeclaration({ objects, onFiled }: { objects: FiscalObjectView[]; onFiled: () => void }) {
  const year = new Date().getFullYear();
  const [objectId, setObjectId] = useState(objects[0]?.id ?? '');
  const obj = objects.find((o) => o.id === objectId);
  const kinds = useMemo(() => (obj ? (['PARCELLE', 'BATIMENT'].includes(obj.category) ? ['IF', 'IRL'] : obj.category === 'UNITE_LOCATIVE' ? ['IRL'] : []) : []), [obj]);
  const [kind, setKind] = useState('IF');
  const [period, setPeriod] = useState(String(year));
  const [pre, setPre] = useState<Prefill | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [attest, setAttest] = useState(false);
  const [piece, setPiece] = useState<{ name: string; mediaType: string; sha256: string; sizeBytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filed, setFiled] = useState<Declaration | null>(null);
  const effectiveKind = kinds.includes(kind) ? kind : kinds[0] ?? 'IF';

  async function load(e: FormEvent) {
    e.preventDefault(); setErr(null); setPre(null); setFiled(null);
    try {
      const p = await api<Prefill>(`/v1/fiscal/declarations/prefill?objectId=${encodeURIComponent(objectId)}&kind=${effectiveKind}&period=${period}`);
      setPre(p); setInputs(Object.fromEntries(p.fields.map((f) => [f.name, f.value ?? ''])));
    } catch (x) { setErr(describeError(x).message); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!pre) return;
    setBusy(true); setErr(null);
    try {
      const d = await api<Declaration>('/v1/fiscal/declarations', { method: 'POST', body: { objectId: pre.objectId, kind: pre.kind, period: pre.period, inputs, attest, ...(piece ? { piece } : {}) } });
      setFiled(d); setPre(null); onFiled();
    } catch (x) { setErr(describeError(x).message); } finally { setBusy(false); }
  }

  if (objects.length === 0) return <EmptyState title="Aucun bien rattaché : rattachez d’abord un bien." />;
  return (
    <div className="stack">
      <form className="form" onSubmit={(e) => void load(e)}>
        <div className="field-row fs-row-3">
          <div className="field">
            <label className="label" htmlFor="nd-obj">Bien</label>
            <select id="nd-obj" value={objectId} onChange={(e) => { setObjectId(e.target.value); setPre(null); }}>
              {objects.map((o) => <option key={o.id} value={o.id}>{o.categoryLabel} — {o.igf?.code ?? o.id}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="nd-kind">Déclaration</label>
            <select id="nd-kind" value={effectiveKind} onChange={(e) => { setKind(e.target.value); setPre(null); }}>
              {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="nd-per">Exercice</label>
            <select id="nd-per" value={period} onChange={(e) => { setPeriod(e.target.value); setPre(null); }}>
              {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <button type="submit" className="btn btn-secondary" disabled={!objectId || kinds.length === 0}><Icon name="file" size={16} /> Ouvrir la déclaration pré-remplie</button>
      </form>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {pre && (
        <form className="form panel fs-prefill" onSubmit={(e) => void submit(e)}>
          <div className="panel-head">
            <div><p className="panel-title">{pre.kindLabel} {pre.period}</p><p className="panel-sub mono">{pre.igf ?? pre.objectId} · rang {pre.localityRank}</p></div>
            <StatusBadge tone={pre.rule.executable ? 'good' : 'warning'} label={pre.rule.executable ? `Règle ${pre.rule.code} ACTIVE` : `Règle ${pre.rule.code} : ${pre.rule.status}`} />
          </div>
          <p className={`callout ${pre.rule.executable ? 'callout-info' : 'callout-warn'}`}><Icon name={pre.rule.executable ? 'info' : 'alert'} size={18} /><span>{pre.notice}{pre.rule.demo ? ' Règle FICTIVE de démonstration.' : ''}</span></p>
          {pre.fields.length === 0 && <p className="small muted">Aucune donnée à saisir : l’assiette est forfaitaire selon le rang de localité.</p>}
          {pre.fields.map((f) => (
            <div className="field" key={f.name}>
              <label className="label" htmlFor={`pf-${f.name}`}>{f.label}</label>
              <input id={`pf-${f.name}`} inputMode="decimal" className="mono" value={inputs[f.name] ?? ''} onChange={(e) => setInputs({ ...inputs, [f.name]: e.target.value })} required pattern="^\d{1,15}(\.\d{1,6})?$" />
              <span className="hint">Pré-rempli : {f.value ?? '—'} · source : {f.source}{f.probativeStatus ? ` · ${PROBATIVE[f.probativeStatus]?.label ?? f.probativeStatus}` : ''}</span>
            </div>
          ))}
          {pre.calcul && <CalculBox c={pre.calcul} />}
          <div className="field">
            <label className="label" htmlFor="pf-piece">Pièce justificative (facultative)</label>
            <input id="pf-piece" type="file" onChange={(e) => { const f = e.target.files?.[0]; if (!f) { setPiece(null); return; } void f.arrayBuffer().then(sha256Hex).then((h) => setPiece({ name: f.name.slice(0, 200), mediaType: f.type || 'application/octet-stream', sha256: h, sizeBytes: f.size })); }} />
            <span className="hint">Seule l’empreinte du document est transmise{piece ? ` : ${piece.name} · ${piece.sha256.slice(0, 16)}…` : ''}.</span>
          </div>
          <label className="check"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /><span>J’atteste l’exactitude de cette déclaration. Toute correction à la baisse d’un élément vérifié ouvre une vérification sans bloquer mon dépôt.</span></label>
          <button type="submit" className="btn btn-primary" disabled={busy || !attest}>{busy ? 'Dépôt…' : 'Déposer la déclaration'}</button>
        </form>
      )}
      {filed && (
        <div className="notice notice-ok" role="status">
          <p><strong>Déclaration déposée.</strong> Accusé de réception <span className="mono">{filed.acknowledgement.number}</span>.</p>
          <LiquidationBox d={filed} />
        </div>
      )}
    </div>
  );
}

export default function Declarations() {
  const { user } = useApp();
  const { isTaxpayer, has } = useViewer();
  const canInstruct = has('R07', 'R11');
  const list = useApi(user && (isTaxpayer || canInstruct) ? () => api<Declaration[]>(isTaxpayer ? '/v1/fiscal/declarations' : '/v1/fiscal/declarations?status=A_INSTRUIRE') : null, [user?.id]);
  const objs = useApi(isTaxpayer ? () => api<FiscalObjectView[]>('/v1/fiscal/objects') : null, [user?.id]);
  const decls = (list.data ?? []).slice().reverse();
  const holderObjects = (objs.data ?? []).filter((o) => o.holder && o.holder !== 'autre');

  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Démarches fiscales" title={isTaxpayer ? 'Déclaration pré-remplie' : 'Corrections de déclarations à instruire'}
        lead="Les données connues (bien, baux déclarés, rang de localité) sont pré-remplies ; vous confirmez ou corrigez. Seule une règle ACTIVE du registre, publiée par quatre personnes distinctes, produit une obligation ; sinon le calcul reste une simulation non opposable." />
      <FiscalTabs />
      <DemoNote />
      {!isTaxpayer && !canInstruct && <EmptyState title="Réservé aux contribuables, mandataires et contrôleurs." icon="lock" />}
      {isTaxpayer && (
        <section className="section panel" aria-labelledby="nd-title">
          <div className="panel-head"><p className="panel-title" id="nd-title"><Icon name="file" size={18} /> Nouvelle déclaration</p></div>
          {objs.loading ? <Loading /> : objs.error ? <ErrorState error={objs.error} onRetry={objs.reload} /> : <NewDeclaration objects={holderObjects} onFiled={list.reload} />}
        </section>
      )}
      {(isTaxpayer || canInstruct) && (
        <section className="section" aria-labelledby="dl-title">
          <div className="section-head"><h2 id="dl-title">{isTaxpayer ? 'Mes déclarations' : 'File d’instruction'}</h2><span className="count">{decls.length}</span></div>
          {list.loading && <Loading />}
          {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
          {!list.loading && decls.length === 0 && <EmptyState title="Aucune déclaration." />}
          <div className="fs-grid">{decls.map((d) => <DeclarationCard key={d.id} d={d} onChanged={list.reload} canInstruct={canInstruct} />)}</div>
        </section>
      )}
    </div>
  );
}
