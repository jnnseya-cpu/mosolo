/**
 * Contrôle technique et vignette sécurisée (module 82 — n° 59 du catalogue du maître d'ouvrage du 27/09/2026).
 * Indicateurs (CT à jour, vignettes émises / annulées), procès-verbaux structurés (dix points de l'arrêté), vignettes
 * sécurisées, mode courtoisie (paramètre daté, décidé par l'autorité compétente). Le centre agréé transmet ses
 * procès-verbaux au moment du contrôle ; la RFCK ne ressaisit jamais un procès-verbal.
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
import { hasRole, NOTE_NUMEROTATION, pct, StateBadge, Tile, Tiles, type Indicators } from './common';

interface Pv { id: string; number: string; plate: string; category: string; centreId: string; result: string; echeance: string; endedAt: string; supersededBy?: string; incoherence?: string; demo?: boolean }
interface Ref { points: { code: string; label: string }[]; categories: { code: string; label: string }[]; phases2026: { code: string; label: string; date: string; statut: string }[] }
interface Courtesy { id: string; categories: string[]; communes: string[]; from: string; to: string; authority: string; decisionRef: string; reason: string; exemple?: boolean }
interface Sticker { number: string; centreId: string; status: string; plate?: string }

export default function ControleTechnique() {
  const { user } = useApp();
  const ind = useApi(() => api<Indicators>('/v1/vehicules/indicateurs'), [user?.id]);
  const ref = useApi(() => api<Ref>('/v1/vehicules/referentiel'), [user?.id]);
  const pvs = useApi(() => api<{ items: Pv[] }>('/v1/vehicules/controles-techniques'), [user?.id]);
  const stickers = useApi(() => api<{ items: Sticker[] }>('/v1/vehicules/vignettes-securisees'), [user?.id]);
  const courtesy = useApi(() => api<{ items: Courtesy[] }>('/v1/vehicules/courtoisie'), [user?.id]);
  const reload = () => { ind.reload(); pvs.reload(); stickers.reload(); courtesy.reload(); };
  const r = useRunner(reload);
  const isCentre = hasRole(user?.roles, 'R34');
  const [plate, setPlate] = useState('');
  const [category, setCategory] = useState('PARTICULIER');
  const [inspecteur, setInspecteur] = useState('');
  const [echeance, setEcheance] = useState('');
  const [result, setResult] = useState<'FAVORABLE' | 'DEFAVORABLE'>('FAVORABLE');
  const [nc, setNc] = useState<Record<string, boolean>>({});
  const [assign, setAssign] = useState({ number: '', pvId: '' });
  const [court, setCourt] = useState({ categories: '', communes: '', from: '', to: '', authority: '', decisionRef: '', reason: '' });

  if (!user) return <div className="page"><PageHead title="Contrôle technique et vignette sécurisée" /><p className="notice">Connectez-vous.</p></div>;
  const i = ind.data?.controleTechnique;
  return (
    <div className="page page-wide">
      <PageHead eyebrow={`Chaîne véhicule · module 82 (${NOTE_NUMEROTATION})`} title="Contrôle technique et vignette sécurisée" lead="Procès-verbaux structurés transmis par les centres agréés, échéances, vignettes techniques numérotées. La vignette fiscale reste un titre distinct, jamais agrégé." />
      <Notice msg={r.msg} />
      {ind.loading && !ind.data ? <Loading /> : ind.error ? <ErrorState error={ind.error} onRetry={reload} /> : i && (
        <Tiles>
          <Tile label="CT à jour" value={pct(i.ctAJourPct)} hint={`${i.ctAJour} / ${i.vehiculesConnus} véhicules connus`} />
          <Tile label="Échéances proches (30 j)" value={i.prochainesEcheances30j} />
          <Tile label="CT échus" value={i.ctEchus} />
          <Tile label="Vignettes émises" value={i.vignettesEmises} />
          <Tile label="Vignettes annulées ou révoquées" value={i.vignettesAnnulees} />
          <Tile label="Vignettes en stock (centres)" value={i.vignettesEnStock} />
          <Tile label="Courtoisie en cours" value={i.courtoisieEnCours} />
        </Tiles>
      )}
      <div className="dash-grid">
        <Section title="Procès-verbaux de contrôle technique" sub="Un champ par point de l’arrêté ; une rectification est un nouveau procès-verbal qui remplace l’ancien (motif)." tools={hasRole(user.roles, 'R06', 'R07') ? <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/vehicules/controles-techniques/rappels', {}, 'Rappels d’échéance envoyés.')}>Envoyer les rappels d’échéance</button> : undefined}>
          {pvs.error ? <ErrorState error={pvs.error} onRetry={pvs.reload} /> : (
            <DataTable caption="Procès-verbaux" rows={pvs.data?.items ?? []} rowKey={(p) => p.id} empty={<EmptyState title="Aucun procès-verbal" icon="car" />} columns={[
              { key: 'p', label: 'Plaque', primary: true, render: (p) => <><strong>{p.plate}</strong><span className="small muted" style={{ display: 'block' }}>{p.number}{p.demo ? ' · [EXEMPLE]' : ''}</span></> },
              { key: 'c', label: 'Centre', render: (p) => p.centreId },
              { key: 'r', label: 'Résultat', render: (p) => <><StateBadge state={p.result === 'FAVORABLE' ? 'A_JOUR' : 'DEFAVORABLE'} label={p.result === 'FAVORABLE' ? 'Favorable' : 'Défavorable'} />{p.incoherence && <span className="small muted" style={{ display: 'block' }}>{p.incoherence}</span>}</> },
              { key: 'e', label: 'Échéance', render: (p) => p.echeance },
              { key: 's', label: 'État', render: (p) => (p.supersededBy ? `Remplacé par ${p.supersededBy}` : 'En vigueur') },
            ]} />
          )}
        </Section>

        {isCentre && ref.data && (
          <Section title="Transmettre un procès-verbal (centre agréé)" sub="À transmettre au moment du contrôle : un procès-verbal tardif est refusé.">
            <div className="vc-form">
              <label><span>Plaque</span><input value={plate} onChange={(e) => setPlate(e.target.value)} /></label>
              <label><span>Catégorie</span><select value={category} onChange={(e) => setCategory(e.target.value)}>{ref.data.categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></label>
              <label><span>Identifiant de l’inspecteur</span><input value={inspecteur} onChange={(e) => setInspecteur(e.target.value)} /></label>
              <fieldset><legend>Points de l’arrêté (cocher les non-conformités)</legend>
                <div className="vc-points">{ref.data.points.map((p) => (
                  <label key={p.code} className="vc-row"><input type="checkbox" checked={!!nc[p.code]} onChange={(e) => setNc({ ...nc, [p.code]: e.target.checked })} /> {p.label}</label>
                ))}</div>
              </fieldset>
              <label><span>Résultat</span><select value={result} onChange={(e) => setResult(e.target.value as 'FAVORABLE' | 'DEFAVORABLE')}><option value="FAVORABLE">Favorable</option><option value="DEFAVORABLE">Défavorable (contre-visite)</option></select></label>
              <label><span>Échéance</span><input type="date" value={echeance} onChange={(e) => setEcheance(e.target.value)} /></label>
              <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || !plate || !inspecteur || !echeance} onClick={() => {
                const now = new Date();
                void r.run('/v1/vehicules/controles-techniques', {
                  centreId: user.entity, plate, category, inspecteur, startedAt: new Date(now.getTime() - 30 * 60_000).toISOString(), endedAt: now.toISOString(),
                  points: Object.fromEntries(ref.data!.points.map((p) => [p.code, { conforme: !nc[p.code] }])), result, echeance,
                }, 'Procès-verbal transmis.');
              }}>Transmettre</button>
            </div>
            <div className="vc-form">
              <h3>Attribuer une vignette sécurisée</h3>
              <label><span>Numéro de vignette (stock du centre)</span><input value={assign.number} onChange={(e) => setAssign({ ...assign, number: e.target.value })} /></label>
              <label><span>Procès-verbal favorable</span><input value={assign.pvId} onChange={(e) => setAssign({ ...assign, pvId: e.target.value })} /></label>
              <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || !assign.number || !assign.pvId} onClick={() => void r.run(`/v1/vehicules/vignettes-securisees/${encodeURIComponent(assign.number)}/attribution`, { pvId: assign.pvId }, 'Vignette attribuée.')}>Attribuer</button>
            </div>
          </Section>
        )}

        <Section title="Vignettes sécurisées" sub="Numérotées, remises aux centres dans la limite de leur quota ; un numéro inconnu est faux par construction.">
          <DataTable caption="Vignettes" rows={(stickers.data?.items ?? []).slice(0, 50)} rowKey={(s) => s.number} empty={<EmptyState title="Aucune vignette" icon="qr" />} columns={[
            { key: 'n', label: 'Numéro', primary: true, render: (s) => s.number },
            { key: 'c', label: 'Centre', render: (s) => s.centreId },
            { key: 's', label: 'Statut', render: (s) => (s.status === 'EN_STOCK' ? 'En stock' : s.status === 'ATTRIBUEE' ? `Attribuée${s.plate ? ` (${s.plate})` : ''}` : s.status === 'ANNULEE' ? 'Annulée' : 'Révoquée') },
          ]} />
        </Section>

        <Section title="Mode courtoisie" sub="Paramètre daté par catégorie et commune, décidé par l’autorité compétente et journalisé : pendant la courtoisie, aucun constat ni procès-verbal de vignette.">
          <Callout tone="warn">Aucune date n’est codée en dur. Calendrier annoncé 2026 (paramètres [EXEMPLE]) : {ref.data?.phases2026.map((p) => `${p.label} ${p.date}`).join(' ; ')}.</Callout>
          <DataTable caption="Périodes" rows={courtesy.data?.items ?? []} rowKey={(c) => c.id} empty={<EmptyState title="Aucune période" icon="clock" />} columns={[
            { key: 'p', label: 'Période', primary: true, render: (c) => <>{c.from} → {c.to}{c.exemple ? ' [EXEMPLE]' : ''}</> },
            { key: 'c', label: 'Catégories', render: (c) => c.categories.join(', ') || 'Toutes' },
            { key: 'm', label: 'Communes', render: (c) => c.communes.join(', ') || 'Toutes' },
            { key: 'd', label: 'Décision', render: (c) => <span className="small">{c.decisionRef} — {c.authority}</span> },
          ]} />
          {hasRole(user.roles, 'R01', 'R04') && (
            <div className="vc-form">
              {(['categories', 'communes', 'from', 'to', 'authority', 'decisionRef', 'reason'] as const).map((k) => (
                <label key={k}><span>{{ categories: 'Catégories (séparées par des virgules)', communes: 'Communes (séparées par des virgules)', from: 'Du (AAAA-MM-JJ)', to: 'Au (AAAA-MM-JJ)', authority: 'Autorité', decisionRef: 'Référence de la décision', reason: 'Motif' }[k]}</span>
                  <input value={court[k]} onChange={(e) => setCourt({ ...court, [k]: e.target.value })} /></label>
              ))}
              <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/vehicules/courtoisie', {
                ...court, categories: court.categories.split(',').map((x) => x.trim()).filter(Boolean), communes: court.communes.split(',').map((x) => x.trim()).filter(Boolean),
              }, 'Période de courtoisie décidée et journalisée.')}>Décider la période</button>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
