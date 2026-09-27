/**
 * CALCU — organe de contrôle (§ 27A.4, § 27A.5) : montants contrôlés et récupérés, institutions à risque, zones
 * exposées, taux d'exécution des recommandations ; registre des fournisseurs, lignes budgétaires, justificatifs
 * géolocalisés ; rapports PDF ; missions ciblées sans déplacement ; transmission à la justice décidée par une autre
 * personne. CALCU ne bloque aucun paiement.
 */
import { useState, type FormEvent } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { EmpreinteFichier, montants } from '../../components/EmpreinteFichier';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, apiBlob, describeError } from '../../lib/api';
import { useApp } from '../../context';
import { hasRole, Message, useAction } from '../tresor/shared';
import './verticales.css';

interface Named { id: string; status: string }
interface Supplier extends Named { name: string; nif: string; declaredBy: string }
interface BudgetLine extends Named { code: string; label: string; entityName: string; exercice: number; allotted: MoneyJSON; declaredBy: string }
interface Mission extends Named { entityName: string; objet: string; openedBy: string; conclusions?: string }
interface Referral extends Named { reportId: string; authority: string; motif: string; proposedBy: string; decidedBy?: string; bordereau?: { number: string; sha256: string } }
interface Reco extends Named { entityName: string; text: string; dueDate: string }
export interface OrganeDashboard {
  controlled: { transactions: number; amounts: MoneyJSON[] }; recovered: { count: number; amounts: MoneyJSON[] };
  recommendations: { issued: number; executed: number; due: number; executionRate: string | null }; notice: string;
  institutionsAtRisk?: { entityName: string; rouge: number; ambre: number; vert: number; amounts: MoneyJSON[] }[];
  exposedZones?: { commune: string; anomalies: number; amounts: MoneyJSON[] }[];
  suppliers?: Supplier[]; budgetLines?: BudgetLine[]; missions?: Mission[]; referrals?: Referral[]; recommendationsList?: Reco[];
}
interface Report { id: string; score: string; status: string; createdAt: string }

