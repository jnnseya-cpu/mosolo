/**
 * Tableau du pilote de 180 jours (§ 45.1, § 45.3, § 45.5) : Gombe, Limete, Kalamu, Ngaliema comparées aux communes
 * témoins ; critères de succès du Cahier ; revues signées aux jalons (J30 … J180), vérifiables et immuables.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { COMMUNES, Section } from './shared';
import { Callout, Field, hasRole, Notice, useRunner } from './planif';
import './pilotage.css';
import { BarChartViz, fmtNombre, KpiTile, StatusDistribution, TimelineStrip } from '../../components/viz';
import { etatsDe, nombre, Tuiles, Visuels } from './visuels';

interface Indicateur40 { code: string; label: string; unit: string; targetLabel: string | null; pilot: string | null; controls: string | null; pilotStatus: string; gapPoints: string | null }
interface Criterion { code: string; label: string; threshold: string; pilot: { value: string | null; unit: string; met: boolean | null; note?: string }; controls: { value: string | null; unit: string; note?: string }; gapPoints: string | null; status: string; note: string; texte46?: string; indicateurs40?: Indicateur40[] }
/** Document maître FR 2, ch. 46 : communes (raison, objets prioritaires), séquence en cinq étapes, communes témoins. */
export interface Chapitre46 {
  communes: readonly { commune: string; raison: string; objets: string }[];
  sequence: { etape: number; semaines: readonly number[]; texte: string; enCours: boolean }[];
  semaine: number | null; temoins: string[] | null; note: string;
}
export interface PilotBoard {
  day: number | null; period: { from: string; to: string }; protocol: string;
  config: { startDate: string | null; communes: string[]; controls: string[]; setBy: string | null; motif: string | null };
  milestones: { milestone: string; days: number; dueDate: string | null; reached: boolean; signed: { id: string; takenAt: string; sha256: string } | null }[];
  criteria: Criterion[]; baseline: { id: string; period: string } | null;
  chapitre46?: Chapitre46;
  snapshots: { id: string; milestone: string; takenAt: string; takenBy: string; sha256: string }[];
}

const STATUS: Record<string, { label: string; tone: 'good' | 'critical' | 'neutral' | 'info' }> = {
  ATTEINT: { label: 'Atteint', tone: 'good' }, NON_ATTEINT: { label: 'Non atteint', tone: 'critical' }, NON_MESURE: { label: 'Non mesuré', tone: 'neutral' }, A_APPRECIER: { label: 'À apprécier (évaluation indépendante)', tone: 'info' },
};
const val = (v: string | null, unit: string) => (v === null ? '—' : `${v}${unit === '%' ? ' %' : unit === 's' ? ' s' : ''}`);

