/**
 * Audit et investigation — module 46 : missions, échantillonnage reproductible, constats et recommandations suivies,
 * export scellé avec chaîne de possession, racine quotidienne, reconstitution d'une correction. Aucune modification.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { api, describeError } from '../../lib/api';
import { Section } from '../pilotage/shared';
import { Area, Choice, Field, hasRole } from '../pilotage/planif';
import { date, Ecran, Indicateurs, useRunner, useVue, type Indicator } from './commun';

interface Reco { id: string; text: string; ownerEntity: string; deadline: string; status: string }
interface Mission { id: string; title: string; objective: string; scope: string; status: string; createdBy: string; samples: { id: string; population: string; seed: string; items: string[]; populationSha256: string }[]; findings: { id: string; title: string; severity: string; recommendations: Reco[] }[] }
interface Vue {
  items: Mission[]; populations: Record<string, string>; indicators: Indicator[];
  integrity: { ok: boolean; length: number; headHash: string; note: string };
  dailyRoots: { available: boolean; roots: { day: string; partial: boolean; count: number; merkleRoot: string; timestamped: boolean; published: boolean }[]; lastCheck: { at: string; ok: boolean; findings: number } | null; link: string };
}

export default function AuditInvestigation() {
  const { user } = useApp();
  const q = useVue<Vue>('/v1/decision/audit/missions');
  const r = useRunner(q.reload);
  const auditor = hasRole(user?.roles, 'R22', 'R23');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [scope, setScope] = useState('');
  const [mission, setMission] = useState('');
  const [population, setPopulation] = useState('PAIEMENTS');
  const [size, setSize] = useState('10');
  const [seed, setSeed] = useState('');
  const [fTitle, setFTitle] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [motif, setMotif] = useState('');
  const [reco, setReco] = useState('');
  const [owner, setOwner] = useState('DGIPK');
  const [deadline, setDeadline] = useState('');
  const [ref, setRef] = useState('');
  const [correction, setCorrection] = useState<string | null>(null);
  async function reconstituer() {
    try {
      const c = await api<{ kind: string; events: { at: string; action: string }[] }>(`/v1/decision/audit/corrections/${encodeURIComponent(ref)}`);
      setCorrection(`${c.kind} : ${c.events.length} événement(s) — ${c.events.map((e) => `${e.at.slice(0, 16)} ${e.action}`).join(' ; ')}`);
    } catch (e) { setCorrection(describeError(e).message); }
  }
  return (
    <Ecran eyebrow="Pilotage et décision · module 46" title="Audit et investigation" lead="Lecture intégrale des preuves et journaux, échantillonnage, export scellé ; aucune modification possible." q={q} msg={r.msg}>
      {(d) => (<>
        <Section title="Indicateurs"><Indicateurs items={d.indicators} /></Section>
        <Section title="Intégrité et racine quotidienne" sub={d.integrity.note}>
          <StatusBadge tone={d.integrity.ok ? 'good' : 'critical'} label={d.integrity.ok ? `Chaîne intègre (${d.integrity.length} événements)` : 'Chaîne rompue'} />
          <DataTable caption="Racines quotidiennes" rows={d.dailyRoots.roots} rowKey={(x) => x.day} empty={<p className="muted">Aucune racine publiée.</p>} columns={[
            { key: 'd', label: 'Jour', primary: true, render: (x) => `${x.day}${x.partial ? ' (partielle)' : ''}` },
            { key: 'n', label: 'Événements', num: true, render: (x) => x.count },
            { key: 'm', label: 'Racine de Merkle', render: (x) => <span className="mono">{x.merkleRoot.slice(0, 16)}…</span> },
            { key: 't', label: 'Horodatée / publiée', render: (x) => `${x.timestamped ? 'oui' : 'non'} / ${x.published ? 'oui' : 'non'}` },
          ]} />
          <p className="small">{d.dailyRoots.lastCheck ? `Dernier contrôle : ${date(d.dailyRoots.lastCheck.at)} — ${d.dailyRoots.lastCheck.ok ? 'conforme' : `${d.dailyRoots.lastCheck.findings} constat(s)`}` : 'Aucun contrôle.'} <a href={d.dailyRoots.link}>Scellement du journal</a> · <a href="/pilotage/piste-audit">Piste d’audit par dossier</a> · <a href="/audit">Journal chaîné</a></p>
        </Section>
        {auditor && (
          <Section title="Nouvelle mission">
            <div className="form">
              <Field label="Intitulé" value={title} onChange={setTitle} />
              <Area label="Objectif" value={objective} onChange={setObjective} rows={2} />
              <Field label="Périmètre" value={scope} onChange={setScope} />
              <button type="button" className="btn btn-primary" disabled={r.busy || title.length < 5 || objective.length < 10} onClick={() => void r.run('/v1/decision/audit/missions', { title, objective, scope }, 'Mission créée.')}>Créer</button>
            </div>
          </Section>
        )}
        <Section title="Missions, échantillons, constats et recommandations">
          <DataTable caption="Missions" rows={d.items} rowKey={(m) => m.id} empty={<p className="muted">Aucune mission.</p>} columns={[
            { key: 'm', label: 'Mission', primary: true, render: (m) => <><strong>{m.id}</strong> — {m.title}<br /><span className="small muted">{m.objective}</span></> },
            { key: 's', label: 'Statut', render: (m) => m.status },
            { key: 'e', label: 'Échantillons', num: true, render: (m) => m.samples.map((x) => `${x.population} ×${x.items.length} (graine ${x.seed})`).join(' ; ') || '—' },
            { key: 'c', label: 'Constats / recommandations', render: (m) => m.findings.map((f) => `${f.title} [${f.severity}] — ${f.recommendations.map((x) => x.status).join(', ') || 'sans recommandation'}`).join(' ; ') || '—' },
            { key: 'a', label: 'Choisir', render: (m) => <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMission(m.id)}>{mission === m.id ? 'Choisie' : 'Choisir'}</button> },
          ]} />
          {auditor && mission && (
            <div className="form">
              <p className="small muted">Mission {mission} : tirage reproductible (même graine, même population ⇒ même échantillon).</p>
              <Choice label="Population" value={population} onChange={setPopulation} options={Object.entries(d.populations)} />
              <Field label="Taille" value={size} onChange={setSize} />
              <Field label="Graine publiée (facultative)" value={seed} onChange={setSeed} />
              <button type="button" className="btn btn-secondary" disabled={r.busy} onClick={() => void r.run(`/v1/decision/audit/missions/${mission}/echantillons`, { population, size: Number(size), ...(seed ? { seed } : {}) }, 'Échantillon tiré.')}>Tirer l’échantillon</button>
              <Field label="Constat — titre" value={fTitle} onChange={setFTitle} />
              <Area label="Constat — description" value={fDesc} onChange={setFDesc} rows={2} />
              <button type="button" className="btn btn-secondary" disabled={r.busy || fTitle.length < 5 || fDesc.length < 10} onClick={() => void r.run(`/v1/decision/audit/missions/${mission}/constats`, { title: fTitle, description: fDesc, severity: 'MOYENNE', evidence: [] }, 'Constat enregistré.')}>Enregistrer le constat</button>
              {(() => {
                const last = d.items.find((m) => m.id === mission)?.findings.at(-1);
                return last ? (
                  <>
                    <Field label={`Recommandation sur « ${last.title} »`} value={reco} onChange={setReco} />
                    <Field label="Service destinataire (entité)" value={owner} onChange={setOwner} />
                    <Field label="Échéance" type="date" value={deadline} onChange={setDeadline} />
                    <button type="button" className="btn btn-secondary" disabled={r.busy || reco.length < 10 || !deadline} onClick={() => void r.run(`/v1/decision/audit/missions/${mission}/constats/${last.id}/recommandations`, { text: reco, ownerEntity: owner, deadline }, 'Recommandation émise.')}>Émettre la recommandation</button>
                  </>
                ) : null;
              })()}
              <Field label="Motif (scellement, clôture)" value={motif} onChange={setMotif} />
              <div className="btn-row">
                <button type="button" className="btn btn-primary" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/decision/audit/missions/${mission}/scelle`, { motif }, 'Export scellé (empreinte, signature, chaîne de possession).')}>Export scellé</button>
                <button type="button" className="btn btn-ghost" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/decision/audit/missions/${mission}/cloture`, { motif }, 'Mission close.')}>Clore la mission</button>
              </div>
            </div>
          )}
        </Section>
        <Section title="Recommandations suivies" sub="Mise en œuvre déclarée par le service destinataire, vérifiée par une autre personne de l’audit.">
          <DataTable caption="Recommandations" rows={d.items.flatMap((m) => m.findings.flatMap((f) => f.recommendations.map((x) => ({ ...x, mission: m.id, finding: f.title }))))} rowKey={(x) => x.id} empty={<p className="muted">Aucune recommandation.</p>} columns={[
            { key: 't', label: 'Recommandation', primary: true, render: (x) => `${x.text} (${x.mission} — ${x.finding})` },
            { key: 'o', label: 'Service / échéance', render: (x) => `${x.ownerEntity} — ${x.deadline}` },
            { key: 's', label: 'Statut', render: (x) => x.status },
            { key: 'a', label: 'Suivi', render: (x) => (
              <div className="btn-row">
                {user?.entity === x.ownerEntity && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/decision/audit/recommandations/${x.id}/suivi`, { status: 'MISE_EN_OEUVRE_DECLAREE', note: 'Mise en œuvre déclarée par le service' }, 'Mise en œuvre déclarée.')}>Déclarer la mise en œuvre</button>}
                {auditor && x.status === 'MISE_EN_OEUVRE_DECLAREE' && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/decision/audit/recommandations/${x.id}/suivi`, { status: 'MISE_EN_OEUVRE_VERIFIEE', note: 'Vérifiée sur pièces' }, 'Mise en œuvre vérifiée.')}>Vérifier</button>}
              </div>
            ) },
          ]} />
        </Section>
        <Section title="Reconstituer une correction" sub="Original, contre-écriture, motif, approbateurs.">
          <div className="form">
            <Field label="Référence (obligation, écriture, paiement)" value={ref} onChange={setRef} />
            <button type="button" className="btn btn-secondary" disabled={!ref} onClick={() => void reconstituer()}>Reconstituer</button>
            {correction && <p className="small" role="status">{correction}</p>}
          </div>
        </Section>
      </>)}
    </Ecran>
  );
}
