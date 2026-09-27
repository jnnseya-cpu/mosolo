/**
 * « Sept questions » (qui ? quoi ? où ? quelle règle ? combien ? payé ? l'argent est-il arrivé sur le compte public et
 * comptabilisé ?) et chaîne opératoire en treize maillons (Cahier v2.9 § 3), pour un objet ou une obligation.
 * Stepper horizontal accessible (liste ordonnée, état en texte et icône, jamais la couleur seule), défilant dans son
 * cadre sur mobile (390 px) sans débordement de la page. Les réponses et leurs sources viennent du serveur, qui applique
 * les habilitations (accès minimal : ni nom ni montant).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import type { Answer, AnswerStatus, Maillon, MaillonStatus, SeptQuestionsView } from './types';
import './chaine.css';
import { ProgressMeter, StatusDistribution } from '../../components/viz';

/** Visuel compact de la chaîne et des sept réponses : maillons par état, réponses par état, part accomplie. */
export function VisuelChaine({ maillons, questions }: { maillons: Maillon[]; questions: Answer[] }) {
  const faits = maillons.filter((m) => m.status === 'FAIT').length;
  const utiles = maillons.filter((m) => m.status !== 'SANS_OBJET').length;
  return (
    <div className="viz-grid ch-visuel" style={{ ['--viz-min' as string]: '260px' }}>
      <StatusDistribution title="Maillons par état" unitLabel="maillons"
        items={(Object.keys(MAILLON_STATUS) as MaillonStatus[]).map((k) => ({ key: k, label: MAILLON_STATUS[k].label, tone: MAILLON_STATUS[k].tone, icon: MAILLON_STATUS[k].icon, count: maillons.filter((m) => m.status === k).length }))} />
      <StatusDistribution title="Les sept réponses par état" unitLabel="questions"
        items={(Object.keys(ANSWER_STATUS) as AnswerStatus[]).map((k) => ({ key: k, label: ANSWER_STATUS[k].label, tone: ANSWER_STATUS[k].tone, count: questions.filter((q) => q.status === k).length })).filter((i) => i.count > 0)} />
      <div className="panel ch-meter">
        <ProgressMeter label="Maillons accomplis (hors sans objet)" value={utiles ? Math.round((faits / utiles) * 1000) / 10 : null} unit="%" target={100} targetLabel="chaîne complète" reason="aucun maillon applicable"
          tone={maillons.some((m) => m.status === 'BLOQUE') ? 'critical' : undefined} toneLabel={maillons.some((m) => m.status === 'BLOQUE') ? 'Maillon bloqué' : undefined} />
      </div>
    </div>
  );
}

export const MAILLON_STATUS: Record<MaillonStatus, { label: string; tone: Tone; icon: string }> = {
  FAIT: { label: 'Fait', tone: 'good', icon: 'check' },
  EN_ATTENTE: { label: 'En attente', tone: 'info', icon: 'clock' },
  SANS_OBJET: { label: 'Sans objet', tone: 'neutral', icon: 'mark' },
  BLOQUE: { label: 'Bloqué', tone: 'critical', icon: 'x' },
};

const ANSWER_STATUS: Record<AnswerStatus, { label: string; tone: Tone }> = {
  REPONDU: { label: 'Répondu', tone: 'good' },
  PARTIEL: { label: 'Partiel', tone: 'warning' },
  EN_ATTENTE: { label: 'En attente', tone: 'info' },
  MASQUE: { label: 'Masqué', tone: 'neutral' },
  SANS_OBJET: { label: 'Sans objet', tone: 'neutral' },
};

const short = (h: string | null | undefined, n = 12) => (h ? `${h.slice(0, n)}…` : '—');

/** Maillon ouvert par défaut : le premier bloqué, sinon le premier en attente, sinon le dernier. */
function defaultStep(ms: Maillon[]): string {
  return (ms.find((m) => m.status === 'BLOQUE') ?? ms.find((m) => m.status === 'EN_ATTENTE') ?? ms.at(-1))?.code ?? '';
}

