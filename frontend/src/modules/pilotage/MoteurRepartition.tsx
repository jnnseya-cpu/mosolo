/**
 * Moteur de répartition des recettes et droits (spécifications du 29/09/2026) — construit par-dessus la répartition
 * du § 37A (écran /pilotage/repartition conservé). Onglets selon le compte : vue exécutive, mon entité, Groupe Nseya
 * (« Ma position commerciale » / « Contrôle financier de la ville »), sous-traitant, agent, règles versionnées,
 * demandes de règlement, compte de règlement, coûts technologiques. Chaque montant porte son état et sa date, et
 * s'ouvre sur « Expliquer ce chiffre » puis « Voir les transactions ». Tous les contrôles restent côté serveur.
 */
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { plotValue } from '../../lib/money';
import { BarChartViz, DonutViz, fmtCompact, fmtTaux, KpiGrid, KpiTile } from '../../components/viz';
import { monthLabel, Section, useFmt } from './shared';
import { usePorteesAutorisees } from './AccesMontants';
import './pilotage.css';

// ————————————————————————— contrat (extraits utilisés par l'écran)

interface Figures {
  currency: string; recettesEligibles: MoneyJSON; droit: MoneyJSON; electronique: MoneyJSON; especes: MoneyJSON; regle: MoneyJSON; approuve: MoneyJSON;
  enAttente: MoneyJSON; conteste: MoneyJSON; recouvrable: MoneyJSON; payable: MoneyJSON; enRetard: MoneyJSON; resteDu: MoneyJSON; contrepasse: MoneyJSON; transactions: number;
}
interface Groupe extends Figures { code: string; label: string; montant: MoneyJSON; expliquer: string | null }
interface Breakdown { key: string; label: string; droit: MoneyJSON; recettesEligibles: MoneyJSON; regle: MoneyJSON; resteDu: MoneyJSON; transactions: number }
interface Stamp { mode: 'REEL' | 'SIMULATION'; asOf: string; etat: string }
interface Executif extends Stamp {
  version: { id: string; status: string; statusLabel: string; poolModeLabel: string };
  parDevise: { currency: string; cartes: { code: string; label: string; montant: MoneyJSON; expliquer: string | null }[]; groupes: Groupe[]; controle: { egal: boolean }; parEntite: Breakdown[]; parModule: Breakdown[]; parMethode: Breakdown[]; parMois: Breakdown[]; coutsTechnologiques: Record<string, unknown> & { positionNette: MoneyJSON; detteServicesNseya: MoneyJSON; modeLabel: string } }[];
  contradictions: Contradiction[];
}
interface Contradiction { code: string; titre: string; harmonisation: string; statut: 'TRANCHE' | 'A_ARBITRER' }
interface Explication extends Stamp {
  beneficiaire: string; label: string;
  parDevise: {
    currency: string; recetteEligible: MoneyJSON; taux: { versionId: string; pct: string[]; recetteEligible: MoneyJSON; droit: MoneyJSON }[]; droitCalcule: MoneyJSON; formule: string; arrondis: MoneyJSON;
    electronique: MoneyJSON; especes: MoneyJSON; etats: Record<string, MoneyJSON>; transactions: number; controle: { egalAuDroit: boolean; electroniquePlusEspeces: boolean };
    par: Record<string, Breakdown[] | { key: string; label: string; montant: MoneyJSON }[]>; voirTransactions: string;
  }[];
}
interface TxItem {
  allocationId: string; date: string; module: string | null; entity: string; methode: string; versionId: string; mode: string; recette: MoneyJSON; beneficiaire: string; typeLabel: string;
  pct: string; montant: MoneyJSON; etat: string; etatLabel: string; regle: MoneyJSON; transaction?: string; paymentReference?: string;
}
interface Transactions extends Stamp { total: number; donneesPersonnelles: string; items: TxItem[]; totals: { currency: string; droit: MoneyJSON }[] }
interface Version {
  id: string; version: number; label: string; status: string; statusLabel: string; sum: string | null; checks: { code: string; message: string }[]; effectiveFrom: string; effectiveUntil: string | null;
  beneficiaries: { code: string; label: string; pct: string; flow: string; modeReglement: string; remainder: boolean }[]; poolModeLabel: string; coutsModeLabel: string; legalBasis: string;
  createdBy: string; reviewedBy?: string; approvedBy?: string; activatedBy?: string; parDefaut: boolean;
}
interface Regles { items: Version[]; circuit: string[]; contradictions: Contradiction[]; modesPool: Record<string, string>; modesReglement: Record<string, string> }
interface Demande { id: string; beneficiary: string; currency: string; amount: MoneyJSON; status: string; flow: string; createdAt: string; requestedBy: string; periodStart: string | null; periodEnd: string | null }

