/**
 * Registre des décisions du Gouvernement provincial (Document maître FR 2, ch. 48) : dix décisions citées mot pour
 * mot, statut (à prendre, prise, refusée), acte (référence, date, empreinte), enregistrement par une personne et
 * validation par une autre ; ce que chaque décision débloque, avec l'état CALCULÉ des verrous de la plateforme
 * (jamais forcé par la décision) ; contradiction signalée au maître d'ouvrage ; synthèse finale (48.2).
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from './shared';
import { Area, Callout, Choice, Field, hasRole, Notice, useRunner } from './planif';
import type { Decision, RegistreDecisions } from './programme-types';
import './pilotage.css';
import { fmtNombre, KpiTile, StatusDistribution } from '../../components/viz';
import { etatsDe, STATUTS_DECISION, Tuiles, Visuels } from './visuels';

/** États calculés de ce que débloque chaque décision (codes du serveur, libellés français). */
const DEBLOQUE: Record<string, { label: string; tone: 'good' | 'warning' | 'neutral' }> = {
  CONSTRUIT: { label: 'Construit', tone: 'good' }, GARDE_ACTIVE: { label: 'Garde active', tone: 'good' }, CIBLE_TENUE: { label: 'Cible tenue', tone: 'good' },
  EN_ATTENTE: { label: 'En attente de la décision', tone: 'warning' }, ACTE_REQUIS: { label: 'Acte requis', tone: 'warning' },
  INCHANGE: { label: 'Inchangé', tone: 'neutral' }, SANS_EFFET_TECHNIQUE: { label: 'Sans effet technique', tone: 'neutral' },
};

/** Visuels des dix décisions : statut, validations attendues, contradictions signalées. */
export function VisuelsDecisions({ reg }: { reg: RegistreDecisions }) {
  const debloques = reg.items.flatMap((d) => d.debloque);
  return (
    <>
      <Tuiles label="Décisions du Gouvernement — synthèse" max={4}>
        <KpiTile hero label="Décisions prises" value={reg.compte.PRISE} format={(v) => fmtNombre(v, 0)} unit={`/ ${reg.items.length}`} target={{ value: reg.items.length, label: 'dix décisions (48.1)', max: reg.items.length }} state={{ label: 'Acte enregistré et validé', tone: 'good' }} />
        <KpiTile label="À valider (seconde personne)" value={reg.compte.aValider} format={(v) => fmtNombre(v, 0)} state={{ label: 'Quatre yeux', tone: 'warning' }} />
        <KpiTile label="Refusées" value={reg.compte.REFUSEE} format={(v) => fmtNombre(v, 0)} state={{ label: 'Refus motivé', tone: 'neutral' }} />
        <KpiTile label="Contradictions signalées" value={reg.contradictions.length} format={(v) => fmtNombre(v, 0)} state={{ label: 'Arbitrage du maître d’ouvrage', tone: reg.contradictions.length ? 'warning' : 'good' }} />
      </Tuiles>
      <Visuels label="Décisions en graphiques">
        <StatusDistribution title="Décisions par statut" unitLabel="décisions" items={etatsDe(reg.items, (d) => d.statut, STATUTS_DECISION)} />
        <StatusDistribution title="Contrôles débloqués par les décisions" unitLabel="contrôles" emptyText="Aucun contrôle rattaché"
          items={etatsDe(debloques, (x) => x.etat, DEBLOQUE)} />
      </Visuels>
    </>
  );
}

const STATUT_TONE: Record<string, 'good' | 'critical' | 'neutral'> = { A_PRENDRE: 'neutral', PRISE: 'good', REFUSEE: 'critical' };

/** Aide d'interface (le serveur reste juge) : qui peut enregistrer, qui peut valider. */
export function decisionActions(d: Decision, user: { id: string; roles: string[] } | null) {
  return {
    enregistrer: d.statut === 'A_PRENDRE' && !d.enAttente && hasRole(user?.roles, 'R02', 'R03', 'R05'),
    valider: !!d.enAttente && d.enAttente.par !== user?.id && hasRole(user?.roles, 'R01', 'R03', 'R05'),
  };
}

