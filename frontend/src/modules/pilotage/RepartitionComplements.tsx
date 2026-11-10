/**
 * Compléments de l'écran de la répartition des recettes (module 73, décisions du maître d'ouvrage du 27/09/2026) :
 *  - enregistrement de l'acte juridique (référence, empreinte, conditions du § 37A.8) et de la convention tripartite
 *    de règlement (périodicité, comptes bénéficiaires VERROUILLÉS du coffre, un par flux et par devise) ;
 *  - automatisation : simulation quotidienne en comptes d'ordre du grand livre avant l'acte ; exécution AUTOMATIQUE des
 *    deux flux une fois l'acte et la convention enregistrés et la clé active (piste d'audit complète) ;
 *  - tableau calculé / rapproché / versé / reste à verser ; contrôle à 100 % ; régularisations automatiques ;
 *  - indicateurs : écart de répartition, délai de versement, écart grand livre / répartitions ;
 *  - réserve des agents par module et quotes-parts par points de résultats vérifiés (module 67).
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { DataTable } from '../../components/DataTable';
import { EmptyState } from '../../components/States';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { api, describeError } from '../../lib/api';
import { monthLabel, Section, useFmt } from './shared';

export interface ConventionView {
  reference: string; bank: string; signedOn: string; documentSha256: string; periodicite: 'QUOTIDIENNE' | 'HEBDOMADAIRE' | 'MENSUELLE';
  beneficiaries: { flow: string; currency: string; alias: string }[]; recordedBy: string; recordedAt: string;
}
export interface AutomationView {
  mode: 'SIMULATION_QUOTIDIENNE' | 'PROPOSITION_QUATRE_YEUX' | 'EXECUTION_AUTOMATIQUE';
  periodicite: string | null; convention: ConventionView | null; missing: string[]; rule: string;
  lastRun: { id: string; at: string; trigger: string; mode: string; created: string[]; skipped: { currency?: string; reason: string }[] } | null;
  simulations?: { id: string; period: string; currency: string; base: MoneyJSON; grossBase: MoneyJSON; payments: number; ledgerEntryIds: string[]; regularisation?: { amount: MoneyJSON; fromDistributions: string[] } }[];
}
export interface TableauRow {
  period: string; currency: string; rapproche: MoneyJSON; calcule: MoneyJSON; verse: MoneyJSON; resteAVerser: MoneyJSON; resteAArreter?: MoneyJSON; simule?: MoneyJSON;
  distributionId: string | null; etat: 'VERSE' | 'ARRETE' | 'A_ARRETER' | 'SIMULATION';
}
export interface RepartitionIndicators {
  grandLivre?: { arretees: GapRow[]; simulees: GapRow[]; simulations: number };
  delaiDepuisRapprochement?: { payments: number; averageDays: number | null; maxDays: number | null; note?: string };
  ecartRepartition: { distributionsWithPartsGap: number; instructedVsLedger: { currency: string; instructed: MoneyJSON; ledger: MoneyJSON; gap: MoneyJSON; zero: boolean }[] };
  delaiVersement: { flowsInstructed: number; averageDays: number | null; maxDays: number | null; note?: string };
}
interface GapRow { currency: string; repartitions: MoneyJSON; grandLivre: MoneyJSON; gap: MoneyJSON; zero: boolean }
export interface ReportComplements {
  automation?: AutomationView;
  check100?: { keySlicesSumTo100: boolean; partsEqualBase: boolean; flowsEqualBase: boolean };
  regularisationsPending?: { orderId: string; paymentReference: string; distributionId: string; period: string; currency: string; amount: MoneyJSON; status: string }[];
  tableau?: { rows: TableauRow[]; note: string };
  indicateurs?: RepartitionIndicators;
  agentsByModule?: { module: string; tutelle: string; currency: string; base: MoneyJSON; reserve: MoneyJSON; payments: number }[];
  pointsShares?: ({ period: string; currency: string; computed: false } | { period: string; currency: string; computed: true; reserve: MoneyJSON; distributed: MoneyJSON; payable: MoneyJSON; undistributed: MoneyJSON; agents: number; withinReserve: boolean })[];
}

const MODE: Record<AutomationView['mode'], { label: string; tone: Tone }> = {
  SIMULATION_QUOTIDIENNE: { label: 'Simulation quotidienne (comptes d’ordre)', tone: 'warning' },
  PROPOSITION_QUATRE_YEUX: { label: 'Clé active — propositions à quatre yeux (convention attendue)', tone: 'info' },
  EXECUTION_AUTOMATIQUE: { label: 'Exécution automatique des deux flux', tone: 'good' },
};
const ETAT: Record<TableauRow['etat'], { label: string; tone: Tone }> = {
  VERSE: { label: 'Versé', tone: 'good' }, ARRETE: { label: 'Arrêté — reste à verser', tone: 'warning' },
  A_ARRETER: { label: 'À arrêter', tone: 'info' }, SIMULATION: { label: 'Simulation', tone: 'neutral' },
};
const SKIP: Record<string, string> = {
  ASSIETTE_NULLE: 'aucune recette nouvelle', DEJA_SIMULEE: 'déjà simulée', DEJA_EXECUTEE: 'déjà exécutée', CONVENTION_REQUISE: 'convention requise',
  COMPTE_BENEFICIAIRE_ABSENT: 'compte bénéficiaire absent', REGULARISATION_SUPERIEURE: 'régularisation reportée', REPARTITION_ECART_100: 'écart à 100 %',
  TRESOR_INDISPONIBLE: 'Trésor indisponible',
};
const has = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));

function useRun(onDone: () => void) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(path: string, body: unknown, ok: string) {
    setBusy(true); setMsg(null);
    try { await api(path, { method: 'POST', body }); setMsg({ ok: true, text: ok }); onDone(); }
    catch (e) { const d = describeError(e); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); }
    finally { setBusy(false); }
  }
  const notice = msg && <p className={msg.ok ? 'notice notice-ok' : 'notice notice-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>;
  return { run, busy, notice };
}

/** Enregistrement de l'acte juridique (juriste vérificateur R14 ou autorité de publication R16). */
export function ActForm({ keyId, conditions, onDone }: { keyId: string; conditions: Record<string, string>; onDone: () => void }) {
  const { run, busy, notice } = useRun(onDone);
  const [f, setF] = useState({ instrumentId: '', reference: '', title: '', nature: 'ARRETE', signedOn: '', documentSha256: '' });
  const [cond, setCond] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="form" aria-label="Enregistrer l’acte juridique" onSubmit={(e) => { e.preventDefault(); void run(`/v1/pilotage/repartition/cles/${encodeURIComponent(keyId)}/acte`, { ...f, conditions: Object.fromEntries(Object.entries(cond).filter(([, v]) => v.trim())) }, 'Acte enregistré : la proposition d’activation est possible.'); }}>
      <h3 className="h-sub">Enregistrer l’acte juridique</h3>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="act-inst">Instrument du registre</label><input id="act-inst" required value={f.instrumentId} onChange={set('instrumentId')} placeholder="identifiant de l’instrument en vigueur" /></div>
        <div className="field"><label className="label" htmlFor="act-ref">Référence de l’acte</label><input id="act-ref" required value={f.reference} onChange={set('reference')} /></div>
      </div>
      <div className="field"><label className="label" htmlFor="act-title">Intitulé</label><input id="act-title" required value={f.title} onChange={set('title')} /></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="act-nat">Nature</label><select id="act-nat" value={f.nature} onChange={set('nature')}><option value="ARRETE">Arrêté</option><option value="EDIT">Édit</option></select></div>
        <div className="field"><label className="label" htmlFor="act-date">Signé le</label><input id="act-date" type="date" required value={f.signedOn} onChange={set('signedOn')} /></div>
      </div>
      <div className="field"><label className="label" htmlFor="act-sha">Empreinte SHA-256 du document officiel</label><input id="act-sha" className="mono" required pattern="[0-9a-f]{64}" value={f.documentSha256} onChange={set('documentSha256')} /></div>
      {Object.entries(conditions).map(([c, label]) => (
        <div className="field" key={c}><label className="label" htmlFor={`act-c-${c}`}>{label}</label><input id={`act-c-${c}`} value={cond[c] ?? ''} onChange={(e) => setCond({ ...cond, [c]: e.target.value })} placeholder="référence de la pièce" /></div>
      ))}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Enregistrer l’acte</button>
      {notice}
    </form>
  );
}