const has = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));
// Décision du 29/09/2026 : seuls R01, R02, R03, R05 et Groupe Nseya (R38) voient les gains des autres.
const EXEC = ['R01', 'R02', 'R03', 'R05', 'R38'];
const CONFIG = ['R01', 'R02', 'R03', 'R05', 'R14', 'R15', 'R16', 'R17', 'R18', 'R19', 'R22', 'R23', 'R26', 'R27', 'R38'];
const ENTITE = ['R04', 'R05', 'R06', 'R07', 'R08'];
const STATUT_TONE: Record<string, Tone> = {
  ACTIVE: 'good', APPROUVEE: 'info', VERIFIEE: 'info', PROPOSEE: 'neutral', ACTE_REQUIS: 'warning', REJETEE: 'critical',
  BROUILLON: 'neutral', SOUMISE: 'info', EN_EXAMEN: 'info', PAIEMENT_INSTRUIT: 'warning', PAYEE: 'good', RAPPROCHEE: 'good', CLOTUREE: 'good',
  REGLE: 'good', PAYABLE: 'warning', EN_RETARD: 'serious', CONTESTE: 'serious', CONTREPASSE: 'critical', RECOUVRABLE: 'critical', SIMULATION: 'neutral', CONSTATE: 'info',
};

type Tab = 'executif' | 'entite' | 'nseya' | 'sous-traitant' | 'agent' | 'regles' | 'demandes' | 'compte' | 'couts';
const TABS: { key: Tab; label: string; roles: string[] }[] = [
  { key: 'executif', label: 'Vue exécutive', roles: EXEC },
  { key: 'entite', label: 'Mon entité', roles: ENTITE },
  { key: 'nseya', label: 'Groupe Nseya', roles: ['R38', 'R01', 'R02', 'R03', 'R05'] },
  { key: 'sous-traitant', label: 'Sous-traitant', roles: ['R35'] },
  { key: 'agent', label: 'Mon activité', roles: ['R10'] },
  { key: 'regles', label: 'Règles versionnées', roles: CONFIG },
  { key: 'demandes', label: 'Demandes de règlement', roles: [...EXEC, 'R06', 'R08', 'R15', 'R17', 'R18'] },
  { key: 'compte', label: 'Compte de règlement', roles: CONFIG },
  { key: 'couts', label: 'Coûts technologiques', roles: CONFIG },
];
const PATH_TAB: Record<string, Tab> = { '/platform-admin/finance/allocation-rules': 'regles', '/executive/finance': 'executif', '/groupe-nseya/command-centre': 'nseya', '/subcontractor/finance': 'sous-traitant' };

const num = (m: MoneyJSON) => plotValue(m);

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

const B = '/v1/pilotage/moteur-repartition';

/** Bandeau d'état : réel ou simulation, date du calcul. */
function StampLine({ s }: { s: Stamp }) {
  return <p className="small"><StatusBadge tone={s.mode === 'REEL' ? 'good' : 'warning'} label={s.mode === 'REEL' ? 'Réel' : 'Simulation'} /> {s.etat} — au {s.asOf}.</p>;
}

// ————————————————————————— « Expliquer ce chiffre » → « Voir les transactions » → transaction

function Expliquer({ query, onClose }: { query: string; onClose: () => void }) {
  const f = useFmt();
  const q = useApi(() => api<Explication>(`${B}/expliquer?${query}`), [query]);
  const [tx, setTx] = useState<string | null>(null);
  return (
    <section className="panel span-12" aria-label="Expliquer ce chiffre">
      <header className="panel-head"><div><h2 className="panel-title">Expliquer ce chiffre</h2><p className="panel-sub">{q.data?.label ?? '…'}</p></div>
        <div className="panel-tools"><button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Fermer</button></div></header>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && (
        <>
          <StampLine s={q.data} />
          {q.data.parDevise.length === 0 && <EmptyState title="Aucune ligne" icon="info">Aucun droit pour ce filtre.</EmptyState>}
          {q.data.parDevise.map((d) => (
            <div key={d.currency}>
              <dl className="kv">
                <div><dt>Recette éligible</dt><dd>{f.money(d.recetteEligible)}</dd></div>
                <div><dt>Taux</dt><dd>{d.taux.map((t) => `${t.pct.map((x) => fmtTaux(x)).join(' / ')} (${t.versionId})`).join(' ; ')}</dd></div>
                <div><dt>Droit calculé</dt><dd><strong>{f.money(d.droitCalcule)}</strong> — {d.formule}</dd></div>
                <div><dt>Arrondis</dt><dd>{f.money(d.arrondis)}</dd></div>
                <div><dt>Électronique / espèces</dt><dd>{f.money(d.electronique)} / {f.money(d.especes)}</dd></div>
                <div><dt>Réglé · approuvé · en attente · contesté</dt><dd>{f.money(d.etats.regle!)} · {f.money(d.etats.approuve!)} · {f.money(d.etats.enAttente!)} · {f.money(d.etats.conteste!)}</dd></div>
                <div><dt>Payable · en retard · recouvrable · contrepassé</dt><dd>{f.money(d.etats.payable!)} · {f.money(d.etats.enRetard!)} · {f.money(d.etats.recouvrable!)} · {f.money(d.etats.contrepasse!)}</dd></div>
                <div><dt>Contrôle</dt><dd>{d.controle.egalAuDroit && d.controle.electroniquePlusEspeces ? <StatusBadge tone="good" label="Somme des lignes = droit affiché" /> : <StatusBadge tone="critical" label="Écart détecté" />}</dd></div>
              </dl>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setTx(d.voirTransactions.replace(`${B}/transactions?`, ''))}>Voir les transactions ({d.transactions})</button>
            </div>
          ))}
          {tx && <Transactions query={tx} />}
        </>
      )}
    </section>
  );
}