/** Visuels du pilote : jour sur 180, critères par statut, pilotes vs témoins, jalons dans le temps. */
export function VisuelsPilote({ b }: { b: PilotBoard }) {
  const pct = b.criteria.filter((c) => c.pilot.unit === '%' && (c.pilot.value !== null || c.controls.value !== null));
  const signees = b.milestones.filter((m) => m.signed).length;
  return (
    <>
      <Tuiles label="Pilote de 180 jours — synthèse" max={4}>
        <KpiTile hero label="Jour du pilote" value={b.day} format={(v) => fmtNombre(v, 0)} unit="/ 180" sub="Durée du pilote : 180 jours (§ 45)"
          reason="Date de démarrage non fixée." state={{ label: b.config.startDate ? `Démarré le ${b.config.startDate}` : 'Non démarré', tone: b.config.startDate ? 'info' : 'neutral' }} />
        <KpiTile label="Critères atteints" value={b.criteria.filter((c) => c.status === 'ATTEINT').length} format={(v) => fmtNombre(v, 0)} unit={`/ ${b.criteria.length}`} state={{ label: 'Seuils du Cahier (§ 45.3)', tone: 'good' }} />
        <KpiTile label="Revues signées" value={signees} format={(v) => fmtNombre(v, 0)} unit={`/ ${b.milestones.length}`} state={{ label: 'Instantanés figés', tone: signees > 0 ? 'good' : 'neutral' }} />
        <KpiTile label="Communes pilotes / témoins" value={`${b.config.communes.length} / ${b.config.controls.length}`} state={{ label: b.baseline ? 'Base de référence certifiée' : 'Base de référence absente', tone: b.baseline ? 'good' : 'warning' }} />
      </Tuiles>
      <Visuels label="Pilote en graphiques">
        <StatusDistribution title="Critères de succès par statut" unitLabel="critères" items={etatsDe(b.criteria, (c) => c.status, STATUS)} />
        <BarChartViz className="viz-span-2" title="Communes pilotes et communes témoins" subtitle="Critères exprimés en % — valeurs réelles de chaque groupe ; seuil dans le tableau" orientation="horizontal" format={(v) => `${fmtNombre(v)} %`}
          emptyText="Aucun critère en % encore mesuré" series={[{ key: 'p', label: 'Communes pilotes' }, { key: 't', label: 'Communes témoins' }]}
          rows={pct.map((c) => ({ key: c.code, label: c.label, values: { p: nombre(c.pilot.value), t: nombre(c.controls.value) } }))} />
        <TimelineStrip className="viz-span-2" title="Jalons du pilote (J30 … J180)" categories={['Revue signée', 'Atteint — à signer', 'À venir']} emptyText="Date de démarrage non fixée : jalons non datés"
          events={b.milestones.filter((m) => m.dueDate).map((m) => ({ id: m.milestone, at: m.dueDate!, category: m.signed ? 'Revue signée' : m.reached ? 'Atteint — à signer' : 'À venir', label: `${m.milestone} (${m.days} jours)` }))} />
      </Visuels>
    </>
  );
}

/** Communes pilotes (raison du choix, objets prioritaires) et séquence en cinq étapes (Document maître FR 2, ch. 46). */
export function Chapitre46View({ c }: { c: Chapitre46 }) {
  return (
    <Section title="Pilote de 180 jours — Document maître FR 2, ch. 46" sub={c.semaine ? `Semaine ${c.semaine} du pilote` : 'Pilote non démarré'}>
      <DataTable caption="Communes proposées" rows={[...c.communes]} rowKey={(x) => x.commune} columns={[
        { key: 'c', label: 'Commune', primary: true, render: (x) => <strong>{x.commune}</strong> },
        { key: 'r', label: 'Raison du choix', render: (x) => x.raison },
        { key: 'o', label: 'Objets prioritaires', render: (x) => x.objets },
      ]} />
      <ol className="small">{c.sequence.map((s) => <li key={s.etape}>{s.enCours ? <strong>{s.texte} (en cours)</strong> : s.texte}</li>)}</ol>
      <p className="small">Communes témoins : {c.temoins?.length ? c.temoins.join(', ') : 'aucune désignée'}. {c.note}</p>
    </Section>
  );
}