/** Enregistrement de la convention tripartite de règlement : périodicité et comptes verrouillés du coffre. */
export function ConventionForm({ keyId, current, onDone }: { keyId: string; current: ConventionView | null; onDone: () => void }) {
  const { run, busy, notice } = useRun(onDone);
  const [f, setF] = useState({ reference: current?.reference ?? '', bank: current?.bank ?? '', signedOn: current?.signedOn ?? '', documentSha256: current?.documentSha256 ?? '', periodicite: current?.periodicite ?? 'QUOTIDIENNE' });
  const [acc, setAcc] = useState<Record<string, string>>(() => Object.fromEntries((current?.beneficiaries ?? []).map((b) => [`${b.flow}|${b.currency}`, b.alias])));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value as never });
  const slots = ['FLUX_1|USD', 'FLUX_2|USD', 'FLUX_1|CDF', 'FLUX_2|CDF'];
  const beneficiaries = slots.filter((s) => acc[s]?.trim()).map((s) => { const [flow, currency] = s.split('|') as [string, string]; return { flow, currency, alias: acc[s]!.trim() }; });
  return (
    <form className="form" aria-label="Convention tripartite de règlement" onSubmit={(e) => { e.preventDefault(); void run(`/v1/pilotage/repartition/cles/${encodeURIComponent(keyId)}/convention`, { ...f, beneficiaries }, 'Convention enregistrée : exécution automatique dès que la clé est active.'); }}>
      <h3 className="h-sub">Convention tripartite de règlement (Province – banque – Groupe Nseya)</h3>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="cv-ref">Référence</label><input id="cv-ref" required value={f.reference} onChange={set('reference')} /></div>
        <div className="field"><label className="label" htmlFor="cv-bank">Banque de règlement</label><input id="cv-bank" required value={f.bank} onChange={set('bank')} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="cv-date">Signée le</label><input id="cv-date" type="date" required value={f.signedOn} onChange={set('signedOn')} /></div>
        <div className="field"><label className="label" htmlFor="cv-per">Périodicité d’exécution</label>
          <select id="cv-per" value={f.periodicite} onChange={set('periodicite')}><option value="QUOTIDIENNE">Quotidienne (après rapprochement)</option><option value="HEBDOMADAIRE">Hebdomadaire</option><option value="MENSUELLE">Mensuelle</option></select></div>
      </div>
      <div className="field"><label className="label" htmlFor="cv-sha">Empreinte SHA-256 de la convention</label><input id="cv-sha" className="mono" required pattern="[0-9a-f]{64}" value={f.documentSha256} onChange={set('documentSha256')} /></div>
      <p className="small muted">Comptes bénéficiaires : alias VERROUILLÉS du coffre (aucun numéro de compte n’est saisi) — deux flux seulement, un compte par flux et par devise.</p>
      <div className="field-row">
        {slots.map((s) => (
          <div className="field" key={s}><label className="label" htmlFor={`cv-${s}`}>{s.startsWith('FLUX_1') ? 'Flux 1 (Groupe Nseya)' : 'Flux 2 (Gouvernement provincial)'} — {s.split('|')[1]}</label>
            <input id={`cv-${s}`} className="mono" value={acc[s] ?? ''} onChange={(e) => setAcc({ ...acc, [s]: e.target.value })} placeholder="alias du coffre" /></div>
        ))}
      </div>
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{current ? 'Remplacer la convention' : 'Enregistrer la convention'}</button>
      {notice}
    </form>
  );
}