function Transactions({ query }: { query: string }) {
  const f = useFmt();
  const q = useApi(() => api<Transactions>(`${B}/transactions?${query}`), [query]);
  const [open, setOpen] = useState<string | null>(null);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  return (
    <>
      <p className="small muted">Données personnelles : {q.data.donneesPersonnelles === 'VISIBLES' ? 'visibles (habilitation ou motif journalisé)' : 'pseudonymisées'} — {q.data.total} ligne(s).</p>
      <DataTable caption="Transactions sources" rows={q.data.items} rowKey={(r) => `${r.allocationId}|${r.beneficiaire}`} columns={[
        { key: 't', label: 'Transaction', primary: true, render: (r) => <button type="button" className="btn-link mono" onClick={() => setOpen(r.allocationId)}>{r.paymentReference ?? r.transaction ?? r.allocationId}</button> },
        { key: 'd', label: 'Date', render: (r) => r.date.slice(0, 10) },
        { key: 'm', label: 'Module · entité', render: (r) => `${r.module ?? '—'} · ${r.entity}` },
        { key: 'x', label: 'Moyen', render: (r) => (r.methode === 'ESPECES' ? 'Espèces' : 'Électronique') },
        { key: 'b', label: 'Bénéficiaire', render: (r) => `${r.typeLabel} — ${fmtTaux(r.pct)}` },
        { key: 'a', label: 'Droit', num: true, render: (r) => f.money(r.montant) },
        { key: 'e', label: 'État', render: (r) => <StatusBadge tone={STATUT_TONE[r.etat] ?? 'neutral'} label={r.etatLabel} /> },
        { key: 'v', label: 'Version', render: (r) => r.versionId },
      ]} />
      {open && <TransactionDetail id={open} />}
    </>
  );
}

function TransactionDetail({ id }: { id: string }) {
  const f = useFmt();
  const q = useApi(() => api<{ transaction: Record<string, unknown> & { montant: MoneyJSON }; quittance: { number: string; status: string } | null; repartition: { lignes: { beneficiary: string; label: string; amount: MoneyJSON; etatLabel: string; etat: string; chemin: string }[]; somme: MoneyJSON }; circuitEspeces: { code: string; label: string; fait: boolean; at: string | null }[] | null; demandes: { id: string; status: string }[] }>(`${B}/transactions/${encodeURIComponent(id)}`), [id]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  const t = q.data.transaction;
  return (
    <div className="panel" aria-label="Détail de la transaction">
      <h3 className="h-sub">Paiement → quittance → répartition → règlement</h3>
      <p className="small">{String(t.date).slice(0, 10)} · {String(t.moduleLabel)} · {String(t.entityLabel)} ({String(t.rattachement)}) · {f.money(t.montant)} · version {String(t.versionId)} · quittance {q.data.quittance ? `${q.data.quittance.number} (${q.data.quittance.status})` : '—'}</p>
      <ul className="small">{q.data.repartition.lignes.map((l) => <li key={l.beneficiary}>{l.label} : {f.money(l.amount)} — <StatusBadge tone={STATUT_TONE[l.etat] ?? 'neutral'} label={l.etatLabel} /> ({l.chemin === 'FLUX_AUTOMATIQUE' ? 'réglé par les flux du § 37A' : 'demande de règlement'})</li>)}</ul>
      <p className="small">Somme des lignes : {f.money(q.data.repartition.somme)}</p>
      {q.data.circuitEspeces && <ol className="small">{q.data.circuitEspeces.map((s) => <li key={s.code}>{s.fait ? '✓' : '○'} {s.label}{s.at ? ` — ${s.at.slice(0, 10)}` : ''}</li>)}</ol>}
    </div>
  );
}

// ————————————————————————— tableaux

function GroupTiles({ groupes, onExplain }: { groupes: Groupe[]; onExplain: (q: string) => void }) {
  const f = useFmt();
  return (
    <KpiGrid>
      {groupes.map((g) => (
        <div key={g.code}>
          <KpiTile label={g.label} value={f.money(g.montant)} state={{ label: `Réglé ${f.money(g.regle)} · reste ${f.money(g.resteDu)}`, tone: 'info' }} sub={`${g.transactions} transaction(s) · électronique ${f.money(g.electronique)} · espèces ${f.money(g.especes)}`} />
          {g.expliquer && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onExplain(g.expliquer!)}>Expliquer ce chiffre</button>}
        </div>
      ))}
    </KpiGrid>
  );
}

function BreakdownBars({ title, rows }: { title: string; rows: Breakdown[] }) {
  if (!rows.length) return null;
  return <BarChartViz title={title} orientation="horizontal" rows={rows.map((r) => ({ key: r.key, label: r.key.length === 7 && /^\d{4}-\d{2}$/.test(r.key) ? monthLabel(r.key) : r.label, values: { droit: num(r.droit) } }))} series={[{ key: 'droit', label: 'Montant' }]} tickFormat={fmtCompact} />;
}

