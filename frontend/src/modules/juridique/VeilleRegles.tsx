/**
 * Module 26 — Veille du registre des règles : règles expirantes (horizon par défaut à confirmer), conflits de normes
 * (texte abrogé ou non en vigueur, doublon d'administration, versions concurrentes, compétence), archivage à quatre
 * yeux (le code reste réservé) et indicateurs (règles actives validées, règles expirant, délai d'approbation).
 */
import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';

interface Veille {
  horizonDays: number; horizonNote: string;
  expiring: { ruleId: string; code: string; version: number; label: string; effectiveTo: string; daysLeft: number; successor: boolean }[];
  conflicts: { kind: string; ruleIds: string[]; detail: string }[];
  indicators: {
    activeValidated: number; active: number; expiring: number; archived: number;
    approvalDelayDays: { measured: true; count: number; mean: number; median: number; max: number } | { measured: false; reason: string };
    pendingApprovals: { ruleId: string; code: string; version: number; status: string; ageDays: number; nextVisa: string | null }[];
  };
  archives: { id: string; ruleId: string; ruleCode: string; version: number; statusBefore: string; motif: string; requestedBy: string; status: string; decision?: { by: string; motif: string } }[];
}

const CONFLICT: Record<string, string> = {
  TEXTE_ABROGE: 'Texte abrogé cité', TEXTE_NON_EN_VIGUEUR: 'Texte non en vigueur', DOUBLON_ADMINISTRATION: 'Doublon entre administrations',
  VERSIONS_CONCURRENTES: 'Versions concurrentes', COMPETENCE: 'Compétence (province, ETD, pouvoir central, acte nouveau)',
};

export function VeilleRegles({ onChanged }: { onChanged?: () => void }) {
  const { user } = useApp();
  const [days, setDays] = useState(90);
  const q = useApi(() => api<Veille>(`/v1/legal-rules/veille?jours=${days}`), [user?.id, days]);
  const [ruleId, setRuleId] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (path: string, body: unknown, ok: string) => {
    setMsg(null);
    try { await api(path, { method: 'POST', body }); setMsg({ ok: true, text: ok }); q.reload(); onChanged?.(); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  };
  const ask = (label: string) => { const m = window.prompt(label); return m && m.trim().length >= 5 ? m.trim() : null; };
  const jurist = !!user?.roles.some((r) => ['R13', 'R14', 'R15', 'R16'].includes(r));
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data!;
  const delay = d.indicators.approvalDelayDays;
  return (
    <section className="panel stack-sm" aria-label="Veille du registre">
      <div className="panel-head"><h2 className="panel-title"><Icon name="clock" size={18} /> Veille du registre et indicateurs</h2></div>
      <div className="row-wrap small">
        <span>Règles actives validées (quatre visas) : <strong>{d.indicators.activeValidated}</strong> / {d.indicators.active}</span>
        <span>Règles expirant sous {d.horizonDays} jours : <strong>{d.indicators.expiring}</strong></span>
        <span>Délai d’approbation : {delay.measured ? <strong>{delay.median} j (médiane), {delay.mean} j (moyenne), max {delay.max} j</strong> : <span className="muted">non mesuré — {delay.reason}</span>}</span>
        <span>Archivées : {d.indicators.archived}</span>
      </div>
      <label className="small">Horizon de veille (jours) <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 90))} aria-label="Horizon de veille" /></label>
      <p className="hint">{d.horizonNote}</p>
      <h3>Règles expirantes</h3>
      {d.expiring.length ? <ul className="list-rows">{d.expiring.map((e) => <li key={e.ruleId} className="list-row"><span className="mono">{e.code}</span> v{e.version} — fin le {e.effectiveTo} ({e.daysLeft} j){e.successor ? ' · nouvelle version préparée' : ' · aucune nouvelle version'}</li>)}</ul> : <p className="small muted">Aucune règle n’expire dans l’horizon.</p>}
      <h3>Conflits de normes</h3>
      {d.conflicts.length ? <ul className="list-rows">{d.conflicts.map((c, i) => <li key={i} className="list-row"><StatusBadge tone="warning" label={CONFLICT[c.kind] ?? c.kind} /> <span className="small">{c.detail}</span></li>)}</ul> : <p className="small muted">Aucun conflit détecté.</p>}
      <h3>Demandes de visa en attente</h3>
      {d.indicators.pendingApprovals.length ? <ul className="list-rows small">{d.indicators.pendingApprovals.map((p) => <li key={p.ruleId}>{p.code} v{p.version} — {p.status}, depuis {p.ageDays} j · prochain visa : {p.nextVisa ?? '—'}</li>)}</ul> : <p className="small muted">Aucune.</p>}
      <h3>Archivage (quatre yeux, code réservé)</h3>
      {jurist && (
        <div className="row-wrap">
          <input value={ruleId} onChange={(e) => setRuleId(e.target.value)} placeholder="Identifiant de la version (ex. rule-xxx-v1)" aria-label="Version à archiver" />
          <button type="button" className="btn btn-ghost btn-sm" disabled={!ruleId} onClick={() => { const m = ask('Motif de l’archivage'); if (m) void run(`/v1/legal-rules/${encodeURIComponent(ruleId)}/archive-requests`, { motif: m }, 'Demande d’archivage enregistrée : confirmation par une autre personne.'); }}>Demander l’archivage</button>
        </div>
      )}
      {msg && <p className={msg.ok ? 'notice notice-ok' : 'err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      <ul className="list-rows">{d.archives.map((a) => (
        <li key={a.id} className="list-row">
          <span className="mono">{a.ruleCode}</span> v{a.version} ({a.statusBefore}) — {a.motif} · {a.status === 'DEMANDEE' ? 'en attente' : a.status === 'CONFIRMEE' ? 'archivée' : 'refusée'}
          {jurist && a.status === 'DEMANDEE' && user?.id !== a.requestedBy && <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif de la confirmation'); if (m) void run(`/v1/legal-rules/archives/${a.id}/decide`, { approve: true, motif: m }, 'Archivage confirmé.'); }}>Confirmer</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif du refus'); if (m) void run(`/v1/legal-rules/archives/${a.id}/decide`, { approve: false, motif: m }, 'Archivage refusé.'); }}>Refuser</button>
          </>}
        </li>
      ))}</ul>
    </section>
  );
}
