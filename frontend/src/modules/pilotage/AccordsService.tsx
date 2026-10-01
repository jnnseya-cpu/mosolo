/**
 * Accords de niveau de service entre entités (§ 10A.3) : délais d'instruction, de reversement et de réponse aux
 * vérifications, suivis au tableau et à l'audit ; satisfaction des contribuables et disponibilité du service (§ 39).
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from './shared';
import { Choice, Field, hasRole, Notice, useRunner } from './planif';
import './pilotage.css';
import { fmtNombre, KpiTile, ProgressMeter, StackedBarViz, StatusDistribution, VizFrame } from '../../components/viz';
import { nombre, Tuiles, Visuels } from './visuels';
import { ChoixEntite } from '../../components/Choix';

/** Visuels des accords de service : respect des délais par accord, état des demandes, satisfaction (§ 39). */
export function VisuelsAccords({ b, sat }: { b: Board; sat: Sat | null }) {
  const entier = (v: number) => fmtNombre(v, 0);
  const etat = (x: Req) => (x.closedAt ? (x.onTime ? 'OK' : 'KO') : x.overdue ? 'RETARD' : 'OUVERTE');
  return (
    <>
      <Tuiles label="Accords de service — synthèse" max={4}>
        <KpiTile hero label="Accords en vigueur" value={b.agreements.filter((a) => a.active).length} format={entier} state={{ label: 'Convention signée', tone: 'info' }} />
        <KpiTile label="Demandes inter-entités" value={b.agreements.reduce((s, a) => s + a.requests, 0)} format={entier} state={{ label: `${b.agreements.reduce((s, a) => s + a.open, 0)} ouverte(s)`, tone: 'neutral' }} />
        <KpiTile label="Closes dans le délai" value={b.agreements.reduce((s, a) => s + a.onTime, 0)} format={entier} state={{ label: 'Délai de l’accord', tone: 'good' }} />
        <KpiTile label="Hors délai" value={b.agreements.reduce((s, a) => s + a.late, 0) + b.requests.filter((x) => !x.closedAt && x.overdue).length} format={entier} state={{ label: 'Suivi à l’audit', tone: 'critical' }} />
      </Tuiles>
      <Visuels label="Accords de service en graphiques">
        <StackedBarViz className="viz-span-2" title="Respect des délais par accord" subtitle="Demandes closes dans le délai, hors délai, encore ouvertes" mode="absolute" orientation="horizontal" format={entier}
          emptyText="Aucun accord enregistré" series={[{ key: 'ok', label: 'Dans le délai' }, { key: 'ko', label: 'Hors délai' }, { key: 'o', label: 'Ouvertes' }]}
          rows={b.agreements.map((a) => ({ key: a.id, label: `${a.fromEntity} → ${a.toEntity} (${a.kindLabel})`, values: { ok: a.onTime, ko: a.late, o: a.open } }))} />
        <StatusDistribution title="Demandes récentes par état" unitLabel="demandes" emptyText="Aucune demande"
          items={(['OK', 'KO', 'RETARD', 'OUVERTE'] as const).map((k) => ({ key: k, label: { OK: 'Close dans le délai', KO: 'Close hors délai', RETARD: 'Ouverte hors délai', OUVERTE: 'Ouverte' }[k], tone: ({ OK: 'good', KO: 'critical', RETARD: 'serious', OUVERTE: 'warning' } as const)[k], count: b.requests.filter((x) => etat(x) === k).length }))} />
        {sat && (
          <VizFrame frame={{ title: 'Satisfaction des contribuables (§ 39)', subtitle: `${sat.total} réponse(s) ; moyenne masquée sous ${sat.threshold} réponses` }} empty={false}
            table={{ columns: ['Moment', 'Moyenne / 5', 'Réponses'], rows: [['Après paiement', sat.afterPayment.masked ? 'masqué' : sat.afterPayment.mean ?? '—', sat.afterPayment.count ?? '—'], ['Après visite', sat.afterVisit.masked ? 'masqué' : sat.afterVisit.mean ?? '—', sat.afterVisit.count ?? '—']] }}>
            <div className="pl-meters">
              <ProgressMeter compact label="Après paiement" unit="/ 5" max={5} value={sat.afterPayment.masked ? null : nombre(sat.afterPayment.mean)} reason={`moins de ${sat.threshold} réponses : moyenne masquée`} />
              <ProgressMeter compact label="Après visite" unit="/ 5" max={5} value={sat.afterVisit.masked ? null : nombre(sat.afterVisit.mean)} reason={`moins de ${sat.threshold} réponses : moyenne masquée`} />
            </div>
          </VizFrame>
        )}
      </Visuels>
    </>
  );
}

interface Agreement { id: string; fromEntity: string; toEntity: string; kind: string; kindLabel: string; delayHours: number; act: { reference: string }; active: boolean; requests: number; open: number; onTime: number; late: number }
interface Req { id: string; agreementId: string; reference: string; openedAt: string; dueAt: string; closedAt?: string; onTime?: boolean; overdue: boolean }
interface Board { kinds: Record<string, string>; agreements: Agreement[]; requests: Req[] }
interface Sat { total: number; threshold: number; afterPayment: { count: number | null; mean: string | null; masked: boolean }; afterVisit: { count: number | null; mean: string | null; masked: boolean }; note: string }

