/**
 * Plan de livraison par versions (Document maître FR 2, ch. 44) : V0.1 à V3.0, contenu relié aux modules de la
 * plateforme qui le livrent (construction vérifiée par le serveur à l'exécution) et public visé ; mise en service
 * décidée par une personne, sur procès-verbal.
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
import type { PlanVersions, Version } from './programme-types';
import './pilotage.css';
import { fmtNombre, KpiTile, StackedBarViz, StatusDistribution } from '../../components/viz';
import { ETATS_VERSION, etatsDe, Tuiles, Visuels } from './visuels';

/** Visuels du plan de livraison : contenus construits par version, état de mise en service. */
export function VisuelsVersions({ p }: { p: PlanVersions }) {
  const contenus = p.items.flatMap((v) => v.contenus);
  return (
    <>
      <Tuiles label="Plan de livraison — synthèse" max={3}>
        <KpiTile hero label="Contenus construits" value={contenus.filter((c) => c.construit).length} format={(v) => fmtNombre(v, 0)} unit={`/ ${contenus.length}`} target={{ value: contenus.length, label: 'tous les contenus', max: contenus.length }} state={{ label: 'Preuve dans le code', tone: 'good' }} />
        <KpiTile label="Versions en service" value={p.items.filter((v) => v.etat === 'EN_SERVICE').length} format={(v) => fmtNombre(v, 0)} unit={`/ ${p.items.length}`} state={{ label: 'Décision humaine', tone: 'info' }} />
        <KpiTile label="Communes du pilote" value={p.communes.pilote.length} format={(v) => fmtNombre(v, 0)} unit={`/ ${p.communes.referentiel}`} state={{ label: 'Référentiel', tone: 'neutral' }} />
      </Tuiles>
      <Visuels label="Versions en graphiques">
        <StackedBarViz className="viz-span-2" title="Contenus par version" subtitle="Construits et restant à construire" mode="absolute" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
          series={[{ key: 'c', label: 'Construit' }, { key: 'r', label: 'À construire' }]} rows={p.items.map((v) => ({ key: v.code, label: `${v.code} — ${v.public}`, values: { c: v.contenus.filter((c) => c.construit).length, r: v.contenus.filter((c) => !c.construit).length } }))} />
        <StatusDistribution title="Mise en service" unitLabel="versions" items={etatsDe(p.items, (v) => v.etat, ETATS_VERSION)} />
      </Visuels>
    </>
  );
}

const ETAT_TONE: Record<string, 'good' | 'warning' | 'neutral'> = { PREVUE: 'neutral', EN_RECETTE: 'warning', EN_SERVICE: 'good' };

function EtatForm({ v, onDone }: { v: Version; onDone: () => void }) {
  const r = useRunner(onDone);
  const [f, setF] = useState({ etat: v.etat, motif: '', reference: '', sha256: '' });
  return (
    <div className="form">
      <Notice msg={r.msg} />
      <Choice label={`Mise en service — ${v.version}`} value={f.etat} onChange={(x) => setF({ ...f, etat: x })} options={[['PREVUE', 'Prévue'], ['EN_RECETTE', 'En recette'], ['EN_SERVICE', 'En service']]} />
      <Field label="Procès-verbal (référence)" value={f.reference} onChange={(x) => setF({ ...f, reference: x })} />
      <Field label="Empreinte SHA-256 du procès-verbal" value={f.sha256} onChange={(x) => setF({ ...f, sha256: x })} />
      <Area label="Motif (10 caractères minimum)" value={f.motif} onChange={(x) => setF({ ...f, motif: x })} rows={2} />
      <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/programme/versions/${encodeURIComponent(v.code)}/etat`, { etat: f.etat, motif: f.motif, ...(f.reference && f.sha256 ? { preuve: { reference: f.reference, sha256: f.sha256 } } : {}) }, 'État enregistré.')}>Enregistrer</button></div>
    </div>
  );
}

export function VersionsView({ p, onDone }: { p: PlanVersions; onDone: () => void }) {
  const { user } = useApp();
  const [edit, setEdit] = useState<string | null>(null);
  const canWrite = hasRole(user?.roles, 'R02', 'R03', 'R05', 'R27');
  const sel = p.items.find((v) => v.code === edit) ?? null;
  return (
    <div className="dash-grid">
      <VisuelsVersions p={p} />
      <Section title="Versions V0.1 à V3.0" sub={p.regle}>
        <DataTable caption="Plan de livraison par versions" rows={p.items} rowKey={(v) => v.code} columns={[
          { key: 'v', label: 'Version', primary: true, render: (v) => <><strong>{v.version}</strong><span className="small muted" style={{ display: 'block' }}>Public : {v.public}</span></> },
          { key: 'c', label: 'Contenu et modules qui le livrent', full: true, render: (v) => (
            <ul className="small">{v.contenus.map((c) => (
              <li key={c.contenu}>{c.construit ? '✓' : '✗'} <strong>{c.contenu}</strong> — {[...c.socle.map((s) => `socle : ${s.cle}`), ...c.modules.map((m) => `module : ${m.nom}`)].join(', ') || '—'}{c.note ? ` (${c.note})` : ''}</li>
            ))}</ul>
          ) },
          { key: 'b', label: 'Construction', render: (v) => <StatusBadge tone={v.construction === 'CONSTRUIT' ? 'good' : 'warning'} label={v.construction === 'CONSTRUIT' ? 'Construit' : 'Partiel'} /> },
          { key: 'e', label: 'Mise en service', render: (v) => <><StatusBadge tone={ETAT_TONE[v.etat] ?? 'neutral'} label={v.etatLibelle} />{canWrite && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEdit(edit === v.code ? null : v.code)}>{edit === v.code ? 'Fermer' : 'Modifier'}</button>}</> },
        ]} />
        {sel && <EtatForm key={sel.code} v={sel} onDone={onDone} />}
        <p className="small muted">Communes du pilote : {p.communes.pilote.join(', ')} · {p.communes.referentiel} communes au référentiel territorial.</p>
      </Section>
    </div>
  );
}

export default function Versions() {
  const { user } = useApp();
  const q = useApi(() => api<PlanVersions>('/v1/pilotage/programme/versions'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Programme · ch. 44" title="Plan de livraison par versions" lead="Contenu de chaque version, modules qui le livrent, public visé et état de mise en service." />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && <VersionsView p={q.data} onDone={q.reload} />}
    </div>
  );
}