function RecordForm({ d, onDone }: { d: Decision; onDone: () => void }) {
  const r = useRunner(onDone);
  const [f, setF] = useState({ statut: 'PRISE', reference: '', titre: '', date: '', sha256: '', motif: '' });
  const body = { statut: f.statut, motif: f.motif, ...(f.statut === 'PRISE' ? { acte: { reference: f.reference, titre: f.titre, date: f.date, sha256: f.sha256 } } : {}) };
  return (
    <div className="form">
      <Notice msg={r.msg} />
      <Choice label={`Décision n° ${d.numero}`} value={f.statut} onChange={(x) => setF({ ...f, statut: x })} options={[['PRISE', 'Prise (acte requis)'], ['REFUSEE', 'Refusée']]} />
      {f.statut === 'PRISE' && <>
        <Field label="Référence de l’acte" value={f.reference} onChange={(x) => setF({ ...f, reference: x })} />
        <Field label="Intitulé de l’acte" value={f.titre} onChange={(x) => setF({ ...f, titre: x })} />
        <Field label="Date de l’acte" type="date" value={f.date} onChange={(x) => setF({ ...f, date: x })} />
        <Field label="Empreinte SHA-256 de l’acte" value={f.sha256} onChange={(x) => setF({ ...f, sha256: x })} />
      </>}
      <Area label="Motif (10 caractères minimum)" value={f.motif} onChange={(x) => setF({ ...f, motif: x })} rows={2} />
      <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/programme/decisions/${d.numero}/enregistrement`, body, 'Décision enregistrée : validation par une autre personne attendue.')}>Enregistrer</button></div>
    </div>
  );
}

function ValidateForm({ d, onDone }: { d: Decision; onDone: () => void }) {
  const r = useRunner(onDone);
  const [motif, setMotif] = useState('');
  return (
    <div className="form">
      <Notice msg={r.msg} />
      <p className="small">Enregistrée par {d.enAttente!.par} le {d.enAttente!.le.slice(0, 10)} : {d.enAttente!.statut === 'PRISE' ? `prise — acte ${d.enAttente!.acte?.reference}` : 'refusée'}.</p>
      <Area label="Motif de la validation ou du rejet (10 caractères minimum)" value={motif} onChange={setMotif} rows={2} />
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/programme/decisions/${d.numero}/validation`, { approve: true, motif }, 'Décision validée.')}>Valider</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/programme/decisions/${d.numero}/validation`, { approve: false, motif }, 'Enregistrement rejeté.')}>Rejeter</button>
      </div>
    </div>
  );
}

export function DecisionsView({ reg, onDone }: { reg: RegistreDecisions; onDone: () => void }) {
  const { user } = useApp();
  const [open, setOpen] = useState<number | null>(null);
  const sel = reg.items.find((d) => d.numero === open) ?? null;
  const acts = sel ? decisionActions(sel, user) : null;
  return (
    <div className="dash-grid">
      <VisuelsDecisions reg={reg} />
      <Section title="Dix décisions immédiates (48.1)" sub={`${reg.compte.A_PRENDRE} à prendre · ${reg.compte.PRISE} prise(s) · ${reg.compte.REFUSEE} refusée(s) · ${reg.compte.aValider} à valider`}>
        {reg.contradictions.map((c) => <Callout key={c.numero} tone="warn"><strong>Décision {c.numero} — {c.texte}.</strong> Contradiction avec {c.avec}. {c.comportement}</Callout>)}
        <DataTable caption="Registre des décisions du Gouvernement provincial" rows={reg.items} rowKey={(d) => d.id} columns={[
          { key: 'd', label: 'Décision', primary: true, render: (d) => <><strong>{d.numero}.</strong> {d.decision}</> },
          { key: 's', label: 'Statut', render: (d) => <><StatusBadge tone={STATUT_TONE[d.statut] ?? 'neutral'} label={d.statutLibelle} />{d.enAttente && <StatusBadge tone="warning" label="Validation attendue" />}{d.acte && <span className="small" style={{ display: 'block' }}>Acte {d.acte.reference} · <code className="hash">{d.acte.sha256.slice(0, 12)}…</code></span>}</> },
          { key: 'u', label: 'Ce qu’elle débloque (état calculé)', full: true, render: (d) => <ul className="small">{d.debloque.map((l) => <li key={l.controle}><strong>{DEBLOQUE[l.etat]?.label ?? l.etat}</strong> — {l.libelle}. {l.detail}</li>)}</ul> },
          { key: 'a', label: 'Détail', render: (d) => <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open === d.numero} onClick={() => setOpen(open === d.numero ? null : d.numero)}>{open === d.numero ? 'Replier' : 'Ouvrir'}</button> },
        ]} />
        {sel && acts && (
          <div>
            {acts.enregistrer && <RecordForm key={`r-${sel.numero}`} d={sel} onDone={onDone} />}
            {acts.valider && <ValidateForm key={`v-${sel.numero}`} d={sel} onDone={onDone} />}
            {!acts.enregistrer && !acts.valider && <p className="small muted">{sel.enAttente && sel.enAttente.par === user?.id ? 'Vous avez enregistré cette décision : une autre personne la valide.' : 'Lecture seule pour votre rôle ou décision close.'}</p>}
            {sel.historique.length > 0 && <ul className="small">{sel.historique.map((h) => <li key={`${h.at}-${h.action}`}>{h.at.slice(0, 10)} · {h.by} · {h.action} — {h.texte}</li>)}</ul>}
          </div>
        )}
        <p className="small muted">{reg.regle}</p>
      </Section>
      <Section title="Synthèse finale (48.2)" sub={reg.devise}>
        <DataTable caption="Synthèse finale" rows={reg.synthese} rowKey={(s) => s.objet} columns={[
          { key: 'o', label: 'Objet', primary: true, render: (s) => <strong>{s.objet}</strong> },
          { key: 'p', label: 'Position recommandée', full: true, render: (s) => s.position },
        ]} />
      </Section>
    </div>
  );
}

export default function Decisions() {
  const { user } = useApp();
  const q = useApi(() => api<RegistreDecisions>('/v1/pilotage/programme/decisions'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Programme · ch. 48" title="Décisions requises du Gouvernement provincial" lead="Dix décisions, leur acte, leur enregistrement par une personne et leur validation par une autre ; ce que chacune débloque dans la plateforme." />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && <DecisionsView reg={q.data} onDone={q.reload} />}
    </div>
  );
}
