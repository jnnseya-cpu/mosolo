/**
 * Projets publics et recommandation d'emploi des fonds (§ 27.2–27.3). L'agent d'allocation propose des scénarios
 * classés sur les fonds rapprochés ; il n'approuve aucune dépense et ne déplace aucun franc. L'autorité décide ; le
 * financement est constaté sur acte budgétaire ; les réalisations financées sont publiées chaque trimestre.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { currentQuarter, Section } from './shared';
import { Area, Callout, Choice, Field, hasRole, moneyText, Notice, useRunner } from './planif';
import './pilotage.css';
import { EnveloppesBudget, type Envelope } from './EnveloppesBudget';
import { BarChartViz, DonutViz, fmtNombre, KpiTile, ProgressMeter, StatusDistribution, VizFrame } from '../../components/viz';
import { BarresParDevise, etatsDe, lignesCompte, nombre, Tuiles, Visuels } from './visuels';
import type { Indicator } from '../decision/commun';

interface Project { id: string; code: string; title: string; domain: string; communes: string[]; beneficiaries: string; expectedResult: string; maturity: string; cost: MoneyJSON; recurringCost: MoneyJSON; procurement: string; risks: string; approvalAuthority: string; legalFundSource: string; status: string; progressPct?: string; funding?: { decisionReference: string }; example?: boolean }
interface FundScenario { id: string; label: string; variant: string; period: string; available: MoneyJSON; availableBasis: string; unallocated: MoneyJSON; status: string; notice: string; items: { projectId: string; code: string; title: string; communes: string[]; proposedAmount: MoneyJSON; rank: number; maturity: string; recurringCost: MoneyJSON; procurement: string; beneficiaries: string; approvalAuthority: string; factors: { label: string; value: string }[] }[]; decision?: { by: string; motif: string } }
interface ListResponse { domains: Record<string, string>; maturity: Record<string, number>; procurement: Record<string, string>; items: Project[]; scenarios: FundScenario[]; envelopes?: Envelope[]; indicators?: Indicator[] }

export const PROJECT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PROPOSE: { label: 'Proposé', tone: 'info' }, RETENU: { label: 'Retenu', tone: 'warning' }, ECARTE: { label: 'Écarté', tone: 'neutral' },
  FINANCE: { label: 'Financé (acte)', tone: 'good' }, EN_COURS: { label: 'En cours', tone: 'good' }, ACHEVE: { label: 'Achevé', tone: 'good' },
};

/** Visuels des projets : statuts, domaines, maturité, coûts par devise, avancement des projets financés. */
export function VisuelsProjets({ d }: { d: ListResponse }) {
  const entier = (v: number) => fmtNombre(v, 0);
  const suivis = d.items.filter((x) => ['FINANCE', 'EN_COURS', 'ACHEVE'].includes(x.status));
  const exemple = d.items.some((x) => x.example);
  return (
    <>
      <Tuiles label="Projets publics — synthèse" max={4}>
        <KpiTile hero label="Projets" value={d.items.length} format={entier} example={exemple} state={{ label: `${d.items.filter((x) => x.status === 'PROPOSE').length} proposé(s)`, tone: 'info' }} />
        <KpiTile label="Financés sur acte" value={suivis.length} format={entier} state={{ label: 'Acte budgétaire', tone: 'good' }} />
        <KpiTile label="Scénarios à décider" value={d.scenarios.filter((s) => s.status === 'PROPOSE').length} format={entier} state={{ label: 'Décision humaine', tone: 'warning' }} />
        <KpiTile label="Enveloppes certifiées" value={(d.envelopes ?? []).filter((e) => e.status === 'CERTIFIEE').length} format={entier} unit={`/ ${(d.envelopes ?? []).length}`} state={{ label: 'Budget voté', tone: 'neutral' }} />
      </Tuiles>
      <Visuels label="Projets en graphiques">
        <StatusDistribution title="Projets par statut" unitLabel="projets" emptyText="Aucun projet" example={exemple} items={etatsDe(d.items, (x) => x.status, PROJECT_STATUS)} />
        <DonutViz title="Projets par domaine" centerLabel="projets" emptyText="Aucun projet" example={exemple} slices={lignesCompte(d.items, (x) => x.domain).map((r) => ({ key: r.key, label: d.domains[r.key] ?? r.key, value: r.values.n }))} />
        <BarChartViz title="Projets par maturité" orientation="horizontal" format={entier} emptyText="Aucun projet" example={exemple} series={[{ key: 'n', label: 'Projets' }]}
          rows={Object.keys(d.maturity).map((m) => ({ key: m, label: m.replace(/_/g, ' ').toLowerCase(), values: { n: d.items.filter((x) => x.maturity === m).length } }))} />
        <BarresParDevise className="viz-span-2" title="Coût et coût récurrent par projet" series={[{ key: 'c', label: 'Coût' }, { key: 'r', label: 'Récurrent annuel' }]}
          rows={d.items.map((x) => ({ key: x.id, label: `${x.code} — ${x.title}${x.example ? ' [EXEMPLE]' : ''}`, values: { c: x.cost, r: x.recurringCost } }))} />
        {suivis.length > 0 && (
          <VizFrame frame={{ title: 'Avancement des projets financés', subtitle: 'Déclaré par le service porteur' }} empty={false}
            table={{ columns: ['Projet', 'Avancement'], rows: suivis.map((x) => [x.title, x.progressPct ? `${x.progressPct} %` : 'non déclaré']) }}>
            <div className="pl-meters">{suivis.map((x) => <ProgressMeter key={x.id} compact label={x.title} unit="%" value={nombre(x.progressPct ?? null)} target={100} targetLabel="achèvement" reason="avancement non déclaré" />)}</div>
          </VizFrame>
        )}
        <StatusDistribution title="Scénarios d’emploi des fonds" unitLabel="scénarios" emptyText="Aucun scénario proposé"
          items={etatsDe(d.scenarios, (s) => s.status, { PROPOSE: { label: 'Proposé — à décider', tone: 'warning' }, RETENU: { label: 'Retenu', tone: 'good' }, ECARTE: { label: 'Écarté', tone: 'neutral' } })} />
      </Visuels>
    </>
  );
}