function ExecutifView({ onExplain }: { onExplain: (q: string) => void }) {
  const f = useFmt();
  const q = useApi(() => api<Executif>(`${B}/tableau/executif`), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  const d = q.data;
  return (
    <>
      <StampLine s={d} />
      <p className="small">Règle en vigueur : <strong>{d.version.id}</strong> <StatusBadge tone={STATUT_TONE[d.version.status] ?? 'neutral'} label={d.version.statusLabel} /> — pool : {d.version.poolModeLabel}.</p>
      {d.parDevise.length === 0 && <EmptyState title="Aucune recette rapprochée répartie" icon="info">Les droits sont constatés sur les paiements rapprochés.</EmptyState>}
      {d.parDevise.map((c) => (
        <Section key={c.currency} title={`Centre de commandement financier — ${c.currency}`} sub={c.controle.egal ? 'Contrôle : la somme des parts égale la recette éligible (100 %).' : 'Écart à 100 % détecté : alerte transmise à l’audit.'}>
          <KpiGrid>{c.cartes.map((k) => (
            <div key={k.code}><KpiTile label={k.label} value={f.money(k.montant)} state={{ label: k.code === 'NON_RAPPROCHE' ? 'Hors assiette' : 'Rapproché', tone: k.code === 'NON_RAPPROCHE' ? 'warning' : 'good' }} />
              {k.expliquer && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onExplain(k.expliquer!)}>Expliquer ce chiffre</button>}</div>
          ))}</KpiGrid>
          <GroupTiles groupes={c.groupes} onExplain={onExplain} />
          <DonutViz title="Répartition de la recette éligible" slices={c.groupes.map((g) => ({ key: g.code, label: g.label, value: num(g.droit) }))} centerLabel={c.currency} />
          <BreakdownBars title="Par ministère / département (part de 10 %)" rows={c.parEntite} />
          <BreakdownBars title="Par module" rows={c.parModule} />
          <BreakdownBars title="Par mois" rows={c.parMois} />
          <p className="small">Coûts technologiques : {c.coutsTechnologiques.modeLabel} — position nette du Gouvernorat {f.money(c.coutsTechnologiques.positionNette)} ; dette de services envers Groupe Nseya (distincte des 10 %) {f.money(c.coutsTechnologiques.detteServicesNseya)} (à confirmer).</p>
        </Section>
      ))}
      <Contradictions items={d.contradictions} />
    </>
  );
}

function Contradictions({ items }: { items: Contradiction[] }) {
  return (
    <Section title="Contradictions à arbitrer" sub="Harmonisées sans rien retirer ; signalées au maître d’ouvrage (Règle n° 1)">
      <ul className="small">{items.map((c) => <li key={c.code}><strong>{c.code}.</strong> {c.titre} — {c.harmonisation} <StatusBadge tone={c.statut === 'TRANCHE' ? 'good' : 'warning'} label={c.statut === 'TRANCHE' ? 'Tranché' : 'À arbitrer'} /></li>)}</ul>
    </Section>
  );
}

function FiguresTiles({ fig, expliquer, onExplain, title }: { fig: Figures; expliquer?: string; onExplain: (q: string) => void; title: string }) {
  const f = useFmt();
  return (
    <Section title={title} sub={`${fig.transactions} transaction(s) — ${fig.currency}`} tools={expliquer ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => onExplain(expliquer)}>Expliquer ce chiffre</button> : undefined}>
      <KpiGrid>
        <KpiTile label="Droit" value={f.money(fig.droit)} state={{ label: 'Constaté', tone: 'info' }} sub={`Recette éligible ${f.money(fig.recettesEligibles)}`} />
        <KpiTile label="Électronique / espèces" value={`${f.money(fig.electronique)} / ${f.money(fig.especes)}`} />
        <KpiTile label="Réglé" value={f.money(fig.regle)} state={{ label: 'Réglé', tone: 'good' }} />
        <KpiTile label="Reste dû" value={f.money(fig.resteDu)} state={{ label: `Payable ${f.money(fig.payable)}`, tone: 'warning' }} sub={`En retard ${f.money(fig.enRetard)} · contesté ${f.money(fig.conteste)} · recouvrable ${f.money(fig.recouvrable)}`} />
      </KpiGrid>
    </Section>
  );
}

