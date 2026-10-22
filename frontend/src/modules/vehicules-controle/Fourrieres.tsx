/**
 * Fourrières, enlèvement et gardiennage (module 83 — n° 60 du catalogue du maître d'ouvrage du 27/09/2026).
 * Chaîne en sept étapes ; aucun enlèvement sans décision de l'autorité compétente enregistrée avant ; la priorisation
 * n'ordonne rien ; compteur de jours automatique ; aucun encaissement sur place ; sortie sur quittance appariée ;
 * destination légale jamais déclenchée par une IA, un score ou un seuil.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from '../pilotage/shared';
import { Callout, Notice, useRunner } from '../pilotage/planif';
import { amounts, hasRole, NOTE_NUMEROTATION, StateBadge, Tile, Tiles, type Indicators } from './common';
import { FourriereVisuels } from './visuels';

interface Dossier {
  id: string; plate: string; status: string; daysInCustody: number; site: { name: string } | null; taxpayerRef: string | null; demo?: boolean;
  constat: { motifLegal: string; at: string }; decision?: { legalBasis: string; decidedAt: string };
  liquidationLines: { code: string; label: string; status: string; amount?: { amount: string; currency: string }; reason?: string }[];
  appealCountdown: { deadline: string; daysLeft: number } | null; custody: { intact: boolean; links: number };
}
interface Site { id: string; name: string; commune: string; capacity: number; occupancy: number; demo?: boolean }
interface Recon { siteId: string; name: string; entries: number; exits: number; inCustody: number; exitsOnReceipt: number; exitsOnDecision: number; obligations: number; obligationsPaid: number; balanced: boolean }
interface Prio { items: { plate: string; score: number; factors: { label: string }[] }[]; notice: string }

const STEPS = ['Constat et immobilisation', 'Entrée (inventaire contradictoire)', 'Gardiennage (compteur de jours)', 'Liquidation détaillée', 'Paiement vers le compte public', 'Mainlevée et sortie', 'Destination légale'];

export default function Fourrieres() {
  const { user } = useApp();
  const ind = useApi(() => api<Indicators>('/v1/vehicules/indicateurs'), [user?.id]);
  const dossiers = useApi(() => api<{ items: Dossier[] }>('/v1/fourrieres/dossiers'), [user?.id]);
  const sites = useApi(() => api<{ items: Site[] }>('/v1/fourrieres/sites'), [user?.id]);
  const recon = useApi(() => api<{ sites: Recon[] }>('/v1/fourrieres/rapprochement'), [user?.id]);
  const prio = useApi(() => api<Prio>('/v1/fourrieres/priorisation'), [user?.id]);
  const reload = () => { ind.reload(); dossiers.reload(); sites.reload(); recon.reload(); };
  const r = useRunner(reload);
  const [dec, setDec] = useState({ id: '', motifLegal: '', legalBasis: '', ref: '' });

  if (!user) return <div className="page"><PageHead title="Fourrières, enlèvement et gardiennage" /><p className="notice">Connectez-vous.</p></div>;
  const f = ind.data?.fourriere;
  const canDecide = hasRole(user.roles, 'R06', 'R07', 'R21');
  return (
    <div className="page page-wide">
      <PageHead eyebrow={`Chaîne véhicule · module 83 (${NOTE_NUMEROTATION})`} title="Fourrières, enlèvement et gardiennage" lead="Aucun enlèvement sans décision de l’autorité compétente ; aucun paiement en espèces ; sortie uniquement sur quittance appariée ou décision motivée." />
      <Notice msg={r.msg} />
      <FourriereVisuels f={f} dossiers={dossiers.data?.items} sites={sites.data?.items} recon={recon.data?.sites} loading={ind.loading} error={ind.error} onRetry={reload} />
      {ind.loading && !ind.data ? <Loading /> : ind.error ? <ErrorState error={ind.error} onRetry={reload} /> : f && (
        <Tiles>
          <Tile label="Véhicules en fourrière" value={f.enFourriere} />
          <Tile label="Durée moyenne de garde" value={f.dureeMoyenneGardeJours === null ? '—' : `${f.dureeMoyenneGardeJours} j`} />
          <Tile label="Mainlevées" value={f.mainlevees} />
          <Tile label="Sorties" value={f.sorties} />
          <Tile label="Garde longue (alerte)" value={f.gardeLongue} />
          <Tile label="Recette fourrière liquidée" value={amounts(f.recetteLiquidee)} />
          <Tile label="Recette fourrière payée" value={amounts(f.recettePayee)} />
        </Tiles>
      )}
      <div className="dash-grid">
        <Section title="Chaîne en sept étapes">
          <ol className="vc-steps">{STEPS.map((s, k) => <li key={s}><strong>{k + 1}.</strong> {s}</li>)}</ol>
          <Callout tone="warn">Paiement uniquement par monnaie mobile, banque ou carte vers le compte public désigné : aucun gestionnaire, caissière ou pointeur n’encaisse.</Callout>
        </Section>
        <Section title="Dossiers">
          {dossiers.error ? <ErrorState error={dossiers.error} onRetry={dossiers.reload} /> : (
            <DataTable caption="Dossiers de fourrière" rows={dossiers.data?.items ?? []} rowKey={(d) => d.id} empty={<EmptyState title="Aucun dossier" icon="car" />} columns={[
              { key: 'p', label: 'Plaque', primary: true, render: (d) => <><strong>{d.plate}</strong><span className="small muted" style={{ display: 'block' }}>{d.id}{d.demo ? ' · [EXEMPLE]' : ''}</span></> },
              { key: 's', label: 'Étape', render: (d) => <StateBadge state={d.status} /> },
              { key: 'm', label: 'Motif légal', render: (d) => <span className="small">{d.constat.motifLegal}{d.decision ? ` — décision : ${d.decision.legalBasis}` : ''}</span> },
              { key: 'j', label: 'Jours de garde', num: true, render: (d) => d.daysInCustody },
              { key: 'l', label: 'Frais', render: (d) => <span className="small">{d.liquidationLines.length ? d.liquidationLines.map((l) => `${l.label} : ${l.amount ? `${l.amount.amount} ${l.amount.currency}` : 'aucun montant (acte requis)'}`).join(' ; ') : 'Non liquidé'}</span> },
              { key: 'c', label: 'Chaîne de garde', render: (d) => (d.custody.intact ? `Intacte (${d.custody.links} maillons)` : 'ROMPUE') },
              { key: 'r', label: 'Recours', render: (d) => (d.appealCountdown ? `${d.appealCountdown.daysLeft > 0 ? `${d.appealCountdown.daysLeft} j restants` : 'Délai expiré'} (${d.appealCountdown.deadline})` : '—') },
              { key: 'a', label: 'Actions', render: (d) => (
                <span className="btn-row">
                  {hasRole(user.roles, 'R06', 'R07') && d.status === 'EN_GARDE' && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/fourrieres/dossiers/${d.id}/liquidation`, {}, 'Liquidation enregistrée (fiches du registre).')}>Liquider</button>}
                  {canDecide && d.status === 'CONSTATE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDec({ ...dec, id: d.id })}>Décider l’enlèvement</button>}
                </span>
              ) },
            ]} />
          )}
          {canDecide && dec.id && (
            <div className="vc-form">
              <h3>Décision d’enlèvement — {dec.id}</h3>
              <label><span>Motif légal</span><input value={dec.motifLegal} onChange={(e) => setDec({ ...dec, motifLegal: e.target.value })} /></label>
              <label><span>Base légale</span><input value={dec.legalBasis} onChange={(e) => setDec({ ...dec, legalBasis: e.target.value })} /></label>
              <label><span>Référence de la décision</span><input value={dec.ref} onChange={(e) => setDec({ ...dec, ref: e.target.value })} /></label>
              <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/fourrieres/dossiers/${dec.id}/decision-enlevement`, { motifLegal: dec.motifLegal, legalBasis: dec.legalBasis, source: { kind: 'DECISION_AUTORITE', ref: dec.ref } }, 'Décision d’enlèvement enregistrée.')}>Enregistrer la décision</button>
            </div>
          )}
        </Section>
        <Section title="Priorisation (indicative)" sub={prio.data?.notice}>
          <DataTable caption="Priorisation" rows={prio.data?.items ?? []} rowKey={(p) => p.plate} empty={<EmptyState title="Rien à prioriser" icon="analysis" />} columns={[
            { key: 'p', label: 'Plaque', primary: true, render: (p) => p.plate },
            { key: 's', label: 'Score', num: true, render: (p) => p.score },
            { key: 'f', label: 'Facteurs', render: (p) => p.factors.map((x) => x.label).join(' ; ') },
            { key: 'o', label: 'Ordre d’enlèvement', render: () => 'Aucun (décision humaine requise)' },
          ]} />
        </Section>
        <Section title="Sites et rapprochement entrées / sorties / paiements">
          <DataTable caption="Sites" rows={sites.data?.items ?? []} rowKey={(s) => s.id} empty={<EmptyState title="Aucun site" icon="pin" />} columns={[
            { key: 'n', label: 'Site', primary: true, render: (s) => <>{s.name}{s.demo ? ' [EXEMPLE]' : ''}<span className="small muted" style={{ display: 'block' }}>{s.commune}</span></> },
            { key: 'o', label: 'Occupation', num: true, render: (s) => `${s.occupancy} / ${s.capacity}` },
          ]} />
          <DataTable caption="Rapprochement" rows={recon.data?.sites ?? []} rowKey={(x) => x.siteId} columns={[
            { key: 'n', label: 'Site', primary: true, render: (x) => x.name },
            { key: 'e', label: 'Entrées', num: true, render: (x) => x.entries },
            { key: 's', label: 'Sorties (quittance / décision)', num: true, render: (x) => `${x.exits} (${x.exitsOnReceipt} / ${x.exitsOnDecision})` },
            { key: 'g', label: 'En garde', num: true, render: (x) => x.inCustody },
            { key: 'p', label: 'Frais payés', num: true, render: (x) => `${x.obligationsPaid} / ${x.obligations}` },
            { key: 'b', label: 'Équilibre', render: (x) => <StateBadge state={x.balanced ? 'CONFORME' : 'A_FAIRE'} label={x.balanced ? 'Équilibré' : 'Écart'} /> },
          ]} />
        </Section>
      </div>
    </div>
  );
}
