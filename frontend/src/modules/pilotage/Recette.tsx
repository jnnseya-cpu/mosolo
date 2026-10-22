/**
 * Recette — critères d'acceptation (ch. 42), carnet de récits (ch. 43) et stratégie de tests (ch. 45) : chaque
 * critère et chaque récit renvoie au test automatisé qui le prouve (fichier et titre) ; ce qui exige le monde réel
 * (recette avec agents réels, test d'intrusion par un tiers, charge sur l'infrastructure cible…) est suivi par statut.
 */
import { useState, type ReactNode } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from './shared';
import { Area, Choice, Field, hasRole, Notice, useRunner } from './planif';
import { preuveTexte, type Recette as RecetteData, type Suivi } from './programme-types';
import './pilotage.css';
import { fmtNombre, KpiTile, StatusDistribution } from '../../components/viz';
import { ETATS_CONSTRUCTION, ETATS_SUIVI, etatsDe, Tuiles, Visuels } from './visuels';

/** Visuels de la recette : couverture par les tests, stratégie construite / partielle / externe, suivis du monde réel. */
export function VisuelsRecette({ d }: { d: RecetteData }) {
  const prouves = d.criteres.filter((c) => c.preuves.length > 0).length;
  return (
    <>
      <Tuiles label="Recette — synthèse" max={4}>
        <KpiTile hero label="Critères d’acceptation prouvés" value={prouves} format={(v) => fmtNombre(v, 0)} unit={`/ ${d.criteres.length}`} target={{ value: d.criteres.length, label: 'tous les critères', max: d.criteres.length }} state={{ label: 'Test automatisé', tone: 'good' }} />
        <KpiTile label="Récits utilisateurs" value={d.recits.length} format={(v) => fmtNombre(v, 0)} state={{ label: 'Bout en bout', tone: 'info' }} />
        <KpiTile label="Points de stratégie construits" value={d.strategie.filter((s) => s.statut === 'CONSTRUIT').length} format={(v) => fmtNombre(v, 0)} unit={`/ ${d.strategie.length}`} state={{ label: 'Ch. 45', tone: 'neutral' }} />
        <KpiTile label="Suivis réalisés" value={d.suivis.filter((s) => s.etat === 'REALISE').length} format={(v) => fmtNombre(v, 0)} unit={`/ ${d.suivis.length}`} state={{ label: 'Jamais simulés', tone: 'warning' }} />
      </Tuiles>
      <Visuels label="Recette en graphiques">
        <StatusDistribution title="Stratégie de tests (ch. 45)" unitLabel="points" items={etatsDe(d.strategie, (s) => s.statut, ETATS_CONSTRUCTION)} />
        <StatusDistribution title="Suivis du monde réel" subtitle="Relèvent de personnes habilitées ; jamais simulés" unitLabel="suivis" items={etatsDe(d.suivis, (s) => s.etat, ETATS_SUIVI)} />
        <StatusDistribution title="Critères reliés à un test" unitLabel="critères" items={[{ key: 'ok', label: 'Prouvé par un test', tone: 'good', count: prouves }, { key: 'ko', label: 'Sans preuve', tone: 'critical', count: d.criteres.length - prouves }]} />
      </Visuels>
    </>
  );
}

/**
 * Preuves techniques repliées (29/09/2026) : le lecteur voit d'abord le nombre de tests qui prouvent le point ; les
 * fichiers et titres de test (données brutes destinées aux équipes techniques et aux auditeurs) restent à un clic.
 */
function Preuves({ items, extra }: { items: Parameters<typeof preuveTexte>[0][]; extra?: ReactNode }) {
  if (!items.length && !extra) return <span className="small muted">—</span>;
  return (
    <details className="small">
      <summary>{items.length ? `${items.length} test${items.length > 1 ? 's' : ''} automatisé${items.length > 1 ? 's' : ''}` : 'Suivis'} — voir le détail technique</summary>
      <ul className="small">{items.map((p) => <li key={preuveTexte(p)}><code>{preuveTexte(p)}</code></li>)}{extra}</ul>
    </details>
  );
}

const SUIVI_TONE: Record<string, 'good' | 'warning' | 'critical' | 'neutral'> = { A_PLANIFIER: 'neutral', PLANIFIE: 'warning', REALISE: 'good', ECHEC: 'critical' };
const WRITERS = ['R02', 'R03', 'R05', 'R22', 'R23', 'R26', 'R27', 'R28'];