function NseyaView({ onExplain }: { onExplain: (q: string) => void }) {
  const f = useFmt();
  const [vue, setVue] = useState<'position' | 'ville'>('position');
  const q = useApi(() => api<Stamp & { positionCommerciale: (Figures & { expliquer: string; enAttenteApprobation: MoneyJSON; fraisGestion: MoneyJSON; detteServices: MoneyJSON; especesPayables: MoneyJSON })[]; controleVille: { currency: string; groupes: Groupe[]; parEntite: Breakdown[]; parModule: Breakdown[]; parAgent: Breakdown[] }[]; confidentialite: string }>(`${B}/tableau/groupe-nseya`), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  return (
    <>
      <StampLine s={q.data} />
      <div className="seg seg-wrap" role="tablist" aria-label="Vues de Groupe Nseya">
        <button type="button" role="tab" aria-selected={vue === 'position'} aria-pressed={vue === 'position'} onClick={() => setVue('position')}>Ma position commerciale</button>
        <button type="button" role="tab" aria-selected={vue === 'ville'} aria-pressed={vue === 'ville'} onClick={() => setVue('ville')}>Contrôle financier de la ville</button>
      </div>
      <p className="small muted">{q.data.confidentialite}</p>
      {vue === 'position' ? q.data.positionCommerciale.map((p) => (
        <div key={p.currency}>
          <FiguresTiles fig={p} expliquer={p.expliquer} onExplain={onExplain} title={`Droit contractuel de 10 % — ${p.currency}`} />
          <p className="small">En attente d’approbation {f.money(p.enAttenteApprobation)} · espèces payables {f.money(p.especesPayables)} · coûts technologiques financés et frais de gestion (distincts des 10 %) {f.money(p.detteServices)}.</p>
        </div>
      )) : q.data.controleVille.map((c) => (
        <Section key={c.currency} title={`Contrôle financier de la ville — ${c.currency}`}>
          <GroupTiles groupes={c.groupes} onExplain={onExplain} />
          <BreakdownBars title="Par ministère / département" rows={c.parEntite} />
          <BreakdownBars title="Par module" rows={c.parModule} />
          <BreakdownBars title="Par agent" rows={c.parAgent} />
        </Section>
      ))}
    </>
  );
}

function ScopedView({ path, onExplain }: { path: 'entite' | 'sous-traitant' | 'agent'; onExplain: (q: string) => void }) {
  const f = useFmt();
  const q = useApi(() => api<Stamp & { parDevise?: (Figures & { expliquer?: string; droit: MoneyJSON | Figures })[]; parRecette?: { currency: string; recetteGeneree: MoneyJSON; agents: Figures; monDroit: Figures & { expliquer: string }; parAgent: { agentId: string; transactions: number; recette: MoneyJSON; agent: MoneyJSON; sousTraitant: MoneyJSON }[] }[]; note?: string }>(`${B}/tableau/${path}`), [path]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  const d = q.data;
  return (
    <>
      <StampLine s={d} />
      {d.note && <p className="small muted">{d.note}</p>}
      {path === 'sous-traitant' ? (d.parRecette ?? []).map((r) => (
        <div key={r.currency}>
          <FiguresTiles fig={r.monDroit} expliquer={r.monDroit.expliquer} onExplain={onExplain} title={`Mon droit de sous-traitant (3 %) — recette générée ${f.money(r.recetteGeneree)}`} />
          <DataTable caption="Agents de l’ombrelle" rows={r.parAgent} rowKey={(a) => a.agentId} columns={[
            { key: 'a', label: 'Agent', primary: true, render: (a) => <button type="button" className="btn-link" onClick={() => onExplain(`beneficiaire=AGENT:${encodeURIComponent(a.agentId)}&currency=${r.currency}`)}>{a.agentId}</button> },
            { key: 't', label: 'Transactions', num: true, render: (a) => String(a.transactions) },
            { key: 'r', label: 'Recette', num: true, render: (a) => f.money(a.recette) },
            { key: 'g', label: 'Agent (7 %)', num: true, render: (a) => f.money(a.agent) },
            { key: 's', label: 'Sous-traitant (3 %)', num: true, render: (a) => f.money(a.sousTraitant) },
          ]} />
        </div>
      )) : (d.parDevise ?? []).map((x) => {
        const fig = ('droit' in x && typeof x.droit === 'object' && 'recettesEligibles' in (x.droit as object) ? x.droit : x) as Figures & { expliquer?: string };
        return <FiguresTiles key={x.currency} fig={fig} expliquer={fig.expliquer ?? x.expliquer} onExplain={onExplain} title={path === 'agent' ? `Mon activité — ${x.currency}` : `Recettes et droits de mon entité — ${x.currency}`} />;
      })}
      {((path === 'sous-traitant' ? d.parRecette : d.parDevise) ?? []).length === 0 && <EmptyState title="Aucun droit" icon="info">Aucune transaction rapprochée dans votre périmètre.</EmptyState>}
    </>
  );
}

// ————————————————————————— règles, demandes, compte, coûts

function ReglesView({ roles }: { roles: string[] }) {
  const q = useApi(() => api<Regles>(`${B}/regles`), []);
  const { run, busy, notice } = useRun(() => q.reload());
  const [motif, setMotif] = useState('Contrôle effectué sur pièces.');
  const [p, setP] = useState({ GROUPE_NSEYA: '10', TUTELLE: '10', AGENTS_SOUS_TRAITANTS: '10', GOUVERNEMENT_PROVINCIAL: '70', effectiveFrom: '', legalBasis: '', poolMode: 'PAR_RECETTE_GENEREE' });
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  const v1 = q.data.items[0]!;
  const sum = ['GROUPE_NSEYA', 'TUTELLE', 'AGENTS_SOUS_TRAITANTS', 'GOUVERNEMENT_PROVINCIAL'].reduce((a, k) => a + Math.round(Number(p[k as keyof typeof p] || 0) * 1000), 0) / 1000;
  const step = (id: string, s: string, approve: boolean) => run(`${B}/regles/${encodeURIComponent(id)}/${s}`, { approve, motif }, approve ? 'Étape enregistrée.' : 'Version rejetée.');
  return (
    <>
      <Section title="Matrice de répartition versionnée — KIN-DEFAULT" sub="Jamais codée en dur ; historique jamais réécrit ; quatre personnes distinctes">
        <ol className="small">{q.data.circuit.map((c) => <li key={c}>{c}</li>)}</ol>
        <DataTable caption="Versions de la règle" rows={q.data.items} rowKey={(v) => v.id} columns={[
          { key: 'i', label: 'Version', primary: true, render: (v) => <><strong>{v.id}</strong>{v.parDefaut && <span className="small muted"> (par défaut — à confirmer)</span>}</> },
          { key: 's', label: 'État', render: (v) => <StatusBadge tone={STATUT_TONE[v.status] ?? 'neutral'} label={v.statusLabel} /> },
          { key: 'b', label: 'Parts', render: (v) => v.beneficiaries.map((b) => `${b.label} ${fmtTaux(b.pct)}`).join(' · ') },
          { key: 't', label: 'Total', num: true, render: (v) => fmtTaux(v.sum) },
          { key: 'e', label: 'Effet', render: (v) => `${v.effectiveFrom} → ${v.effectiveUntil ?? '…'}` },
          { key: 'p', label: 'Pool', render: (v) => v.poolModeLabel },
          { key: 'c', label: 'Contrôles', render: (v) => (v.checks.length ? v.checks.map((c) => c.message).join(' ') : 'Conforme') },
          { key: 'a', label: 'Actions', render: (v) => (
            <span className="btn-row">
              {['ACTE_REQUIS', 'PROPOSEE'].includes(v.status) && has(roles, 'R14', 'R15') && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void step(v.id, 'verification', true)}>Vérifier</button>}
              {v.status === 'VERIFIEE' && has(roles, 'R05', 'R02') && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void step(v.id, 'approbation', true)}>Approuver</button>}
              {v.status === 'APPROUVEE' && has(roles, 'R01', 'R05', 'R16') && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void step(v.id, 'activation', true)}>Activer</button>}
            </span>
          ) },
        ]} />
        <div className="field"><label className="label" htmlFor="mr-motif">Motif de la décision</label><input id="mr-motif" value={motif} onChange={(e) => setMotif(e.target.value)} /></div>
        {notice}
      </Section>
      {has(roles, 'R26', 'R05', 'R15') && (
        <Section title="Proposer une nouvelle version (pourcentages PROPOSÉS, sans effet)" sub="Refus si le total n’est pas exactement 100 % ; activation par le circuit seulement">
          <form className="form" aria-label="Proposer une version" onSubmit={(e) => {
            e.preventDefault();
            const beneficiaries = v1.beneficiaries.map((b) => ({ code: b.code, label: b.label, pct: p[b.code as keyof typeof p], flow: b.flow, remainder: b.remainder, modeReglement: b.modeReglement }));
            void run(`${B}/regles`, { label: `Proposition du ${new Date().toISOString().slice(0, 10)}`, beneficiaries, effectiveFrom: p.effectiveFrom, legalBasis: p.legalBasis, pool: { mode: p.poolMode, lecture: 'POINTS_DE_LA_TRANSACTION', direct: { agentPct: p.AGENTS_SOUS_TRAITANTS, sousTraitantPct: '0' }, sousTraitance: { agentPct: String(Number(p.AGENTS_SOUS_TRAITANTS) * 0.7), sousTraitantPct: String(Number(p.AGENTS_SOUS_TRAITANTS) * 0.3) } }, motif }, 'Version proposée : vérification par une autre personne requise.');
          }}>
            <div className="field-row">
              {(['GOUVERNEMENT_PROVINCIAL', 'GROUPE_NSEYA', 'TUTELLE', 'AGENTS_SOUS_TRAITANTS'] as const).map((k) => (
                <div className="field" key={k}><label className="label" htmlFor={`mr-${k}`}>{v1.beneficiaries.find((b) => b.code === k)?.label} (%)</label><input id={`mr-${k}`} inputMode="decimal" value={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.value })} /></div>
              ))}
            </div>
            <p className="small">Total : <strong>{fmtTaux(sum)}</strong> {sum === 100 ? <StatusBadge tone="good" label="100 %" /> : <StatusBadge tone="critical" label="Refusé à la vérification" />}</p>
            <div className="field-row">
              <div className="field"><label className="label" htmlFor="mr-eff">Date d’effet</label><input id="mr-eff" type="date" required value={p.effectiveFrom} onChange={(e) => setP({ ...p, effectiveFrom: e.target.value })} /></div>
              <div className="field"><label className="label" htmlFor="mr-pool">Pool de terrain</label><select id="mr-pool" value={p.poolMode} onChange={(e) => setP({ ...p, poolMode: e.target.value })}>{Object.entries(q.data.modesPool).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            </div>
            <div className="field"><label className="label" htmlFor="mr-legal">Base juridique ou contractuelle</label><input id="mr-legal" required minLength={5} value={p.legalBasis} onChange={(e) => setP({ ...p, legalBasis: e.target.value })} /></div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Proposer</button>
          </form>
        </Section>
      )}
      <Contradictions items={q.data.contradictions} />
    </>
  );
}

