/**
 * Registre des risques (Document maître FR 2, ch. 41) : les 13 risques de la source avec probabilité, impact et
 * traitement ; carte de chaleur ; chaque mesure reliée au contrôle de la plateforme qui la met en œuvre (code et test)
 * ou marquée « externe » (monde réel) ; revue périodique par une personne, revue en retard signalée ; journalisé.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { STATUS } from '../../lib/palette';
import { Section } from './shared';
import { Area, Callout, Choice, hasRole, Notice, useRunner } from './planif';
import { preuveTexte, SUPERVISION, type RegistreRisques, type Risque } from './programme-types';
import './pilotage.css';
import { fmtNombre, KpiTile, MatrixHeat, StatusDistribution, TimelineStrip } from '../../components/viz';
import { etatsDe, Tuiles, Visuels } from './visuels';

/** Visuels du registre : matrice probabilité × impact (nombre de risques), zones, prochaines revues. */
export function VisuelsRisques({ r }: { r: RegistreRisques }) {
  const probs = [...r.carteChaleur.probabilites].sort((a, b) => b.rang - a.rang);
  const imps = [...r.carteChaleur.impacts].sort((a, b) => a.rang - b.rang);
  const zones = Object.fromEntries(Object.entries(ZONE).map(([k, z]) => [k, { label: r.carteChaleur.cellules.find((c) => c.zone === k)?.libelle ?? k, tone: z.tone }]));
  return (
    <>
      <Tuiles label="Registre des risques — synthèse" max={4}>
        <KpiTile hero label="Risques suivis" value={r.synthese.total} format={(v) => fmtNombre(v, 0)} state={{ label: 'Document maître, ch. 41', tone: 'info' }} />
        <KpiTile label="En zone critique" value={r.synthese.critiques} format={(v) => fmtNombre(v, 0)} state={{ label: 'Critique', tone: r.synthese.critiques > 0 ? 'critical' : 'good' }} />
        <KpiTile label="Revues en retard" value={r.synthese.enRetard} format={(v) => fmtNombre(v, 0)} state={{ label: r.synthese.enRetard > 0 ? 'À revoir' : 'À jour', tone: r.synthese.enRetard > 0 ? 'warning' : 'good' }} />
        <KpiTile label="Mesures relevant d’un tiers" value={r.synthese.mesuresExternes} format={(v) => fmtNombre(v, 0)} state={{ label: 'Externe', tone: 'neutral' }} />
      </Tuiles>
      <Visuels label="Risques en graphiques">
        <MatrixHeat className="viz-span-2" title="Matrice probabilité × impact" subtitle="Nombre de risques par case ; le détail des codes figure dans la carte ci-dessous" measureLabel="Risques"
          rows={probs.map((p) => p.libelle)} cols={imps.map((i) => i.libelle)} format={(v) => fmtNombre(v, 0)}
          values={probs.map((p) => imps.map((i) => r.carteChaleur.cellules.find((c) => c.probabilite === p.code && c.impact === i.code)?.risques.length ?? 0))} />
        <StatusDistribution title="Risques par zone de criticité" unitLabel="risques" items={etatsDe(r.items, (x) => x.criticite.zone, zones)} />
        <TimelineStrip className="viz-span-2" title="Prochaines revues" categories={['En retard', 'À venir']} emptyText="Aucune revue planifiée"
          events={r.items.map((x) => ({ id: x.code, at: x.prochaineRevue, category: x.revueEnRetard ? 'En retard' : 'À venir', label: `${x.code} — ${x.risque}` }))} />
      </Visuels>
    </>
  );
}

const ZONE: Record<string, { tone: Tone; color: string }> = {
  CRITIQUE: { tone: 'critical', color: STATUS.critical }, ELEVEE: { tone: 'serious', color: STATUS.serious },
  MODEREE: { tone: 'warning', color: STATUS.warning }, FAIBLE: { tone: 'good', color: STATUS.good },
};