export function AutomationPanel({ automation, onDone }: { automation: AutomationView; onDone: () => void }) {
  const { user, fmtDate } = useApp();
  const f = useFmt();
  const { run, busy, notice } = useRun(onDone);
  const m = MODE[automation.mode];
  const canRun = has(user?.roles, 'R17', 'R18', 'R05', 'R22');
  return (
    <Section title="Exécution de la répartition" sub={automation.rule}>
      <p data-testid="repartition-automation"><StatusBadge tone={m.tone} label={m.label} />{automation.periodicite ? <span className="small"> · périodicité {automation.periodicite.toLowerCase()}</span> : null}</p>
      {automation.missing.length > 0 && <ul className="small">{automation.missing.map((x) => <li key={x}>Condition manquante : {x}</li>)}</ul>}
      {automation.convention && (
        <p className="small">Convention {automation.convention.reference} ({automation.convention.bank}), enregistrée par {automation.convention.recordedBy} le {fmtDate(automation.convention.recordedAt, true)} — comptes verrouillés : {automation.convention.beneficiaries.map((b) => `${b.flow} ${b.currency} → ${b.alias}`).join(' ; ')}.</p>
      )}
      {automation.lastRun ? (
        <p className="small muted">Dernier traitement le {fmtDate(automation.lastRun.at, true)} ({automation.lastRun.trigger}) : {automation.lastRun.created.length} répartition(s) {automation.lastRun.mode === 'SIMULATION' ? 'simulée(s)' : 'exécutée(s)'}{automation.lastRun.skipped.length ? ` ; ${automation.lastRun.skipped.map((s) => `${s.currency ?? ''} ${SKIP[s.reason] ?? s.reason}`.trim()).join(', ')}` : ''}.</p>
      ) : <p className="small muted">Aucun traitement encore exécuté.</p>}
      {canRun && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run('/v1/pilotage/repartition/automatisation/executer', {}, 'Traitement exécuté (idempotent).')}>Exécuter le traitement maintenant</button>}
      {notice}
      {(automation.simulations?.length ?? 0) > 0 && (
        <DataTable caption="Simulations inscrites en comptes d’ordre" rows={automation.simulations!} rowKey={(s) => s.id} columns={[
          { key: 'i', label: 'Simulation', primary: true, render: (s) => <span className="mono">{s.id}</span> },
          { key: 'p', label: 'Jour · devise', render: (s) => `${s.period} · ${s.currency}` },
          { key: 'b', label: 'Assiette nette', num: true, render: (s) => <>{f.money(s.base)} <span className="small muted">({s.payments} paiement(s))</span></> },
          { key: 'r', label: 'Régularisation', render: (s) => (s.regularisation ? <span className="small">−{f.money(s.regularisation.amount)} ({s.regularisation.fromDistributions.join(', ')})</span> : '—') },
          { key: 'g', label: 'Grand livre', render: (s) => <span className="mono small">{s.ledgerEntryIds.join(', ') || '—'}</span> },
        ]} />
      )}
    </Section>
  );
}

