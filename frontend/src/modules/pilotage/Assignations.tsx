/**
 * Assignations budgétaires (§ 26.1) : registre par commune et catégorie (import puis certification par une seconde
 * personne) et carte des écarts assignation / rapproché. Niveau 11 « disponible pour affectation » : non mesuré tant
 * que le budget voté et les règles de trésorerie ne sont pas intégrés.
 */
import { useState, type CSSProperties } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { COMMUNE_GRID } from '../../demo/governor';
import { SEQ_NAVY } from '../../lib/palette';
import { Section } from './shared';
import { Area, Callout, CertBadge, certifyGuard, Field, hasRole, moneysText, moneyText, Notice, pctText, useRunner } from './planif';
import './pilotage.css';

interface TargetSet { id: string; fiscalYear: string; label: string; status: string; importedBy: string; act: { reference: string; title: string }; entries: unknown[]; decision?: { by: string; approve: boolean } }
export interface GapMap {
  year: string; certified: boolean; note?: string; rule?: string;
  rows: { commune: string; category: string; target: MoneyJSON; realised: MoneyJSON; gap: MoneyJSON; ratePct: string | null }[];
  byCommune: { commune: string; target: MoneyJSON[]; realised: MoneyJSON[]; ratePctCdf: string | null }[];
  totals?: { targetCdf: MoneyJSON; realisedCdf: MoneyJSON; ratePct: string | null };
}

/** Lignes « commune;catégorie;montant;devise » → assignations. */
export function parseTargets(text: string) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.toLowerCase().startsWith('commune')).map((l) => {
    const [commune = '*', category = '*', amount = '0', currency = 'CDF'] = l.split(';').map((x) => x.trim());
    return { commune, category, amount: { amount: amount.replace(',', '.'), currency: currency.toUpperCase() } };
  });
}

/**
 * Carte schématique des 24 communes (même disposition que la carte du Gouverneur) : couleur selon la réalisation de
 * l'assignation (rapproché / assigné), doublée du pourcentage écrit ; commune sans assignation : « — ».
 */
export function GapCartogram({ g }: { g: GapMap }) {
  const by = new Map(g.byCommune.map((c) => [c.commune, c.ratePctCdf]));
  return (
    <>
      <ul className="heat-grid" aria-label="Carte schématique des écarts par commune">
        {Object.entries(COMMUNE_GRID).map(([name, pos]) => {
          const v = by.get(name) ?? null;
          const step = v === null ? 0 : Math.min(SEQ_NAVY.length - 1, Math.floor(Math.min(100, Number(v)) / (100 / SEQ_NAVY.length)));
          return (
            <li key={name} className="heat-tile" title={`${name} — ${v === null ? 'sans assignation' : `${v} %`}`}
              style={{ background: v === null ? 'transparent' : SEQ_NAVY[step], color: v !== null && step >= 3 ? '#fff' : undefined, border: v === null ? '1px dashed var(--line, #ccc)' : undefined, '--gc': pos[0], '--gr': pos[1] } as CSSProperties}>
              <span className="heat-name">{name}</span><span className="heat-val">{v === null ? '—' : `${Math.round(Number(v))} %`}</span>
            </li>
          );
        })}
      </ul>
      <p className="small muted">Carte schématique (disposition indicative des communes) ; les valeurs exactes figurent dans le tableau ci-dessous.</p>
    </>
  );
}

/** Exportation signée de la carte des écarts (avec les six états par commune), vérifiable publiquement. */
export function ExportEcarts({ annee }: { annee: string }) {
  const [res, setRes] = useState<{ exportId: string; sha256: string; signature: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="btn-row">
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setErr(null); api<{ exportId: string; sha256: string; signature: string }>(`/v1/pilotage/assignations/ecarts/export?annee=${annee}`).then(setRes, (e: unknown) => setErr(e instanceof Error ? e.message : 'Export refusé')); }}>Exporter (signé)</button>
      {res && <span className="small">Export {res.exportId} · SHA-256 <code className="hash">{res.sha256.slice(0, 16)}…</code> · vérifiable par l’outil de vérification des exports</span>}
      {err && <span className="small" role="alert">{err}</span>}
    </div>
  );
}

