/**
 * Couche usager de la chaîne véhicule : dans l'espace unique du contribuable, chaque véhicule avec sa vignette fiscale,
 * sa taxe de circulation, son contrôle technique (deux vignettes distinctes), son dossier de fourrière (situation
 * fiscale payable depuis le téléphone), ses rendez-vous et son attestation. Aucun paiement en espèces.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Notice, useRunner } from '../pilotage/planif';
import { StateBadge } from './common';
import { MesVehiculesVisuels } from './visuels';

interface Line { state: string; label: string }
interface Vehicle {
  plate: string; identification: { categoryLabel: string };
  vignetteFiscale: Line; taxeCirculation: Line; controleTechnique: Line & { echeance: string | null }; autorisationTransport: Line; quitus: Line;
  fourriere: { id: string; status: string; site: { name: string } | null; liquidationLines: { label: string; status: string; amount?: { amount: string; currency: string }; payPath?: string }[] }[];
  appointments: { id: string; date: string; centreId: string; status: string }[];
  attestation: { number: string; result: string; echeance: string } | null;
}

export default function MesVehicules() {
  const { user } = useApp();
  const data = useApi(() => api<{ vehicles: Vehicle[]; notice: string; situationFiscale?: { id: string; label: string; amount: { amount: string; currency: string }; dueDate: string }[] }>('/v1/vehicules/mes-vehicules'), [user?.id]);
  const r = useRunner(() => data.reload());
  const [rdv, setRdv] = useState({ plate: '', centreId: '', date: '' });
  // Annuaire public des centres agréés (30/09/2026) : l'usager choisit son centre au lieu d'en saisir le numéro.
  // Arrivée depuis « À faire » (#rendez-vous-ct) : défilement jusqu'au formulaire de rendez-vous.
  const loc = useLocation();
  useEffect(() => { if (loc.hash) setTimeout(() => document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: 'smooth' }), 300); }, [loc.hash, data.data]);
  const centres = useApi(() => api<{ items: { id: string; publicCode: string; name: string; kindLabel: string; commune: string; hours?: { open: string; close: string } }[] }>('/v1/public/centres-agrees'), []);

  if (!user) return <div className="page"><PageHead title="Mes véhicules" /><p className="notice">Connectez-vous à votre espace.</p></div>;
  return (
    <div className="page">
      <PageHead eyebrow="Mon espace" title="Mes véhicules" lead={data.data?.notice ?? 'Vignette fiscale, contrôle technique, fourrière, rendez-vous et quittances.'} />
      <Notice msg={r.msg} />
      {!!data.data?.vehicles.length && <MesVehiculesVisuels vehicles={data.data.vehicles} />}
      {data.loading && !data.data ? <Loading /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : !data.data?.vehicles.length ? <EmptyState title="Aucun véhicule rattaché" icon="car" /> : data.data.vehicles.map((v) => (
        <section key={v.plate} className="panel" style={{ marginBottom: '1rem' }}>
          <h2 className="panel-title">{v.plate} <span className="small muted">{v.identification.categoryLabel}</span></h2>
          <div className="vc-lines">
            <div className="vc-line"><h3>Vignette fiscale</h3><StateBadge state={v.vignetteFiscale.state} /><p className="small">{v.vignetteFiscale.label}</p></div>
            <div className="vc-line"><h3>Taxe de circulation</h3><StateBadge state={v.taxeCirculation.state} /><p className="small">{v.taxeCirculation.label}</p></div>
            <div className="vc-line"><h3>Contrôle technique</h3><StateBadge state={v.controleTechnique.state} /><p className="small">{v.controleTechnique.label}</p>{v.attestation && <p className="small muted">Attestation {v.attestation.number}</p>}</div>
            <div className="vc-line"><h3>Quitus provincial</h3><StateBadge state={v.quitus.state} /><p className="small">{v.quitus.label}</p></div>
          </div>
          {v.fourriere.map((d) => (
            <div key={d.id} className="vc-line" style={{ marginTop: '0.75rem' }}>
              <h3>Fourrière — {d.site?.name ?? 'site'} <StateBadge state={d.status} /></h3>
              <ul>{d.liquidationLines.map((l) => <li key={l.label} className="small">{l.label} : {l.amount ? `${l.amount.amount} ${l.amount.currency}` : 'aucun montant (acte requis)'}</li>)}</ul>
              <p className="small">Paiement par monnaie mobile, banque ou carte depuis votre espace (même référence, même quittance). Jamais d’espèces à la fourrière.</p>
            </div>
          ))}
          {v.appointments.length > 0 && <p className="small">Rendez-vous : {v.appointments.map((a) => `${a.date} (${a.status === 'CONFIRME' ? 'confirmé' : 'demandé'})`).join(' · ')}</p>}
        </section>
      ))}
      {!!data.data?.situationFiscale?.length && (
        <section className="panel" style={{ marginBottom: '1rem' }}>
          <h2 className="panel-title">Ma situation fiscale (payable depuis mon téléphone)</h2>
          <ul>{data.data.situationFiscale.map((o) => <li key={o.id} className="small">{o.label} : {o.amount.amount} {o.amount.currency} — échéance {o.dueDate}</li>)}</ul>
        </section>
      )}
      <div className="vc-form">
        <h3 id="rendez-vous-ct">Prendre rendez-vous pour un contrôle technique</h3>
        <p className="small muted">Choisissez votre véhicule, un centre agréé et une date : le centre effectue le contrôle et appose la vignette technique ; le résultat apparaît ensuite ici et dans « Mes preuves ».</p>
        <label><span>Véhicule</span>
          <select value={rdv.plate} onChange={(e) => setRdv({ ...rdv, plate: e.target.value })}>
            <option value="">Choisir un véhicule</option>
            {(data.data?.vehicles ?? []).map((v) => <option key={v.plate} value={v.plate}>{v.plate} — {v.controleTechnique.label}</option>)}
          </select></label>
        <label><span>Centre agréé</span>
          <select value={rdv.centreId} onChange={(e) => setRdv({ ...rdv, centreId: e.target.value })}>
            <option value="">{centres.data?.items.length ? 'Choisir un centre agréé' : 'Aucun centre agréé disponible'}</option>
            {(centres.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.commune} — {c.name}{c.hours ? ` (${c.hours.open}–${c.hours.close})` : ''}</option>)}
          </select></label>
        <label><span>Date</span><input type="date" value={rdv.date} onChange={(e) => setRdv({ ...rdv, date: e.target.value })} /></label>
        <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || !rdv.plate || !rdv.centreId || !rdv.date} onClick={() => void r.run('/v1/vehicules/rendez-vous', rdv, 'Rendez-vous demandé.')}>Demander le rendez-vous</button>
      </div>
    </div>
  );
}
