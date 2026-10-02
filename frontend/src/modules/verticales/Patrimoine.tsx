/**
 * Patrimoine provincial (MOSOLO Assets, modules 48 et 61 — Partie V) : inventaire des actifs, évaluation par une autre
 * personne, appel public ou délibération, ouverture des offres scellées après la date limite, attribution motivée,
 * revenus domaniaux (obligations, paiements confirmés, règlements rapprochés). Aucune attribution de gré à gré.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { PatrimoineVisuels } from './visuels';

interface Asset { id: string; reference: string; nature: string; designation: string; commune: string; status: string; demo: boolean; evaluation: { annualRevenueEstimate: MoneyJSON; marketValue: MoneyJSON } | null }
interface Call { id: string; reference: string; assetId: string; procedure: string; deadline: string; status: string; reservePrice: MoneyJSON; candidatures: number; opening?: { offers: { caseId: string; amount: MoneyJSON | null }[] }; award?: { caseId: string; motif: string } }
interface Revenues { rule: { code: string; status: string; demo?: boolean }; items: { assetId: string; reference: string; designation: string; status: string; obligations: number; liquidated: MoneyJSON[]; paid: MoneyJSON[]; reconciled: MoneyJSON[] }[]; notice: string }

const STATUS: Record<string, string> = { INVENTORIE: 'Inventorié', EVALUE: 'Évalué', EN_APPEL: 'En appel', ATTRIBUE: 'Attribué', PUBLIE: 'Publié', PLIS_OUVERTS: 'Plis ouverts', INFRUCTUEUX: 'Infructueux' };
const list = (l: MoneyJSON[]) => (l.length ? l.map((m, i) => <MoneyText key={i} money={m} />) : '0');

export default function Patrimoine() {
  const { user, fmtDate } = useApp();
  const ov = useApi(() => api<{ assets: Asset[]; calls: Call[] }>('/v1/verticales/actifs'), [user?.id]);
  const rev = useApi(() => api<Revenues>('/v1/verticales/actifs/revenus'), [user?.id]);
  const [err, setErr] = useState<string | null>(null);
  const [inv, setInv] = useState({ nature: 'LOCAL_COMMERCIAL', designation: '', commune: 'Gombe', quartier: '', titleReference: '' });
  const reload = () => { ov.reload(); rev.reload(); };
  const post = async (path: string, body: unknown) => { setErr(null); try { await api(path, { method: 'POST', body }); reload(); } catch (e) { setErr(describeError(e).message); } };
  const ask = (label: string) => window.prompt(label)?.trim() ?? '';
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Patrimoine provincial (MOSOLO Assets) · modules 48 · 61" title="Valorisation du patrimoine provincial"
        lead="Inventaire, évaluation par une autre personne, appel public ou délibération, ouverture publique des offres, attribution motivée et suivi des revenus domaniaux. Aucune attribution de gré à gré." />
      <ExampleNotice text="Actifs et montants marqués [EXEMPLE] : données de démonstration, non contractuelles." />
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {ov.loading && <Loading />}
      {!!ov.error && <ErrorState error={ov.error} onRetry={ov.reload} />}
      {ov.data && <PatrimoineVisuels assets={ov.data.assets} calls={ov.data.calls} revenues={rev.data?.items} />}
      {ov.data && (
        <div className="stack">
          <section className="panel">
            <h2 className="panel-title"><Icon name="bank" size={18} /> Inventaire des actifs</h2>
            {!ov.data.assets.length ? <EmptyState title="Aucun actif inventorié" /> : (
              <ul className="list-rows">{ov.data.assets.map((a) => (
                <li key={a.id} className="list-row">
                  <div className="min0"><p className="row-title">{a.designation}</p><p className="small muted">{a.reference} · {a.nature} · {a.commune}{a.evaluation ? ` · mise à prix ${a.evaluation.annualRevenueEstimate.amount} ${a.evaluation.annualRevenueEstimate.currency}/an` : ''}</p></div>
                  <div className="row-side">
                    <StatusBadge tone={a.status === 'ATTRIBUE' ? 'good' : 'info'} label={STATUS[a.status] ?? a.status} />
                    {a.status === 'INVENTORIE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const v = ask('Valeur vénale (USD)'); const r = ask('Revenu annuel de référence (USD)'); const n = ask('Note d’évaluation'); if (v && r && n) void post(`/v1/verticales/actifs/inventaire/${a.id}/evaluations`, { method: 'COMPARAISON', marketValue: { amount: v, currency: 'USD' }, annualRevenueEstimate: { amount: r, currency: 'USD' }, reportSha256: '0'.repeat(64), note: n }); }}>Évaluer</button>}
                    {a.status === 'EVALUE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const o = ask('Objet de l’appel public'); const d = ask('Date limite (AAAA-MM-JJ)'); if (o && d) void post('/v1/verticales/actifs/appels', { assetId: a.id, procedure: 'APPEL_PUBLIC', objet: o, deadline: `${d}T12:00:00.000Z` }); }}>Publier un appel</button>}
                  </div>
                </li>
              ))}</ul>
            )}
            <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); void post('/v1/verticales/actifs/inventaire', inv); }}>
              <select value={inv.nature} onChange={(e) => setInv({ ...inv, nature: e.target.value })} aria-label="Nature"><option value="LOCAL_COMMERCIAL">Local commercial</option><option value="TERRAIN">Terrain</option><option value="BATIMENT">Bâtiment</option><option value="ESPACE_PUBLICITAIRE">Espace publicitaire</option><option value="EQUIPEMENT">Équipement</option><option value="AUTRE">Autre</option></select>
              <input value={inv.designation} onChange={(e) => setInv({ ...inv, designation: e.target.value })} placeholder="Désignation" aria-label="Désignation" />
              <input value={inv.commune} onChange={(e) => setInv({ ...inv, commune: e.target.value })} placeholder="Commune" aria-label="Commune" />
              <input value={inv.quartier} onChange={(e) => setInv({ ...inv, quartier: e.target.value })} placeholder="Quartier" aria-label="Quartier" />
              <input value={inv.titleReference} onChange={(e) => setInv({ ...inv, titleReference: e.target.value })} placeholder="Acte d’affectation" aria-label="Acte d’affectation" />
              <button type="submit" className="btn btn-secondary btn-sm">Inventorier</button>
            </form>
          </section>
          <section className="panel">
            <h2 className="panel-title"><Icon name="scale" size={18} /> Appels publics et délibérations</h2>
            {!ov.data.calls.length ? <EmptyState title="Aucun appel" /> : (
              <ul className="list-rows">{ov.data.calls.map((c) => (
                <li key={c.id} className="list-row">
                  <div className="min0"><p className="row-title">{c.reference} — {c.procedure === 'APPEL_PUBLIC' ? 'appel public' : 'délibération'}</p><p className="small muted">Date limite {fmtDate(c.deadline, true)} · mise à prix {c.reservePrice.amount} {c.reservePrice.currency} · {c.candidatures} candidature(s){c.award ? ` · attribué : ${c.award.motif}` : ''}</p></div>
                  <div className="row-side">
                    <StatusBadge tone={c.status === 'ATTRIBUE' ? 'good' : 'info'} label={STATUS[c.status] ?? c.status} />
                    {c.status === 'PUBLIE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void post(`/v1/verticales/actifs/appels/${c.id}/ouverture`, { offers: [] })}>Ouvrir les plis</button>}
                    {c.status === 'PLIS_OUVERTS' && c.opening?.offers.map((o) => <button key={o.caseId} type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif de l’attribution'); if (m) void post(`/v1/verticales/actifs/appels/${c.id}/attribution`, { caseId: o.caseId, motif: m }); }}>Attribuer {o.caseId}</button>)}
                  </div>
                </li>
              ))}</ul>
            )}
          </section>
        </div>
      )}
      {rev.data && (
        <section className="panel">
          <h2 className="panel-title"><Icon name="ledger" size={18} /> Revenus domaniaux</h2>
          <p className="small">Règle {rev.data.rule.code} : {rev.data.rule.status}{rev.data.rule.demo ? ' [EXEMPLE]' : ''}</p>
          <DataTable caption="Revenus domaniaux par actif" rows={rev.data.items} rowKey={(r) => r.assetId} columns={[
            { key: 'r', label: 'Actif', render: (r) => r.designation },
            { key: 's', label: 'Statut', render: (r) => STATUS[r.status] ?? r.status },
            { key: 'l', label: 'Liquidé', render: (r) => list(r.liquidated) },
            { key: 'p', label: 'Payé', render: (r) => list(r.paid) },
            { key: 'c', label: 'Rapproché', render: (r) => list(r.reconciled) },
          ]} />
          <p className="hint">{rev.data.notice}</p>
        </section>
      )}
    </div>
  );
}