export function ControlsPanel({ report }: { report: ReportComplements }) {
  const f = useFmt();
  const c = report.check100;
  const ind = report.indicateurs;
  return (
    <Section title="Contrôles et indicateurs" sub="Alerte sur tout écart à 100 % ; régularisation automatique des remboursements et contrepassations sur la répartition suivante">
      {c && (
        <p data-testid="repartition-check100">
          <StatusBadge tone={c.keySlicesSumTo100 && c.partsEqualBase && c.flowsEqualBase ? 'good' : 'critical'} label={c.keySlicesSumTo100 && c.partsEqualBase && c.flowsEqualBase ? 'Parts = 100 % de l’assiette' : 'Écart à 100 % — alerte transmise à l’audit'} />
          <span className="small"> Clé : {c.keySlicesSumTo100 ? '100 %' : 'écart'} · parts : {c.partsEqualBase ? 'égales à l’assiette' : 'écart'} · deux flux : {c.flowsEqualBase ? 'égaux à l’assiette' : 'écart'}</span>
        </p>
      )}
      <DataTable caption="Régularisations en attente (remboursés ou contrepassés après répartition)" rows={report.regularisationsPending ?? []} rowKey={(r) => r.orderId}
        empty={<EmptyState title="Aucune régularisation en attente" icon="check" />} columns={[
          { key: 'r', label: 'Paiement', primary: true, render: (r) => <span className="mono">{r.paymentReference}</span> },
          { key: 'd', label: 'Répartition d’origine', render: (r) => `${r.distributionId} (${r.period})` },
          { key: 'a', label: 'Montant', num: true, render: (r) => f.money(r.amount) },
          { key: 's', label: 'État', render: (r) => r.status },
        ]} />
      {ind && (
        <ul className="small" data-testid="repartition-indicators">
          <li>Écart de répartition : {ind.ecartRepartition.distributionsWithPartsGap} répartition(s) dont les parts diffèrent de l’assiette ; flux instruits / grand livre : {ind.ecartRepartition.instructedVsLedger.map((x) => `${x.currency} ${x.zero ? 'écart nul' : `écart ${f.money(x.gap)}`}`).join(' · ') || 'aucun flux instruit'}.</li>
          {ind.grandLivre && <li>Grand livre (comptes d’ordre) : répartitions arrêtées {ind.grandLivre.arretees.map((x) => `${x.currency} ${x.zero ? 'écart nul' : `écart ${f.money(x.gap)}`}`).join(' · ') || '—'} ; simulations ({ind.grandLivre.simulations}) {ind.grandLivre.simulees.map((x) => `${x.currency} ${x.zero ? 'écart nul' : `écart ${f.money(x.gap)}`}`).join(' · ') || '—'}.</li>}
          <li>Délai de versement (arrêté → instruction) : {ind.delaiVersement.averageDays === null ? (ind.delaiVersement.note ?? 'non mesuré') : `${ind.delaiVersement.averageDays} j en moyenne, ${ind.delaiVersement.maxDays} j au plus (${ind.delaiVersement.flowsInstructed} flux)`}.</li>
          {ind.delaiDepuisRapprochement && <li>Délai depuis le rapprochement des paiements : {ind.delaiDepuisRapprochement.averageDays === null ? (ind.delaiDepuisRapprochement.note ?? 'non mesuré') : `${ind.delaiDepuisRapprochement.averageDays} j en moyenne (${ind.delaiDepuisRapprochement.payments} paiement(s))`}.</li>}
        </ul>
      )}
    </Section>
  );
}