function DemandesView({ roles }: { roles: string[] }) {
  const f = useFmt();
  const q = useApi(() => api<{ items: Demande[]; etats: Record<string, string>; circuit: string }>(`${B}/demandes`), []);
  const { run, busy, notice } = useRun(() => q.reload());
  const [op, setOp] = useState('');
  const motif = { motif: 'Étape motivée du circuit de règlement.' };
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  const go = (d: Demande, path: string, body: unknown) => run(`${B}/demandes/${encodeURIComponent(d.id)}/${path}`, body, 'Étape enregistrée.');
  const actions = (d: Demande): ReactNode => {
    switch (d.status) {
      case 'BROUILLON': return <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void go(d, 'soumission', motif)}>Soumettre</button>;
      case 'SOUMISE': return has(roles, 'R15', 'R17') && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void go(d, 'examen', motif)}>Prendre en examen</button>;
      case 'EN_EXAMEN': return has(roles, 'R05', 'R02') && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void go(d, 'approbation', { approve: true, ...motif })}>Approuver</button>;
      case 'APPROUVEE': return has(roles, 'R17') && <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !op} onClick={() => void go(d, 'instruction', { operationId: op, ...motif })}>Instruire (opération du flux)</button>;
      case 'PAIEMENT_INSTRUIT': return has(roles, 'R17') && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void go(d, 'paiement', { reference: `VIR-${d.id}` })}>Constater le paiement</button>;
      case 'PAYEE': return has(roles, 'R18') && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void go(d, 'rapprochement', { reference: `REL-${d.id}` })}>Rapprocher</button>;
      case 'RAPPROCHEE': return has(roles, 'R17') && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void go(d, 'cloture', motif)}>Clôturer</button>;
      default: return null;
    }
  };
  return (
    <Section title="Demandes de règlement" sub={q.data.circuit}>
      {has(roles, 'R38') && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(`${B}/demandes`, { beneficiary: 'GROUPE_NSEYA', currency: 'USD', motif: 'Demande de règlement des droits espèces payables.' }, 'Brouillon créé (jamais au-dessus du reste dû).')}>Créer une demande (espèces, USD)</button>}
      {has(roles, 'R17') && <div className="field"><label className="label" htmlFor="dr-op">Opération de décaissement du flux (Flux 1 ou Flux 2)</label><input id="dr-op" className="mono" value={op} onChange={(e) => setOp(e.target.value)} placeholder="identifiant de l’opération du Trésor" /></div>}
      <DataTable caption="Demandes" rows={q.data.items} rowKey={(d) => d.id} empty={<EmptyState title="Aucune demande" icon="info">Aucune demande de règlement.</EmptyState>} columns={[
        { key: 'i', label: 'Demande', primary: true, render: (d) => <span className="mono">{d.id}</span> },
        { key: 'b', label: 'Bénéficiaire', render: (d) => `${d.beneficiary} (${d.flow === 'FLUX_1' ? 'Flux 1' : 'Flux 2'})` },
        { key: 'a', label: 'Montant', num: true, render: (d) => f.money(d.amount) },
        { key: 's', label: 'État', render: (d) => <StatusBadge tone={STATUT_TONE[d.status] ?? 'neutral'} label={q.data!.etats[d.status] ?? d.status} /> },
        { key: 'x', label: 'Action', render: actions },
      ]} />
      {notice}
    </Section>
  );
}

