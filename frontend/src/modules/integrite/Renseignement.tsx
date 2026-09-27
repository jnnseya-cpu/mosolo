/**
 * Renseignement anti-fraude (spécification fonctionnelle, module 40) : scores explicables des alertes (gravité,
 * confiance, variables et sources), suspension conservatoire d'un accès technique (proposée par l'enquêteur, exécutée
 * et levée par le responsable sécurité), transmission à l'autorité compétente (bordereau scellé, accusé de réception),
 * déperdition évitée et indicateurs. Aucune sanction automatique.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ReasonAction } from '../fiscal/common';

export interface ScoreItem {
  id: string; alertId: string; ruleLabel: string; status: string; raisedAt: string; score: number; band: string; confidence: string;
  factors: { factor: string; value: string; contribution: string; source: string }[]; variables: { name: string; value: string; source: string }[]; method: string;
}
interface Suspension { id: string; caseId: string; userId: string; reason: string; days: number; status: string; proposedBy: string; execution?: { until: string } }
interface Transmission { id: string; caseId: string; authority: string; bordereauHash: string; transmittedAt: string; acknowledgement?: { reference: string } }
interface CaseLite { id: string; title: string; status: string; decision: string | null; investigatorId: string }
interface Indicators {
  alertes: { ouvertes: number; resolues: number };
  delaiInstruction: { statut: string; medianeJours?: number; motif?: string };
  deperditionEvitee: { statut: string; montants?: Record<string, string>; motif?: string };
  suspensions: { enVigueur: number; proposees: number }; transmissions: { total: number; accusees: number }; signalementsCitoyens: number;
}

const BAND: Record<string, Tone> = { ELEVE: 'critical', MOYEN: 'warning', FAIBLE: 'neutral' };
const S_STATUS: Record<string, { label: string; tone: Tone }> = {
  PROPOSEE: { label: 'Proposée — responsable sécurité', tone: 'warning' }, EN_VIGUEUR: { label: 'En vigueur (conservatoire)', tone: 'critical' },
  LEVEE: { label: 'Levée', tone: 'neutral' }, EXPIREE: { label: 'Échue', tone: 'neutral' }, REFUSEE: { label: 'Refusée', tone: 'neutral' },
};

export function ScoreCard({ s }: { s: ScoreItem }) {
  return (
    <li className="panel stack-sm">
      <div className="panel-head"><p className="panel-title">{s.ruleLabel}</p><StatusBadge tone={BAND[s.band] ?? 'neutral'} label={`Score ${s.score}/100`} /></div>
      <p className="small">{s.factors.map((f) => `${f.factor} ${f.value} (${f.contribution})`).join(' · ')} · confiance {s.confidence.toLowerCase()}</p>
      <ul className="plain-list small">{s.variables.map((v) => <li key={`${v.name}-${v.value}`}>{v.name} : {v.value} <span className="muted">— source : {v.source}</span></li>)}</ul>
      <p className="small muted">{s.method}</p>
    </li>
  );
}

export default function Renseignement() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const investigator = roles.includes('R24');
  const security = roles.some((r) => r === 'R28' || r === 'R26');
  const decider = roles.some((r) => r === 'R06' || r === 'R21');
  const scores = useApi(() => (roles.some((r) => ['R24', 'R22', 'R28'].includes(r)) ? api<{ items: ScoreItem[] }>('/v1/integrite/scores') : Promise.resolve({ items: [] })), [user?.id]);
  const susp = useApi(() => (roles.some((r) => ['R24', 'R22', 'R28', 'R26'].includes(r)) ? api<Suspension[]>('/v1/integrite/suspensions-conservatoires') : Promise.resolve([])), [user?.id]);
  const cases = useApi(() => (roles.some((r) => ['R24', 'R22', 'R06', 'R21'].includes(r)) ? api<CaseLite[]>('/v1/integrite/cases') : Promise.resolve([])), [user?.id]);
  const trans = useApi(() => (roles.some((r) => ['R24', 'R22', 'R06', 'R21'].includes(r)) ? api<Transmission[]>('/v1/integrite/transmissions') : Promise.resolve([])), [user?.id]);
  const ind = useApi(() => (roles.some((r) => ['R24', 'R22', 'R28', 'R25', 'R01', 'R02', 'R05'].includes(r)) ? api<Indicators>('/v1/integrite/renseignement/indicateurs') : Promise.resolve(null)), [user?.id]);
  const [target, setTarget] = useState<Record<string, { userId: string; days: string }>>({});
  const [err, setErr] = useState<string | null>(null);
  const reload = () => { susp.reload(); cases.reload(); trans.reload(); ind.reload(); };
  const act = (p: Promise<unknown>) => p.then(reload).catch((x) => { setErr(describeError(x).message); throw x; });
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Intégrité" title="Renseignement anti-fraude"
        lead="Les signaux sont classés par un score explicable (gravité, confiance, variables et sources) : il ordonne l’examen, il ne décide rien. Une suspension d’accès technique n’est qu’une mesure conservatoire, décidée et levée par des personnes distinctes ; la qualification et la sanction relèvent de l’autorité compétente." />
      {ind.data && (
        <section className="panel stack-sm" aria-label="Indicateurs du renseignement">
          <p className="small">Alertes ouvertes : <strong>{ind.data.alertes.ouvertes}</strong> · résolues : <strong>{ind.data.alertes.resolues}</strong> · signalements citoyens : {ind.data.signalementsCitoyens}</p>
          <p className="small">Délai d’instruction (médiane) : <strong>{ind.data.delaiInstruction.statut === 'MESURE' ? `${ind.data.delaiInstruction.medianeJours} j` : `non mesuré — ${ind.data.delaiInstruction.motif}`}</strong></p>
          <p className="small">Déperdition évitée : <strong>{ind.data.deperditionEvitee.statut === 'MESURE' ? Object.entries(ind.data.deperditionEvitee.montants ?? {}).map(([c, v]) => `${v} ${c}`).join(' + ') : `non mesurée — ${ind.data.deperditionEvitee.motif}`}</strong> · suspensions en vigueur : {ind.data.suspensions.enVigueur} · transmissions : {ind.data.transmissions.total} ({ind.data.transmissions.accusees} accusée(s))</p>
        </section>
      )}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <section className="stack-sm" aria-labelledby="sc-title">
        <h2 className="h-sub" id="sc-title">Alertes classées par score explicable</h2>
        {scores.loading && <Loading />}
        {scores.error !== null && <ErrorState error={scores.error} onRetry={scores.reload} />}
        {scores.data && scores.data.items.length === 0 && <EmptyState title="Aucune alerte à examiner." />}
        <ul className="stack-sm">{(scores.data?.items ?? []).slice(0, 30).map((s) => <ScoreCard key={s.alertId} s={s} />)}</ul>
      </section>
      <section className="stack-sm" aria-labelledby="su-title">
        <h2 className="h-sub" id="su-title">Suspensions conservatoires d’accès technique</h2>
        {investigator && (cases.data ?? []).filter((c) => c.status !== 'DECIDE' && c.investigatorId === user?.id).map((c) => (
          <div key={c.id} className="btn-row">
            <span className="small">Dossier <span className="mono">{c.id}</span> — {c.title}</span>
            <label className="small" htmlFor={`su-u-${c.id}`}>Compte</label><input id={`su-u-${c.id}`} value={target[c.id]?.userId ?? ''} onChange={(e) => setTarget({ ...target, [c.id]: { userId: e.target.value, days: target[c.id]?.days ?? '' } })} />
            <label className="small" htmlFor={`su-d-${c.id}`}>Jours</label><input id={`su-d-${c.id}`} inputMode="numeric" size={3} value={target[c.id]?.days ?? ''} onChange={(e) => setTarget({ ...target, [c.id]: { userId: target[c.id]?.userId ?? '', days: e.target.value } })} />
            <ReasonAction label="Proposer la suspension" confirmLabel="Proposer" minLength={20} onSubmit={(reason) => act(api(`/v1/integrite/cases/${c.id}/suspensions-conservatoires`, { method: 'POST', body: { userId: target[c.id]?.userId ?? '', days: Number(target[c.id]?.days ?? 0), reason } }))} />
          </div>))}
        {(susp.data ?? []).length === 0 && <p className="small muted">Aucune mesure.</p>}
        <ul className="stack-sm">{(susp.data ?? []).map((s) => {
          const st = S_STATUS[s.status] ?? { label: s.status, tone: 'neutral' as Tone };
          return (
            <li key={s.id} className="panel stack-sm">
              <div className="panel-head"><p className="panel-title">Compte <span className="mono">{s.userId}</span> · dossier {s.caseId} · {s.days} j</p><StatusBadge tone={st.tone} label={st.label} /></div>
              <p className="small">{s.reason}{s.execution ? ` — jusqu’au ${new Date(s.execution.until).toLocaleString('fr-FR')}` : ''}</p>
              {security && s.status === 'PROPOSEE' && user?.id !== s.proposedBy && (
                <div className="btn-row">
                  <ReasonAction label="Exécuter" confirmLabel="Suspendre l’accès (conservatoire)" onSubmit={(reason) => act(api(`/v1/integrite/suspensions-conservatoires/${s.id}/decision`, { method: 'POST', body: { execute: true, reason } }))} />
                  <ReasonAction label="Refuser" confirmLabel="Refuser" tone="secondary" onSubmit={(reason) => act(api(`/v1/integrite/suspensions-conservatoires/${s.id}/decision`, { method: 'POST', body: { execute: false, reason } }))} />
                </div>)}
              {security && s.status === 'EN_VIGUEUR' && <ReasonAction label="Lever" confirmLabel="Lever la mesure" onSubmit={(reason) => act(api(`/v1/integrite/suspensions-conservatoires/${s.id}/levee`, { method: 'POST', body: { reason } }))} />}
            </li>);
        })}</ul>
      </section>
      <section className="stack-sm" aria-labelledby="tr-title">
        <h2 className="h-sub" id="tr-title">Transmission à l’autorité compétente</h2>
        {decider && (cases.data ?? []).filter((c) => c.decision === 'SAISINE_AUTORITE_COMPETENTE' && !(trans.data ?? []).some((t) => t.caseId === c.id)).map((c) => (
          <div key={c.id} className="btn-row"><span className="small">Dossier <span className="mono">{c.id}</span> — {c.title} (saisine décidée)</span>
            <ReasonAction label="Transmettre" confirmLabel="Transmettre (bordereau scellé)" onSubmit={(authority) => act(api(`/v1/integrite/cases/${c.id}/transmission`, { method: 'POST', body: { authority } }))} />
          </div>))}
        <ul className="stack-sm">{(trans.data ?? []).map((t) => (
          <li key={t.id} className="panel stack-sm">
            <p className="small"><span className="mono">{t.id}</span> · dossier {t.caseId} → {t.authority} · {new Date(t.transmittedAt).toLocaleString('fr-FR')} · bordereau <span className="mono">{t.bordereauHash.slice(0, 12)}…</span> · {t.acknowledgement ? `accusé ${t.acknowledgement.reference}` : 'accusé en attente'}</p>
            {decider && !t.acknowledgement && <ReasonAction label="Enregistrer l’accusé" confirmLabel="Enregistrer" onSubmit={(reference) => act(api(`/v1/integrite/transmissions/${t.id}/accuse`, { method: 'POST', body: { reference } }))} />}
          </li>))}</ul>
      </section>
    </div>
  );
}