export function GapView({ g }: { g: GapMap }) {
  if (!g.certified) return <Callout tone="warn"><strong>Écart non mesuré.</strong> {g.note}</Callout>;
  const tone = (p: string | null) => (p === null ? 'neutral' : Number(p) >= 100 ? 'good' : Number(p) >= 50 ? 'warning' : 'critical') as 'neutral' | 'good' | 'warning' | 'critical';
  return (
    <>
      <div className="pl-figs"><div className="pl-fig"><span>Réalisation de l’exercice {g.year}</span><strong>{pctText(g.totals?.ratePct)}</strong><span>{moneyText(g.totals?.realisedCdf)} rapprochés pour {moneyText(g.totals?.targetCdf)} assignés (contre-valeur indicative)</span></div></div>
      <GapCartogram g={g} />
      <ExportEcarts annee={g.year} />
      <DataTable caption="Carte des écarts par commune" rows={g.byCommune} rowKey={(r) => r.commune} columns={[
        { key: 'c', label: 'Commune', primary: true, render: (r) => (r.commune === '*' ? 'Toute la province' : r.commune) },
        { key: 't', label: 'Assignation', num: true, render: (r) => moneysText(r.target) },
        { key: 'r', label: 'Rapproché', num: true, render: (r) => moneysText(r.realised) },
        { key: 'p', label: 'Réalisation', num: true, render: (r) => <StatusBadge tone={tone(r.ratePctCdf)} label={pctText(r.ratePctCdf)} /> },
      ]} />
      <DataTable caption="Écarts par ligne" rows={g.rows} rowKey={(r) => `${r.commune}-${r.category}-${r.target.currency}`} columns={[
        { key: 'c', label: 'Commune × catégorie', primary: true, render: (r) => `${r.commune === '*' ? 'Toutes' : r.commune} × ${r.category === '*' ? 'toutes' : r.category}` },
        { key: 't', label: 'Assignation', num: true, render: (r) => moneyText(r.target) },
        { key: 'r', label: 'Rapproché', num: true, render: (r) => moneyText(r.realised) },
        { key: 'g', label: 'Écart', num: true, render: (r) => moneyText(r.gap) },
        { key: 'p', label: 'Taux', num: true, render: (r) => pctText(r.ratePct) },
      ]} />
      <p className="small muted">{g.rule}</p>
    </>
  );
}

export default function Assignations() {
  const { user } = useApp();
  const year = String(new Date().getUTCFullYear());
  const [annee, setAnnee] = useState(year);
  const sets = useApi(() => api<{ items: TargetSet[] }>('/v1/pilotage/assignations'), [user?.id]);
  const gaps = useApi(() => api<GapMap>(`/v1/pilotage/assignations/ecarts?annee=${annee}`), [user?.id, annee]);
  const reload = () => { sets.reload(); gaps.reload(); };
  const r = useRunner(reload);
  const [motif, setMotif] = useState('');
  const [form, setForm] = useState({ fiscalYear: year, label: '', reference: '', title: '', lines: 'commune;categorie;montant;devise\n' });
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 26.1" title="Assignations et carte des écarts" lead="Écart à l’assignation par commune et par catégorie, mesuré sur les recettes rapprochées ; assignations certifiées par deux personnes." />
      <div className="dash-grid">
        <Section title="Écart assignation / rapproché" tools={<label className="pl-filter"><span>Exercice</span><select value={annee} onChange={(e) => setAnnee(e.target.value)}>{[year, String(Number(year) - 1)].map((y) => <option key={y} value={y}>{y}</option>)}</select></label>}>
          {gaps.loading && !gaps.data ? <Loading /> : gaps.error ? <ErrorState error={gaps.error} onRetry={reload} /> : gaps.data && <GapView g={gaps.data} />}
        </Section>
        <Section title="Registre des assignations" sub="Acte de référence (budget voté, contrat de performance) ; certification par le Gouverneur, le cabinet ou le ministre des Finances">
          <Notice msg={r.msg} />
          <DataTable caption="Assignations" rows={sets.data?.items ?? []} rowKey={(s) => s.id} empty={<EmptyState title="Aucune assignation importée" icon="chart" />} columns={[
            { key: 'l', label: 'Assignations', primary: true, render: (s) => <><strong>{s.label}</strong><span className="small muted" style={{ display: 'block' }}>{s.fiscalYear} · {s.act.reference} · {s.entries.length} ligne(s)</span></> },
            { key: 's', label: 'Statut', render: (s) => <CertBadge status={s.status} /> },
            { key: 'a', label: 'Certification', render: (s) => {
              const block = certifyGuard(s, user, ['R01', 'R02', 'R05']);
              return block ? <span className="small muted">{block}</span> : (
                <div className="btn-row">
                  <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/pilotage/assignations/${s.id}/certification`, { approve: true, motif }, 'Assignations certifiées.')}>Certifier</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/pilotage/assignations/${s.id}/certification`, { approve: false, motif }, 'Assignations rejetées.')}>Rejeter</button>
                </div>
              );
            } },
          ]} />
          <Field label="Motif (10 caractères minimum)" value={motif} onChange={setMotif} />
          {hasRole(user?.roles, 'R05', 'R06', 'R15') && (
            <div className="form">
              <Field label="Exercice" value={form.fiscalYear} onChange={(v) => setForm({ ...form, fiscalYear: v })} />
              <Field label="Libellé" value={form.label} onChange={(v) => setForm({ ...form, label: v })} />
              <Field label="Référence de l’acte" value={form.reference} onChange={(v) => setForm({ ...form, reference: v })} />
              <Field label="Intitulé de l’acte" value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
              <Area label="Lignes « commune;catégorie;montant;devise » (« * » pour toutes)" value={form.lines} onChange={(v) => setForm({ ...form, lines: v })} />
              <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/assignations', { fiscalYear: form.fiscalYear, label: form.label, act: { reference: form.reference, title: form.title }, entries: parseTargets(form.lines) }, 'Assignations importées : une seconde personne doit les certifier.')}>Importer</button></div>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
