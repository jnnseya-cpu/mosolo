/**
 * Règlement en trésorerie (spécification fonctionnelle, module 29) : import des relevés des banques et des opérateurs à
 * DOUBLE VALIDATION. Le dépôt (fichier avec totaux de contrôle, ou saisie) n'écrit rien ; le contrôle d'intégrité est
 * affiché ; une seconde personne habilitée, distincte du déposant, valide ou rejette avec motif. Indicateurs du module :
 * délai de règlement et fonds en attente.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { ImportsParEtat } from './visuels';
import { api } from '../../lib/api';
import { hasRole, Message, shortHash, useAction } from './shared';
import './tresor.css';

export interface IntegrityCheck { code: string; ok: boolean; blocking: boolean; detail: string }
export interface StatementImport {
  id: string; statementId: string; fingerprint: string; lines: unknown[] | number;
  status: 'EN_ATTENTE_VALIDATION' | 'INTEGRITE_KO' | 'VALIDE' | 'REJETE';
  integrity: { ok: boolean; checks: IntegrityCheck[]; totals: MoneyJSON[] };
  source?: { kind: string; institution: string; fileName: string; fileSha256: string; period: { from: string; to: string }; declared: { lines: number; totals: MoneyJSON[] } };
  proposedBy: string; proposedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
  result?: { matched: number; exceptions: number; settledUnapplied: number; claimed: number };
}
export interface RelevesIndicators {
  delaiReglement: { statut: 'MESURE'; medianeHeures: number; paiements: number } | { statut: 'NON_MESURE'; motif: string };
  imports: { enAttente: number; valides: number; rejetes: number; integriteKo: number };
}
export interface SuspenseSummary { open: number; totals: MoneyJSON[] }

const STATUS: Record<StatementImport['status'], { label: string; tone: Tone }> = {
  EN_ATTENTE_VALIDATION: { label: 'En attente de seconde validation', tone: 'warning' },
  INTEGRITE_KO: { label: 'Intégrité en échec', tone: 'critical' },
  VALIDE: { label: 'Validé et appliqué', tone: 'good' },
  REJETE: { label: 'Rejeté', tone: 'neutral' },
};
const money = (m: MoneyJSON) => `${m.amount} ${m.currency}`;
const count = (l: unknown[] | number) => (typeof l === 'number' ? l : l.length);

export function ImportsRelevesView({ imports, indicators, suspense, userId, canPropose, canValidate, onChanged }: {
  imports: StatementImport[]; indicators: RelevesIndicators | null; suspense: SuspenseSummary | null; userId: string;
  canPropose: boolean; canValidate: boolean; onChanged: () => void;
}) {
  const { busy, msg, run } = useAction();
  const [motif, setMotif] = useState<Record<string, string>>({});
  const [f, setF] = useState({ statementId: '', source: 'BANQUE', institution: '', periodFrom: '', periodTo: '', fileName: '', fileContent: '', lines: '', amount: '', currency: 'USD' });
  async function readFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setF((p) => ({ ...p, fileName: file.name, fileContent: text }));
  }
  const d = indicators?.delaiReglement;
  return (
    <>
      <section className="panel" aria-labelledby="rel-ind">
        <h2 className="panel-title" id="rel-ind">Indicateurs du règlement en trésorerie</h2>
        <div className="kpi-row">
          <div className="kpi"><p className="kpi-label">Délai de règlement (médiane)</p>
            <p className="kpi-value">{d ? (d.statut === 'MESURE' ? `${d.medianeHeures} h` : 'Non mesuré') : '—'}</p>
            <p className="small muted">{d ? (d.statut === 'MESURE' ? `Confirmation → règlement, ${d.paiements} paiement(s)` : d.motif) : ''}</p></div>
          <div className="kpi"><p className="kpi-label">Fonds en attente (compte d’attente)</p>
            <p className="kpi-value">{suspense ? (suspense.totals.length ? suspense.totals.map(money).join(' · ') : '0') : '—'}</p>
            <p className="small muted">{suspense ? `${suspense.open} suspens ouvert(s)` : ''}</p></div>
          <div className="kpi"><p className="kpi-label">Imports à valider</p><p className="kpi-value">{indicators?.imports.enAttente ?? '—'}</p>
            <p className="small muted">{indicators ? `${indicators.imports.valides} validé(s), ${indicators.imports.rejetes} rejeté(s), ${indicators.imports.integriteKo} en échec d’intégrité` : ''}</p></div>
        </div>
        <ImportsParEtat imports={imports} framed={false} />
      </section>
      <Message msg={msg} />
      {canPropose && (
        <section className="panel" aria-labelledby="rel-depot">
          <h2 className="panel-title" id="rel-depot">Déposer un fichier de relevé (banque ou opérateur)</h2>
          <p className="small muted">Colonnes : compte ; montant ; devise ; date de valeur ; référence ; contrepartie (facultatif). Le dépôt n’écrit rien : empreinte, totaux de contrôle et période sont vérifiés, puis une autre personne valide.</p>
          <div className="field-row">
            <label className="field"><span className="label">Identifiant du relevé</span><input value={f.statementId} onChange={(e) => setF({ ...f, statementId: e.target.value })} /></label>
            <label className="field"><span className="label">Source</span>
              <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="BANQUE">Banque</option><option value="OPERATEUR">Opérateur de monnaie mobile</option></select></label>
            <label className="field"><span className="label">Établissement</span><input value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} /></label>
          </div>
          <div className="field-row">
            <label className="field"><span className="label">Période du</span><input type="date" value={f.periodFrom} onChange={(e) => setF({ ...f, periodFrom: e.target.value })} /></label>
            <label className="field"><span className="label">au</span><input type="date" value={f.periodTo} onChange={(e) => setF({ ...f, periodTo: e.target.value })} /></label>
            <label className="field"><span className="label">Fichier</span><input type="file" accept=".csv,.txt" onChange={(e) => void readFile(e.target.files?.[0])} /></label>
          </div>
          <label className="field"><span className="label">Contenu du fichier</span><textarea rows={3} value={f.fileContent} onChange={(e) => setF({ ...f, fileContent: e.target.value, fileName: f.fileName || 'saisie.csv' })} /></label>
          <div className="field-row">
            <label className="field"><span className="label">Lignes déclarées par l’établissement</span><input inputMode="numeric" value={f.lines} onChange={(e) => setF({ ...f, lines: e.target.value })} /></label>
            <label className="field"><span className="label">Total de contrôle déclaré</span><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(',', '.') })} /></label>
            <label className="field"><span className="label">Devise</span><select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>USD</option><option>CDF</option></select></label>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || !f.statementId || !f.fileContent || !f.periodFrom || !f.periodTo || f.institution.trim().length < 2}
            onClick={() => void run('/v1/tresor/releves/depots', {
              statementId: f.statementId, source: f.source, institution: f.institution, periodFrom: f.periodFrom, periodTo: f.periodTo, fileName: f.fileName || 'saisie.csv', fileContent: f.fileContent,
              declared: { lines: Number.parseInt(f.lines || '0', 10), totals: f.amount ? [{ amount: f.amount, currency: f.currency }] : [] },
            }, 'Relevé déposé : contrôle d’intégrité calculé, en attente de seconde validation.', onChanged)}>Déposer le relevé</button>
        </section>
      )}
      <section className="panel" aria-labelledby="rel-list">
        <h2 className="panel-title" id="rel-list">Imports proposés et décisions</h2>
        {imports.length === 0 ? <EmptyState title="Aucun import proposé" icon="check" /> : (
          <ul className="list-rows">
            {imports.map((i) => {
              const mine = i.proposedBy === userId;
              return (
                <li key={i.id} className="list-row list-row-stack">
                  <div className="row-between"><span className="row-title">{i.statementId} <span className="mono small muted">{i.id}</span></span><StatusBadge tone={STATUS[i.status].tone} label={STATUS[i.status].label} /></div>
                  <p className="small">{count(i.lines)} ligne(s) · totaux {i.integrity.totals.map(money).join(', ') || '—'} · empreinte <span className="mono">{shortHash(i.fingerprint)}</span> · proposé par {i.proposedBy}
                    {i.source ? ` · fichier ${i.source.fileName} (${i.source.institution}, ${i.source.period.from} → ${i.source.period.to})` : ''}</p>
                  <ul className="plain-list small">
                    {i.integrity.checks.map((c) => <li key={c.code}>{c.ok ? '✔' : c.blocking ? '✖' : '⚠'} <strong>{c.code}</strong> — {c.detail}</li>)}
                  </ul>
                  {i.decision && <p className="small">{i.decision.approve ? 'Validé' : 'Rejeté'} par {i.decision.by} — {i.decision.motif}{i.result ? ` · ${i.result.matched} rapproché(s), ${i.result.exceptions} exception(s)` : ''}</p>}
                  {canValidate && i.status === 'EN_ATTENTE_VALIDATION' && (mine ? <p className="small muted">Vous avez proposé cet import : une autre personne doit le valider.</p> : (
                    <div className="row-between">
                      <input aria-label={`Motif de la décision ${i.statementId}`} placeholder="Motif (5 caractères au moins)" value={motif[i.id] ?? ''} onChange={(e) => setMotif({ ...motif, [i.id]: e.target.value })} />
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy || (motif[i.id] ?? '').trim().length < 5}
                        onClick={() => void run(`/v1/settlements/statements/${encodeURIComponent(i.statementId)}/validation`, { approve: true, motif: motif[i.id] }, 'Relevé validé et appliqué.', onChanged)}>Valider et appliquer</button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (motif[i.id] ?? '').trim().length < 5}
                        onClick={() => void run(`/v1/settlements/statements/${encodeURIComponent(i.statementId)}/validation`, { approve: false, motif: motif[i.id] }, 'Import rejeté.', onChanged)}>Rejeter</button>
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

/** Panneau intégré à la page Trésor. */
export function ImportsRelevesPanel({ onChanged }: { onChanged?: () => void }) {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, 'R17', 'R18', 'R22', 'R23');
  const list = useApi(allowed ? () => api<StatementImport[]>('/v1/settlements/imports') : null, [user?.id]);
  const ind = useApi(allowed ? () => api<RelevesIndicators>('/v1/tresor/releves/indicateurs') : null, [user?.id]);
  const susp = useApi(allowed ? () => api<SuspenseSummary>('/v1/tresor/suspense') : null, [user?.id]);
  if (!allowed) return null;
  const reload = () => { list.reload(); ind.reload(); susp.reload(); onChanged?.(); };
  return (
    <>
      {list.loading && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && <ImportsRelevesView imports={list.data} indicators={ind.data} suspense={susp.data} userId={user?.id ?? ''}
        canPropose={hasRole(user?.roles, 'R17', 'R18')} canValidate={hasRole(user?.roles, 'R17', 'R18')} onChanged={reload} />}
    </>
  );
}

export default function ImportsReleves() {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, 'R17', 'R18', 'R22', 'R23');
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Trésor" title="Relevés bancaires et d’opérateurs (double validation)" lead="Le dépôt n’écrit rien ; l’intégrité est contrôlée ; une seconde personne valide avant tout règlement, appariement ou suspens." />
      {!allowed ? <EmptyState title="Accès réservé" icon="lock">Réservé au Trésor, au rapprochement et à l’audit.</EmptyState> : <ImportsRelevesPanel />}
    </div>
  );
}