export function TableauPanel({ tableau }: { tableau: { rows: TableauRow[]; note: string } }) {
  const f = useFmt();
  return (
    <Section title="Tableau : rapproché, calculé, versé, reste à verser" sub={tableau.note}>
      <DataTable caption="Tableau de la répartition" rows={tableau.rows} rowKey={(r) => `${r.period}-${r.currency}`} empty={<EmptyState title="Aucune période" icon="chart" />} columns={[
        { key: 'p', label: 'Mois', primary: true, render: (r) => `${monthLabel(r.period)} · ${r.currency}` },
        { key: 'a', label: 'Rapproché', num: true, render: (r) => f.money(r.rapproche) },
        { key: 'c', label: 'Calculé', num: true, render: (r) => f.money(r.calcule) },
        { key: 'v', label: 'Versé', num: true, render: (r) => f.money(r.verse) },
        { key: 'x', label: 'Reste à verser', num: true, render: (r) => f.money(r.resteAVerser) },
        { key: 'y', label: 'Reste à arrêter', num: true, render: (r) => (r.resteAArreter ? f.money(r.resteAArreter) : '—') },
        { key: 's', label: 'Simulé', num: true, render: (r) => (r.simule ? f.money(r.simule) : '—') },
        { key: 'e', label: 'État', render: (r) => <StatusBadge tone={ETAT[r.etat].tone} label={ETAT[r.etat].label} /> },
      ]} />
    </Section>
  );
}

export function ReserveModulesPanel({ report }: { report: ReportComplements }) {
  const f = useFmt();
  return (
    <Section title="Réserve des agents par module et quotes-parts par points" sub="Décision du 27/09/2026 : réserve de 10 % par module, répartie au prorata des points de résultats vérifiés × note de qualité, jamais selon le montant liquidé (détail : écran « Réserve des agents »)">
      <DataTable caption="Réserve des agents par module (code de règle)" rows={report.agentsByModule ?? []} rowKey={(r) => `${r.module}-${r.currency}`} empty={<EmptyState title="Aucune recette rapprochée" icon="users" />} columns={[
        { key: 'm', label: 'Module (règle)', primary: true, render: (r) => <span className="mono">{r.module}</span> },
        { key: 't', label: 'Tutelle (indicatif)', render: (r) => <span className="small">{r.tutelle}</span> },
        { key: 'b', label: 'Assiette', num: true, render: (r) => f.money(r.base) },
        { key: 'r', label: 'Réserve', num: true, render: (r) => f.money(r.reserve) },
      ]} />
      <DataTable caption="Quotes-parts calculées par points de résultats" rows={report.pointsShares ?? []} rowKey={(r) => `${r.period}-${r.currency}`} empty={<EmptyState title="Aucune quote-part" icon="users" />} columns={[
        { key: 'p', label: 'Mois', primary: true, render: (r) => `${monthLabel(r.period)} · ${r.currency}` },
        { key: 'd', label: 'Réparti par points', num: true, render: (r) => (r.computed ? f.money(r.distributed) : 'non calculé') },
        { key: 'v', label: 'Payable (points validés)', num: true, render: (r) => (r.computed ? f.money(r.payable) : '—') },
        { key: 'u', label: 'Non réparti', num: true, render: (r) => (r.computed ? f.money(r.undistributed) : '—') },
        { key: 's', label: 'Contrôle', render: (r) => (r.computed ? <StatusBadge tone={r.withinReserve ? 'good' : 'critical'} label={r.withinReserve ? 'Dans la réserve' : 'Dépassement'} /> : '—') },
      ]} />
    </Section>
  );
}
