/**
 * Circuit des instructions du Gouverneur et du cabinet (§ 26.1–26.2) : instruction → service désigné → échéance →
 * rapport → clôture par l'autorité (preuve de clôture). Chaque étape est journalisée ; le destinataire ne clôt jamais.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from './shared';
import { Area, Choice, Field, hasRole, Notice, useRunner } from './planif';
import './pilotage.css';
import { BarChartViz, DonutViz, fmtNombre, KpiTile, StatusDistribution, TimelineStrip } from '../../components/viz';
import { etatsDe, lignesCompte, Tuiles, Visuels } from './visuels';
// Parcours par rôle (29/09/2026) : un écran vide propose la prochaine action utile du travail du jour.
import { SuiteDuTravail } from '../../components/SuiteDuTravail';
import { ChoixEntite, ChoixRole } from '../../components/Choix';

export interface InstructionRow {
  id: string; number: string; authority: string; origin: string; originLabel: string; subject: string; body: string; deadline: string; status: string; overdue: boolean; daysLeft: number;
  assignee: { entity: string; role?: string; userId?: string }; issuedBy: string; reports: { by: string; at: string; text: string }[]; closure?: { onTime: boolean; motif: string };
}
export const INSTR_STATUS: Record<string, { label: string; tone: Tone }> = {
  EMISE: { label: 'Émise', tone: 'info' }, ACCUSEE: { label: 'En cours', tone: 'warning' }, RAPPORT_DEPOSE: { label: 'Rapport déposé', tone: 'info' }, CLOSE: { label: 'Close', tone: 'good' },
};

/** Actions possibles (aide d'interface ; le serveur décide). */
export function instructionActions(i: InstructionRow, user: { id: string; roles: string[]; entity?: string } | null) {
  const issuer = hasRole(user?.roles, 'R01', 'R02', 'R03');
  const assignee = i.assignee.userId ? i.assignee.userId === user?.id : user?.entity === i.assignee.entity && (!i.assignee.role || !!user?.roles.includes(i.assignee.role));
  return {
    acknowledge: assignee && i.status === 'EMISE',
    report: assignee && i.status !== 'CLOSE',
    close: issuer && !assignee && i.status === 'RAPPORT_DEPOSE',
  };
}

/** Visuels du circuit des instructions : statuts, échéances, origines, services destinataires. */
export function VisuelsInstructions({ items, origins }: { items: InstructionRow[]; origins: Record<string, string> }) {
  const entier = (v: number) => fmtNombre(v, 0);
  const closes = items.filter((i) => i.closure);
  return (
    <>
      <Tuiles label="Instructions — synthèse" max={4}>
        <KpiTile hero label="Instructions" value={items.length} format={entier} state={{ label: `${items.filter((i) => i.status !== 'CLOSE').length} en cours`, tone: 'info' }} />
        <KpiTile label="En retard" value={items.filter((i) => i.overdue && i.status !== 'CLOSE').length} format={entier} state={{ label: 'Échéance dépassée', tone: items.some((i) => i.overdue && i.status !== 'CLOSE') ? 'critical' : 'good' }} />
        <KpiTile label="Closes dans le délai" value={closes.filter((i) => i.closure?.onTime).length} format={entier} unit={`/ ${closes.length}`} state={{ label: 'Preuve de clôture', tone: 'good' }} />
        <KpiTile label="Rapports déposés" value={items.reduce((s, i) => s + i.reports.length, 0)} format={entier} state={{ label: 'Service destinataire', tone: 'neutral' }} />
      </Tuiles>
      <Visuels label="Instructions en graphiques">
        <StatusDistribution title="Instructions par statut" unitLabel="instructions" emptyText="Aucune instruction" items={etatsDe(items, (i) => i.status, INSTR_STATUS)} />
        <DonutViz title="Instructions par bloc d’origine" centerLabel="instructions" emptyText="Aucune instruction"
          slices={lignesCompte(items, (i) => i.origin).map((r) => ({ key: r.key, label: (origins[r.key] ?? r.key).split(' — ')[0]!, value: r.values.n }))} />
        <TimelineStrip className="viz-span-2" title="Échéances des instructions" categories={['En retard', 'À échéance', 'Close']} emptyText="Aucune instruction"
          events={items.map((i) => ({ id: i.id, at: i.deadline, category: i.status === 'CLOSE' ? 'Close' : i.overdue ? 'En retard' : 'À échéance', label: `${i.number} — ${i.subject}` }))} />
        <BarChartViz title="Par service destinataire" orientation="horizontal" format={entier} emptyText="Aucune instruction" series={[{ key: 'n', label: 'Instructions' }]} rows={lignesCompte(items, (i) => i.assignee.entity)} />
      </Visuels>
    </>
  );
}