export default function AccordsService() {
  const { user } = useApp();
  const q = useApi(() => api<Board>('/v1/pilotage/accords-service'), [user?.id]);
  const canSat = hasRole(user?.roles, 'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R15', 'R17', 'R18', 'R22', 'R23', 'R24');
  const sat = useApi<Sat>(canSat ? () => api<Sat>('/v1/pilotage/satisfaction') : null, [user?.id]);
  const r = useRunner(q.reload);
  const [form, setForm] = useState({ fromEntity: '', toEntity: '', kind: 'INSTRUCTION', delayHours: '', reference: '', title: '' });
  const [ref, setRef] = useState('');
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 10A.3 et § 39" title="Accords de service entre entités" lead="Chaque demande inter-entités est horodatée ; son échéance découle de l’accord signé ; le respect des délais est suivi au tableau et à l’audit." />
      <Notice msg={r.msg} />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && (
        <div className="dash-grid">
          <VisuelsAccords b={q.data} sat={sat.data ?? null} />
          <Section title="Accords en vigueur">
            <DataTable caption="Accords" rows={q.data.agreements} rowKey={(a) => a.id} empty={<EmptyState title="Aucun accord de service enregistré" icon="scale">Les délais ne sont jamais présumés : ils découlent d’un accord signé.</EmptyState>} columns={[
              { key: 'e', label: 'Entités', primary: true, render: (a) => <><strong>{a.fromEntity} → {a.toEntity}</strong><span className="small muted" style={{ display: 'block' }}>{a.kindLabel} · {a.delayHours} h · {a.act.reference}</span></> },
              { key: 'n', label: 'Demandes', num: true, render: (a) => `${a.requests} (${a.open} ouverte(s))` },
              { key: 'r', label: 'Dans le délai / hors délai', num: true, render: (a) => `${a.onTime} / ${a.late}` },
              { key: 's', label: 'État', render: (a) => <StatusBadge tone={a.active ? 'good' : 'neutral'} label={a.active ? 'En vigueur' : 'Remplacé'} /> },
              { key: 'o', label: 'Ouvrir une demande', render: (a) => (a.active && user?.entity === a.fromEntity ? <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || ref.trim().length < 3} onClick={() => void r.run(`/v1/pilotage/accords-service/${a.id}/demandes`, { reference: ref }, 'Demande ouverte.')}>Ouvrir</button> : '—') },
            ]} />
            <Field label="Référence de la demande à ouvrir" value={ref} onChange={setRef} />
          </Section>
          <Section title="Demandes récentes">
            <DataTable caption="Demandes" rows={q.data.requests} rowKey={(x) => x.id} empty={<EmptyState title="Aucune demande" icon="check" />} columns={[
              { key: 'r', label: 'Demande', primary: true, render: (x) => <><strong>{x.reference}</strong><span className="small muted" style={{ display: 'block' }}>Échéance {x.dueAt.slice(0, 16).replace('T', ' ')}</span></> },
              { key: 's', label: 'État', render: (x) => (x.closedAt ? <StatusBadge tone={x.onTime ? 'good' : 'critical'} label={x.onTime ? 'Close dans le délai' : 'Close hors délai'} /> : <StatusBadge tone={x.overdue ? 'critical' : 'warning'} label={x.overdue ? 'Hors délai' : 'Ouverte'} />) },
              { key: 'c', label: 'Réponse', render: (x) => {
                const a = q.data!.agreements.find((y) => y.id === x.agreementId);
                return !x.closedAt && a && user?.entity === a.toEntity ? <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/accords-service/demandes/${x.id}/cloture`, {}, 'Demande close.')}>Répondre et clore</button> : '—';
              } },
            ]} />
          </Section>
          {hasRole(user?.roles, 'R02', 'R03', 'R05', 'R08') && (
            <Section title="Enregistrer un accord" sub="Sur la foi d’une convention signée (référence obligatoire)">
              <div className="form">
                <ChoixEntite label="Entité demandeuse" value={form.fromEntity} onChange={(v) => setForm({ ...form, fromEntity: v })} />
                <ChoixEntite label="Entité qui s’engage" value={form.toEntity} onChange={(v) => setForm({ ...form, toEntity: v })} />
                <Choice label="Nature" value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} options={Object.entries(q.data.kinds)} />
                <Field label="Délai (heures)" value={form.delayHours} onChange={(v) => setForm({ ...form, delayHours: v })} />
                <Field label="Référence de la convention" value={form.reference} onChange={(v) => setForm({ ...form, reference: v })} />
                <Field label="Intitulé" value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
                <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/accords-service', { fromEntity: form.fromEntity, toEntity: form.toEntity, kind: form.kind, delayHours: Number(form.delayHours), act: { reference: form.reference, title: form.title } }, 'Accord enregistré.')}>Enregistrer</button></div>
              </div>
            </Section>
          )}
          {sat.data && (
            <Section title="Satisfaction des contribuables (§ 39)" sub={sat.data.note}>
              <div className="pl-figs">
                <div className="pl-fig"><span>Réponses</span><strong>{sat.data.total}</strong></div>
                <div className="pl-fig"><span>Après paiement</span><strong>{sat.data.afterPayment.masked ? 'masqué' : `${sat.data.afterPayment.mean} / 5`}</strong></div>
                <div className="pl-fig"><span>Après visite</span><strong>{sat.data.afterVisit.masked ? 'masqué' : `${sat.data.afterVisit.mean} / 5`}</strong></div>
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