function CompteView({ roles }: { roles: string[] }) {
  const q = useApi(() => api<{ items: { id: string; account_name: string; financial_institution: string; account_reference: string; currency: string; status: string; maskedNumber: string | null; created_by: string; verified_by: string | null; authorised_by: string | null; demo?: boolean }[]; regle: string }>(`${B}/comptes-reglement`), []);
  const { run, busy, notice } = useRun(() => q.reload());
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  return (
    <Section title="Compte de règlement principal du Gouvernement" sub={q.data.regle}>
      <DataTable caption="Comptes désignés" rows={q.data.items} rowKey={(c) => c.id} empty={<EmptyState title="Aucun compte désigné" icon="info">Proposition par le Trésor requise.</EmptyState>} columns={[
        { key: 'n', label: 'Compte', primary: true, render: (c) => `${c.account_name} — ${c.financial_institution}${c.demo ? ' [EXEMPLE]' : ''}` },
        { key: 'r', label: 'Alias (coffre)', render: (c) => <span className="mono">{c.account_reference} {c.maskedNumber}</span> },
        { key: 'c', label: 'Devise', render: (c) => c.currency },
        { key: 's', label: 'État', render: (c) => <StatusBadge tone={c.status === 'ACTIF' ? 'good' : c.status === 'REJETE' ? 'critical' : 'warning'} label={c.status} /> },
        { key: 'p', label: 'Circuit', render: (c) => `proposé ${c.created_by} · vérifié ${c.verified_by ?? '—'} · autorisé ${c.authorised_by ?? '—'}` },
        { key: 'a', label: 'Action', render: (c) => (
          <>
            {c.status === 'PROPOSE' && has(roles, 'R19') && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(`${B}/comptes-reglement/${c.id}/verification`, { approve: true, motif: 'Vérification hors bande effectuée.' }, 'Compte vérifié.')}>Vérifier (coffre)</button>}
            {c.status === 'VERIFIE' && has(roles, 'R01') && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(`${B}/comptes-reglement/${c.id}/autorisation`, { approve: true, motif: 'Désignation du compte principal.', approvalReference: `ARR-GOUV-${c.id}` }, 'Compte désigné.')}>Autoriser (Gouverneur)</button>}
          </>
        ) },
      ]} />
      {notice}
    </Section>
  );
}