export default function Instructions() {
  const { user } = useApp();
  const q = useApi(() => api<{ items: InstructionRow[]; origins: Record<string, string> }>('/v1/pilotage/instructions'), [user?.id]);
  const r = useRunner(q.reload);
  const [text, setText] = useState('');
  const [form, setForm] = useState({ origin: 'COMMUNE', subject: '', body: '', entity: 'DGIPK', role: '', deadline: '' });
  // Conversion justifiée : lecture du champ facultatif `entity` de la session (absent du type commun de l'utilisateur).
  const u = user as unknown as { id: string; roles: string[]; entity?: string } | null;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 26.1–26.2" title="Instructions et suivi" lead="Chaque instruction a un service destinataire, une échéance, un rapport et une clôture motivée par l’autorité ; le suivi alimente le tableau du cabinet." />
      <div className="dash-grid">
        {q.data && <VisuelsInstructions items={q.data.items} origins={q.data.origins} />}
        <Section title="Instructions" sub="Visibles de l’autorité, de l’audit et du service destinataire">
          <Notice msg={r.msg} />
          {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : (
            <DataTable caption="Instructions" rows={q.data?.items ?? []} rowKey={(i) => i.id} empty={<EmptyState title="Aucune instruction" icon="check"><SuiteDuTravail /></EmptyState>} columns={[
              { key: 'n', label: 'Instruction', primary: true, render: (i) => <><strong>{i.number} — {i.subject}</strong><span className="small muted" style={{ display: 'block' }}>{i.authority} · {i.originLabel}</span></> },
              { key: 'd', label: 'Destinataire', render: (i) => `${i.assignee.entity}${i.assignee.role ? ` (${i.assignee.role})` : ''}` },
              { key: 'e', label: 'Échéance', render: (i) => <>{i.deadline}{i.overdue && <StatusBadge tone="critical" label="En retard" />}</> },
              { key: 's', label: 'Statut', render: (i) => <StatusBadge tone={INSTR_STATUS[i.status]?.tone ?? 'neutral'} label={INSTR_STATUS[i.status]?.label ?? i.status} /> },
              { key: 'a', label: 'Actions', render: (i) => {
                const a = instructionActions(i, u);
                return (
                  <div className="btn-row">
                    {a.acknowledge && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/instructions/${i.id}/accuse`, {}, 'Réception accusée.')}>Accuser réception</button>}
                    {a.report && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || text.trim().length < 10} onClick={() => void r.run(`/v1/pilotage/instructions/${i.id}/rapport`, { text }, 'Rapport déposé.')}>Déposer le rapport</button>}
                    {a.close && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || text.trim().length < 10} onClick={() => void r.run(`/v1/pilotage/instructions/${i.id}/cloture`, { motif: text }, 'Instruction close.')}>Clore</button>}
                    {i.closure && <span className="small muted">{i.closure.onTime ? 'Close dans le délai' : 'Close hors délai'}</span>}
                  </div>
                );
              } },
            ]} />
          )}
          <Area label="Rapport ou motif de clôture (10 caractères minimum)" rows={2} value={text} onChange={setText} />
        </Section>
        {hasRole(user?.roles, 'R01', 'R02', 'R03') && (
          <Section title="Nouvelle instruction" sub="Issue d’un bloc du tableau de bord (§ 26.1) : interpeller, demander un plan d’action, lancer une campagne, saisir l’audit…">
            <div className="form">
              <Choice label="Bloc d’origine" value={form.origin} onChange={(v) => setForm({ ...form, origin: v })} options={Object.entries(q.data?.origins ?? { COMMUNE: 'Par commune' })} />
              <Field label="Objet" value={form.subject} onChange={(v) => setForm({ ...form, subject: v })} />
              <Area label="Instruction" value={form.body} onChange={(v) => setForm({ ...form, body: v })} />
              <ChoixEntite label="Entité destinataire" value={form.entity} onChange={(v) => setForm({ ...form, entity: v })} />
              <ChoixRole label="Rôle destinataire (facultatif)" facultatif value={form.role} onChange={(v) => setForm({ ...form, role: v })} />
              <Field label="Échéance" type="date" value={form.deadline} onChange={(v) => setForm({ ...form, deadline: v })} />
              <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/instructions', { origin: form.origin, subject: form.subject, body: form.body, assignee: { entity: form.entity, ...(form.role ? { role: form.role } : {}) }, deadline: form.deadline }, 'Instruction émise.')}>Émettre</button></div>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
