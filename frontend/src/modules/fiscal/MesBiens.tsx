/**
 * Mes biens et relations (contribuable) / Biens, relations et validation (agents) :
 * hiérarchie commune › quartier › avenue › parcelle › bâtiment › unité, identifiant géofiscal (IGF),
 * QR par bien, relations contribuable–objet (rôle, quote-part, preuve, statut probant).
 */
import { useState, type FormEvent } from 'react';
import { Drawer } from '../../components/Drawer';
import { SeptQuestionsPanel } from '../chaine/SeptQuestions';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ColorChip, DemoNote, FiscalTabs, PROBATIVE, PROOF_LABELS, ReasonAction, RELATION_STATUS, useViewer, VerifyQr } from './common';
import type { FiscalObjectView, QueueResponse, Reference, RelationView } from './types';
import './fiscal.css';

function Breadcrumb({ o }: { o: FiscalObjectView }) {
  const parts = [...o.tree.geo.map((g) => `${g.name}${g.code !== '—' ? ` (${g.code})` : ''}`), ...o.tree.objects.slice(0, -1).map((x) => x.label)];
  return <p className="fs-path small">{parts.map((p, i) => <span key={`${p}-${i}`}>{p}<Icon name="chevronRight" size={12} /></span>)}<strong>{o.categoryLabel}</strong></p>;
}

function RelationRow({ r, onChanged }: { r: RelationView; onChanged: () => void }) {
  const { fmtDate } = useApp();
  const st = RELATION_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
  const pb = r.probativeStatus ? PROBATIVE[r.probativeStatus] : undefined;
  return (
    <li className="fs-rel">
      <div className="fs-rel-main">
        <p className="row-title">{r.own ? 'Vous' : r.taxpayerName ?? (r.taxpayerId ? r.taxpayerId : 'Autre titulaire (non affiché)')} — {r.roleLabel}{r.share ? ` · quote-part ${r.share} %` : ''}</p>
        <p className="small muted">Depuis le {fmtDate(r.from)}{r.to ? ` jusqu’au ${fmtDate(r.to)}` : ''}</p>
        {r.proofs && r.proofs.length > 0 && (
          <p className="small">Preuve : {r.proofs.map((p) => `${PROOF_LABELS[p.type] ?? p.type} — ${p.reference}`).join(' ; ')}</p>
        )}
      </div>
      <div className="row-side">
        {pb && <StatusBadge tone={pb.tone} label={pb.label} />}
        <StatusBadge tone={st.tone} label={st.label} />
        {r.own && r.id && (r.status === 'VALIDEE' || r.status === 'PROPOSEE') && (
          <ReasonAction label="Contester" confirmLabel="Envoyer la contestation" tone="secondary"
            onSubmit={(reason) => api(`/v1/fiscal/relationships/${encodeURIComponent(r.id!)}/contest`, { method: 'POST', body: { reason } }).then(onChanged)} />
        )}
      </div>
    </li>
  );
}

function ObjectCard({ o, onChanged }: { o: FiscalObjectView; onChanged: () => void }) {
  const { fmtDate } = useApp();
  const [chain, setChain] = useState(false);
  return (
    <article className="panel fs-object">
      <div className="fs-object-head">
        <div className="min0">
          <Breadcrumb o={o} />
          <h3 className="fs-igf mono">{o.igf ? o.igf.code : 'IGF attribué à la validation'}</h3>
          <p className="small muted">
            {o.igf ? <>Identifiant interne permanent <span className="mono">{o.igf.uuid.slice(0, 8)}…</span> · attribué le {fmtDate(o.igf.assignedAt)}</> : `Objet provisoire ${o.id}`}
            {o.example && <span className="tag fs-tag-demo">Exemple</span>}
          </p>
        </div>
        {o.plate && <VerifyQr path={o.plate.verifyPath} code={o.plate.shortCode} caption={o.plate.nfiu} size={96} />}
      </div>
      <dl className="kv kv-dense">
        <div><dt>Situation fiscale</dt><dd><ColorChip result={o.situation} /><span className="small muted fs-reason-txt">{o.situation.reason}</span></dd></div>
        <div><dt>Vérification</dt><dd><ColorChip result={o.coverage} /></dd></div>
        <div><dt>Occupation</dt><dd>{o.occupancy.label}</dd></div>
        <div><dt>Rang de localité</dt><dd>{o.localityRank}</dd></div>
        {o.plate && <div><dt>QR par bien</dt><dd>{o.plate.status === 'POSEE' ? 'Plaque posée' : 'Étiquette émise — pose administrative à venir'} <span className="small muted">(sans effet restrictif avant l’acte NFIU)</span></dd></div>}
        {o.tree.children.length > 0 && <div><dt>Sous-objets</dt><dd>{o.tree.children.map((c) => <span key={c.id} className="tag mono">{c.igf ?? c.id}</span>)}</dd></div>}
      </dl>
      <h4 className="h-sub fs-sub">Relations contribuable–objet</h4>
      {o.relations.length === 0 ? <p className="small muted">Aucune relation enregistrée.</p> : (
        <ul className="fs-rels">{o.relations.map((r, i) => <RelationRow key={r.id ?? `anon-${i}`} r={r} onChanged={onChanged} />)}</ul>
      )}
      {/* Vision (§ 3) : sept questions et chaîne opératoire du bien, selon les habilitations du lecteur. */}
      <div className="row-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setChain(true)} aria-haspopup="dialog"><Icon name="sync" size={16} /> Sept questions et chaîne</button>
      </div>
      <Drawer open={chain} onClose={() => setChain(false)} title={`Sept questions — ${o.igf?.code ?? o.id}`}>
        {chain && <SeptQuestionsPanel objectId={o.id} />}
      </Drawer>
    </article>
  );
}