function SuiviForm({ s, onDone }: { s: Suivi; onDone: () => void }) {
  const r = useRunner(onDone);
  const [v, setV] = useState({ etat: s.etat, motif: '', echeance: s.echeance ?? '', reference: '', sha256: '' });
  const body = { etat: v.etat, motif: v.motif, ...(v.echeance ? { echeance: v.echeance } : {}), ...(v.reference && v.sha256 ? { preuve: { reference: v.reference, sha256: v.sha256 } } : {}) };
  return (
    <div className="form">
      <Notice msg={r.msg} />
      <Choice label={`État — ${s.libelle}`} value={v.etat} onChange={(x) => setV({ ...v, etat: x })} options={[['A_PLANIFIER', 'À planifier'], ['PLANIFIE', 'Planifié'], ['REALISE', 'Réalisé'], ['ECHEC', 'En échec — à reprendre']]} />
      <Field label="Échéance" type="date" value={v.echeance} onChange={(x) => setV({ ...v, echeance: x })} />
      <Field label="Référence du procès-verbal (si réalisé)" value={v.reference} onChange={(x) => setV({ ...v, reference: x })} />
      <Field label="Empreinte SHA-256 du procès-verbal" value={v.sha256} onChange={(x) => setV({ ...v, sha256: x })} />
      <Area label="Motif (10 caractères minimum)" value={v.motif} onChange={(x) => setV({ ...v, motif: x })} rows={2} />
      <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/programme/recette/suivis/${s.code}`, body, 'Suivi mis à jour.')}>Mettre à jour</button></div>
    </div>
  );
}

export function RecetteView({ d, onDone }: { d: RecetteData; onDone: () => void }) {
  const { user } = useApp();
  const [edit, setEdit] = useState<string | null>(null);
  const canWrite = hasRole(user?.roles, ...WRITERS);
  const sel = d.suivis.find((s) => s.code === edit) ?? null;
  return (
    <div className="dash-grid">
      <VisuelsRecette d={d} />
      <Section title={`Critères d’acceptation (${d.criteres.length})`} sub="Chaque critère et le test automatisé qui le prouve">
        <DataTable caption="Recette — critères d’acceptation" rows={d.criteres} rowKey={(c) => c.code} columns={[
          { key: 'c', label: 'Critère', primary: true, render: (c) => <><strong>{c.code}</strong> {c.critere}{c.obligatoire && <span className="small muted" style={{ display: 'block' }}>Exigé : {c.obligatoire}</span>}{c.origine && <span className="small muted" style={{ display: 'block' }}>{c.origine}</span>}</> },
          { key: 's', label: 'État de la preuve', render: (c) => (c.preuves.some((p) => p.statut === 'PENDING_MERGE') ? <StatusBadge tone="warning" label="Preuve : lot postes de décision (à relier à la fusion)" /> : <StatusBadge tone="good" label="Prouvé par test automatisé" />) },
          { key: 'p', label: 'Tests qui le prouvent', full: true, render: (c) => <Preuves items={c.preuves} /> },
        ]} />
      </Section>
      <Section title={`Carnet de développement (${d.recits.length} récits)`} sub="Un test de bout en bout par récit (détail technique à un clic)">
        <DataTable caption="Récits utilisateurs et critères" rows={d.recits} rowKey={(r) => r.code} columns={[
          { key: 'r', label: 'Récit', primary: true, render: (r) => <><strong>{r.code}</strong> {r.recit}</> },
          { key: 'c', label: 'Critères d’acceptation', render: (r) => <span className="small">{r.criteres}</span> },
          { key: 'p', label: 'Preuve', full: true, render: (r) => <><Preuves items={r.preuves} />{r.construitIci && <span className="small muted">Complété : {r.construitIci}</span>}</> },
        ]} />
      </Section>
      <Section title="Stratégie de tests (ch. 45)" sub={d.regle}>
        <DataTable caption="Stratégie de tests" rows={d.strategie} rowKey={(p) => p.code} columns={[
          { key: 'p', label: 'Point', primary: true, render: (p) => <><strong>{p.code}</strong> {p.point}<span className="small muted" style={{ display: 'block' }}>{p.note}</span></> },
          { key: 's', label: 'Statut', render: (p) => <StatusBadge tone={p.statut === 'CONSTRUIT' ? 'good' : p.statut === 'PARTIEL' ? 'warning' : 'info'} label={p.statut === 'CONSTRUIT' ? 'Construit et testé' : p.statut === 'PARTIEL' ? 'Construit ; exécution réelle suivie' : 'Monde réel — suivi'} /> },
          { key: 'e', label: 'Preuves et suivis', full: true, render: (p) => <><Preuves items={p.preuves} extra={p.suivis.map((s) => <li key={s.code}>Suivi {s.code} : {s.etatLibelle}</li>)} />{p.suivis.map((s) => <span key={s.code} className="small muted" style={{ display: 'block' }}>Suivi : {s.etatLibelle}</span>)}</> },
        ]} />
      </Section>
      <Section title="Suivis du monde réel" sub="Jamais simulés : état, échéance et preuve enregistrés par une personne habilitée">
        <DataTable caption="Éléments suivis" rows={d.suivis} rowKey={(s) => s.code} columns={[
          { key: 'l', label: 'Élément', primary: true, render: (s) => <><strong>{s.libelle}</strong><span className="small muted" style={{ display: 'block' }}>Responsable : {s.responsable}</span></> },
          { key: 'e', label: 'État', render: (s) => <StatusBadge tone={SUIVI_TONE[s.etat] ?? 'neutral'} label={s.etatLibelle} /> },
          { key: 'd', label: 'Échéance', render: (s) => s.echeance ?? '—' },
          { key: 'a', label: 'Action', render: (s) => (canWrite ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEdit(edit === s.code ? null : s.code)}>{edit === s.code ? 'Fermer' : 'Mettre à jour'}</button> : <span className="small muted">Lecture</span>) },
        ]} />
        {sel && <SuiviForm key={sel.code} s={sel} onDone={onDone} />}
      </Section>
    </div>
  );
}

export default function Recette() {
  const { user } = useApp();
  const q = useApi(() => api<RecetteData>('/v1/pilotage/programme/recette'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Programme · ch. 42, 43, 45" title="Recette — critères d’acceptation" lead="Critères d’acceptation, récits utilisateurs et stratégie de tests, chacun relié au test qui le prouve ; exécutions du monde réel suivies." />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && <RecetteView d={q.data} onDone={q.reload} />}
    </div>
  );
}