export function ChaineStepper({ maillons, idPrefix = 'ch' }: { maillons: Maillon[]; idPrefix?: string }) {
  const { fmtDate } = useApp();
  const [sel, setSel] = useState(() => defaultStep(maillons));
  const current = maillons.find((m) => m.code === sel) ?? maillons[0];
  const done = maillons.filter((m) => m.status === 'FAIT').length;
  const detailId = `${idPrefix}-detail`;
  return (
    <div className="ch-chain">
      <p className="small muted" id={`${idPrefix}-summary`}>{done} maillon(s) accompli(s) sur {maillons.length}{maillons.some((m) => m.status === 'BLOQUE') ? ' — au moins un maillon bloqué' : ''}.</p>
      <div className="ch-stepper-wrap">
        <ol className="ch-stepper" aria-label="Chaîne opératoire en treize maillons" aria-describedby={`${idPrefix}-summary`}>
          {maillons.map((m) => {
            const st = MAILLON_STATUS[m.status];
            const active = m.code === current?.code;
            return (
              <li key={m.code} className={`ch-step ch-${m.status.toLowerCase()}${active ? ' ch-active' : ''}`} aria-current={active ? 'step' : undefined}>
                <button type="button" className="ch-step-btn" aria-expanded={active} aria-controls={detailId} onClick={() => setSel(m.code)}>
                  <span className="ch-dot" aria-hidden="true"><Icon name={st.icon} size={14} /></span>
                  <span className="ch-num" aria-hidden="true">{m.rang}</span>
                  <span className="ch-lbl">{m.label}</span>
                  <span className="ch-st">{st.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      {current && (
        <div id={detailId} className={`ch-detail panel ch-${current.status.toLowerCase()}`} aria-live="polite">
          <div className="ch-detail-head">
            <p className="row-title">{current.rang}. {current.label}</p>
            <StatusBadge tone={MAILLON_STATUS[current.status].tone} label={MAILLON_STATUS[current.status].label} icon={MAILLON_STATUS[current.status].icon} />
            {current.rupture && <span className="tag ch-tag-rupture">Maillon sauté</span>}
          </div>
          <p>{current.detail}</p>
          {current.reason && <p className="notice notice-err" role="alert">{current.reason}</p>}
          <dl className="kv kv-dense">
            <div><dt>Horodatage</dt><dd>{current.at ? fmtDate(current.at, true) : '—'}</dd></div>
            <div><dt>Acteur</dt><dd>{current.actor ? `${current.actor.id} (${current.actor.kind})` : '—'}</dd></div>
            <div><dt>Événement d’audit</dt><dd className="mono">{current.auditEventId ?? '—'}{current.auditSeq !== null ? ` · rang ${current.auditSeq}` : ''}</dd></div>
            <div><dt>Empreinte de chaîne</dt><dd className="mono hash" title={current.chainHash ?? undefined}>{short(current.chainHash, 16)}</dd></div>
            {current.evidence.length > 0 && (
              <div><dt>Pièces</dt><dd><ul className="plain-list">{current.evidence.map((e) => <li key={`${e.type}-${e.id}`} className="small"><span className="mono">{e.id}</span> <span className="muted">({e.type}{e.hash ? ` · ${short(e.hash)}` : ''})</span></li>)}</ul></dd></div>
            )}
            <div><dt>Garde-fou</dt><dd className="small">{current.garde}</dd></div>
          </dl>
        </div>
      )}
    </div>
  );
}

interface Mny { amount: string; currency: string }
interface Src {
  taxpayerId?: string | null; identitySource?: string; objectId?: string; objectRef?: string; hiddenObligations?: number; igfCode?: string | null;
  precision?: { accuracyM: number | null; source: string };
  rules?: { code: string; version: number; statusAtLiquidation: string; legalReferences: { id: string; status: string }[] }[];
  breakdown?: { obligationId: string; gross: Mny; amount: Mny; adjustments: unknown[] }[];
  obligations?: { payments?: { paymentReference: string; status: string }[] }[];
  payments?: { paymentReference: string; ledger?: { entryId: string; eventType: string }[]; receipt: { number: string; level: string } | null }[];
}

/** Ligne de sources lisible par question (identifiants, versions, empreintes). */
function sourceLine(a: Answer): string | null {
  const s = a.sources as Src;
  switch (a.code) {
    case 'QUI': return s.taxpayerId ? `Compte ${s.taxpayerId} · ${s.identitySource ?? 'COMPTE_UNIQUE'}` : null;
    case 'QUOI': return `Objet ${s.objectId ?? '—'} · réf. ${s.objectRef ?? '—'}${s.hiddenObligations ? ` · ${s.hiddenObligations} obligation(s) hors de votre périmètre` : ''}`;
    case 'OU': return `IGF ${s.igfCode ?? '—'} · précision ${s.precision?.accuracyM != null ? `± ${Math.round(s.precision.accuracyM)} m` : 'non mesurée'} (${s.precision?.source === 'CONSTAT_TERRAIN' ? 'constat terrain' : 'déclaration'})`;
    case 'REGLE': return (s.rules ?? []).map((r) => `${r.code} v${r.version} [${r.statusAtLiquidation} à la liquidation] — ${r.legalReferences.map((l) => `${l.id} (${l.status})`).join(', ')}`).join(' | ') || null;
    case 'COMBIEN': return (s.breakdown ?? []).map((b) => `${b.obligationId} : brut ${b.gross.amount} ${b.gross.currency}${b.adjustments.length ? ` − ${b.adjustments.length} exonération(s)` : ''} = ${b.amount.amount} ${b.amount.currency}`).join(' | ') || null;
    case 'PAYE': return (s.obligations ?? []).flatMap((o) => (o.payments ?? []).map((p) => `${p.paymentReference} (${p.status})`)).join(', ') || null;
    case 'COMPTE_PUBLIC': return (s.payments ?? []).map((p) => `${p.paymentReference} : écriture(s) ${(p.ledger ?? []).map((e) => `${e.entryId} ${e.eventType}`).join(', ') || '—'} · quittance ${p.receipt ? `${p.receipt.number} ${p.receipt.level}` : '—'}`).join(' | ') || null;
    default: return null;
  }
}

export function QuestionsList({ questions }: { questions: Answer[] }) {
  return (
    <dl className="ch-questions">
      {questions.map((q, i) => {
        const st = ANSWER_STATUS[q.status];
        const src = sourceLine(q);
        return (
          <div key={q.code} className="ch-q">
            <dt><span className="ch-q-num" aria-hidden="true">{i + 1}</span>{q.question}</dt>
            <dd>
              <StatusBadge tone={st.tone} label={st.label} />
              <p className="ch-q-answer">{q.answer}</p>
              {src && <p className="small muted ch-q-src"><span className="sr-only">Sources : </span><Icon name="file" size={12} /> {src}</p>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Panneau complet (objet ou obligation) : sept réponses puis chaîne ; sélection de l'obligation si plusieurs. */
export function SeptQuestionsPanel({ objectId, obligationId, standaloneLink = true }: { objectId?: string; obligationId?: string; standaloneLink?: boolean }) {
  const { user } = useApp();
  const url = obligationId ? `/v1/obligations/${encodeURIComponent(obligationId)}/chaine` : `/v1/objects/${encodeURIComponent(objectId ?? '')}/sept-questions`;
  const q = useApi(() => api<SeptQuestionsView>(url), [url, user?.id]);
  const [pick, setPick] = useState<string | null>(null);
  const d = q.data;
  const chain = useMemo(() => {
    if (!d) return null;
    const alt = pick && d.obligations?.find((o) => o.obligationId === pick);
    return alt ? { obligationId: alt.obligationId, maillons: alt.maillons } : d.chaine;
  }, [d, pick]);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!d || !chain) return null;
  const idBase = `ch-${(obligationId ?? objectId ?? 'x').replace(/[^A-Za-z0-9-]/g, '')}`;
  return (
    <div className="stack ch-panel">
      <div className="ch-head">
        <p className="small muted">
          <span className="mono">{d.objet.ref}</span> · {d.objet.categoryLabel} · {d.objet.commune} › {d.objet.quartier}
          {d.objet.demo && <span className="tag">Exemple — non contractuel</span>}
        </p>
        {d.access === 'minimal' && <StatusBadge tone="info" label="Accès minimal : ni nom ni montant" icon="lock" />}
      </div>
      <VisuelChaine maillons={chain.maillons} questions={d.questions} />
      <section aria-labelledby={`${idBase}-q`}>
        <h3 className="h-sub" id={`${idBase}-q`}>Les sept questions</h3>
        <QuestionsList questions={d.questions} />
      </section>
      <section aria-labelledby={`${idBase}-c`}>
        <h3 className="h-sub" id={`${idBase}-c`}>Chaîne opératoire</h3>
        {d.obligations && d.obligations.length > 1 && (
          <div className="field ch-pick">
            <label className="label" htmlFor={`${idBase}-ob`}>Obligation</label>
            <select id={`${idBase}-ob`} value={chain.obligationId ?? ''} onChange={(e) => setPick(e.target.value)}>
              {d.obligations.map((o) => <option key={o.obligationId} value={o.obligationId}>{o.obligationId} — {o.label}{o.current ? '' : ' (remplacée)'}</option>)}
            </select>
          </div>
        )}
        <ChaineStepper key={chain.obligationId ?? 'objet'} maillons={chain.maillons} idPrefix={idBase} />
      </section>
      {d.notice && <p className="small muted">{d.notice}</p>}
      {standaloneLink && !obligationId && objectId && <Link className="btn btn-ghost btn-sm" to={`/chaine/${encodeURIComponent(objectId)}`}><Icon name="external" size={16} /> Vue complète</Link>}
    </div>
  );
}