export function PilotView({ b, onDone }: { b: PilotBoard; onDone: () => void }) {
  const { user } = useApp();
  const r = useRunner(onDone);
  const [cfg, setCfg] = useState({ startDate: b.config.startDate ?? '', controls: b.config.controls.join(', '), motif: '' });
  const canSign = hasRole(user?.roles, 'R01', 'R05', 'R22', 'R23');
  return (
    <div className="dash-grid">
      <VisuelsPilote b={b} />
      <Section title="Communes pilotes et communes témoins" sub={b.config.startDate ? `Démarrage le ${b.config.startDate} — jour ${b.day}` : 'Date de démarrage non fixée'}>
        <p className="small"><strong>Pilotes :</strong> {b.config.communes.join(', ')} · <strong>Témoins :</strong> {b.config.controls.length ? b.config.controls.join(', ') : 'aucune désignée'}</p>
        {!b.baseline && <Callout tone="warn">Base de référence auditée absente : la progression comparée n’est pas mesurée (§ 45.5).</Callout>}
        <p className="small muted">{b.protocol}</p>
      </Section>
      <Section title="Critères de succès (§ 45.3)" sub="Seuils du Cahier ; valeurs calculées sur les données réelles de chaque groupe">
        <DataTable caption="Critères du pilote" rows={b.criteria} rowKey={(c) => c.code} columns={[
          { key: 'l', label: 'Critère', primary: true, render: (c) => <><strong>{c.label}</strong><span className="small muted" style={{ display: 'block' }}>Seuil : {c.threshold}</span>{c.texte46 && <span className="small" style={{ display: 'block' }}>Ch. 46 : « {c.texte46} »</span>}</> },
          { key: 'p', label: 'Communes pilotes', num: true, render: (c) => val(c.pilot.value, c.pilot.unit) },
          { key: 't', label: 'Communes témoins', num: true, render: (c) => val(c.controls.value, c.controls.unit) },
          { key: 'g', label: 'Écart (points)', num: true, render: (c) => c.gapPoints ?? '—' },
          { key: 's', label: 'Statut', render: (c) => <><StatusBadge tone={STATUS[c.status]?.tone ?? 'neutral'} label={STATUS[c.status]?.label ?? c.status} />{c.note && <span className="small muted" style={{ display: 'block' }}>{c.note}</span>}</> },
          { key: 'i', label: 'Indicateurs du § 40 (pilotes / témoins)', full: true, render: (c) => (c.indicateurs40?.length ? <ul className="small">{c.indicateurs40.map((i) => <li key={i.code}><strong>{i.label}</strong> : {val(i.pilot, i.unit)} / {val(i.controls, i.unit)}{i.gapPoints !== null ? ` (écart ${i.gapPoints})` : ''}{i.targetLabel ? ` — cible ${i.targetLabel}` : ''}</li>)}</ul> : '—') },
        ]} />
      </Section>
      {b.chapitre46 && <Chapitre46View c={b.chapitre46} />}
      <Section title="Revues signées (J30 … J180)" sub="Instantané figé et signé à chaque jalon ; vérifiable par l’outil de vérification des exports">
        <Notice msg={r.msg} />
        <DataTable caption="Jalons" rows={b.milestones} rowKey={(m) => m.milestone} columns={[
          { key: 'm', label: 'Jalon', primary: true, render: (m) => <strong>{m.milestone}</strong> },
          { key: 'd', label: 'Échéance', render: (m) => m.dueDate ?? '—' },
          { key: 's', label: 'Revue', render: (m) => (m.signed ? <span className="small">Signée le {m.signed.takenAt.slice(0, 10)} · <code className="hash">{m.signed.sha256.slice(0, 16)}…</code></span> : m.reached && canSign
            ? <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/pilote/revues/${m.milestone}`, {}, `Revue ${m.milestone} signée.`)}>Signer la revue</button>
            : <span className="small muted">{m.reached ? 'À signer (audit, Finances, Gouverneur)' : 'Jalon non atteint'}</span>) },
        ]} />
      </Section>
      {hasRole(user?.roles, 'R01', 'R05') && (
        <Section title="Configuration du protocole" sub="Date de démarrage et communes témoins (jamais une commune pilote) ; figée après la première revue signée">
          <div className="form">
            <Field label="Date de démarrage" type="date" value={cfg.startDate} onChange={(v) => setCfg({ ...cfg, startDate: v })} />
            <Field label="Communes témoins (séparées par des virgules)" value={cfg.controls} onChange={(v) => setCfg({ ...cfg, controls: v })} hint={`Communes : ${COMMUNES.filter((c) => !b.config.communes.includes(c)).join(', ')}`} />
            <Field label="Motif (10 caractères minimum)" value={cfg.motif} onChange={(v) => setCfg({ ...cfg, motif: v })} />
            <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/pilote/configuration', { startDate: cfg.startDate, controls: cfg.controls.split(',').map((x) => x.trim()).filter(Boolean), motif: cfg.motif }, 'Protocole enregistré.')}>Enregistrer</button></div>
          </div>
        </Section>
      )}
    </div>
  );
}

export default function Pilote() {
  const { user } = useApp();
  const q = useApi(() => api<PilotBoard>('/v1/pilotage/pilote'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 45" title="Pilote de 180 jours" lead="Communes pilotes comparées aux communes témoins, sur une base de référence auditée ; décision de généralisation sur résultats vérifiés de façon indépendante." />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && <PilotView b={q.data} onDone={q.reload} />}
    </div>
  );
}
