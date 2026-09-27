/**
 * Recette — critères d'acceptation (ch. 42), carnet de récits (ch. 43) et stratégie de tests (ch. 45) : chaque
 * critère et chaque récit renvoie au test automatisé qui le prouve (fichier et titre) ; ce qui exige le monde réel
 * (recette avec agents réels, test d'intrusion par un tiers, charge sur l'infrastructure cible…) est suivi par statut.
 */
import { useState } from 'react';
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
      <Section title={`Critères d’acceptation (${d.criteres.length})`} sub="Chaque critère et le test automatisé qui le prouve">
        <DataTable caption="Recette — critères d’acceptation" rows={d.criteres} rowKey={(c) => c.code} columns={[
          { key: 'c', label: 'Critère', primary: true, render: (c) => <><strong>{c.code}</strong> {c.critere}{c.obligatoire && <span className="small muted" style={{ display: 'block' }}>Exigé : {c.obligatoire}</span>}{c.origine && <span className="small muted" style={{ display: 'block' }}>{c.origine}</span>}</> },
          { key: 's', label: 'État de la preuve', render: (c) => (c.preuves.some((p) => p.statut === 'PENDING_MERGE') ? <StatusBadge tone="warning" label="Preuve : lot postes de décision (à relier à la fusion)" /> : <StatusBadge tone="good" label="Prouvé par test automatisé" />) },
          { key: 'p', label: 'Tests qui le prouvent', full: true, render: (c) => <ul className="small">{c.preuves.map((p) => <li key={preuveTexte(p)}><code>{preuveTexte(p)}</code></li>)}</ul> },
        ]} />
      </Section>
      <Section title={`Carnet de développement (${d.recits.length} récits)`} sub="Un test de bout en bout par récit (backend/test/carnet-recits.test.ts)">
        <DataTable caption="Récits utilisateurs et critères" rows={d.recits} rowKey={(r) => r.code} columns={[
          { key: 'r', label: 'Récit', primary: true, render: (r) => <><strong>{r.code}</strong> {r.recit}</> },
          { key: 'c', label: 'Critères d’acceptation', render: (r) => <span className="small">{r.criteres}</span> },
          { key: 'p', label: 'Preuve', full: true, render: (r) => <><ul className="small">{r.preuves.map((p) => <li key={preuveTexte(p)}><code>{preuveTexte(p)}</code></li>)}</ul>{r.construitIci && <span className="small muted">Complété : {r.construitIci}</span>}</> },
        ]} />
      </Section>
      <Section title="Stratégie de tests (ch. 45)" sub={d.regle}>
        <DataTable caption="Stratégie de tests" rows={d.strategie} rowKey={(p) => p.code} columns={[
          { key: 'p', label: 'Point', primary: true, render: (p) => <><strong>{p.code}</strong> {p.point}<span className="small muted" style={{ display: 'block' }}>{p.note}</span></> },
          { key: 's', label: 'Statut', render: (p) => <StatusBadge tone={p.statut === 'CONSTRUIT' ? 'good' : p.statut === 'PARTIEL' ? 'warning' : 'info'} label={p.statut === 'CONSTRUIT' ? 'Construit et testé' : p.statut === 'PARTIEL' ? 'Construit ; exécution réelle suivie' : 'Monde réel — suivi'} /> },
          { key: 'e', label: 'Preuves et suivis', full: true, render: (p) => <ul className="small">{p.preuves.map((x) => <li key={preuveTexte(x)}><code>{preuveTexte(x)}</code></li>)}{p.suivis.map((s) => <li key={s.code}>Suivi {s.code} : {s.etatLibelle}</li>)}</ul> },
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