function CoutsView() {
  const f = useFmt();
  const q = useApi(() => api<{ items: { id: string; provider: string; categoryLabel: string; period: string; grossCost: MoneyJSON; fundedBy: string; managementFeeAmount: MoneyJSON | null; status: string }[]; note: string }>(`${B}/couts`), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  return (
    <Section title="Coûts technologiques (hors répartition initiale)" sub={q.data.note}>
      <DataTable caption="Coûts technologiques" rows={q.data.items} rowKey={(c) => c.id} empty={<EmptyState title="Aucun coût saisi" icon="info">Traitement désactivé par défaut (à confirmer).</EmptyState>} columns={[
        { key: 'p', label: 'Prestataire', primary: true, render: (c) => c.provider },
        { key: 'c', label: 'Catégorie', render: (c) => c.categoryLabel },
        { key: 'm', label: 'Période', render: (c) => monthLabel(c.period) },
        { key: 'g', label: 'Coût', num: true, render: (c) => f.money(c.grossCost) },
        { key: 'f', label: 'Financé par', render: (c) => (c.fundedBy === 'GROUPE_NSEYA' ? 'Groupe Nseya' : 'Gouvernorat') },
        { key: 'x', label: 'Frais de gestion', num: true, render: (c) => (c.managementFeeAmount ? f.money(c.managementFeeAmount) : '—') },
        { key: 's', label: 'État', render: (c) => c.status },
      ]} />
    </Section>
  );
}

export default function MoteurRepartition() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const location = useLocation();
  // Autorisation préalable de la direction (portée « MOTEUR ») : ouvre les vues d'ensemble pour la durée accordée.
  const autorisees = usePorteesAutorisees();
  const visible = TABS.filter((t) => has(roles, ...t.roles) || (autorisees.includes('MOTEUR') && (t.key === 'executif' || t.key === 'nseya' || t.key === 'demandes')));
  const initial = PATH_TAB[location.pathname] && visible.some((t) => t.key === PATH_TAB[location.pathname]) ? PATH_TAB[location.pathname]! : visible[0]?.key ?? 'regles';
  const [chosen, setTab] = useState<Tab | null>(null);
  // Onglet choisi s'il est visible pour le compte, sinon l'onglet de l'adresse (chargement asynchrone du compte).
  const tab: Tab = chosen && visible.some((t) => t.key === chosen) ? chosen : initial;
  const [explain, setExplain] = useState<string | null>(null);
  const onExplain = (q: string) => setExplain(q);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · moteur de répartition" title="Répartition des recettes et droits"
        lead="Un seul moteur pour tous les paiements rapprochés : 70 % Gouvernorat, 10 % Groupe Nseya, 10 % ministère ou département propriétaire du module, 10 % opérations de terrain (agent direct 10 % ; agent de sous-traitant 7 % + sous-traitant 3 %). Règle versionnée KIN-DEFAULT, activée seulement par le circuit à quatre personnes après l’acte ; deux flux de décaissement seulement (§ 37A)." />
      {visible.length === 0 ? <EmptyState title="Accès non prévu" icon="lock">Votre compte n’a pas de vue financière sur ce moteur.</EmptyState> : (
        <>
          <div className="seg seg-wrap" role="tablist" aria-label="Vues du moteur de répartition">
            {visible.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} aria-pressed={tab === t.key} onClick={() => { setTab(t.key); setExplain(null); }}>{t.label}</button>)}
          </div>
          {explain && <Expliquer query={explain} onClose={() => setExplain(null)} />}
          {tab === 'executif' && <ExecutifView onExplain={onExplain} />}
          {tab === 'entite' && <ScopedView path="entite" onExplain={onExplain} />}
          {tab === 'nseya' && <NseyaView onExplain={onExplain} />}
          {tab === 'sous-traitant' && <ScopedView path="sous-traitant" onExplain={onExplain} />}
          {tab === 'agent' && <ScopedView path="agent" onExplain={onExplain} />}
          {tab === 'regles' && <ReglesView roles={roles} />}
          {tab === 'demandes' && <DemandesView roles={roles} />}
          {tab === 'compte' && <CompteView roles={roles} />}
          {tab === 'couts' && <CoutsView />}
        </>
      )}
    </div>
  );
}
