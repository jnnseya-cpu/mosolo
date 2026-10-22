/**
 * Vue du propriétaire d'un bâtiment (spécification v1.0, § 8) : unités, occupation VÉRIFIÉE (rôle et période), loyer du
 * bail déclaré par le propriétaire (IRL) et revendications en attente MASQUÉES. Jamais l'identité, le foyer, les
 * revenus ni les pièces des occupants. Réservée au titulaire d'une relation de propriété ou de gestion vérifiée.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatMoney } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { DonutViz, KpiGrid, KpiTile } from '../../components/viz';
import { CLAIM_STATUS, RECORD_STATUS } from './common';
import type { VueProprietaire as Vue } from './types';
import './compte-unique.css';

const ROLE: Record<string, string> = { LOCATAIRE: 'Locataire', SOUS_LOCATAIRE: 'Sous-locataire', OCCUPANT: 'Occupant', TENANT: 'Locataire', SUBTENANT: 'Sous-locataire', OPERATOR: 'Exploitant' };

export default function VueProprietaire() {
  const { id = '' } = useParams();
  const { fmtDate } = useApp();
  const [date, setDate] = useState('');
  const q = useApi<Vue>(() => api<Vue>(`/v1/biens/${encodeURIComponent(id)}/vue-proprietaire${date ? `?date=${date}` : ''}`), [id, date]);
  const v = q.data;
  return (
    <div className="page">
      <PageHead eyebrow="Mes biens et relations" title={v ? `Mon bâtiment — ${v.bien.libelle}` : 'Mon bâtiment'}
        lead="Occupation vérifiée de chaque unité, sans aucune donnée personnelle des occupants." />
      <p><Link to="/espace/biens-relations">← Mes biens et relations</Link></p>
      <div className="field"><label className="label" htmlFor="vp-date">Situation à la date du</label><input id="vp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {v && (
        <>
          <p className="small"><StatusBadge tone={RECORD_STATUS[v.bien.statutEnregistrement]?.tone ?? 'neutral'} label={RECORD_STATUS[v.bien.statutEnregistrement]?.label ?? v.bien.statutEnregistrement} /> <span className="muted">Provenance : {v.bien.provenance ?? '—'} · situation au {fmtDate(v.date)}</span></p>
          <KpiGrid max={4} label="Occupation du bâtiment">
            <KpiTile label="Unités" value={v.synthese.unites} />
            <KpiTile label="Occupées (vérifiées)" value={v.synthese.occupees} />
            <KpiTile label="Vacantes" value={v.synthese.vacantes} />
            <KpiTile label="Revendications en attente" value={v.synthese.enAttente} />
          </KpiGrid>
          <DonutViz title="Unités occupées et vacantes" centerLabel="unités" slices={[{ key: 'occ', label: 'Occupées (vérifiées)', value: v.synthese.occupees }, { key: 'vac', label: 'Vacantes', value: v.synthese.vacantes }]} emptyText="Aucune unité" />
          <ul className="list-rows">
            {v.unites.map((u) => (
              <li key={u.id} className="list-row">
                <div className="min0">
                  <p className="row-title">Unité {u.libelle}</p>
                  {u.occupationsVerifiees.map((o, i) => <p key={i} className="small">{ROLE[o.role] ?? o.role} vérifié{o.colocation ? ' (colocation)' : ''} — depuis le {fmtDate(o.du)}{o.au ? ` jusqu’au ${fmtDate(o.au)}` : ''}</p>)}
                  {u.loyerIRL.map((l) => <p key={l.bail} className="small muted">Bail {l.bail} : {formatMoney(l.loyer)} ({l.periodicite.toLowerCase()}) — base IRL</p>)}
                  {u.revendicationsEnAttente.length > 0 && <p className="small muted">{u.revendicationsEnAttente.length} revendication(s) en attente : {u.revendicationsEnAttente.map((r) => `${ROLE[r.role] ?? r.role} — ${CLAIM_STATUS[r.statut]?.label ?? r.statut}`).join(' ; ')}</p>}
                </div>
                <div className="row-side"><StatusBadge tone={u.occupation === 'OCCUPEE' ? 'good' : 'neutral'} label={u.occupation === 'OCCUPEE' ? 'Occupée' : 'Vacante'} /></div>
              </li>
            ))}
          </ul>
          <p className="small muted">{v.confidentialite}</p>
        </>
      )}
    </div>
  );
}