async function downloadPdf(reportId: string): Promise<void> {
  const blob = await apiBlob(`/v1/verticales/calcu/reports/${encodeURIComponent(reportId)}/pdf`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `rapport-${reportId}.pdf`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Justificatif géolocalisé (§ 27A.4) : pièce par empreinte, position et horodatage de la capture, ligne budgétaire. */
function JustificatifForm({ budgetLines, onDone }: { budgetLines: BudgetLine[]; onDone: () => void }) {
  const { busy, msg, run } = useAction();
  const [f, setF] = useState({ accountId: '', operationRef: '', type: 'ENGAGEMENT', supplier: '', amount: '', currency: 'CDF', date: '', sha: '', commune: '', budgetLineId: '' });
  const [geo, setGeo] = useState<{ lat: number; lon: number; accuracyM: number; capturedAt: string } | null>(null);
  const locate = () => navigator.geolocation?.getCurrentPosition((p) => setGeo({ lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy), capturedAt: new Date().toISOString() }));
  function submit(e: FormEvent) {
    e.preventDefault();
    void run('/v1/verticales/calcu/justificatifs', {
      accountId: f.accountId, operationRef: f.operationRef, type: f.type, supplier: f.supplier, amount: { amount: f.amount, currency: f.currency }, date: f.date, sha256: f.sha,
      ...(geo ? { geo } : {}), ...(f.commune ? { commune: f.commune } : {}), ...(f.budgetLineId ? { budgetLineId: f.budgetLineId } : {}),
    }, 'Justificatif enregistré.', onDone);
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="form" onSubmit={submit}>
      <div className="field"><label className="label" htmlFor="cj-acc">Compte (CALCU-CPT-…)</label><input id="cj-acc" className="mono" value={f.accountId} onChange={set('accountId')} required /></div>
      <div className="field"><label className="label" htmlFor="cj-op">Référence de l’opération</label><input id="cj-op" value={f.operationRef} onChange={set('operationRef')} required /></div>
      <div className="field"><label className="label" htmlFor="cj-t">Pièce</label><select id="cj-t" value={f.type} onChange={set('type')}>{['DEVIS', 'BON_COMMANDE', 'ENGAGEMENT', 'CONTRAT', 'FOURNISSEUR'].map((t) => <option key={t}>{t}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="cj-s">Fournisseur</label><input id="cj-s" value={f.supplier} onChange={set('supplier')} required /></div>
      <div className="field"><label className="label" htmlFor="cj-a">Montant</label><input id="cj-a" value={f.amount} onChange={set('amount')} required /><select aria-label="Devise" value={f.currency} onChange={set('currency')}><option>CDF</option><option>USD</option></select></div>
      <div className="field"><label className="label" htmlFor="cj-d">Date de la pièce</label><input id="cj-d" type="date" value={f.date} onChange={set('date')} required /></div>
      <div className="field"><label className="label" htmlFor="cj-c">Commune du lieu de la dépense</label><input id="cj-c" value={f.commune} onChange={set('commune')} /></div>
      <div className="field"><label className="label" htmlFor="cj-lb">Ligne budgétaire</label><select id="cj-lb" value={f.budgetLineId} onChange={set('budgetLineId')}><option value="">—</option>{budgetLines.map((l) => <option key={l.id} value={l.id}>{l.code} {l.label}</option>)}</select></div>
      <EmpreinteFichier label="Photo ou scan de la pièce" value={f.sha} onChange={(sha) => setF({ ...f, sha })} />
      <p className="small"><button type="button" className="btn btn-ghost btn-sm" onClick={locate}><Icon name="gps" size={16} /> Géolocaliser la capture</button> {geo ? `${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)} ±${geo.accuracyM} m` : 'Position non relevée'}</p>
      <button type="submit" className="btn btn-secondary" disabled={busy || !f.sha}>Enregistrer le justificatif</button>
      <Message msg={msg} />
    </form>
  );
}

export function CalcuOrganeView({ d, reports, roles, onChanged }: { d: OrganeDashboard; reports: Report[]; roles: string[]; onChanged: () => void }) {
  const { busy, msg, setMsg, run } = useAction();
  const [motif, setMotif] = useState<Record<string, string>>({});
  const [sup, setSup] = useState({ name: '', nif: '' });
  const [mission, setMission] = useState({ entityName: '', objet: '', scope: '', reportId: '' });
  const [reco, setReco] = useState({ entityName: '', text: '', dueDate: '' });
  const [ref, setRef] = useState({ reportId: '', authority: '', motif: '', sha: '' });
  const control = hasRole(roles, 'R22');
  const declare = hasRole(roles, 'R08', 'R17');
  const post = (path: string, body: unknown, ok: string) => void run(path, body, ok, onChanged);
  return (
    <>
      <div className="kpi-row">
        <div className="kpi"><p className="kpi-label caps-sm">Montants contrôlés</p><p className="kpi-value">{montants(d.controlled.amounts)}</p><div className="kpi-foot"><span className="kpi-sub">{d.controlled.transactions} transaction(s)</span></div></div>
        <div className="kpi"><p className="kpi-label caps-sm">Montants récupérés</p><p className="kpi-value">{montants(d.recovered.amounts)}</p></div>
        <div className="kpi"><p className="kpi-label caps-sm">Exécution des recommandations</p><p className="kpi-value">{d.recommendations.executionRate ?? '—'}</p><div className="kpi-foot"><span className="kpi-sub">{d.recommendations.executed} / {d.recommendations.due} échues</span></div></div>
      </div>
      <p className="callout callout-info">{d.notice}</p>
      <Message msg={msg} />
      {d.institutionsAtRisk && (
        <section className="panel" aria-labelledby="co-inst"><h2 className="panel-title" id="co-inst">Institutions à risque</h2>
          <DataTable rows={d.institutionsAtRisk} rowKey={(x) => x.entityName} caption="Institutions à risque" empty={<EmptyState title="Aucune institution à risque" icon="check" />}
            columns={[
              { key: 'e', label: 'Entité', primary: true, render: (x) => x.entityName },
              { key: 'r', label: 'Rouge', num: true, render: (x) => x.rouge },
              { key: 'a', label: 'Ambre', num: true, render: (x) => x.ambre },
              { key: 'm', label: 'Montants en anomalie', num: true, render: (x) => montants(x.amounts) },
            ]} />
          <h3 className="panel-title">Zones à forte exposition</h3>
          <ul className="plain-list small">{(d.exposedZones ?? []).map((z) => <li key={z.commune}>{z.commune === 'NON_LOCALISE' ? 'Non localisé (justificatif sans commune)' : z.commune} — {z.anomalies} anomalie(s), {montants(z.amounts)}</li>)}</ul>
        </section>
      )}
      <section className="panel" aria-labelledby="co-rep"><h2 className="panel-title" id="co-rep">Rapports d’anomalie (PDF cacheté)</h2>
        {reports.length === 0 ? <EmptyState title="Aucun rapport" icon="check" /> : (
          <ul className="list-rows">{reports.map((r) => (
            <li key={r.id} className="list-row"><span className="row-title mono">{r.id}</span><StatusBadge tone={r.score === 'ROUGE' ? 'critical' : 'warning'} label={`${r.score} · ${r.status}`} />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void downloadPdf(r.id).catch((e) => setMsg({ ok: false, text: describeError(e).message }))}><Icon name="download" size={16} /> PDF</button></li>
          ))}</ul>
        )}
      </section>
      <section className="panel" aria-labelledby="co-sup"><h2 className="panel-title" id="co-sup">Registre des fournisseurs et lignes budgétaires</h2>
        <ul className="list-rows">{(d.suppliers ?? []).map((s) => (
          <li key={s.id} className="list-row"><span className="row-title">{s.name} <span className="mono small">{s.nif}</span></span><StatusBadge tone={s.status === 'VALIDE' ? 'good' : s.status === 'RADIE' ? 'critical' : 'warning'} label={s.status} />
            {control && s.status === 'DECLARE' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => post(`/v1/verticales/calcu/fournisseurs/${s.id}/validation`, {}, 'Fournisseur validé.')}>Valider</button>}</li>
        ))}</ul>
        <ul className="list-rows">{(d.budgetLines ?? []).map((l) => <li key={l.id} className="list-row"><span className="row-title">{l.entityName} {l.exercice} — {l.code} {l.label}</span><span className="small">{l.allotted.amount} {l.allotted.currency}</span><StatusBadge tone={l.status === 'VALIDEE' ? 'good' : 'warning'} label={l.status} />
          {hasRole(roles, 'R05', 'R15') && l.status === 'DECLAREE' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => post(`/v1/verticales/calcu/lignes-budgetaires/${l.id}/validation`, {}, 'Ligne budgétaire validée.')}>Valider (Finances)</button>}</li>)}</ul>
        {declare && (
          <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); post('/v1/verticales/calcu/fournisseurs', sup, 'Fournisseur déclaré : validation par l’organe de contrôle.'); }}>
            <div className="field"><label className="label" htmlFor="co-sn">Fournisseur</label><input id="co-sn" value={sup.name} onChange={(e) => setSup({ ...sup, name: e.target.value })} required /></div>
            <div className="field"><label className="label" htmlFor="co-nif">NIF</label><input id="co-nif" value={sup.nif} onChange={(e) => setSup({ ...sup, nif: e.target.value })} required /></div>
            <button type="submit" className="btn btn-secondary" disabled={busy}>Déclarer le fournisseur</button>
          </form>
        )}
        {declare && <><h3 className="panel-title">Justificatif géolocalisé</h3><JustificatifForm budgetLines={d.budgetLines ?? []} onDone={onChanged} /></>}
      </section>
      {control && (
        <section className="panel" aria-labelledby="co-mis"><h2 className="panel-title" id="co-mis">Missions ciblées, transmissions à la justice, recommandations</h2>
          <ul className="list-rows">{(d.missions ?? []).map((m) => <li key={m.id} className="list-row"><span className="row-title">{m.id} — {m.entityName} : {m.objet}</span><StatusBadge tone={m.status === 'OUVERTE' ? 'info' : 'good'} label={m.status === 'OUVERTE' ? 'Ouverte (sans déplacement)' : 'Clôturée'} /></li>)}</ul>
          <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); post('/v1/verticales/calcu/missions', { entityName: mission.entityName, objet: mission.objet, scope: mission.scope, ...(mission.reportId ? { reportId: mission.reportId } : {}) }, 'Mission ouverte.'); }}>
            <div className="field"><label className="label" htmlFor="co-me">Entité contrôlée</label><input id="co-me" value={mission.entityName} onChange={(e) => setMission({ ...mission, entityName: e.target.value })} required /></div>
            <div className="field"><label className="label" htmlFor="co-mo">Objet</label><input id="co-mo" value={mission.objet} onChange={(e) => setMission({ ...mission, objet: e.target.value })} required minLength={5} /></div>
            <div className="field"><label className="label" htmlFor="co-ms">Périmètre</label><input id="co-ms" value={mission.scope} onChange={(e) => setMission({ ...mission, scope: e.target.value })} required minLength={5} /></div>
            <button type="submit" className="btn btn-secondary" disabled={busy}>Ouvrir une mission ciblée</button>
          </form>
          <ul className="list-rows">{(d.referrals ?? []).map((j) => (
            <li key={j.id} className="list-row list-row-stack"><div className="row-between"><span className="row-title">{j.id} — rapport {j.reportId} → {j.authority}</span><StatusBadge tone={j.status === 'TRANSMISE' ? 'serious' : j.status === 'PROPOSEE' ? 'warning' : 'neutral'} label={j.status} /></div>
              <p className="small">{j.motif} — proposé par {j.proposedBy}{j.bordereau ? ` · bordereau ${j.bordereau.number}` : ''}</p>
              {j.status === 'PROPOSEE' && <div className="row-between">
                <input aria-label={`Motif ${j.id}`} value={motif[j.id] ?? ''} onChange={(e) => setMotif({ ...motif, [j.id]: e.target.value })} placeholder="Motif de la décision" />
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || (motif[j.id] ?? '').length < 10} onClick={() => post(`/v1/verticales/calcu/transmissions/${j.id}/decision`, { approve: true, motif: motif[j.id] }, 'Transmission décidée : bordereau horodaté.')}>Transmettre</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (motif[j.id] ?? '').length < 10} onClick={() => post(`/v1/verticales/calcu/transmissions/${j.id}/decision`, { approve: false, motif: motif[j.id] }, 'Transmission écartée.')}>Écarter</button>
              </div>}
            </li>))}
          </ul>
          <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); post(`/v1/verticales/calcu/reports/${ref.reportId}/transmission-justice`, { motif: ref.motif, authority: ref.authority, pieces: [ref.sha] }, 'Transmission proposée : décision par une autre personne.'); }}>
            <div className="field"><label className="label" htmlFor="co-jr">Rapport</label><select id="co-jr" value={ref.reportId} onChange={(e) => setRef({ ...ref, reportId: e.target.value })}><option value="">—</option>{reports.map((r) => <option key={r.id}>{r.id}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="co-ja">Autorité judiciaire</label><input id="co-ja" value={ref.authority} onChange={(e) => setRef({ ...ref, authority: e.target.value })} required /></div>
            <div className="field"><label className="label" htmlFor="co-jm">Motif</label><input id="co-jm" value={ref.motif} onChange={(e) => setRef({ ...ref, motif: e.target.value })} required minLength={10} /></div>
            <EmpreinteFichier label="Pièce transmise" value={ref.sha} onChange={(sha) => setRef({ ...ref, sha })} />
            <button type="submit" className="btn btn-secondary" disabled={busy || !ref.reportId || !ref.sha}>Proposer la transmission à la justice</button>
          </form>
          <ul className="list-rows">{(d.recommendationsList ?? []).map((r) => (
            <li key={r.id} className="list-row"><span className="row-title">{r.entityName} — {r.text} (échéance {r.dueDate})</span><StatusBadge tone={r.status === 'EXECUTEE' ? 'good' : r.status === 'NON_EXECUTEE' ? 'critical' : 'warning'} label={r.status} />
              {r.status !== 'EXECUTEE' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => post(`/v1/verticales/calcu/recommandations/${r.id}/suivi`, { status: 'EXECUTEE', note: 'Exécution constatée par l’organe de contrôle.' }, 'Suivi enregistré.')}>Constater l’exécution</button>}</li>
          ))}</ul>
          <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); post('/v1/verticales/calcu/recommandations', reco, 'Recommandation émise.'); }}>
            <div className="field"><label className="label" htmlFor="co-re">Entité</label><input id="co-re" value={reco.entityName} onChange={(e) => setReco({ ...reco, entityName: e.target.value })} required /></div>
            <div className="field"><label className="label" htmlFor="co-rt">Recommandation</label><input id="co-rt" value={reco.text} onChange={(e) => setReco({ ...reco, text: e.target.value })} required minLength={10} /></div>
            <div className="field"><label className="label" htmlFor="co-rd">Échéance</label><input id="co-rd" type="date" value={reco.dueDate} onChange={(e) => setReco({ ...reco, dueDate: e.target.value })} required /></div>
            <button type="submit" className="btn btn-secondary" disabled={busy}>Émettre la recommandation</button>
          </form>
        </section>
      )}
    </>
  );
}

export default function CalcuOrgane() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const allowed = hasRole(roles, 'R01', 'R05', 'R08', 'R15', 'R17', 'R22', 'R23');
  const d = useApi(allowed ? () => api<OrganeDashboard>('/v1/verticales/calcu/organe') : null, [user?.id]);
  const ov = useApi(allowed ? () => api<{ reports?: Report[] }>('/v1/verticales/calcu/overview') : null, [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="CALCU" title="Organe de contrôle — tableaux et pouvoirs" lead="Montants contrôlés et récupérés, institutions à risque, zones exposées, recommandations ; missions ciblées sans déplacement et transmission à la justice décidée par une autre personne. CALCU ne bloque aucun paiement." />
      {!allowed ? <EmptyState title="Accès réservé" icon="lock">Réservé à l’organe de contrôle, aux Finances et au Gouverneur.</EmptyState> : (
        <>
          {d.loading && <Loading />}
          {d.error !== null && <ErrorState error={d.error} onRetry={d.reload} />}
          {d.data && <CalcuOrganeView d={d.data} reports={ov.data?.reports ?? []} roles={roles} onChanged={() => { d.reload(); ov.reload(); }} />}
        </>
      )}
    </div>
  );
}
