/**
 * ParkSmart — pilotage du chapitre 11A : grilles tarifaires (règles du registre, jamais de tarif saisi), occupation par
 * heure et cible de 15 à 25 % de places libres, recommandations tarifaires (jamais appliquées), sources de recettes et
 * données urbaines anonymisées, plaque (priorisation seulement), surréservation (désactivée sans validation juridique),
 * reconfigurations, affectation (engagement de programmation publié) et phases de déploiement conditionnées par l'acte.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { DemoTag, ErrorLine, hasRole, Kpis, Money, pctText, ReasonForm, useAction } from './shared';
import './parking.css';
import { TarificationDynamiqueTab } from './TarificationDynamique';

// ------------------------------------------------------------------ Types (contrat /v1/parking, chapitre 11A)

type GridStatus = 'ACTIVE' | 'A_VERIFIER' | 'ACTE_REQUIS';
interface Grid {
  id: string; mode: string; ruleCode: string; scope: 'REEL' | 'DEMO'; status: GridStatus; notice: string;
  zones: { id: string; code: string; name: string }[]; titleTypeCode: string | null;
  rule: { code: string; version: number; status: string; label: string; demo: boolean; formula: string; rateTable: Record<string, string> } | null;
}
interface TariffMode { mode: string; label: string; usage: string; title: boolean; grids: Grid[]; titleTypes: { code: string; label: string; activable: boolean; notActivableReason?: string }[] }
interface HourCell { hour: number; observed: boolean; occupied: number | null; source: 'CAPTEUR' | 'SESSIONS' | null; freeRate: string | null; target: 'SATURE' | 'SOUS_UTILISE' | 'DANS_LA_CIBLE' | 'SANS_OBJET' }
interface Occupancy {
  date: string; notice: string; target: { minPct: number; maxPct: number };
  zones: { zoneId: string; code: string; name: string; capacity: number; legalStatus: string; demo: boolean; hours: HourCell[]; hoursSaturated: number; hoursUnderused: number; alert: { level: string; text: string; freeRate: string | null } | null }[];
  alerts: { zoneId: string; name: string; text: string }[];
}
interface Recommendation { id: string; zoneId: string; zone: { code: string; name: string } | null; date: string; direction: string; basis: string; status: string; applied: false; decision?: { reason: string } }
interface Sources { sources: { code: string; label: string; content?: string; status: string; revenue?: MoneyJSON[]; titlesRevenue?: MoneyJSON[]; items?: { label: string; status: string }[]; zones?: { code: string; name: string; category: string }[] }[]; notice: string }
interface UrbanData { date: string; kThreshold: number; suppressedCells: number; notice: string; zones: { zoneCode: string; commune: string; demo: boolean; cells: { hour: number; sessionsStarted: number | null; distinctVehicles: number | null; suppressed: string | null; congestion: boolean }[] }[] }
interface Priorities { items: { plate: string; unpaid: number; retained: number; redChecks: number; checks: number; complianceScore: string | null; recidivism: string }[]; order: string; notice: string }
interface Profile { plate: string; measureAuthority: string; score: { complianceScore: string | null; recidivism: string; explanation: string[] }; history: { sessions: unknown[]; checks: unknown[]; violations: { id: string; reference: string; nature: string; status: string; payment: string | null }[]; titles: { number: string; typeCode: string; status: string; validUntil: string }[]; referrals: { id: string; measure: string; at: string }[] } }
interface Overbooking { active: boolean; ratePct: number; validation: { reference: string; guarantee: string; at: string } | null; stats: { sample: number; cancelled: number; observedCancellationRate: string | null; suggestedRatePct: number | null; enoughHistory: boolean; basis: string; bounds: { minPct: number; maxPct: number } } }
interface Reconfiguration { id: string; zone: { code: string; name: string } | null; kind: string; description: string; expectedEffect: string; status: string; demo: boolean }
interface Commitment { id: string; domain: string; domainLabel: string; label: string; legalForm: string; actReference: string | null; period: string; programmedAmount: MoneyJSON | null; published: boolean; demo: boolean }
interface Phase { id: string; number: number; label: string; duration: string; perimeter: string; status: string; zones: { id: string; code: string; name: string; legalStatus: string }[]; blockers: string[]; activable: boolean; activation?: { actReference: string } }

export const GRID_STATUS: Record<GridStatus, { tone: Tone; label: string }> = {
  ACTIVE: { tone: 'good', label: 'Publiée (ACTIVE)' }, A_VERIFIER: { tone: 'warning', label: 'À vérifier' }, ACTE_REQUIS: { tone: 'neutral', label: 'Acte requis' },
};
export const TARGET_CELL: Record<HourCell['target'], string> = { SATURE: 'Saturée', SOUS_UTILISE: 'Sous-utilisée', DANS_LA_CIBLE: 'Dans la cible', SANS_OBJET: '—' };
const RECONFIG_KIND: Record<string, string> = {
  STATIONNEMENT_EN_EPI: 'Stationnement en épi', NOUVELLES_BAIES: 'Nouvelles baies', ZONE_LIVRAISON: 'Zone de livraison', ZONE_ROTATION_RAPIDE: 'Rotation rapide', LONGUE_DUREE_PERIPHERIE: 'Longue durée en périphérie',
};

type Tab = 'tarifs' | 'dynamique' | 'occupation' | 'recettes' | 'plaques' | 'surreservation' | 'espaces' | 'affectation' | 'deploiement';
const TABS: [Tab, string][] = [
  ['tarifs', 'Grilles tarifaires'], ['dynamique', 'Tarification automatique (fourchettes de l’acte)'], ['occupation', 'Occupation et recommandations'], ['recettes', 'Recettes et données urbaines'], ['plaques', 'Plaques (priorisation)'],
  ['surreservation', 'Surréservation'], ['espaces', 'Reconfigurations'], ['affectation', 'Affectation'], ['deploiement', 'Déploiement'],
];

export default function ParkSmartPilotage() {
  const { user } = useApp();
  const [tab, setTab] = useState<Tab>('tarifs');
  if (!hasRole(user?.roles, 'R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R20', 'R21', 'R22', 'R23')) {
    return (
      <div className="page">
        <PageHead eyebrow="MOSOLO Parking" title="ParkSmart — pilotage § 11A" />
        <EmptyState title="Écran réservé au pilotage et à la régie" icon="lock">Choisissez « Cheffe de service Stationnement — DGTK » ou « Directeur général DGTK » dans l’en-tête.</EmptyState>
      </div>
    );
  }
  return (
    <div className="page page-wide">
      <PageHead eyebrow="MOSOLO Parking · chapitre 11A" title="ParkSmart — pilotage"
        lead="Toute grille tarifaire est une règle du registre, approuvée avant activation. Le système mesure et recommande ; une personne décide. Aucun blocage ni fourrière n’est déclenché par l’algorithme." />
      <ExampleNotice text="Valeurs marquées [EXEMPLE] : grilles fictives de démonstration, non opposables. Les grilles réelles restent « acte requis »." />
      <div className="seg seg-wrap pk-tabs" role="tablist" aria-label="Rubriques">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-pressed={tab === k} aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'tarifs' && <Tariffs />}
      {tab === 'dynamique' && <TarificationDynamiqueTab />}
      {tab === 'occupation' && <OccupancyTab />}
      {tab === 'recettes' && <RevenueTab />}
      {tab === 'plaques' && <PlatesTab />}
      {tab === 'surreservation' && <OverbookingTab />}
      {tab === 'espaces' && <ReconfigTab />}
      {tab === 'affectation' && <AffectationTab />}
      {tab === 'deploiement' && <DeploymentTab />}
    </div>
  );
}

function useLoad<T>(path: string, deps: unknown[] = []) {
  const { user } = useApp();
  return useApi(() => api<T>(path), [user?.id, ...deps]);
}

function Guard<T>({ state, children }: { state: { loading: boolean; error: unknown; data: T | null; reload: () => void }; children: (d: T) => ReactElement }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  return state.data ? children(state.data) : <Loading />;
}

// ------------------------------------------------------------------ Grilles tarifaires

function Tariffs() {
  const data = useLoad<{ items: TariffMode[] }>('/v1/parking/tariff-modes');
  return (
    <Guard state={data}>{(d) => (
      <div className="dash-grid">
        {d.items.map((m) => (
          <section key={m.mode} className="panel span-6">
            <header className="panel-head"><div><h2 className="panel-title"><Icon name="scale" size={18} /> {m.label}</h2><p className="panel-sub">{m.usage}{m.title ? ' · titre lié à la plaque (moteur de titres)' : ''}</p></div></header>
            <ul className="list-rows">
              {m.grids.map((g) => (
                <li key={g.id} className="list-row">
                  <div className="min0">
                    <p className="pk-row-title">{g.ruleCode} {g.scope === 'DEMO' && <DemoTag label="[EXEMPLE]" />}</p>
                    <p className="pk-sub">{g.notice}{g.rule?.formula ? ` · ${g.rule.formula}` : ''}</p>
                    {g.status === 'ACTIVE' && g.rule && Object.keys(g.rule.rateTable).length > 0 && (
                      <p className="pk-sub mono">{Object.entries(g.rule.rateTable).slice(0, 6).map(([k, v]) => `${k} = ${v}`).join(' · ')}</p>
                    )}
                  </div>
                  <div className="row-side"><StatusBadge tone={GRID_STATUS[g.status].tone} label={GRID_STATUS[g.status].label} /></div>
                </li>
              ))}
              {m.titleTypes.map((t) => (
                <li key={t.code} className="list-row">
                  <div className="min0"><p className="pk-row-title">Titre {t.code}</p><p className="pk-sub">{t.label}{t.notActivableReason ? ` — ${t.notActivableReason}` : ''}</p></div>
                  <div className="row-side"><StatusBadge tone={t.activable ? 'good' : 'neutral'} label={t.activable ? 'Achetable' : 'Non activable'} /></div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    )}</Guard>
  );
}

// ------------------------------------------------------------------ Occupation, alertes, recommandations

function OccupancyTab() {
  const { user } = useApp();
  const [tick, setTick] = useState(0);
  const occ = useLoad<Occupancy>('/v1/parking/occupancy', [tick]);
  const recs = useLoad<{ items: Recommendation[] }>('/v1/parking/pricing-recommendations', [tick]);
  const act = useAction();
  const regie = hasRole(user?.roles, 'R06', 'R07');
  return (
    <Guard state={occ}>{(d) => (
      <div className="dash-grid">
        <section className="panel span-12">
          <header className="panel-head"><div><h2 className="panel-title"><Icon name="chart" size={18} /> Occupation par heure — {d.date}</h2><p className="panel-sub">{d.notice}</p></div></header>
          {d.alerts.length > 0 && <ul className="list-rows">{d.alerts.map((a) => <li key={a.zoneId} className="list-row"><span className="pk-row-title">{a.name}</span><StatusBadge tone="warning" label={a.text} /></li>)}</ul>}
          <div className="table-scroll">
            <table className="data-table pk-hours">
              <caption className="sr-only">Places libres par zone et par heure</caption>
              <thead><tr><th scope="col">Zone</th>{Array.from({ length: 24 }, (_, h) => <th key={h} scope="col" className="num">{h}h</th>)}</tr></thead>
              <tbody>
                {d.zones.filter((z) => z.capacity > 0).map((z) => (
                  <tr key={z.zoneId}>
                    <th scope="row">{z.code} <DemoTag show={z.demo} /></th>
                    {z.hours.map((h) => <td key={h.hour} className={`num pk-cell-${h.target.toLowerCase()}`} title={`${TARGET_CELL[h.target]}${h.source === 'CAPTEUR' ? ' (capteur)' : ''}`}>{h.observed ? pctText(h.freeRate) : ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Valeurs : part de places libres. Cible : {d.target.minPct} à {d.target.maxPct} %.</p>
        </section>
        <section className="panel span-12">
          <header className="panel-head">
            <div><h2 className="panel-title"><Icon name="analysis" size={18} /> Recommandations tarifaires</h2><p className="panel-sub">Préparées par le système, jamais appliquées : un changement de tarif est une nouvelle version de règle approuvée par quatre visas.</p></div>
            {regie && <button type="button" className="btn btn-secondary btn-sm" disabled={act.busy} onClick={() => void act.run(() => api('/v1/parking/pricing-recommendations/run', { method: 'POST' }), () => setTick((n) => n + 1))}>Préparer</button>}
          </header>
          <ErrorLine error={act.error} />
          <Guard state={recs}>{(r) => r.items.length === 0 ? <p className="muted small">Aucune recommandation.</p> : (
            <ul className="list-rows">
              {r.items.map((x) => (
                <li key={x.id} className="list-row pk-col">
                  <div className="min0"><p className="pk-row-title">{x.zone?.name ?? x.zoneId} — {x.direction === 'HAUSSE_A_ETUDIER' ? 'hausse à étudier' : 'baisse à étudier'}</p><p className="pk-sub">{x.basis}</p>{x.decision && <p className="pk-sub">Décision : {x.decision.reason}</p>}</div>
                  <StatusBadge tone={x.status === 'PROPOSEE' ? 'info' : 'neutral'} label={x.status === 'PROPOSEE' ? 'Proposée' : x.status === 'ECARTEE' ? 'Écartée' : 'Retenue pour nouvelle version'} />
                  {regie && x.status === 'PROPOSEE' && (
                    <ReasonForm confirmLabel="Retenir pour une nouvelle version" onSubmit={(reason) => api(`/v1/parking/pricing-recommendations/${x.id}/decide`, { method: 'POST', body: { outcome: 'RETENUE_POUR_NOUVELLE_VERSION', reason } }).then(() => setTick((n) => n + 1))} />
                  )}
                </li>
              ))}
            </ul>
          )}</Guard>
        </section>
      </div>
    )}</Guard>
  );
}

// ------------------------------------------------------------------ Recettes et données urbaines

function RevenueTab() {
  const src = useLoad<Sources>('/v1/parking/revenue-sources');
  const urban = useLoad<UrbanData>('/v1/parking/urban-data');
  return (
    <div className="dash-grid">
      <section className="panel span-12">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="cash" size={18} /> Sources de recettes (§ 11A.3)</h2></div></header>
        <Guard state={src}>{(d) => (
          <>
            <ul className="list-rows">
              {d.sources.map((s) => (
                <li key={s.code} className="list-row pk-col">
                  <div className="min0">
                    <p className="pk-row-title">{s.label}</p>
                    {s.content && <p className="pk-sub">{s.content}</p>}
                    {s.items && <p className="pk-sub">{s.items.map((i) => `${i.label} : ${i.status === 'PHASE_FUTURE' ? 'phase future' : i.status === 'ACTE_REQUIS' ? 'acte requis' : 'en service'}`).join(' · ')}</p>}
                    {s.zones && s.zones.length > 0 && <p className="pk-sub">Zones premium : {s.zones.map((z) => `${z.name} (${z.category.toLowerCase()})`).join(', ')}</p>}
                  </div>
                  <div className="row-side">{s.revenue && <Money items={s.revenue} empty="0" />}{s.titlesRevenue && s.titlesRevenue.length > 0 && <span className="small"> + titres <Money items={s.titlesRevenue} /></span>}</div>
                </li>
              ))}
            </ul>
            <p className="small muted">{d.notice}</p>
          </>
        )}</Guard>
      </section>
      <section className="panel span-12">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="table" size={18} /> Données urbaines agrégées et anonymisées</h2></div></header>
        <Guard state={urban}>{(d) => (
          <>
            <p className="small">{d.notice} Cellules masquées : {d.suppressedCells}.</p>
            <DataTable rows={d.zones} rowKey={(z) => z.zoneCode} caption="Sessions commencées par zone (agrégats)"
              columns={[
                { key: 'z', label: 'Zone', primary: true, render: (z) => <>{z.zoneCode} <DemoTag show={z.demo} /></> },
                { key: 'c', label: 'Commune', render: (z) => z.commune },
                { key: 's', label: 'Sessions commencées (cellules publiées)', num: true, render: (z) => z.cells.reduce((a, c) => a + (c.sessionsStarted ?? 0), 0) },
                { key: 'm', label: 'Heures masquées (seuil k)', num: true, render: (z) => z.cells.filter((c) => c.suppressed).length },
                { key: 'g', label: 'Heures congestionnées', num: true, render: (z) => z.cells.filter((c) => c.congestion).length },
              ]} />
          </>
        )}</Guard>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ Plaques : priorisation seulement

function PlatesTab() {
  const { user } = useApp();
  const [tick, setTick] = useState(0);
  const pr = useLoad<Priorities>('/v1/parking/plates/priorities', [tick]);
  const [plate, setPlate] = useState<string | null>(null);
  const prof = useApi(() => (plate ? api<Profile>(`/v1/parking/plates/${encodeURIComponent(plate)}/profile`) : Promise.resolve(null)), [plate, tick, user?.id]);
  const regie = hasRole(user?.roles, 'R06', 'R07');
  return (
    <div className="dash-grid">
      <section className="panel span-6">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="gps" size={18} /> Priorités de patrouille et de proposition</h2></div></header>
        <Guard state={pr}>{(d) => (
          <>
            <p className="small muted">{d.notice} Ordre : {d.order}</p>
            <DataTable rows={d.items} rowKey={(r) => r.plate} caption="Plaques à prioriser"
              columns={[
                { key: 'p', label: 'Plaque', primary: true, render: (r) => <button type="button" className="btn btn-link btn-sm mono" onClick={() => setPlate(r.plate)}>{r.plate}</button> },
                { key: 'u', label: 'Pénalités impayées', num: true, render: (r) => r.unpaid },
                { key: 'r', label: 'Constats retenus', num: true, render: (r) => r.retained },
                { key: 'c', label: 'Conformité', num: true, render: (r) => pctText(r.complianceScore) },
              ]} />
          </>
        )}</Guard>
      </section>
      <section className="panel span-6">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="car" size={18} /> Profil de la plaque</h2></div></header>
        {!plate ? <p className="muted small">Choisissez une plaque.</p> : prof.loading ? <Loading /> : prof.error ? <ErrorState error={prof.error} /> : prof.data && (
          <div>
            <p className="pk-row-title mono">{prof.data.plate}</p>
            <ul className="small">{prof.data.score.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
            <p className="notice small"><Icon name="lock" size={14} /> {prof.data.measureAuthority}</p>
            <p className="small">Titres liés : {prof.data.history.titles.length} · constats : {prof.data.history.violations.length} · transmissions : {prof.data.history.referrals.length}</p>
            {regie && (
              <ReasonForm confirmLabel="Transmettre au contentieux (aucune mesure)" placeholder="Motifs de la transmission (obligatoire)"
                onSubmit={(grounds) => api(`/v1/parking/plates/${encodeURIComponent(plate)}/referrals`, { method: 'POST', body: { measure: 'FOURRIERE', grounds } }).then(() => setTick((n) => n + 1))} />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ Surréservation

function OverbookingTab() {
  const { user } = useApp();
  const [tick, setTick] = useState(0);
  const st = useLoad<Overbooking>('/v1/parking/overbooking', [tick]);
  const authority = hasRole(user?.roles, 'R06');
  const [reference, setReference] = useState('');
  const act = useAction();
  function validate(e: FormEvent) {
    e.preventDefault();
    void act.run(() => api('/v1/parking/overbooking/legal-validation', { method: 'POST', body: { reference, guarantee: 'COMPENSATION_AUTOMATIQUE', reason: 'Avis juridique enregistré par l’autorité.' } }), () => setTick((n) => n + 1));
  }
  return (
    <Guard state={st}>{(d) => (
      <div className="dash-grid">
        <section className="panel span-12">
          <Kpis items={[
            { label: 'Surréservation', value: d.active ? `Activée (${d.ratePct} %)` : 'Désactivée' },
            { label: 'Validation juridique', value: d.validation ? d.validation.reference : 'Aucune', sub: d.validation ? (d.validation.guarantee === 'GARANTIE_PLACE' ? 'Garantie de place' : 'Compensation automatique') : 'Protection du consommateur' },
            { label: 'Annulations observées', value: pctText(d.stats.observedCancellationRate), sub: `${d.stats.cancelled} sur ${d.stats.sample}` },
            { label: 'Taux fondé sur l’historique', value: d.stats.suggestedRatePct === null ? '—' : `${d.stats.suggestedRatePct} %`, sub: `bornes du dossier : ${d.stats.bounds.minPct}–${d.stats.bounds.maxPct} %` },
          ]} />
          <p className="small muted">{d.stats.basis}</p>
          {authority && !d.validation && (
            <form className="form" onSubmit={validate}>
              <label className="field"><span className="label">Référence de l’avis juridique (protection du consommateur)</span><input value={reference} onChange={(e) => setReference(e.target.value)} /></label>
              <ErrorLine error={act.error} />
              <button type="submit" className="btn btn-secondary btn-sm" disabled={act.busy || reference.trim().length < 3}>Enregistrer la validation</button>
            </form>
          )}
          {authority && d.validation && (
            <ReasonForm confirmLabel={d.active ? 'Désactiver' : 'Activer au taux fondé sur l’historique'} onSubmit={(reason) => api('/v1/parking/overbooking/activation', { method: 'POST', body: { enabled: !d.active, reason } }).then(() => setTick((n) => n + 1))} />
          )}
        </section>
      </div>
    )}</Guard>
  );
}

// ------------------------------------------------------------------ Reconfigurations

function ReconfigTab() {
  const data = useLoad<{ items: Reconfiguration[] }>('/v1/parking/reconfigurations');
  return (
    <Guard state={data}>{(d) => (
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="replace" size={18} /> Registre des reconfigurations (§ 11A.5)</h2><p className="panel-sub">Éléments de planification : la capacité d’une zone ne change qu’après acte et relevé.</p></div></header>
        <DataTable rows={d.items} rowKey={(r) => r.id} caption="Reconfigurations"
          columns={[
            { key: 'z', label: 'Zone', primary: true, render: (r) => <>{r.zone?.name ?? '—'} <DemoTag show={r.demo} /></> },
            { key: 'k', label: 'Nature', render: (r) => RECONFIG_KIND[r.kind] ?? r.kind },
            { key: 'd', label: 'Description', render: (r) => r.description },
            { key: 'e', label: 'Effet attendu', render: (r) => r.expectedEffect },
            { key: 's', label: 'Statut', render: (r) => <StatusBadge tone={r.status === 'REALISEE' ? 'good' : r.status === 'ABANDONNEE' ? 'neutral' : 'info'} label={r.status.toLowerCase()} /> },
          ]} />
      </section>
    )}</Guard>
  );
}

// ------------------------------------------------------------------ Affectation

function AffectationTab() {
  const { user } = useApp();
  const [tick, setTick] = useState(0);
  const data = useLoad<{ items: Commitment[] }>('/v1/parking/affectation/commitments', [tick]);
  const act = useAction();
  const authority = hasRole(user?.roles, 'R06', 'R07');
  return (
    <Guard state={data}>{(d) => (
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="building" size={18} /> Affectation (§ 11A.7)</h2><p className="panel-sub">Aucune affectation automatique : universalité budgétaire (LOFIP). À défaut d’acte, engagement de programmation publié au tableau de transparence.</p></div></header>
        <ErrorLine error={act.error} />
        <ul className="list-rows">
          {d.items.map((c) => (
            <li key={c.id} className="list-row">
              <div className="min0"><p className="pk-row-title">{c.domainLabel} — {c.label} <DemoTag show={c.demo} /></p><p className="pk-sub">{c.legalForm === 'ACTE_JURIDIQUE' ? `Acte : ${c.actReference}` : 'Engagement de programmation'} · {c.period}{c.programmedAmount ? <> · <Money items={c.programmedAmount} /></> : null}</p></div>
              <div className="row-side">
                {c.published ? <StatusBadge tone="good" label="Publié" /> : authority ? <button type="button" className="btn btn-secondary btn-sm" disabled={act.busy} onClick={() => void act.run(() => api(`/v1/parking/affectation/commitments/${c.id}/publish`, { method: 'POST' }), () => setTick((n) => n + 1))}>Publier</button> : <StatusBadge tone="neutral" label="Non publié" />}
              </div>
            </li>
          ))}
        </ul>
      </section>
    )}</Guard>
  );
}

// ------------------------------------------------------------------ Déploiement

function DeploymentTab() {
  const { user } = useApp();
  const [tick, setTick] = useState(0);
  const data = useLoad<{ phases: Phase[]; notice: string }>('/v1/parking/deployment', [tick]);
  const authority = hasRole(user?.roles, 'R06');
  const [acts, setActs] = useState<Record<string, string>>({});
  return (
    <Guard state={data}>{(d) => (
      <div className="dash-grid">
        <p className="small muted span-12">{d.notice}</p>
        {d.phases.map((p) => (
          <section key={p.id} className="panel span-4">
            <header className="panel-head"><div><h2 className="panel-title">Phase {p.number} — {p.label}</h2><p className="panel-sub">{p.duration} · {p.perimeter}</p></div></header>
            <StatusBadge tone={p.status === 'ACTIVEE' ? 'good' : 'neutral'} label={p.status === 'ACTIVEE' ? `Activée (${p.activation?.actReference ?? ''})` : 'Planifiée'} />
            <ul className="list-rows">{p.zones.map((z) => <li key={z.id} className="list-row"><span className="pk-row-title">{z.name}</span><span className="small">{z.legalStatus === 'ACTE_REQUIS' ? 'acte requis' : z.legalStatus.toLowerCase()}</span></li>)}</ul>
            {p.blockers.length > 0 && <p className="small notice">{p.blockers.join(' ; ')}</p>}
            {authority && p.activable && (
              <ReasonForm confirmLabel="Activer la phase" onSubmit={(reason) => api(`/v1/parking/deployment/phases/${p.number}/activation`, { method: 'POST', body: { actReference: acts[p.id] ?? '', reason } }).then(() => setTick((n) => n + 1))}>
                <label className="field"><span className="label">Référence de l’acte réglementaire</span><input value={acts[p.id] ?? ''} onChange={(e) => setActs({ ...acts, [p.id]: e.target.value })} /></label>
              </ReasonForm>
            )}
          </section>
        ))}
      </div>
    )}</Guard>
  );
}
