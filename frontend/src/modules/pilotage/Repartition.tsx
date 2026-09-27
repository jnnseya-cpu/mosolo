/**
 * Répartition des recettes (§ 37A, Cahier des exigences v2.9) : clé 10 / 10 / 10 / 70 au statut ACTE_REQUIS, simulation
 * sur recettes RAPPROCHÉES (par part, période, devise), deux flux de décaissement seulement, consommation de la réserve
 * « agents et sous-traitants » par les commissions validées. Activation : acte enregistré + deux personnes ; clé active
 * sans convention : chaque flux est proposé au Trésor et validé par une seconde personne ; acte ET convention tripartite
 * enregistrés : les deux flux sont exécutés automatiquement (décision du maître d'ouvrage du 27/09/2026).
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api, describeError } from '../../lib/api';
import { monthLabel, qs, Section, useFmt } from './shared';
import { ActForm, AutomationPanel, ControlsPanel, ConventionForm, ReserveModulesPanel, TableauPanel, type AutomationView, type ReportComplements } from './RepartitionComplements';
import './pilotage.css';
import { DonutViz, fmtCompact, fmtNombre, KpiTile, LineAreaViz, ProgressMeter, VizFrame } from '../../components/viz';
import { BarresParDevise, nombre, Tuiles, Visuels } from './visuels';

// ————————————————————————— contrat —————————————————————————

export type KeyStatus = 'ACTE_REQUIS' | 'ACTIVATION_PROPOSEE' | 'ACTIVE';
export interface Slice { code: string; label: string; pct: string; flow: 'FLUX_1' | 'FLUX_2'; remainder: boolean; calcul: string }
export interface SliceAmount { slice: string; label: string; pct: string; flow: string; amount: MoneyJSON }
export interface Aggregate {
  currency: string; base: MoneyJSON; payments: number; slices: SliceAmount[]; flows: { flow: string; label: string; amount: MoneyJSON }[];
  check: { sumOfSlices: MoneyJSON; equalsBase: boolean; flowsEqualBase: boolean };
}
export interface AgentsRow {
  period?: string; currency: string; reserve: MoneyJSON; commissionsValidated: MoneyJSON; commissionsRequested: MoneyJSON; commissionsAcquired: MoneyJSON;
  remaining: MoneyJSON; consumptionPct: string | null; status: 'SANS_CONSOMMATION' | 'SANS_RESERVE' | 'DEPASSEMENT' | 'DANS_LA_RESERVE';
}
export interface DistributionRow {
  id: string; period: string; currency: string; base: MoneyJSON; createdBy: string; createdAt: string; mode?: 'MANUEL' | 'AUTOMATIQUE';
  flows: { flow: string; label: string; amount: MoneyJSON; status: 'A_PROPOSER' | 'PROPOSEE' | 'INSTRUCTION_EMISE' | 'REJETEE'; operationId: string | null }[];
}
export interface RepartitionReport {
  generatedAt: string; mode: 'SIMULATION' | 'CALCUL'; disbursement: 'AUCUN'; notice: string; baseDefinition: string; tutelleNote: string;
  key: { id: string; status: KeyStatus; version: number; slices: Slice[]; durationYears: number; source: string };
  totals: (Aggregate & { regularisations: { count: number; amount: MoneyJSON } })[];
  byPeriod: (Aggregate & { period: string })[];
  byTutelle: (Aggregate & { tutelle: string })[];
  agents: { commissionModuleLoaded: boolean; rows: AgentsRow[]; totals: AgentsRow[]; rules: string[]; byModule?: ReportComplements['agentsByModule']; pointsShares?: ReportComplements['pointsShares'] };
  distributions: DistributionRow[];
  automation?: AutomationView;
  check100?: ReportComplements['check100'];
  regularisationsPending?: ReportComplements['regularisationsPending'];
  tableau?: ReportComplements['tableau'];
  indicateurs?: ReportComplements['indicateurs'];
}
export interface KeyView {
  key: {
    id: string; status: KeyStatus; slices: Slice[]; durationYears: number; source: string;
    legalAct?: { instrumentId: string; reference: string; title: string; nature: string; signedOn: string; documentSha256: string; conditions: Record<string, string>; recordedBy: string; recordedAt: string };
    activation?: { proposedBy: string; proposedAt: string; motif: string; ruleId: string; ruleVersion: number };
    decision?: { by: string; at: string; approve: boolean; motif: string };
    history: { at: string; by: string; action: string; detail?: string }[];
  };
  flows: Record<string, { label: string; beneficiary: string; note: string }>;
  baseDefinition: string; conditions: Record<string, string>; notice: string; activationPath: string[];
  registry: { id: string; version: number; status: string; executable: boolean; sourceReference: string | null }[];
}

export const KEY_STATUS: Record<KeyStatus, { label: string; tone: Tone }> = {
  ACTE_REQUIS: { label: 'Acte requis — non active', tone: 'warning' },
  ACTIVATION_PROPOSEE: { label: 'Activation proposée — seconde personne attendue', tone: 'info' },
  ACTIVE: { label: 'Active — flux proposés au Trésor ou exécutés automatiquement (convention)', tone: 'good' },
};
const AGENTS_STATUS: Record<AgentsRow['status'], { label: string; tone: Tone }> = {
  SANS_CONSOMMATION: { label: 'Aucune commission validée', tone: 'neutral' },
  DANS_LA_RESERVE: { label: 'Dans la réserve', tone: 'good' },
  DEPASSEMENT: { label: 'Dépassement — à arbitrer', tone: 'critical' },
  SANS_RESERVE: { label: 'Commissions sans réserve', tone: 'serious' },
};
const FLOW_STATUS: Record<DistributionRow['flows'][number]['status'], { label: string; tone: Tone }> = {
  A_PROPOSER: { label: 'À proposer', tone: 'neutral' }, PROPOSEE: { label: 'Proposé — validation Trésor', tone: 'warning' },
  INSTRUCTION_EMISE: { label: 'Instruction émise', tone: 'good' }, REJETEE: { label: 'Rejeté', tone: 'critical' },
};

const has = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));

/**
 * Actions ouvertes à la personne qui consulte (le serveur reste seul juge : séparation des tâches, acte, registre).
 * La décision d'activation revient à une personne distincte du proposant et de celle qui a enregistré l'acte.
 */
