/**
 * Registre des points juridiques à trancher avant la production (J1–J30 ; § 6.4 du Cahier ; annexe B, 29 points),
 * fonctions conditionnées (ce que chaque écran attend) et complétude du registre des textes (§ 6.1).
 * Trancher un point : un juriste propose l'acte (référence + empreinte SHA-256, le document reste sur l'appareil),
 * une AUTRE personne habilitée décide ; tout est journalisé.
 */
import { useEffect, useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { useApp } from '../../context';
import { ActionError, hasRole, Kpi, Tabs, useAction } from '../integrite/shared';
import type { EtatFonction } from './AttenteBaseLegale';
import '../integrite/integrite.css';
import { PointsVisuels } from './visuels';

interface Acte { reference: string; titre: string; sha256: string }
export interface PointView {
  code: string; question: string; autorite: string; hypothese: string; verrou: string; donnees?: string; source: string;
  statut: 'OUVERT' | 'TRANCHE';
  proposition: { acte: Acte; motif: string; proposedBy: string; proposedAt: string } | null;
  decision: { acte: Acte; motif: string; proposedBy: string; decidedBy: string; at: string } | null;
  annexeB: number[]; septQuestions: number[]; fonctions: string[];
}
export interface Registre {
  points: PointView[];
  septQuestions: { rang: number; question: string; autorite: string; effet: string; points: string[]; statut: string }[];
  annexeB: { point: number; objet: string; points: string[]; note?: string; statut: string }[];
  /** Document maître FR 2 : annexe B (13 points) et annexe A (11 sources et leur fiabilité). */
  annexeBFr2?: { point: number; objet: string; points: string[]; note?: string; statut: string }[];
  annexeA?: { rang: number; source: string; usage: string; fiabilite: string; points: string[]; instrumentsStatut: { id: string; statut: string }[] }[];
  fonctions: EtatFonction[];
  summary: { total: number; ouverts: number; tranches: number };
  note: string;
}
interface Completude {
  complet: boolean; absents: string[];
  lignes: { texte: string; objet: string; usage: string; statut: string; complet: boolean; instruments: { id: string; present: boolean; status: string | null }[] }[];
}

const READ = Array.from({ length: 29 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`).concat('R36');
const PROPOSE = ['R13', 'R14'];
const DECIDE = ['R16', 'R05', 'R01'];

export function StatutPoint({ statut }: { statut: string }) {
  return <StatusBadge tone={statut === 'TRANCHE' ? 'good' : 'warning'} label={statut === 'TRANCHE' ? 'Tranché' : 'Ouvert'} />;
}
const STATUT_TEXTE: Record<string, [string, 'good' | 'warning' | 'critical' | 'neutral' | 'info']> = {
  EN_VIGUEUR: ['En vigueur', 'good'], MODIFIE: ['Modifié', 'info'], A_VERIFIER: ['À vérifier', 'warning'], ABROGE: ['Abrogé', 'critical'], ABSENT: ['Absent du registre', 'critical'], MIXTE: ['Statuts mixtes', 'neutral'],
};

type Tab = 'points' | 'questions' | 'annexe' | 'annexeFr2' | 'sources' | 'fonctions' | 'textes';

export default function PointsJuridiques() {
  const { user, fmtDate } = useApp();
  const allowed = hasRole(user?.roles, ...READ);
  const canPropose = hasRole(user?.roles, ...PROPOSE);
  const canDecide = hasRole(user?.roles, ...DECIDE);
  const reg = useApi(allowed ? () => api<Registre>('/v1/juridique/points') : null, [user?.id]);
  const textes = useApi(allowed ? () => api<Completude>('/v1/legal-instruments/completude') : null, [user?.id]);
  const [tab, setTab] = useState<Tab>('points');
  const [pick, setPick] = useState<PointView | null>(null);
  const [form, setForm] = useState({ reference: '', titre: '', sha256: '', motif: '' });
  const [motifs, setMotifs] = useState<Record<string, string>>({});
  const a = useAction();
  // Lien direct depuis le chemin vers l'acte des modules sectoriels (29/09/2026) : /juridique/points?point=J30.
  const [params] = useState(() => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search));
  const asked = params.get('point')?.toUpperCase() ?? null;
  const askedPoint = asked ? reg.data?.points.find((p) => p.code === asked) ?? null : null;
  const [linkDone, setLinkDone] = useState(false);
  useEffect(() => {
    if (linkDone || !askedPoint) return;
    if (canPropose && askedPoint.statut !== 'TRANCHE' && !askedPoint.proposition) setPick(askedPoint);
    setLinkDone(true);
  }, [askedPoint, canPropose, linkDone]);

  if (!allowed) {
    return <div className="page"><PageHead eyebrow="Registre juridique" title="Points juridiques à trancher" /><EmptyState title="Accès réservé" icon="lock">Réservé aux agents publics habilités et à l’observateur de la société civile.</EmptyState></div>;
  }
  const onFile = async (f: File | undefined) => { if (f) setForm({ ...form, sha256: await sha256Hex(await f.arrayBuffer()), titre: form.titre || f.name.slice(0, 200) }); };
  const propose = async () => {
    if (!pick) return;
    const body = { acte: { reference: form.reference, titre: form.titre, sha256: form.sha256 }, motif: form.motif };
    if (await a.run(() => api(`/v1/juridique/points/${pick.code}/propositions`, { method: 'POST', body }))) { setPick(null); setForm({ reference: '', titre: '', sha256: '', motif: '' }); reg.reload(); }
  };
  const decide = async (p: PointView, approve: boolean) => {
    if (await a.run(() => api(`/v1/juridique/points/${p.code}/decision`, { method: 'POST', body: { approve, motif: motifs[p.code] ?? '' } }))) reg.reload();
  };
  const pending = (reg.data?.points ?? []).filter((p) => p.proposition);

  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Registre juridique" title="Points juridiques à trancher"
        lead="J1 à J30, les sept questions du § 6.4 et les 29 points de l’annexe B du Cahier. Tant qu’un point est ouvert, l’hypothèse intérimaire sûre s’applique : rien n’est désactivé, chaque écran affiche ce qu’il attend." />
      <ActionError error={a.error} />
      {reg.loading && <Loading />}
      {reg.error !== null && <ErrorState error={reg.error} onRetry={reg.reload} />}
      {reg.data && (
        <>
          <div className="kpi-row ig-kpis">
            <Kpi label="Points" value={reg.data.summary.total} />
            <Kpi label="Ouverts" value={reg.data.summary.ouverts} />
            <Kpi label="Tranchés sur acte" value={reg.data.summary.tranches} />
            <Kpi label="Propositions à décider" value={pending.length} />
          </div>
          <PointsVisuels points={reg.data.points} fonctions={reg.data.fonctions} />
          <p className="callout callout-info ig-note"><Icon name="info" size={18} /><span>{reg.data.note}</span></p>
          {askedPoint && (
            <section className="panel" aria-labelledby="pj-asked">
              <h2 className="panel-title" id="pj-asked">Point demandé : {askedPoint.code}</h2>
              <p className="small">{askedPoint.question} — {askedPoint.autorite}</p>
              <p className="small"><StatutPoint statut={askedPoint.statut} /> {askedPoint.proposition ? `Proposition en attente (${askedPoint.proposition.acte.reference}) : décision par une autre personne habilitée.` : askedPoint.statut === 'TRANCHE' ? `Tranché : ${askedPoint.decision?.acte.reference ?? ''}` : canPropose ? 'Renseignez l’acte ci-dessous pour proposer de trancher ce point.' : 'Proposition réservée aux juristes (rédacteur, vérificateur) ; décision par l’autorité de publication, le ministre des Finances ou le Gouverneur.'}</p>
            </section>
          )}

          {pending.length > 0 && (
            <section className="panel" aria-labelledby="pj-pending">
              <h2 className="panel-title" id="pj-pending">Propositions à décider</h2>
              <ul className="plain-list ig-stack">
                {pending.map((p) => (
                  <li key={p.code} className="ig-block">
                    <p><strong>{p.code}</strong> — {p.question}</p>
                    <p className="small">Acte : {p.proposition!.acte.reference} — {p.proposition!.acte.titre} <span className="mono muted">{p.proposition!.acte.sha256.slice(0, 12)}…</span></p>
                    <p className="small muted">Proposé par {p.proposition!.proposedBy} le {fmtDate(p.proposition!.proposedAt, true)} — {p.proposition!.motif}</p>
                    {canDecide && p.proposition!.proposedBy !== user?.id ? (
                      <div className="ig-review-act">
                        <input aria-label={`Motif de décision ${p.code}`} className="input-sm" placeholder="Motif (10 caractères minimum)" value={motifs[p.code] ?? ''} onChange={(e) => setMotifs({ ...motifs, [p.code]: e.target.value })} />
                        <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || (motifs[p.code] ?? '').trim().length < 10} onClick={() => void decide(p, true)}>Trancher</button>
                        <button type="button" className="btn btn-ghost btn-sm ig-danger" disabled={a.busy || (motifs[p.code] ?? '').trim().length < 10} onClick={() => void decide(p, false)}>Rejeter</button>
                      </div>
                    ) : <p className="small muted">Décision par une autre personne habilitée (autorité de publication, ministre des Finances, Gouverneur).</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {pick && (
            <section className="panel" aria-labelledby="pj-form">
              <h2 className="panel-title" id="pj-form">Proposer de trancher {pick.code}</h2>
              <p className="small muted">{pick.question} — {pick.autorite}</p>
              <label className="field"><span>Référence de l’acte</span><input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="Numéro, date, Journal officiel" /></label>
              <label className="field"><span>Titre de l’acte</span><input value={form.titre} onChange={(e) => setForm({ ...form, titre: e.target.value })} /></label>
              <label className="field"><span>Document de l’acte (seule son empreinte est transmise)</span><input type="file" onChange={(e) => void onFile(e.target.files?.[0])} /></label>
              <label className="field"><span>Empreinte SHA-256</span><input className="mono" value={form.sha256} onChange={(e) => setForm({ ...form, sha256: e.target.value })} /></label>
              <label className="field"><span>Motif</span><textarea rows={3} value={form.motif} onChange={(e) => setForm({ ...form, motif: e.target.value })} /></label>
              <div className="input-row">
                <button type="button" className="btn btn-primary" disabled={a.busy || form.motif.trim().length < 10 || form.reference.trim().length < 3 || form.titre.trim().length < 3 || !/^[0-9a-f]{64}$/i.test(form.sha256)} onClick={() => void propose()}>Proposer</button>
                <button type="button" className="btn btn-ghost" onClick={() => setPick(null)}>Annuler</button>
              </div>
            </section>
          )}

          <Tabs<Tab> value={tab} onChange={setTab} label="Vues du registre" items={[
            { id: 'points', label: 'Points J1–J30', count: reg.data.summary.ouverts },
            { id: 'questions', label: 'Sept questions (§ 6.4)' },
            { id: 'annexe', label: 'Annexe B (29 points)' },
            ...(reg.data.annexeBFr2 ? [{ id: 'annexeFr2' as Tab, label: `Annexe B du Document maître FR 2 (${reg.data.annexeBFr2.length} points)` }] : []),
            ...(reg.data.annexeA ? [{ id: 'sources' as Tab, label: `Annexe A — sources (${reg.data.annexeA.length})` }] : []),
            { id: 'fonctions', label: 'Fonctions en attente', count: reg.data.fonctions.filter((f) => f.enAttente).length },
            { id: 'textes', label: 'Textes (§ 6.1)' },
          ]} />

          {tab === 'points' && (
            <DataTable rows={reg.data.points} rowKey={(p) => p.code} caption="Points juridiques J1 à J30"
              columns={[
                { key: 'c', label: 'Point', primary: true, render: (p) => <><span className="row-title">{p.code}</span><span className="small">{p.question}</span></> },
                { key: 'a', label: 'Autorité', render: (p) => <span className="small">{p.autorite}</span> },
                { key: 's', label: 'Statut', render: (p) => <span className="ig-inline"><StatutPoint statut={p.statut} />{p.decision && <span className="small muted">{p.decision.acte.reference}</span>}</span> },
                { key: 'h', label: 'Hypothèse intérimaire · verrou', full: true, render: (p) => <span className="small">{p.hypothese} · <em>{p.verrou}</em>{p.annexeB.length ? ` · annexe B : ${p.annexeB.join(', ')}` : ''}</span> },
                ...(canPropose ? [{ key: 'x', label: 'Action', render: (p: PointView) => (p.statut === 'TRANCHE' || p.proposition ? <span className="small muted">{p.proposition ? 'Proposition en attente' : '—'}</span>
                  : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPick(p)}>Proposer l’acte</button>) }] : []),
              ]} />
          )}
          {tab === 'questions' && (
            <DataTable rows={reg.data.septQuestions} rowKey={(q) => String(q.rang)} caption="Sept points juridiques du § 6.4"
              columns={[
                { key: 'q', label: 'Question', primary: true, render: (q) => q.question },
                { key: 'a', label: 'Autorité', render: (q) => <span className="small">{q.autorite}</span> },
                { key: 'e', label: 'Effet si non tranchée', render: (q) => <span className="small">{q.effet}</span> },
                { key: 'p', label: 'Points', render: (q) => <span className="ig-inline"><span className="mono small">{q.points.join(', ')}</span><StatutPoint statut={q.statut} /></span> },
              ]} />
          )}
          {tab === 'annexe' && (
            <DataTable rows={reg.data.annexeB} rowKey={(x) => String(x.point)} caption="Annexe B — points à vérifier avant mise en production"
              columns={[
                { key: 'n', label: 'N°', num: true, render: (x) => x.point },
                { key: 'o', label: 'Objet', primary: true, render: (x) => <>{x.objet}{x.note && <span className="small muted"> — {x.note}</span>}</> },
                { key: 'p', label: 'Rattachement', render: (x) => <span className="ig-inline"><span className="mono small">{x.points.join(', ')}</span><StatutPoint statut={x.statut} /></span> },
              ]} />
          )}
          {tab === 'annexeFr2' && reg.data.annexeBFr2 && (
            <DataTable rows={reg.data.annexeBFr2} rowKey={(x) => String(x.point)} caption="Annexe B du Document maître FR 2 — points à vérifier avant mise en production"
              columns={[
                { key: 'n', label: 'N°', num: true, render: (x) => x.point },
                { key: 'o', label: 'Objet', primary: true, render: (x) => <>{x.objet}{x.note && <span className="small muted"> — {x.note}</span>}</> },
                { key: 'p', label: 'Rattachement', render: (x) => <span className="ig-inline"><span className="mono small">{x.points.join(', ')}</span><StatutPoint statut={x.statut} /></span> },
              ]} />
          )}
          {tab === 'sources' && reg.data.annexeA && (
            <DataTable rows={reg.data.annexeA} rowKey={(x) => String(x.rang)} caption="Annexe A — sources consultées et niveau de fiabilité"
              columns={[
                { key: 's', label: 'Source', primary: true, render: (x) => x.source },
                { key: 'u', label: 'Usage', render: (x) => <span className="small">{x.usage}</span> },
                { key: 'f', label: 'Fiabilité', render: (x) => <span className="small">{x.fiabilite}</span> },
                { key: 'r', label: 'Rattachement', render: (x) => <span className="small mono">{[...x.instrumentsStatut.map((i) => `${i.id} (${STATUT_TEXTE[i.statut]?.[0] ?? i.statut})`), ...x.points].join(', ') || '—'}</span> },
              ]} />
          )}
          {tab === 'fonctions' && (
            <ul className="plain-list ig-stack">
              {reg.data.fonctions.map((f) => (
                <li key={f.code} className="ig-block">
                  <p><strong>{f.label}</strong> <StatusBadge tone={f.enAttente ? 'warning' : 'good'} label={f.enAttente ? 'En attente de base légale' : 'Base légale tranchée'} /></p>
                  <p className="small">{f.message}</p>
                  <p className="small muted">{f.points.map((p) => `${p.code} (${p.statut === 'TRANCHE' ? 'tranché' : 'ouvert'})`).join(' · ')}</p>
                </li>
              ))}
            </ul>
          )}
          {tab === 'textes' && (textes.data ? (
            <>
              <p className={textes.data.complet ? 'notice notice-ok' : 'callout callout-warn'}>{textes.data.complet ? 'Tous les textes du tableau du § 6.1 figurent au registre.' : `Textes absents du registre : ${textes.data.absents.join(', ')}`}</p>
              <DataTable rows={textes.data.lignes} rowKey={(l) => l.texte} caption="Textes de référence (§ 6.1)"
                columns={[
                  { key: 't', label: 'Texte', primary: true, render: (l) => <><span className="row-title">{l.texte}</span><span className="small muted">{l.objet}</span></> },
                  { key: 's', label: 'Statut', render: (l) => { const [label, tone] = STATUT_TEXTE[l.statut] ?? [l.statut, 'neutral' as const]; return <StatusBadge tone={tone} label={label} />; } },
                  { key: 'u', label: 'Usage dans MOSOLO', full: true, render: (l) => <span className="small">{l.usage} <span className="mono muted">({l.instruments.map((i) => i.id).join(', ')})</span></span> },
                ]} />
            </>
          ) : textes.loading ? <Loading /> : <p className="small muted">Registre des textes indisponible.</p>)}
        </>
      )}
    </div>
  );
}