function AttachForm({ refData, onDone }: { refData: Reference; onDone: () => void }) {
  const [v, setV] = useState({ objectId: '', role: 'PROPRIETAIRE', share: '', from: '', proofType: 'TITRE_FONCIER', proofRef: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await api<RelationView>('/v1/fiscal/relationships', { method: 'POST', body: {
        objectId: v.objectId.trim(), role: v.role, from: v.from, ...(v.share ? { share: v.share } : {}),
        proofs: [{ type: v.proofType, reference: v.proofRef.trim() }],
      } });
      setMsg({ ok: true, text: r.status === 'CONTESTEE'
        ? 'Demande enregistrée. Une autre revendication existe sur ce bien : un dossier de conflit est ouvert, aucune donnée de l’autre partie ne vous est communiquée.'
        : 'Demande de rattachement enregistrée. Un agent habilité l’instruira ; votre réponse ne vaut pas preuve de propriété.' });
      onDone();
    } catch (x) { setMsg({ ok: false, text: describeError(x).message }); } finally { setBusy(false); }
  }
  return (
    <form className="form" onSubmit={(e) => void go(e)}>
      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor="at-obj">Identifiant de l’objet</label>
          <input id="at-obj" className="mono" value={v.objectId} onChange={(e) => setV({ ...v, objectId: e.target.value })} required placeholder="OBJ-…" />
          <span className="hint">Inscrit sur l’avis de recensement ou la plaque du bien.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="at-role">Votre rôle</label>
          <select id="at-role" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
            {refData.relationRoles.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor="at-share">Quote-part (%)</label>
          <input id="at-share" inputMode="decimal" value={v.share} onChange={(e) => setV({ ...v, share: e.target.value })} placeholder={v.role === 'PROPRIETAIRE' ? '100' : 'ex. 50'} required={v.role === 'COPROPRIETAIRE'} pattern="^\d{1,3}(\.\d{1,2})?$" />
          <span className="hint">Obligatoire pour un copropriétaire ; 100 % par défaut pour un propriétaire unique.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="at-from">Depuis le</label>
          <input id="at-from" type="date" value={v.from} onChange={(e) => setV({ ...v, from: e.target.value })} required />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor="at-pt">Pièce justificative</label>
          <select id="at-pt" value={v.proofType} onChange={(e) => setV({ ...v, proofType: e.target.value })}>
            {refData.proofTypes.filter((p) => p !== 'CONSTAT_TERRAIN').map((p) => <option key={p} value={p}>{PROOF_LABELS[p] ?? p}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="at-pr">Référence de la pièce</label>
          <input id="at-pr" value={v.proofRef} onChange={(e) => setV({ ...v, proofRef: e.target.value })} required minLength={3} maxLength={200} />
        </div>
      </div>
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Envoi…' : 'Demander le rattachement'}</button>
    </form>
  );
}

function AgentQueue() {
  const q = useApi(() => api<QueueResponse>('/v1/fiscal/relationships/queue'), []);
  const [keep, setKeep] = useState<Record<string, string[]>>({});
  const [flash, setFlash] = useState<string | null>(null);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data!;
  async function validateObject(id: string) {
    try {
      const r = await api<{ object: FiscalObjectView }>(`/v1/fiscal/objects/${encodeURIComponent(id)}/validate`, { method: 'POST' });
      setFlash(`Objet validé — IGF ${r.object.igf?.code ?? ''} attribué, QR par bien émis.`);
      q.reload();
    } catch (x) { setFlash(describeError(x).message); }
  }
  return (
    <div className="stack">
      {flash && <p className="notice notice-ok" role="status">{flash}</p>}
      <section className="panel">
        <div className="panel-head"><div><p className="panel-title">Objets à valider</p><p className="panel-sub">Validation = IGF stable + QR par bien. L’auteur du recensement ne valide pas.</p></div><span className="count">{d.objectsToValidate.length}</span></div>
        {d.objectsToValidate.length === 0 ? <EmptyState title="Aucun objet en attente." /> : (
          <ul className="list-rows compact-rows">
            {d.objectsToValidate.slice(0, 30).map((o) => (
              <li key={o.id} className="list-row">
                <div className="min0"><p className="row-title mono">{o.id}</p><p className="small muted">{o.category} · {o.commune} › {o.quartier} · recensé par {o.createdBy}</p></div>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void validateObject(o.id)}><Icon name="check" size={16} /> Valider et attribuer l’IGF</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><div><p className="panel-title">Rattachements proposés</p><p className="panel-sub">Le déclarant ne valide jamais sa propre déclaration ; objet de forte valeur : niveau N2 exigé.</p></div><span className="count">{d.relations.length}</span></div>
        {d.relations.length === 0 ? <EmptyState title="Aucun rattachement en attente." /> : (
          <ul className="list-rows">
            {d.relations.map((r) => (
              <li key={r.id} className="list-row">
                <div className="min0">
                  <p className="row-title">{r.taxpayerName} — {r.roleLabel}{r.share ? ` · ${r.share} %` : ''}</p>
                  <p className="small muted mono">{r.object.igf?.code ?? r.object.id} · {r.object.commune}{r.object.highValue ? ' · forte valeur (N2)' : ''}</p>
                  <p className="small">Preuve : {(r.proofs ?? []).map((p) => `${PROOF_LABELS[p.type] ?? p.type} — ${p.reference}`).join(' ; ')}</p>
                </div>
                <div className="row-actions">
                  <ReasonAction label="Valider" confirmLabel="Valider le rattachement" onSubmit={(reason) => api(`/v1/fiscal/relationships/${encodeURIComponent(r.id!)}/validate`, { method: 'POST', body: { approve: true, reason } }).then(q.reload)} />
                  <ReasonAction label="Rejeter" confirmLabel="Rejeter" tone="secondary" onSubmit={(reason) => api(`/v1/fiscal/relationships/${encodeURIComponent(r.id!)}/validate`, { method: 'POST', body: { approve: false, reason } }).then(q.reload)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><div><p className="panel-title">Conflits de revendication</p><p className="panel-sub">Décision motivée (chef de service ou direction) ; aucune obligation n’est déplacée avant décision.</p></div><span className="count">{d.disputes.length}</span></div>
        {d.disputes.length === 0 ? <EmptyState title="Aucun conflit ouvert." /> : d.disputes.map((x) => (
          <div key={x.id} className="line-box fs-dispute">
            <p className="row-title">{x.id} — objet <span className="mono">{x.objectId}</span></p>
            <p className="small muted">{x.openedReason}</p>
            <fieldset className="field">
              <legend className="label">Relations à maintenir</legend>
              {x.relations.map((r) => (
                <label key={r.id} className="check">
                  <input type="checkbox" checked={(keep[x.id] ?? []).includes(r.id!)} onChange={(e) => setKeep({ ...keep, [x.id]: e.target.checked ? [...(keep[x.id] ?? []), r.id!] : (keep[x.id] ?? []).filter((k) => k !== r.id) })} />
                  <span>{r.taxpayerName} — {r.roleLabel}{r.share ? ` (${r.share} %)` : ''} · {RELATION_STATUS[r.status]?.label ?? r.status}</span>
                </label>
              ))}
            </fieldset>
            <ReasonAction label="Trancher" confirmLabel="Enregistrer la décision" onSubmit={(reason) => api(`/v1/fiscal/disputes/${encodeURIComponent(x.id)}/resolve`, { method: 'POST', body: { keepRelationIds: keep[x.id] ?? [], reason } }).then(q.reload)} />
          </div>
        ))}
      </section>
    </div>
  );
}

interface ScanResult {
  nfiu: string; plateStatus: string; category: string; commune: string; quartier: string; avenue: string | null; localityRank: number;
  occupancy: { label: string }; situation: FiscalObjectView['situation']; coverage: FiscalObjectView['coverage']; probativeStatus: string; notice: string; checkedAt: string;
}

function PlateScan() {
  const { fmtDate } = useApp();
  const [code, setCode] = useState('');
  const [res, setRes] = useState<ScanResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault();
    setErr(null); setRes(null);
    try { setRes(await api<ScanResult>(`/v1/fiscal/plates/${encodeURIComponent(code.trim())}/scan`)); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <section className="panel">
      <div className="panel-head"><div><p className="panel-title"><Icon name="qr" size={18} /> Scan de plaque (agent habilité)</p><p className="panel-sub">Identifiant, occupation, couleur de situation — aucun montant, aucune négociation. Chaque scan est journalisé.</p></div></div>
      <form className="input-row" onSubmit={(e) => void go(e)}>
        <input aria-label="Code court de la plaque" className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-X" autoCapitalize="characters" />
        <button type="submit" className="btn btn-primary" disabled={!code.trim()}>Lire</button>
      </form>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {res && (<>
        <dl className="kv kv-dense fs-scan">
          <div><dt>NFIU</dt><dd className="mono">{res.nfiu}</dd></div>
          <div><dt>Bien</dt><dd>{res.category} · {res.commune} › {res.quartier}{res.avenue ? ` › ${res.avenue}` : ''}</dd></div>
          <div><dt>Occupation</dt><dd>{res.occupancy.label}</dd></div>
          <div><dt>Situation</dt><dd><ColorChip result={res.situation} /></dd></div>
          <div><dt>Vérification</dt><dd><ColorChip result={res.coverage} /></dd></div>
          <div><dt>Lu le</dt><dd>{fmtDate(res.checkedAt, true)}</dd></div>
        </dl>
        <p className="small muted">{res.notice}</p>
      </>)}
    </section>
  );
}

export default function MesBiens() {
  const { user } = useApp();
  const { isTaxpayer, has } = useViewer();
  const objs = useApi(user ? () => api<FiscalObjectView[]>('/v1/fiscal/objects') : null, [user?.id]);
  const refData = useApi(() => api<Reference>('/v1/fiscal/reference'), []);
  const agent = has('R06', 'R07', 'R11');
  const scanner = has('R06', 'R07', 'R09', 'R10', 'R11');
  const list = objs.data ?? [];

  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Démarches fiscales" title={isTaxpayer ? 'Mes biens et relations' : 'Biens, relations et validation'}
        lead="Chaque bien reçoit, à sa validation, un identifiant géofiscal permanent et un QR vérifiable. Une relation (propriétaire, copropriétaire, usufruitier, héritier présumé, gestionnaire) n’est jamais établie sans pièce ; elle est validée par un agent habilité." />
      <FiscalTabs />
      <DemoNote />
      {!user && <EmptyState title="Choisissez un utilisateur de démonstration (en-tête) pour voir ses biens." icon="user" />}

      {agent && <section className="section" aria-labelledby="fs-queue"><div className="section-head"><h2 id="fs-queue">File de validation</h2></div><AgentQueue /></section>}
      {scanner && <section className="section"><PlateScan /></section>}

      {user && (
        <section className="section" aria-labelledby="fs-objs">
          <div className="section-head"><h2 id="fs-objs">{isTaxpayer ? 'Mes biens' : 'Objets de mon périmètre'}</h2><span className="count">{list.length}</span></div>
          {objs.loading && <Loading />}
          {objs.error !== null && <ErrorState error={objs.error} onRetry={objs.reload} />}
          {!objs.loading && !objs.error && list.length === 0 && <EmptyState title="Aucun bien rattaché." />}
          <div className="fs-grid">{list.slice(0, isTaxpayer ? 50 : 12).map((o) => <ObjectCard key={o.id} o={o} onChanged={objs.reload} />)}</div>
          {!isTaxpayer && list.length > 12 && <p className="small muted">{list.length - 12} autres objets — voir la carte pour la vue d’ensemble.</p>}
        </section>
      )}

      {isTaxpayer && refData.data && (
        <section className="section panel" aria-labelledby="fs-attach">
          <div className="panel-head"><div><p className="panel-title" id="fs-attach"><Icon name="building" size={18} /> Rattacher un bien</p><p className="panel-sub">Votre déclaration ouvre une instruction : elle ne vaut jamais preuve de propriété ni d’assujettissement.</p></div></div>
          <AttachForm refData={refData.data} onDone={objs.reload} />
        </section>
      )}
    </div>
  );
}