export function repartitionGuard(key: KeyView['key'], user: { id: string; roles: string[] } | null) {
  const roles = user?.roles;
  const canRecordAct = key.status === 'ACTE_REQUIS' && has(roles, 'R14', 'R16');
  const canPropose = key.status === 'ACTE_REQUIS' && !!key.legalAct && has(roles, 'R05', 'R16');
  let decideBlock: string | null = null;
  if (key.status !== 'ACTIVATION_PROPOSEE') decideBlock = 'Aucune activation proposée.';
  else if (!has(roles, 'R01', 'R05', 'R16')) decideBlock = 'Décision réservée au Gouverneur, au ministre des Finances et à l’autorité de publication.';
  else if (key.activation?.proposedBy === user?.id) decideBlock = 'Vous avez proposé l’activation : une autre personne décide.';
  else if (key.legalAct?.recordedBy === user?.id) decideBlock = 'Vous avez enregistré l’acte : une autre personne décide.';
  const canProposeDisbursement = key.status === 'ACTIVE' && has(roles, 'R17', 'R18');
  return { canRecordAct, canPropose, canDecide: decideBlock === null, decideBlock, canProposeDisbursement };
}

// ————————————————————————— vues —————————————————————————

/** Visuels de la répartition : clé, parts par devise, assiette mois par mois, réserve des agents, tutelles. */
export function VisuelsRepartition({ report, keyView }: { report: RepartitionReport; keyView: KeyView }) {
  const k = keyView.key;
  const devises = report.totals.map((t) => t.currency);
  const acte = k.status === 'ACTIVE' ? undefined : 'Clé au statut « acte requis » : parts par défaut — à confirmer par le maître d’ouvrage ; simulation seulement.';
  return (
    <>
      <Tuiles label="Répartition des recettes — synthèse" max={4}>
        <KpiTile hero label="Clé de répartition" value={`${k.slices.map((s) => s.pct).join(' / ')} %`} state={{ label: KEY_STATUS[k.status].label, tone: KEY_STATUS[k.status].tone }} sub={`${k.source} · ${k.durationYears} ans`} />
        {report.totals.map((t) => (
          <KpiTile key={t.currency} label={`Assiette rapprochée — ${t.currency}`} value={nombre(t.base.amount)} unit={t.currency} format={fmtCompact}
            state={t.check.equalsBase && t.check.flowsEqualBase ? { label: '100 % réparti', tone: 'good' } : { label: 'Écart — alerte', tone: 'critical' }} sub={`${t.payments} paiement(s) rapproché(s)`} />
        ))}
        {report.totals.length === 0 && <KpiTile label="Assiette rapprochée" value={null} reason="Aucune recette rapprochée sur la période." />}
        <KpiTile label="Répartitions arrêtées" value={report.distributions.length} format={(v) => fmtNombre(v, 0)} state={{ label: report.mode === 'SIMULATION' ? 'Simulation' : 'Calcul', tone: report.mode === 'SIMULATION' ? 'warning' : 'good' }} />
      </Tuiles>
      <Visuels label="Répartition en graphiques">
        <DonutViz title="Clé de répartition (§ 37A)" subtitle="Part de chaque bénéficiaire, en %" centerLabel="% des recettes rapprochées" format={(v) => `${fmtNombre(v)} %`} note={acte}
          slices={k.slices.map((s) => ({ key: s.code, label: s.label, value: nombre(s.pct) ?? 0 }))} />
        {report.totals.map((t) => (
          <DonutViz key={t.currency} title={`Parts calculées — ${t.currency}`} subtitle="Sur l’assiette rapprochée (somme = 100 % de l’assiette)" centerLabel={t.currency} format={(v) => `${fmtCompact(v)} ${t.currency}`}
            slices={t.slices.map((s) => ({ key: s.slice, label: s.label, value: nombre(s.amount.amount) ?? 0 }))} note={acte} />
        ))}
        {devises.map((c) => {
          const pts = report.byPeriod.filter((p) => p.currency === c && p.period.length === 7).sort((a, b) => a.period.localeCompare(b.period));
          return pts.length > 0 ? (
            <LineAreaViz key={`l-${c}`} className="viz-span-2" title={`Assiette rapprochée, mois par mois — ${c}`} granularity="month" area format={(v) => `${fmtCompact(v)} ${c}`} tickFormat={fmtCompact}
              series={[{ key: 'b', label: 'Assiette rapprochée' }]} points={pts.map((p) => ({ date: p.period, values: { b: nombre(p.base.amount) } }))} />
          ) : null;
        })}
        {report.agents.totals.length > 0 && (
          <VizFrame frame={{ title: 'Réserve des agents — consommation', subtitle: 'Commissions validées / réserve des 10 % (par devise)' }} empty={false}
            table={{ columns: ['Devise', 'Consommation'], rows: report.agents.totals.map((r) => [r.currency, r.consumptionPct === null ? '—' : `${r.consumptionPct} %`]) }}>
            <div className="pl-meters">
              {report.agents.totals.map((r) => (
                <ProgressMeter key={r.currency} compact label={`Réserve ${r.currency}`} unit="%" value={nombre(r.consumptionPct)} target={100} targetLabel="plafond de la réserve" better="BAISSE"
                  tone={AGENTS_STATUS[r.status].tone} toneLabel={AGENTS_STATUS[r.status].label} reason="aucune réserve sur la période" />
              ))}
            </div>
          </VizFrame>
        )}
        <BarresParDevise className="viz-span-2" title="Part des ministères de tutelle (indicatif)" series={[{ key: 'm', label: 'Part du ministère' }, { key: 'a', label: 'Réserve agents du module' }]} emptyText="Aucun module rattaché"
          rows={report.byTutelle.map((t) => ({ key: `${t.tutelle}-${t.currency}`, label: t.tutelle, values: { m: t.slices.find((x) => x.slice === 'TUTELLE')?.amount, a: t.slices.find((x) => x.slice === 'AGENTS_SOUS_TRAITANTS')?.amount } }))} />
      </Visuels>
    </>
  );
}

