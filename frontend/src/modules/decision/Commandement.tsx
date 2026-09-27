/**
 * Centre de commandement exécutif (Command Centre) — module 41 : échelle des onze états, carte de chaleur par commune,
 * quartier ou catégorie et situation, alertes (écarts, fraude, retards), décisions tracées (demande d'explication ou de
 * plan d'action), rapport signé. Agrégats seulement ; aucune capacité d'édition financière.
 */
import { useState } from 'react';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { Section } from '../pilotage/shared';
import { Area, Choice, Field } from '../pilotage/planif';
import { Ecran, Indicateurs, montant, pct, useRunner, useVue, type Indicator } from './commun';
import type { MoneyJSON } from '@mosolo/shared';

interface Row { key: string; obligations: number; assessedCdf: MoneyJSON; reconciledCdf: MoneyJSON; overdueCdf: MoneyJSON; recoveryPct: string | null; overduePct: string | null; coveragePct: string | null; situations: Record<string, { count: number }> }
interface Alert { family: string; severity: 'CRITIQUE' | 'ELEVEE' | 'MOYENNE'; code: string; title: string; detail: string; count: number; link: string }
interface Vue {
  generatedAt: string; rule: string; financialEdit: false;
  ladder: { levels: { level: string; label: string; count: number | null; consolidatedCdf: MoneyJSON | null }[] } | null;
  heatmap: { dimension: string; metricNote: string; rows: Row[]; situations: Record<string, string> };
  alerts: { items: Alert[]; critical: number; byFamily: { family: string; count: number }[] };
  indicators: Indicator[];
  decisions: { instructions: { total?: number; overdue?: unknown[] } | null };
}

const SEV = { CRITIQUE: 'critical', ELEVEE: 'serious', MOYENNE: 'warning' } as const;

export default function Commandement() {
  const [dimension, setDimension] = useState('commune');
  const q = useVue<Vue>(`/v1/decision/commandement?dimension=${dimension}`, [dimension]);
  const r = useRunner(q.reload);
  const [kind, setKind] = useState('EXPLICATION');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [entity, setEntity] = useState('DGIPK');
  const [deadline, setDeadline] = useState('');
  const [report, setReport] = useState<string | null>(null);
  async function rapport() {
    try {
      const x = await api<{ exportId: string; manifest: { sha256: string } }>('/v1/decision/commandement/rapport');
      setReport(`Rapport ${x.exportId} signé — empreinte SHA-256 ${x.manifest.sha256.slice(0, 16)}… (vérifiable par POST /v1/pilotage/exports/verify).`);
    } catch { setReport('Rapport indisponible.'); }
  }
  return (
    <Ecran eyebrow="Pilotage et décision · module 41" title="Centre de commandement exécutif (Command Centre)" lead="Vision en temps réel fondée sur des montants rapprochés ; agrégats seulement, aucune édition financière." q={q} msg={r.msg}>
      {(d) => (<>
        <Section title="Indicateurs" sub={d.rule}><Indicateurs items={d.indicators} /></Section>
        <Section title="Échelle des onze états" sub="Du potentiel estimé au disponible pour affectation (servie par le pilotage).">
          {d.ladder ? (
            <DataTable caption="Échelle des onze états" rows={d.ladder.levels} rowKey={(l) => l.level} columns={[
              { key: 'l', label: 'État', primary: true, render: (l) => l.label },
              { key: 'n', label: 'Nombre', num: true, render: (l) => l.count ?? '—' },
              { key: 'c', label: 'Contre-valeur CDF', num: true, render: (l) => montant(l.consolidatedCdf) },
            ]} />
          ) : <p className="muted">Échelle indisponible pour ce profil.</p>}
        </Section>
        <Section title="Carte de chaleur" sub={d.heatmap.metricNote} tools={<Choice label="Dimension" value={dimension} onChange={setDimension} options={[['commune', 'Commune'], ['quartier', 'Quartier'], ['categorie', 'Catégorie']]} />}>
          <DataTable caption="Carte de chaleur" rows={d.heatmap.rows} rowKey={(x) => x.key} columns={[
            { key: 'k', label: dimension === 'categorie' ? 'Catégorie' : dimension === 'quartier' ? 'Quartier' : 'Commune', primary: true, render: (x) => x.key },
            { key: 'a', label: 'Liquidé', num: true, render: (x) => montant(x.assessedCdf) },
            { key: 'r', label: 'Rapproché', num: true, render: (x) => montant(x.reconciledCdf) },
            { key: 'p', label: 'Intensité (rapproché / liquidé)', num: true, render: (x) => pct(x.recoveryPct) },
            { key: 'o', label: 'En retard', num: true, render: (x) => pct(x.overduePct) },
            { key: 'c', label: 'Couverture', num: true, render: (x) => pct(x.coveragePct) },
            { key: 's', label: 'Situations (payé / exigible / retard / contesté)', render: (x) => ['PAYE', 'EXIGIBLE', 'EN_RETARD', 'CONTESTE'].map((s) => x.situations[s]?.count ?? 0).join(' / ') },
          ]} />
        </Section>
        <Section title={`Alertes (${d.alerts.critical} critique(s))`} sub={d.alerts.byFamily.map((f) => `${f.family === 'ECARTS' ? 'Écarts' : f.family === 'FRAUDE' ? 'Fraude' : 'Retards'} : ${f.count}`).join(' · ')}>
          <DataTable caption="Alertes" rows={d.alerts.items} rowKey={(a) => a.code} empty={<p className="muted">Aucune alerte.</p>} columns={[
            { key: 's', label: 'Sévérité', render: (a) => <StatusBadge tone={SEV[a.severity]} label={a.severity} /> },
            { key: 't', label: 'Alerte', primary: true, render: (a) => <><strong>{a.title}</strong><br /><span className="small muted">{a.detail}</span></> },
            { key: 'l', label: 'Lien', render: (a) => <a href={a.link}>Ouvrir</a> },
          ]} />
        </Section>
        <Section title="Décision tracée" sub="Demande d’explication ou de plan d’action, suivie par le circuit des instructions ; aucun effet financier.">
          <div className="form">
            <Choice label="Nature" value={kind} onChange={setKind} options={[['EXPLICATION', 'Demande d’explication'], ['PLAN_ACTION', 'Demande de plan d’action']]} />
            <Field label="Objet" value={subject} onChange={setSubject} />
            <Area label="Texte" value={body} onChange={setBody} />
            <Field label="Entité destinataire" value={entity} onChange={setEntity} />
            <Field label="Échéance" type="date" value={deadline} onChange={setDeadline} />
            <div className="btn-row">
              <button type="button" className="btn btn-primary" disabled={r.busy || subject.length < 5 || body.length < 10 || !deadline} onClick={() => void r.run('/v1/decision/commandement/decisions', { kind, subject, body, assignee: { entity }, deadline }, 'Décision tracée : instruction émise.')}>Émettre</button>
              <button type="button" className="btn btn-secondary" onClick={() => void rapport()}>Exporter le rapport signé</button>
            </div>
            {report && <p className="small" role="status">{report}</p>}
            <p className="small muted">Instructions suivies : {d.decisions.instructions?.total ?? 0}.</p>
          </div>
        </Section>
      </>)}
    </Ecran>
  );
}