export default function Projets() {
  const { user } = useApp();
  const q = useApi(() => api<ListResponse>('/v1/pilotage/projets'), [user?.id]);
  const r = useRunner(q.reload);
  const [motif, setMotif] = useState('');
  const [rec, setRec] = useState({ period: currentQuarter(), currency: 'USD', legalFundSource: '' });
  const [p, setP] = useState({ code: '', title: '', domain: 'VOIRIE', communes: '', beneficiaries: '', expectedResult: '', maturity: 'IDEE', cost: '', recurringCost: '', currency: 'USD', procurement: 'A_DETERMINER', risks: '', approvalAuthority: '', legalFundSource: '' });
  const [fund, setFund] = useState({ reference: '', progress: '' });
  const decide = hasRole(user?.roles, 'R01', 'R05');
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 27.2–27.3" title="Projets publics et emploi des fonds" lead="Collecte → comptabilité → partage légal → Trésor → budget → autorisation → engagement → dépense. L’IA compare des scénarios ; aucun transfert ni engagement n’est automatique." />
      <Callout><strong>L’IA propose, l’autorité décide.</strong> Les montants disponibles sont les recettes rapprochées ; la disponibilité budgétaire (niveau 11) relève du budget voté.</Callout>
      <Notice msg={r.msg} />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && (
        <div className="dash-grid">
          <VisuelsProjets d={q.data} />
          <EnveloppesBudget envelopes={q.data.envelopes ?? []} indicators={q.data.indicators ?? []} roles={user?.roles} userId={user?.id} onDone={q.reload} />
          <Section title="Projets" sub="Fiches complètes du § 27.2 : bénéficiaires, impact géographique, résultat, maturité, coût récurrent, passation, risques, autorité">
            <DataTable caption="Projets" rows={q.data.items} rowKey={(x) => x.id} empty={<EmptyState title="Aucun projet" icon="building" />} columns={[
              { key: 't', label: 'Projet', primary: true, render: (x) => <><strong>{x.title}</strong><span className="small muted" style={{ display: 'block' }}>{x.code} · {q.data!.domains[x.domain] ?? x.domain} · {x.communes.join(', ')}{x.example ? ' · donnée de démonstration non contractuelle' : ''}</span></> },
              { key: 'c', label: 'Coût / récurrent', num: true, render: (x) => `${moneyText(x.cost)} / ${moneyText(x.recurringCost)}` },
              { key: 'm', label: 'Maturité', render: (x) => x.maturity },
              { key: 's', label: 'Statut', render: (x) => <><StatusBadge tone={PROJECT_STATUS[x.status]?.tone ?? 'neutral'} label={PROJECT_STATUS[x.status]?.label ?? x.status} />{x.progressPct && <span className="small"> {x.progressPct} %</span>}</> },
              { key: 'a', label: 'Actions', render: (x) => (
                <div className="btn-row">
                  {decide && x.status === 'RETENU' && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || fund.reference.trim().length < 3 || motif.trim().length < 10} onClick={() => void r.run(`/v1/pilotage/projets/${x.id}/financement`, { decisionReference: fund.reference, amount: x.cost, motif }, 'Financement constaté sur acte.')}>Constater le financement</button>}
                  {hasRole(user?.roles, 'R05', 'R06', 'R07', 'R08') && ['FINANCE', 'EN_COURS'].includes(x.status) && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || !fund.progress} onClick={() => void r.run(`/v1/pilotage/projets/${x.id}/avancement`, { progressPct: fund.progress, note: 'Avancement déclaré par le service porteur', ...(fund.progress === '100' ? { status: 'ACHEVE' } : {}) }, 'Avancement enregistré.')}>Avancement</button>}
                </div>
              ) },
            ]} />
            <div className="form">
              <Field label="Référence de l’acte budgétaire (financement)" value={fund.reference} onChange={(v) => setFund({ ...fund, reference: v })} />
              <Field label="Avancement (%)" value={fund.progress} onChange={(v) => setFund({ ...fund, progress: v })} />
              <Field label="Motif de décision (10 caractères minimum)" value={motif} onChange={setMotif} />
            </div>
          </Section>
          <Section title="Scénarios d’emploi des fonds (proposés par l’IA)" sub="Classés selon trois logiques ; décision humaine motivée ; aucun effet financier">
            <DataTable caption="Scénarios" rows={q.data.scenarios} rowKey={(s) => s.id} empty={<EmptyState title="Aucun scénario proposé" icon="analysis" />} columns={[
              { key: 'l', label: 'Scénario', primary: true, render: (s) => <><strong>{s.label}</strong><span className="small muted" style={{ display: 'block' }}>{s.period} · disponible {moneyText(s.available)} · non affecté {moneyText(s.unallocated)}</span></> },
              { key: 'i', label: 'Projets classés', render: (s) => <ol className="small">{s.items.map((it) => <li key={it.projectId}>{it.title} — {moneyText(it.proposedAmount)} ({it.communes.join(', ')} ; {it.maturity} ; récurrent {moneyText(it.recurringCost)} ; {it.procurement} ; {it.approvalAuthority})</li>)}</ol> },
              { key: 's', label: 'Décision', render: (s) => (s.status !== 'PROPOSE' ? <StatusBadge tone={s.status === 'RETENU' ? 'good' : 'neutral'} label={s.status === 'RETENU' ? 'Retenu' : 'Écarté'} /> : decide ? (
                <div className="btn-row">
                  <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/pilotage/projets/scenarios/${s.id}/decision`, { retain: true, motif }, 'Scénario retenu (aucun transfert).')}>Retenir</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/pilotage/projets/scenarios/${s.id}/decision`, { retain: false, motif }, 'Scénario écarté.')}>Écarter</button>
                </div>
              ) : <span className="small muted">Décision : Gouverneur ou ministre des Finances</span>) },
            ]} />
            {hasRole(user?.roles, 'R01', 'R05', 'R15') && (
              <div className="form">
                <Field label="Période (AAAA-Tn)" value={rec.period} onChange={(v) => setRec({ ...rec, period: v })} />
                <Choice label="Devise" value={rec.currency} onChange={(v) => setRec({ ...rec, currency: v })} options={[['USD', 'USD'], ['CDF', 'CDF']]} />
                <Field label="Source légale des fonds" value={rec.legalFundSource} onChange={(v) => setRec({ ...rec, legalFundSource: v })} />
                <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/projets/recommandations', rec, 'Scénarios proposés : décision humaine requise.')}>Demander des scénarios</button></div>
              </div>
            )}
          </Section>
          {hasRole(user?.roles, 'R03', 'R05', 'R06', 'R08', 'R15') && (
            <Section title="Nouveau projet" sub="Bénéficiaires décrits collectivement : jamais de nom ni de donnée personnelle">
              <div className="form">
                <Field label="Code" value={p.code} onChange={(v) => setP({ ...p, code: v })} />
                <Field label="Intitulé" value={p.title} onChange={(v) => setP({ ...p, title: v })} />
                <Choice label="Domaine" value={p.domain} onChange={(v) => setP({ ...p, domain: v })} options={Object.entries(q.data.domains)} />
                <Field label="Communes d’impact (séparées par des virgules)" value={p.communes} onChange={(v) => setP({ ...p, communes: v })} />
                <Area label="Bénéficiaires" rows={2} value={p.beneficiaries} onChange={(v) => setP({ ...p, beneficiaries: v })} />
                <Area label="Résultat attendu" rows={2} value={p.expectedResult} onChange={(v) => setP({ ...p, expectedResult: v })} />
                <Choice label="Maturité" value={p.maturity} onChange={(v) => setP({ ...p, maturity: v })} options={Object.keys(q.data.maturity).map((k) => [k, k])} />
                <Field label="Coût" value={p.cost} onChange={(v) => setP({ ...p, cost: v })} />
                <Field label="Coût récurrent annuel" value={p.recurringCost} onChange={(v) => setP({ ...p, recurringCost: v })} />
                <Choice label="Devise" value={p.currency} onChange={(v) => setP({ ...p, currency: v })} options={[['USD', 'USD'], ['CDF', 'CDF']]} />
                <Choice label="Passation de marché" value={p.procurement} onChange={(v) => setP({ ...p, procurement: v })} options={Object.entries(q.data.procurement)} />
                <Area label="Risques" rows={2} value={p.risks} onChange={(v) => setP({ ...p, risks: v })} />
                <Field label="Autorité d’approbation" value={p.approvalAuthority} onChange={(v) => setP({ ...p, approvalAuthority: v })} />
                <Field label="Source légale des fonds" value={p.legalFundSource} onChange={(v) => setP({ ...p, legalFundSource: v })} />
                <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/projets', {
                  code: p.code, title: p.title, domain: p.domain, communes: p.communes.split(',').map((x) => x.trim()).filter(Boolean), beneficiaries: p.beneficiaries, expectedResult: p.expectedResult,
                  maturity: p.maturity, cost: { amount: p.cost, currency: p.currency }, recurringCost: { amount: p.recurringCost, currency: p.currency }, procurement: p.procurement, risks: p.risks,
                  approvalAuthority: p.approvalAuthority, legalFundSource: p.legalFundSource,
                }, 'Projet enregistré.')}>Enregistrer le projet</button></div>
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