function SliceAmounts({ agg }: { agg: Aggregate }) {
  const f = useFmt();
  return <>{agg.slices.map((s) => <span key={s.slice} className="small" style={{ display: 'block' }}>{s.label} ({s.pct} %) : <strong>{f.money(s.amount)}</strong></span>)}</>;
}

export function RepartitionView({ report, keyView, onDone }: { report: RepartitionReport; keyView: KeyView; onDone: () => void }) {
  const { user, fmtDate } = useApp();
  const f = useFmt();
  const guard = repartitionGuard(keyView.key, user);
  const [motif, setMotif] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [prop, setProp] = useState({ period: '', currency: 'USD' });
  const base = `/v1/pilotage/repartition/cles/${encodeURIComponent(keyView.key.id)}`;
  async function run(path: string, body: unknown, ok: string) {
    if (motif.trim().length < 10) { setMsg({ ok: false, text: 'Motif d’au moins 10 caractères requis.' }); return; }
    setBusy(true); setMsg(null);
    try { await api(path, { method: 'POST', body }); setMsg({ ok: true, text: ok }); setMotif(''); onDone(); }
    catch (e) { const d = describeError(e); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); }
    finally { setBusy(false); }
  }
  const k = keyView.key;
  return (
    <div className="dash-grid">
      <div className="span-12">
        <div className={`callout ${report.mode === 'SIMULATION' ? 'callout-warn' : 'callout-info'}`} data-testid="repartition-notice" role="note">
          <Icon name={report.mode === 'SIMULATION' ? 'alert' : 'shieldCheck'} size={18} />
          <span><StatusBadge tone={KEY_STATUS[k.status].tone} label={KEY_STATUS[k.status].label} /> <strong>{report.notice}</strong></span>
        </div>
        <p className="small muted">{report.baseDefinition}</p>
      </div>
      <VisuelsRepartition report={report} keyView={keyView} />

      <Section title="Clé de répartition" sub={`${k.source} · durée ${k.durationYears} ans · deux flux de décaissement seulement`}>
        <DataTable caption="Parts de la clé" rows={k.slices} rowKey={(s) => s.code} columns={[
          { key: 'b', label: 'Bénéficiaire', primary: true, render: (s) => s.label },
          { key: 'p', label: 'Part', num: true, render: (s) => `${s.pct} %` },
          { key: 'c', label: 'Calcul', render: (s) => <span className="small">{s.calcul}</span> },
          { key: 'f', label: 'Flux', render: (s) => <span className="small">{keyView.flows[s.flow]?.label ?? s.flow}</span> },
        ]} />
        <ul className="small plain-list">{Object.entries(keyView.flows).map(([code, fl]) => <li key={code}><strong>{fl.label}</strong> — {fl.note}</li>)}</ul>
      </Section>

      <Section title="Activation (acte juridique et deux personnes)" sub="Aucune règle, aucun taux ni aucune projection n’entre en production avant certification juridique (§ 37A.8).">
        <ol className="small">{keyView.activationPath.map((s) => <li key={s}>{s}</li>)}</ol>
        <ul className="small plain-list" data-testid="repartition-conditions">
          <li>Acte juridique : {k.legalAct ? <strong>{k.legalAct.nature} {k.legalAct.reference} ({k.legalAct.instrumentId}), enregistré par {k.legalAct.recordedBy}</strong> : <StatusBadge tone="warning" label="non enregistré" />}</li>
          {Object.entries(keyView.conditions).map(([c, label]) => (
            <li key={c}>{label} : {k.legalAct?.conditions[c] ? <strong>{k.legalAct.conditions[c]}</strong> : <StatusBadge tone="warning" label="non documenté" />}</li>
          ))}
          <li>Registre juridique : {keyView.registry.map((r) => `${r.id} (${r.status}${r.executable ? ', exécutable' : ''})`).join(' ; ') || '—'}</li>
        </ul>
        {k.activation && <p className="small">Activation proposée par {k.activation.proposedBy} le {fmtDate(k.activation.proposedAt, true)} : {k.activation.motif}</p>}
        {k.decision && <p className="small muted">{k.decision.approve ? 'Activée' : 'Refusée'} par {k.decision.by} le {fmtDate(k.decision.at, true)} : {k.decision.motif}</p>}
        {msg && <p className={msg.ok ? 'notice notice-ok' : 'notice notice-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
        {(guard.canPropose || k.status === 'ACTIVATION_PROPOSEE' || guard.canProposeDisbursement) && (
          <div className="form">
            <div className="field"><label className="label" htmlFor="rep-motif">Motif (10 caractères minimum)</label>
              <input id="rep-motif" value={motif} onChange={(e) => setMotif(e.target.value)} /></div>
            <div className="btn-row">
              {guard.canPropose && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(`${base}/activation`, { motif }, 'Activation proposée : une seconde personne décide.')}>Proposer l’activation</button>}
              {k.status === 'ACTIVATION_PROPOSEE' && (guard.canDecide ? (
                <>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(`${base}/activation/decision`, { approve: true, motif }, 'Clé activée.')}>Approuver l’activation</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(`${base}/activation/decision`, { approve: false, motif }, 'Activation refusée : la clé reste au statut ACTE_REQUIS.')}>Refuser</button>
                </>
              ) : <p className="small muted" data-testid="repartition-block">{guard.decideBlock}</p>)}
            </div>
            {guard.canProposeDisbursement && (
              <div className="btn-row">
                <label className="pl-filter" htmlFor="rep-period"><span>Mois clos</span><input id="rep-period" placeholder="AAAA-MM" value={prop.period} onChange={(e) => setProp({ ...prop, period: e.target.value })} /></label>
                <label className="pl-filter" htmlFor="rep-cur"><span>Devise</span>
                  <select id="rep-cur" value={prop.currency} onChange={(e) => setProp({ ...prop, currency: e.target.value })}><option value="USD">USD</option><option value="CDF">CDF</option></select></label>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run('/v1/pilotage/repartition/propositions', { ...prop, reason: motif }, 'Deux flux proposés au Trésor : validation par une seconde personne.')}>Proposer les deux flux au Trésor</button>
              </div>
            )}
          </div>
        )}
        {guard.canRecordAct && <p className="small muted">Enregistrement de l’acte : juriste vérificateur ou autorité de publication, sur référence d’un instrument en vigueur du registre et empreinte du document officiel.</p>}
        {guard.canRecordAct && <ActForm keyId={k.id} conditions={keyView.conditions} onDone={onDone} />}
        {has(user?.roles, 'R14', 'R16') && <ConventionForm keyId={k.id} current={report.automation?.convention ?? null} onDone={onDone} />}
      </Section>

      {report.automation && <AutomationPanel automation={report.automation} onDone={onDone} />}
      {report.tableau && <TableauPanel tableau={report.tableau} />}
      <ControlsPanel report={report} />

      <Section title={report.mode === 'SIMULATION' ? 'Simulation par devise' : 'Répartition par devise'} sub="Somme des parts toujours égale à l’assiette rapprochée ; devises jamais additionnées">
        <DataTable caption="Répartition par devise" rows={report.totals} rowKey={(t) => t.currency} empty={<EmptyState title="Aucune recette rapprochée sur la période" icon="chart" />} columns={[
          { key: 'c', label: 'Devise', primary: true, render: (t) => <strong>{t.currency}</strong> },
          { key: 'b', label: 'Assiette rapprochée', num: true, render: (t) => <>{f.money(t.base)} <span className="small muted">({t.payments} paiement(s))</span></> },
          { key: 's', label: 'Parts', render: (t) => <SliceAmounts agg={t} /> },
          { key: 'f', label: 'Deux flux', render: (t) => <>{t.flows.map((x) => <span key={x.flow} className="small" style={{ display: 'block' }}>{x.label} : <strong>{f.money(x.amount)}</strong></span>)}</> },
          { key: 'k', label: 'Contrôle', render: (t) => <StatusBadge tone={t.check.equalsBase && t.check.flowsEqualBase ? 'good' : 'critical'} label={t.check.equalsBase && t.check.flowsEqualBase ? '100 % de l’assiette' : 'Écart — alerte'} /> },
          { key: 'r', label: 'Régularisations', render: (t) => t.regularisations.count ? <span className="small">{t.regularisations.count} remboursé(s) ou contrepassé(s) : {f.money(t.regularisations.amount)} hors assiette</span> : '—' },
        ]} />
      </Section>

      <Section title="Par période">
        <DataTable caption="Répartition par mois" rows={report.byPeriod} rowKey={(p) => `${p.period}-${p.currency}`} empty={<EmptyState title="Aucune période" icon="chart" />} columns={[
          { key: 'p', label: 'Mois', primary: true, render: (p) => monthLabel(p.period) },
          { key: 'c', label: 'Devise', render: (p) => p.currency },
          { key: 'b', label: 'Assiette', num: true, render: (p) => f.money(p.base) },
          ...report.key.slices.map((s) => ({ key: s.code, label: `${s.label} (${s.pct} %)`, num: true, render: (p: Aggregate) => f.money(p.slices.find((x) => x.slice === s.code)!.amount) })),
        ]} />
      </Section>

      <Section title="Par ministère de tutelle (indicatif)" sub={report.tutelleNote}>
        <DataTable caption="Répartition par ministère de tutelle" rows={report.byTutelle} rowKey={(t) => `${t.tutelle}-${t.currency}`} empty={<EmptyState title="Aucun module" icon="chart" />} columns={[
          { key: 't', label: 'Ministère de tutelle', primary: true, render: (t) => t.tutelle },
          { key: 'c', label: 'Devise', render: (t) => t.currency },
          { key: 'b', label: 'Assiette', num: true, render: (t) => f.money(t.base) },
          { key: 'm', label: 'Part du ministère', num: true, render: (t) => f.money(t.slices.find((x) => x.slice === 'TUTELLE')!.amount) },
          { key: 'a', label: 'Réserve agents du module', num: true, render: (t) => f.money(t.slices.find((x) => x.slice === 'AGENTS_SOUS_TRAITANTS')!.amount) },
        ]} />
      </Section>

      <Section title="Réserve « agents et sous-traitants » et commissions des agents" sub="Les commissions validées par un superviseur sont prélevées sur la réserve des 10 %">
        <DataTable caption="Consommation de la réserve des agents" rows={report.agents.totals} rowKey={(r) => r.currency} empty={<EmptyState title="Ni réserve ni commission sur la période" icon="users" />} columns={[
          { key: 'c', label: 'Devise', primary: true, render: (r) => <strong>{r.currency}</strong> },
          { key: 'r', label: 'Réserve (10 %)', num: true, render: (r) => f.money(r.reserve) },
          { key: 'v', label: 'Commissions validées', num: true, render: (r) => f.money(r.commissionsValidated) },
          { key: 'd', label: 'Demandées / acquises', num: true, render: (r) => <span className="small">{f.money(r.commissionsRequested)} / {f.money(r.commissionsAcquired)}</span> },
          { key: 'x', label: 'Reste', num: true, render: (r) => f.money(r.remaining) },
          { key: 'p', label: 'Consommation', num: true, render: (r) => (r.consumptionPct === null ? '—' : `${r.consumptionPct} %`) },
          { key: 's', label: 'État', render: (r) => <StatusBadge tone={AGENTS_STATUS[r.status].tone} label={AGENTS_STATUS[r.status].label} /> },
        ]} />
        <ul className="small">{report.agents.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      </Section>

      <ReserveModulesPanel report={{ agentsByModule: report.agents.byModule, pointsShares: report.agents.pointsShares }} />

      <Section title="Répartitions arrêtées et flux" sub="Flux proposés au Trésor (quatre yeux) ou exécutés automatiquement après l’acte et la convention ; deux flux seulement">
        <DataTable caption="Répartitions arrêtées" rows={report.distributions} rowKey={(d) => d.id} empty={<EmptyState title="Aucune répartition arrêtée" icon="lock">{report.mode === 'SIMULATION' ? 'Clé non active : simulation seulement.' : 'Proposez les deux flux d’un mois clos.'}</EmptyState>} columns={[
          { key: 'i', label: 'Répartition', primary: true, render: (d) => <span className="mono">{d.id}</span> },
          { key: 'p', label: 'Période', render: (d) => `${d.period.length === 7 ? monthLabel(d.period) : d.period} · ${d.currency}${d.mode === 'AUTOMATIQUE' ? ' · automatique' : ''}` },
          { key: 'b', label: 'Assiette', num: true, render: (d) => f.money(d.base) },
          { key: 'f', label: 'Flux', render: (d) => <>{d.flows.map((x) => <span key={x.flow} className="small" style={{ display: 'block' }}>{x.label} : {f.money(x.amount)} <StatusBadge tone={FLOW_STATUS[x.status].tone} label={FLOW_STATUS[x.status].label} /></span>)}</> },
        ]} />
      </Section>
    </div>
  );
}