/** Carte de chaleur probabilité × impact : couleur doublée du libellé de zone et du nombre de risques. */
export function CarteChaleur({ r }: { r: RegistreRisques }) {
  const probs = [...r.carteChaleur.probabilites].sort((a, b) => b.rang - a.rang);
  return (
    <div className="table-scroll">
    <table className="data-table heatmap-risques">
      <caption>Carte de chaleur des risques (probabilité × impact)</caption>
      <thead><tr><th scope="col">Probabilité \ Impact</th>{r.carteChaleur.impacts.map((i) => <th key={i.code} scope="col">{i.libelle}</th>)}</tr></thead>
      <tbody>
        {probs.map((p) => (
          <tr key={p.code}>
            <th scope="row">{p.libelle}</th>
            {r.carteChaleur.impacts.map((i) => {
              const c = r.carteChaleur.cellules.find((x) => x.probabilite === p.code && x.impact === i.code)!;
              const z = ZONE[c.zone] ?? ZONE.FAIBLE!;
              return (
                <td key={i.code} style={{ background: c.risques.length ? z.color : undefined, color: c.risques.length && c.zone !== 'MODEREE' ? '#fff' : undefined }} title={`${c.libelle} (score ${c.score})`}>
                  <strong>{c.risques.length ? c.risques.join(', ') : '—'}</strong>
                  <span className="small" style={{ display: 'block' }}>{c.libelle}</span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function RevueForm({ risque, onDone }: { risque: Risque; onDone: () => void }) {
  const r = useRunner(onDone);
  const [v, setV] = useState({ probabilite: risque.probabilite, impact: risque.impact, commentaire: '' });
  return (
    <div className="form">
      <Notice msg={r.msg} />
      <Choice label="Probabilité revue" value={v.probabilite} onChange={(x) => setV({ ...v, probabilite: x })} options={[['FAIBLE', 'Faible'], ['MOYENNE', 'Moyenne'], ['ELEVEE', 'Élevée'], ['TRES_ELEVEE', 'Très élevée']]} />
      <Choice label="Impact revu" value={v.impact} onChange={(x) => setV({ ...v, impact: x })} options={[['FAIBLE', 'Faible'], ['MOYEN', 'Moyen'], ['ELEVE', 'Élevé'], ['TRES_ELEVE', 'Très élevé']]} />
      <Area label="Commentaire de revue (10 caractères minimum)" value={v.commentaire} onChange={(x) => setV({ ...v, commentaire: x })} rows={2} />
      <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/programme/risques/${risque.code}/revues`, v, `Revue du risque ${risque.code} enregistrée.`)}>Enregistrer la revue</button></div>
    </div>
  );
}

export function RisquesView({ r, onDone }: { r: RegistreRisques; onDone: () => void }) {
  const { user } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const canReview = (x: Risque) => hasRole(user?.roles, x.proprietaire, ...SUPERVISION);
  const sel = r.items.find((x) => x.code === open) ?? null;
  return (
    <div className="dash-grid">
      <VisuelsRisques r={r} />
      <Section title="Carte de chaleur" sub={`${r.synthese.total} risques · ${r.synthese.critiques} en zone critique · ${r.synthese.enRetard} revue(s) en retard`}>
        {r.synthese.enRetard > 0 && <Callout tone="warn">{r.synthese.enRetard} revue(s) en retard : à revoir par le propriétaire du risque ou la supervision du programme.</Callout>}
        <CarteChaleur r={r} />
        <p className="small muted">{r.echelle}</p>
      </Section>
      <Section title="Registre (ch. 41)" sub={r.regle}>
        <DataTable caption="Registre des risques" rows={r.items} rowKey={(x) => x.code} columns={[
          { key: 'r', label: 'Risque', primary: true, render: (x) => <><strong>{x.code} — {x.risque}</strong><span className="small muted" style={{ display: 'block' }}>Source : probabilité {x.source.probabilite}, impact {x.source.impact}</span></> },
          { key: 'c', label: 'Criticité', render: (x) => <StatusBadge tone={ZONE[x.criticite.zone]?.tone ?? 'neutral'} label={`${x.probabiliteLibelle} × ${x.impactLibelle} — ${x.criticite.libelle}`} /> },
          { key: 't', label: 'Traitement', render: (x) => <span className="small">{x.traitement}</span> },
          { key: 'p', label: 'Propriétaire', render: (x) => <><span className="mono">{x.proprietaire}</span><span className="small muted" style={{ display: 'block' }}>{x.proprietaireStatut === 'DESIGNE' ? 'Désigné' : 'Par défaut — à confirmer'}</span></> },
          { key: 'v', label: 'Revue', render: (x) => (x.revueEnRetard ? <StatusBadge tone="critical" label={`En retard de ${x.joursDeRetard} j (due le ${x.prochaineRevue})`} /> : <StatusBadge tone="good" label={`Prochaine le ${x.prochaineRevue}`} />) },
          { key: 'a', label: 'Détail', render: (x) => <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open === x.code} onClick={() => setOpen(open === x.code ? null : x.code)}>{open === x.code ? 'Replier' : 'Mesures et revue'}</button> },
        ]} />
      </Section>
      {sel && (
        <Section title={`${sel.code} — mesures et contrôles`} sub={`Registre antérieur harmonisé : ${sel.registreAnterieur.join(', ') || '—'}`}>
          <DataTable caption={`Mesures du risque ${sel.code}`} rows={sel.mesures} rowKey={(m) => m.mesure} columns={[
            { key: 'm', label: 'Mesure (citée)', primary: true, render: (m) => m.mesure },
            { key: 's', label: 'Statut', render: (m) => <StatusBadge tone={m.statut === 'CONSTRUIT' ? 'good' : 'info'} label={m.statut === 'CONSTRUIT' ? 'Contrôle de la plateforme' : 'Externe (monde réel, suivi)'} /> },
            { key: 'p', label: 'Preuves', full: true, render: (m) => <ul className="small">{[...(m.code ?? []), ...(m.tests ?? [])].map((p) => <li key={preuveTexte(p)}><code>{preuveTexte(p)}</code></li>)}{m.note && <li>{m.note}</li>}</ul> },
          ]} />
          {canReview(sel) ? <RevueForm key={sel.code} risque={sel} onDone={onDone} /> : <p className="small muted">Revue réservée au propriétaire ({sel.proprietaire}) ou à la supervision du programme.</p>}
          {sel.historique.length > 0 && <ul className="small">{sel.historique.map((h) => <li key={`${h.at}-${h.action}`}>{h.at.slice(0, 10)} · {h.by} · {h.action} — {h.texte}</li>)}</ul>}
        </Section>
      )}
    </div>
  );
}

export default function Risques() {
  const { user } = useApp();
  const q = useApi(() => api<RegistreRisques>('/v1/pilotage/programme/risques'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Programme · ch. 41" title="Registre des risques" lead="Treize risques du Document maître, leur traitement relié aux contrôles de la plateforme, revus périodiquement par une personne." />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && <RisquesView r={q.data} onDone={q.reload} />}
    </div>
  );
}
