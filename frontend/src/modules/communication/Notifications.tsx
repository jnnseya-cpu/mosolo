/**
 * Notifications et communication (spécification fonctionnelle, module 39) : modèles versionnés par recette et par langue
 * (rédaction, activation par une seconde personne, messages sans lien, mise en demeure seulement sur acte en vigueur),
 * avis imprimés à apposer sur la plaque (apposition sur place = preuve de remise), preuve de remise d'un envoi,
 * indicateurs (taux de délivrance, délai, taux d'ouverture).
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { ReasonAction } from '../fiscal/common';

interface Template { id: string; eventCode: string; revenueCategory: string | null; lang: string; version: number; text: string; status: string; proposedBy: string; legalBasis?: { instrumentId: string; article: string } }
interface PlateNotice { id: string; objectId: string; plate: string | null; eventCode: string; text: string; verificationCode: string; origin: string; status: string; createdAt: string; posting?: { at: string; distanceM: number } }
interface Mesure { statut: string; taux?: string | null; motif?: string; medianeMinutes?: number; delivres?: number; mesurables?: number }
export interface CommIndicators { delivrance: Mesure; delai: Mesure; ouverture: { messages: Mesure; avisLegaux: Mesure }; bacASable: number; avisPlaque: { aApposer: number; apposes: number }; modeles: { actifs: number; brouillons: number }; raccordement: string }

const T_STATUS: Record<string, { label: string; tone: Tone }> = { BROUILLON: { label: 'Brouillon — seconde personne', tone: 'warning' }, ACTIF: { label: 'Actif', tone: 'good' }, ARCHIVE: { label: 'Archivé', tone: 'neutral' }, REJETE: { label: 'Rejeté', tone: 'critical' } };
const m = (x: Mesure, unit = '') => (x.statut === 'MESURE' ? `${x.taux ?? x.medianeMinutes ?? '—'}${unit}` : `non mesuré — ${x.motif ?? ''}`);

export function IndicatorsView({ d }: { d: CommIndicators }) {
  return (
    <section className="panel stack-sm" aria-label="Indicateurs des notifications">
      <p className="small">Taux de délivrance : <strong>{m(d.delivrance)}</strong>{d.delivrance.statut === 'MESURE' ? ` (${d.delivrance.delivres}/${d.delivrance.mesurables})` : ''}</p>
      <p className="small">Délai de délivrance (médiane) : <strong>{m(d.delai, ' min')}</strong></p>
      <p className="small">Taux d’ouverture : messages <strong>{m(d.ouverture.messages)}</strong> · avis légaux <strong>{m(d.ouverture.avisLegaux)}</strong></p>
      <p className="small muted">{d.bacASable} envoi(s) journalisé(s) en bac à sable · avis sur plaque : {d.avisPlaque.aApposer} à apposer, {d.avisPlaque.apposes} apposé(s) · modèles actifs : {d.modeles.actifs} · {d.raccordement}</p>
    </section>
  );
}

function Templates() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const q = useApi(() => api<{ items: Template[]; legalEvents: string[]; languages: string[] }>('/v1/communication/modeles'), [user?.id]);
  const [f, setF] = useState({ eventCode: '', revenueCategory: '', lang: 'fr', text: '', instrumentId: '', article: '' });
  const [err, setErr] = useState<string | null>(null);
  const approver = roles.some((r) => ['R06', 'R14', 'R16'].includes(r));
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      await api('/v1/communication/modeles', { method: 'POST', body: { eventCode: f.eventCode, lang: f.lang, text: f.text, ...(f.revenueCategory ? { revenueCategory: f.revenueCategory } : {}), ...(f.instrumentId ? { legalBasis: { instrumentId: f.instrumentId, article: f.article } } : {}) } });
      setF({ ...f, text: '' }); q.reload();
    } catch (x) { setErr(describeError(x).message); }
  }
  if (q.loading) return <Loading />;
  if (q.error !== null) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="stack-sm" aria-labelledby="tpl-title">
      <h2 className="h-sub" id="tpl-title">Modèles versionnés (par recette et par langue)</h2>
      {(q.data?.items ?? []).length === 0 && <EmptyState title="Aucun modèle : le texte par défaut du catalogue s’applique." />}
      <ul className="stack-sm">{(q.data?.items ?? []).map((t) => {
        const st = T_STATUS[t.status] ?? { label: t.status, tone: 'neutral' as Tone };
        return (
          <li key={t.id} className="panel stack-sm">
            <div className="panel-head"><p className="panel-title"><span className="mono">{t.eventCode}</span> · {t.lang}{t.revenueCategory ? ` · ${t.revenueCategory}` : ''} · v{t.version}</p><StatusBadge tone={st.tone} label={st.label} /></div>
            <p className="small">« {t.text} »{t.legalBasis ? ` — base légale : ${t.legalBasis.instrumentId}, ${t.legalBasis.article}` : ''}</p>
            {approver && t.status === 'BROUILLON' && user?.id !== t.proposedBy && (
              <div className="btn-row">
                <ReasonAction label="Activer" confirmLabel="Activer (version précédente archivée)" onSubmit={(motif) => api(`/v1/communication/modeles/${t.id}/decision`, { method: 'POST', body: { approve: true, motif } }).then(q.reload)} />
                <ReasonAction label="Rejeter" confirmLabel="Rejeter" tone="secondary" onSubmit={(motif) => api(`/v1/communication/modeles/${t.id}/decision`, { method: 'POST', body: { approve: false, motif } }).then(q.reload)} />
              </div>)}
          </li>);
      })}</ul>
      {roles.some((r) => ['R06', 'R07', 'R13'].includes(r)) && (
        <form className="panel stack-sm" onSubmit={(e) => void go(e)} aria-label="Rédiger un modèle">
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="tpl-ev">Événement</label><input id="tpl-ev" required value={f.eventCode} onChange={(e) => setF({ ...f, eventCode: e.target.value })} placeholder="obligation.overdue" /></div>
            <div className="field"><label className="label" htmlFor="tpl-cat">Recette (facultatif)</label><input id="tpl-cat" value={f.revenueCategory} onChange={(e) => setF({ ...f, revenueCategory: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="tpl-lang">Langue</label><select id="tpl-lang" value={f.lang} onChange={(e) => setF({ ...f, lang: e.target.value })}>{(q.data?.languages ?? ['fr']).map((l) => <option key={l} value={l}>{l}</option>)}</select></div>
          </div>
          <div className="field"><label className="label" htmlFor="tpl-text">Texte (minimal, sans lien ; variables {'{{reference}}'}, {'{{date}}'})</label><textarea id="tpl-text" rows={2} required maxLength={480} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></div>
          {(q.data?.legalEvents ?? []).includes(f.eventCode) && (
            <div className="field-row">
              <div className="field"><label className="label" htmlFor="tpl-inst">Acte en vigueur (identifiant)</label><input id="tpl-inst" required value={f.instrumentId} onChange={(e) => setF({ ...f, instrumentId: e.target.value })} /></div>
              <div className="field"><label className="label" htmlFor="tpl-art">Article</label><input id="tpl-art" required value={f.article} onChange={(e) => setF({ ...f, article: e.target.value })} /></div>
            </div>)}
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-primary btn-sm">Proposer le modèle</button>
        </form>
      )}
    </section>
  );
}

function PlateNotices() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const q = useApi(() => api<PlateNotice[]>('/v1/communication/avis-plaque'), [user?.id]);
  const [err, setErr] = useState<string | null>(null);
  const agent = roles.some((r) => r === 'R10' || r === 'R11');
  async function post(n: PlateNotice) {
    setErr(null);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20_000 }));
      const photoSha256 = await sha256Hex(`${n.id}|${pos.timestamp}`);
      await api(`/v1/communication/avis-plaque/${n.id}/apposition`, { method: 'POST', body: { gps: { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy) }, photoSha256 } });
      q.reload();
    } catch (x) { setErr(describeError(x).message); }
  }
  if (q.loading) return <Loading />;
  if (q.error !== null) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="stack-sm" aria-labelledby="plq-title">
      <h2 className="h-sub" id="plq-title">Avis imprimés à apposer sur la plaque</h2>
      {(q.data ?? []).length === 0 && <EmptyState title="Aucun avis à apposer." />}
      <ul className="stack-sm">{(q.data ?? []).map((n) => (
        <li key={n.id} className="panel stack-sm">
          <p className="panel-title"><span className="mono">{n.id}</span> · objet {n.objectId}{n.plate ? ` · plaque ${n.plate}` : ''} · {n.origin === 'ECHEC_CANAUX' ? 'canaux épuisés' : 'manuel'}</p>
          <p className="small">« {n.text} » — code de vérification <span className="mono">{n.verificationCode}</span></p>
          {n.posting ? <p className="small">Apposé le {new Date(n.posting.at).toLocaleString('fr-FR')} à {n.posting.distanceM} m de l’objet.</p>
            : agent && <button type="button" className="btn btn-primary btn-sm" onClick={() => void post(n)}>Apposer ici (position et photo)</button>}
        </li>))}</ul>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </section>
  );
}

export default function Notifications() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const staff = roles.some((r) => ['R01', 'R02', 'R05', 'R06', 'R07', 'R11', 'R12', 'R13', 'R14', 'R16', 'R20', 'R21', 'R22', 'R23'].includes(r));
  const ind = useApi(() => (staff ? api<CommIndicators>('/v1/communication/indicateurs') : Promise.resolve(null)), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Documents et communication" title="Notifications et modèles"
        lead="La bonne information, par le canal que la personne peut recevoir, avec preuve de délivrance. En cas d’échec, un canal de secours est essayé ; pour un avis obligatoire resté sans remise, un avis imprimé est apposé sur la plaque de l’objet." />
      {ind.data && <IndicatorsView d={ind.data} />}
      {staff && <Templates />}
      <PlateNotices />
    </div>
  );
}