export default function Repartition() {
  const { user } = useApp();
  const [filter, setFilter] = useState<{ period?: string; currency?: string }>({});
  const q = useApi(() => api<RepartitionReport>(`/v1/pilotage/repartition${qs({ ...filter })}`), [user?.id, JSON.stringify(filter)]);
  const k = useApi(() => api<KeyView>('/v1/pilotage/repartition/cle'), [user?.id]);
  const reload = () => { q.reload(); k.reload(); };
  const year = new Date().getUTCFullYear();
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 37A" title="Répartition des recettes"
        lead="Clé 10 % Groupe Nseya · 10 % ministères de tutelle · 10 % agents et sous-traitants · 70 % Gouvernement provincial, sur les recettes rapprochées, pendant 30 ans. Position du promoteur non active : acte juridique requis.">
        <button type="button" className="btn btn-secondary btn-sm" onClick={reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      <form className="pl-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filtres de la répartition">
        <label className="pl-filter" htmlFor="rep-f-p"><span>Période</span>
          <select id="rep-f-p" value={filter.period ?? ''} onChange={(e) => setFilter({ ...filter, period: e.target.value || undefined })}>
            <option value="">Depuis l’origine</option>
            {[String(year), String(year - 1)].map((p) => <option key={p} value={p}>Exercice {p}</option>)}
            {Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </label>
        <label className="pl-filter" htmlFor="rep-f-c"><span>Devise</span>
          <select id="rep-f-c" value={filter.currency ?? ''} onChange={(e) => setFilter({ ...filter, currency: e.target.value || undefined })}>
            <option value="">Toutes</option><option value="CDF">CDF</option><option value="USD">USD</option>
          </select>
        </label>
      </form>
      {(q.loading && !q.data) || (k.loading && !k.data) ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={reload} /> : k.error ? <ErrorState error={k.error} onRetry={reload} /> : q.data && k.data && (
        <RepartitionView report={q.data} keyView={k.data} onDone={reload} />
      )}
    </div>
  );
}
