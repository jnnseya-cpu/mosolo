/**
 * File de revue des biens et relations (spécification v1.0, § 5 et § 6) — réviseurs habilités (vérifier, rejeter,
 * demander une pièce, remplacer), revue de FUSION de biens (les deux arbres côte à côte, identifiants officiels,
 * positions, nombre de revendications et conflits ; cible canonique explicite), affectation à un agent de terrain
 * (territoire, durée) et constat de terrain (GPS + photo). Aucune décision automatique ; motif toujours obligatoire.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError, newIdempotencyKey } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { BarChartViz } from '../../components/viz';
import { CLAIM_ROLE, CLAIM_STATUS, RECORD_STATUS, sha256OfFile, toneOf } from './common';
import type { CaseDetail, CaseSummary, TreeNode } from './types';
import './compte-unique.css';
// Parcours par rôle (29/09/2026) : un écran vide propose la prochaine action utile du travail du jour.
import { SuiteDuTravail } from '../../components/SuiteDuTravail';

export default function RevueBiens() {
  const { user } = useApp();
  const q = useApi<{ items: CaseSummary[] }>(() => api('/v1/dossiers-revue'), [user?.id]);
  const [sel, setSel] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const parMotif = new Map<string, number>();
  for (const c of items.filter((x) => x.statut !== 'DECIDE')) parMotif.set(c.motifLibelle, (parMotif.get(c.motifLibelle) ?? 0) + 1);
  return (
    <div className="page">
      <PageHead eyebrow="Biens et relations" title="Revue des revendications et des doublons de biens"
        lead="Vérification par une personne habilitée : pièce acceptée, constat de terrain ou intégration autorisée. Une invitation acceptée ou un rapprochement ne suffisent jamais." />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          <BarChartViz title="Dossiers ouverts par motif" orientation="horizontal" series={[{ key: 'n', label: 'Dossiers' }]} rows={[...parMotif.entries()].map(([k, n]) => ({ key: k, label: k, values: { n } }))} emptyText="Aucun dossier ouvert" />
          {items.length === 0 ? <EmptyState title="Aucun dossier dans votre périmètre"><SuiteDuTravail /></EmptyState> : (
            <ul className="list-rows">
              {items.map((c) => (
                <li key={c.id} className="list-row">
                  <div className="min0">
                    <p className="row-title">{c.motifLibelle} — {c.commune}</p>
                    <p className="small muted mono">{c.id}{c.revendication ? ` · ${CLAIM_ROLE[c.revendication.role] ?? c.revendication.role} (${CLAIM_STATUS[c.revendication.statut]?.label ?? c.revendication.statut})` : ''}</p>
                  </div>
                  <div className="row-side">
                    <StatusBadge tone={toneOf(c.statut)} label={c.statut} />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSel(sel === c.id ? null : c.id)} aria-expanded={sel === c.id}>Examiner</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {sel && <Dossier id={sel} onChanged={q.reload} />}
        </>
      )}
    </div>
  );
}

function Tree({ n }: { n: TreeNode }) {
  return (
    <ul className="br-tree">
      <li className={n.dossierVise ? 'br-tree-target' : ''}>
        <span>{n.categorie} — {n.libelle}</span>{' '}
        <StatusBadge tone={RECORD_STATUS[n.statutEnregistrement]?.tone ?? 'neutral'} label={RECORD_STATUS[n.statutEnregistrement]?.label ?? n.statutEnregistrement} />
        <span className="small muted"> · {n.provenance}{n.identifiantOfficiel ? ` · ${n.identifiantOfficiel.namespace} ${n.identifiantOfficiel.value}${n.identifiantOfficiel.verified ? ' (vérifié)' : ' (déclaré)'}` : ''} · {n.position.lat.toFixed(4)}, {n.position.lon.toFixed(4)} · {n.revendications} revendication(s){n.conflits ? ` · ${n.conflits} conflit(s)` : ''}</span>
        {n.enfants.map((c) => <Tree key={c.id} n={c} />)}
      </li>
    </ul>
  );
}

function Dossier({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { fmtDate } = useApp();
  const q = useApi<CaseDetail>(() => api(`/v1/dossiers-revue/${encodeURIComponent(id)}`), [id]);
  const [choice, setDecision] = useState<string | null>(null);
  const [motif, setMotif] = useState('');
  const [canon, setCanon] = useState('');
  const [agent, setAgent] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const c = q.data;
  const post = async (path: string, body: Record<string, unknown>) => {
    setMsg(null);
    try { await api(`/v1/dossiers-revue/${encodeURIComponent(id)}/${path}`, { method: 'POST', idempotencyKey: newIdempotencyKey(), body }); setMsg('Enregistré.'); q.reload(); onChanged(); } catch (x) { setMsg(describeError(x).message); }
  };
  const decide = (e: FormEvent, value: string) => { e.preventDefault(); void post('decision', { decision: value, motif, ...(canon ? { canonical_target_id: canon } : {}), version: c?.version }); };
  const field = async (file: File | undefined) => {
    if (!file || !navigator.geolocation) { setMsg('Photo et position requises.'); return; }
    const sha = await sha256OfFile(file);
    navigator.geolocation.getCurrentPosition(
      (p) => void post('constat-terrain', { gps: { lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: p.coords.accuracy }, photo_sha256: sha, observations: motif || 'Constat sur place', confirme: true }),
      () => setMsg('Position indisponible : le constat exige le GPS.'),
    );
  };
  if (q.loading) return <Loading />;
  if (q.error !== null) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!c) return null;
  const merge = c.motif === 'FUSION_BIENS';
  const decision = choice ?? (merge ? 'FUSIONNER' : c.motif === 'CHEVAUCHEMENT_LOCATION_EXCLUSIVE' ? 'MAINTENIR' : 'VERIFIED');
  return (
    <section className="panel" aria-labelledby="rv-detail">
      <h2 id="rv-detail">{c.motifLibelle} <span className="mono small">{c.id}</span></h2>
      <p className="small muted">{c.mentionJuridique}</p>
      {c.note && <p className="small">{c.note}</p>}
      {c.revendications.map((r) => (
        <div key={r.id} className="br-claim">
          <p className="row-title">{CLAIM_ROLE[r.role] ?? r.role}{r.quotePart ? ` · ${r.quotePart} %` : ''}{r.colocation ? ' · colocation' : ''} — <StatusBadge tone={CLAIM_STATUS[r.statut]?.tone ?? 'neutral'} label={CLAIM_STATUS[r.statut]?.label ?? r.statut} /></p>
          {r.compte && <p className="small">Compte : {r.compte.nom} ({r.compte.niveau ?? '—'})</p>}
          {r.cible && <p className="small">Bien : {r.cible.libelle} — {RECORD_STATUS[r.cible.statutEnregistrement]?.label ?? r.cible.statutEnregistrement}</p>}
          <p className="small muted">{r.du ? `Du ${fmtDate(r.du)}` : ''}{r.au ? ` au ${fmtDate(r.au)}` : ''}</p>
          {r.pieces.length > 0 && <ul className="plain-list small">{r.pieces.map((p) => <li key={p.id}>{p.type} — <span className="mono">{p.sha256.slice(0, 16)}…</span> · {fmtDate(p.deposeeLe)}</li>)}</ul>}
        </div>
      ))}
      {c.fusion && (
        <div className="br-trees" aria-label="Arbres des deux enregistrements">
          {c.fusion.enregistrements.map((t) => <div key={t.id}><h3 className="h-sub">Enregistrement {t.id}</h3><Tree n={t} /></div>)}
        </div>
      )}
      {c.statut !== 'DECIDE' && (
        <form className="br-form" onSubmit={(e) => decide(e, decision)}>
          <div className="field">
            <label className="label" htmlFor="rv-dec">Décision</label>
            <select id="rv-dec" value={decision} onChange={(e) => setDecision(e.target.value)}>
              {merge ? (<><option value="FUSIONNER">Fusionner vers la cible canonique</option><option value="REJETER">Ne pas fusionner</option></>) : c.motif === 'CHEVAUCHEMENT_LOCATION_EXCLUSIVE' ? (<><option value="MAINTENIR">Maintenir les deux</option></>) : (
                <><option value="VERIFIED">Vérifier</option><option value="NEEDS_EVIDENCE">Demander une pièce</option><option value="REJECTED">Rejeter</option><option value="SUPERSEDED">Remplacée</option></>
              )}
            </select>
          </div>
          {merge && c.fusion && (
            <div className="field"><label className="label" htmlFor="rv-canon">Cible canonique (explicite)</label>
              <select id="rv-canon" value={canon} onChange={(e) => setCanon(e.target.value)}><option value="">—</option>{c.fusion.enregistrements.flatMap(function all(t): TreeNode[] { return [t, ...t.enfants.flatMap(all)]; }).filter((t) => t.dossierVise).map((t) => <option key={t.id} value={t.id}>{t.id} — {RECORD_STATUS[t.statutEnregistrement]?.label ?? t.statutEnregistrement}</option>)}</select>
            </div>
          )}
          <div className="field br-full"><label className="label" htmlFor="rv-motif">Motif (obligatoire)</label><textarea id="rv-motif" rows={3} value={motif} onChange={(e) => setMotif(e.target.value)} /></div>
          <button type="submit" className="btn btn-primary" disabled={motif.trim().length < 5}>Enregistrer la décision</button>
          {!merge && (
            <div className="br-actions br-full">
              <input aria-label="Agent de terrain à affecter" placeholder="Identifiant de l’agent de terrain" value={agent} onChange={(e) => setAgent(e.target.value)} />
              <button type="button" className="btn btn-ghost btn-sm" disabled={!agent} onClick={() => void post('affectation', { agent_id: agent })}>Affecter (durée limitée)</button>
              <label className="btn btn-secondary btn-sm">Constat de terrain (photo + GPS)<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void field(e.target.files?.[0])} /></label>
            </div>
          )}
        </form>
      )}
      {c.decision && <p className="small">Décision : {c.decision.decision} — {c.decision.reason} ({fmtDate(c.decision.at, true)})</p>}
      {msg && <p className="notice" role="status">{msg}</p>}
    </section>
  );
}
