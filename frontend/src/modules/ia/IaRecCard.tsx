import { useState } from 'react';
import { useApp } from '../../context';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { api, describeError } from '../../lib/api';
import {
  ACTION_STATUS_LABEL, ACTION_STATUS_TONE, AUTONOMY_HELP, AUTONOMY_SHORT, CONF_LABEL, CONF_TONE, DOMAIN_LABEL, EFFECT_LABEL, STATUS_LABEL, STATUS_TONE, latency,
} from './labels';
import type { IaRec } from './types';
import { useSecureDraft } from './useSecureDraft';

const FIELDS: [keyof IaRec, string][] = [
  ['situation', '1. Situation'], ['insight', '2. Analyse'], ['risk', '3. Risque'], ['recommendation', '4. Recommandation'],
  ['nextAction', '5. Prochaine action'], ['owner', '6. Responsable'], ['deadline', '7. Échéance'],
];

/** Recommandation d'un agent : format standard, actions par niveau, validation (B), décision (C), annulation. */
export default function IaRecCard({ rec, onChange }: { rec: IaRec; onChange: (r: IaRec) => void }) {
  const { fmtDate, user } = useApp();
  const draft = useSecureDraft(`ia-motif:${rec.id}`, user?.id);
  const [modification, setModification] = useState('');
  const [mode, setMode] = useState<'none' | 'modify'>('none');
  const [undoFor, setUndoFor] = useState<string | null>(null);
  const [undoReason, setUndoReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(rec.status === 'EMISE');

  const pending = rec.actions.filter((a) => a.status === 'PROPOSEE' || a.status === 'NON_EXECUTEE_DESACTIVEE');
  const decidable = rec.canDecide && (rec.status === 'EMISE' || rec.status === 'TRAITEE_AUTO');
  const pendingB = pending.some((a) => a.level === 'B');

  async function call(path: string, body: unknown, ok: string) {
    setBusy(true); setMsg(null);
    try {
      const out = await api<IaRec>(path, { method: 'POST', body });
      onChange(out);
      draft.clear();
      setMsg({ ok: true, text: ok });
      setMode('none'); setUndoFor(null); setUndoReason('');
    } catch (e) {
      setMsg({ ok: false, text: describeError(e).message });
    } finally { setBusy(false); }
  }
  const reason = draft.value.trim();
  const needReason = () => { if (reason.length < 3) { setMsg({ ok: false, text: 'Indiquez un motif (3 caractères au moins).' }); return false; } return true; };

  return (
    <article className={`panel ia-rec ia-level-${AUTONOMY_SHORT[rec.autonomy]}`} aria-labelledby={`iar-${rec.id}`}>
      <header className="ia-rec-head">
        <div className="ia-rec-title">
          <span className={`ia-level ia-level-chip-${AUTONOMY_SHORT[rec.autonomy]}`} title={AUTONOMY_HELP[rec.autonomy]}>Niveau {AUTONOMY_SHORT[rec.autonomy]}</span>
          <div>
            <h3 id={`iar-${rec.id}`}>{rec.agent}</h3>
            <p className="small muted">{rec.crossAgents.join(' · ')} — {rec.entity} — {fmtDate(rec.createdAt, true)}</p>
          </div>
        </div>
        <div className="ia-rec-tools">
          {rec.example && <span className="ribbon">Exemple</span>}
          <StatusBadge tone={STATUS_TONE[rec.status]} label={STATUS_LABEL[rec.status]} />
          <StatusBadge tone={CONF_TONE[rec.confidence]} label={`Confiance ${CONF_LABEL[rec.confidence].toLowerCase()}`} />
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} /> {open ? 'Réduire' : 'Détails'}
          </button>
        </div>
      </header>
      <p className="ia-rec-lead">{rec.recommendation}</p>

      {open && (
        <>
          <dl className="ai-fields">
            {FIELDS.map(([k, label]) => (
              <div className="ai-field" key={k}><dt>{label}</dt><dd className="ia-pre">{String(rec[k] ?? '—')}</dd></div>
            ))}
            <div className="ai-field"><dt>8. Niveau de confiance</dt><dd><StatusBadge tone={CONF_TONE[rec.confidence]} label={CONF_LABEL[rec.confidence]} /> <span className="small muted">— sources : {rec.sources.join(' ; ')}</span></dd></div>
          </dl>

          {rec.factors && rec.factors.length > 0 && (
            <div className="ia-factors">
              <h4 className="eyebrow">Facteurs contributifs (score indicatif, non opposable)</h4>
              <ul>
                {rec.factors.map((f) => (
                  <li key={f.label}><span>{f.label}</span><span className="ia-bar" aria-hidden="true"><span style={{ width: `${Math.round(Number.parseFloat(f.weight) * 200)}%` }} /></span><span className="num">+{f.weight.replace('.', ',')}</span></li>
                ))}
              </ul>
            </div>
          )}

          {rec.decision && (
            <div className="ai-decision">
              <h4 className="eyebrow">Aide à la décision</h4>
              <dl className="kv kv-dense">
                <div><dt>Meilleure option</dt><dd>{rec.decision.bestOption}</dd></div>
                <div><dt>Option alternative</dt><dd>{rec.decision.alternativeOption}</dd></div>
                <div><dt>Risque de l’inaction</dt><dd>{rec.decision.riskOfInaction}</dd></div>
                <div><dt>Impact financier</dt><dd>{rec.decision.financialImpact}</dd></div>
                <div><dt>Impact opérationnel</dt><dd>{rec.decision.operationalImpact}</dd></div>
                {rec.recommendedStep && <div><dt>Étape recommandée</dt><dd>{rec.recommendedStep}</dd></div>}
              </dl>
            </div>
          )}
          {!rec.decision && rec.recommendedStep && <p className="small"><strong>Étape recommandée :</strong> {rec.recommendedStep}</p>}
          {rec.circuit && <p className="callout callout-info ia-circuit"><Icon name="scale" size={16} /> <span><strong>Circuit humain :</strong> {rec.circuit}</span></p>}

          {rec.actions.length > 0 && (
            <div className="ia-actions">
              <h4 className="eyebrow">Actions proposées</h4>
              <ul className="list-rows">
                {rec.actions.map((a) => {
                  const effect = rec.effects.find((e) => e.id === a.effectId);
                  return (
                    <li key={a.id} className="list-row ia-action-row">
                      <div className="ia-action-main">
                        <span className={`ia-level ia-level-chip-${a.level}`}>{a.level}</span>
                        <div>
                          <div className="ia-action-label">{a.label}</div>
                          {a.blockedReason && <div className="small muted">{a.blockedReason}</div>}
                          {effect && (
                            <div className="small muted">
                              {EFFECT_LABEL[effect.type] ?? effect.type} {effect.id} — par {effect.createdByKind === 'ai' ? 'l’agent (niveau A)' : effect.createdBy}
                              {effect.deliveries !== undefined && ` — ${effect.deliveries} envoi(s)`}
                              {effect.status === 'ANNULE' && ` — annulé : ${effect.undoReason ?? ''}`}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="ia-action-tools">
                        <StatusBadge tone={ACTION_STATUS_TONE[a.status]} label={ACTION_STATUS_LABEL[a.status]} />
                        {rec.canUndo && (a.status === 'EXECUTEE' || a.status === 'EXECUTEE_AUTO') && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setUndoFor(a.id); setUndoReason(''); }}>
                            <Icon name="history" size={16} /> Annuler
                          </button>
                        )}
                      </div>
                      {undoFor === a.id && (
                        <div className="ia-inline-form">
                          <label className="field">
                            <span className="label">Motif de l’annulation</span>
                            <input value={undoReason} onChange={(e) => setUndoReason(e.target.value)} placeholder="Ex. bail retrouvé au dossier papier" />
                          </label>
                          <div className="btn-row">
                            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || undoReason.trim().length < 3}
                              onClick={() => void call(`/v1/ia/recommendations/${encodeURIComponent(rec.id)}/actions/${a.id}/undo`, { reason: undoReason.trim() }, 'Action annulée et journalisée.')}>
                              Confirmer l’annulation
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setUndoFor(null)}>Fermer</button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {rec.citations.length > 0 && (
            <details className="ia-citations">
              <summary>Données citées ({rec.citations.length})</summary>
              <ul>
                {rec.citations.map((c) => (
                  <li key={`${c.domain}:${c.ref}`}><span className="chip">{DOMAIN_LABEL[c.domain] ?? c.domain}</span> <span>{c.label}</span> <code className="small muted">{c.ref}</code></li>
                ))}
              </ul>
            </details>
          )}

          {decidable && (
            <div className="ai-actions">
              <label className="field">
                <span className="label">Motif de votre décision</span>
                <textarea rows={2} value={draft.value} onChange={(e) => draft.setValue(e.target.value)} placeholder="Motif obligatoire, conservé au journal" />
                <span className="small muted ia-draft-state" aria-live="polite">
                  <Icon name="lock" size={14} />{' '}
                  {draft.status === 'unavailable' ? 'Chiffrement local indisponible : rien n’est conservé sur l’appareil.'
                    : draft.status === 'saving' ? 'Enregistrement chiffré…'
                    : draft.status === 'saved' ? 'Brouillon chiffré sur l’appareil (ce n’est pas une décision).' : 'Brouillon chiffré automatiquement sur l’appareil.'}
                </span>
              </label>
              {mode === 'modify' && (
                <label className="field">
                  <span className="label">Modification retenue</span>
                  <textarea rows={2} value={modification} onChange={(e) => setModification(e.target.value)} />
                </label>
              )}
              <div className="btn-row">
                {rec.canValidate && pending.length > 0 && (
                  <button type="button" className="btn btn-primary" disabled={busy}
                    onClick={() => needReason() && void call(`/v1/ia/recommendations/${encodeURIComponent(rec.id)}/validate`, { reason }, 'Validé : actions exécutées en votre nom.')}>
                    <Icon name="check" size={18} /> Valider et exécuter ({pending.length})
                  </button>
                )}
                {!pendingB && (
                  <button type="button" className={`btn ${rec.canValidate && pending.length ? 'btn-secondary' : 'btn-primary'}`} disabled={busy}
                    onClick={() => needReason() && void call(`/v1/ia/recommendations/${encodeURIComponent(rec.id)}/decide`, { decision: 'ACCEPTEE', reason }, 'Recommandation acceptée.')}>
                    <Icon name="check" size={18} /> Accepter
                  </button>
                )}
                {mode === 'modify' ? (
                  <button type="button" className="btn btn-secondary" disabled={busy || !modification.trim()}
                    onClick={() => needReason() && void call(`/v1/ia/recommendations/${encodeURIComponent(rec.id)}/decide`, { decision: 'MODIFIEE', reason, modification: modification.trim() }, 'Décision modifiée enregistrée.')}>
                    Enregistrer la modification
                  </button>
                ) : (
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setMode('modify')}><Icon name="replace" size={18} /> Modifier</button>
                )}
                <button type="button" className="btn btn-ghost" disabled={busy}
                  onClick={() => needReason() && void call(`/v1/ia/recommendations/${encodeURIComponent(rec.id)}/decide`, { decision: 'REJETEE', reason }, 'Recommandation rejetée ; effets automatiques retirés.')}>
                  <Icon name="x" size={18} /> Rejeter
                </button>
              </div>
            </div>
          )}
          {!rec.canDecide && rec.status === 'EMISE' && <p className="small muted">Décision réservée aux rôles validateurs de cet agent.</p>}

          <p className="ai-disclaimer"><Icon name="info" size={16} /> <span>{rec.notice}</span></p>
          <p className="small muted">
            Finalité : {rec.purpose} · Version d’analyse {rec.promptVersion.split('-').slice(-2).join('-')} · Empreinte de sortie {rec.outputHash.slice(0, 12)}…
            {rec.decidedAt && ` · Décidé le ${fmtDate(rec.decidedAt, true)} par ${rec.decidedByRole ?? ''} (délai : ${latency(rec.decisionLatencyMs)})`}
            {rec.decisionReason && ` · Motif : ${rec.decisionReason}`}
            {rec.modification && ` · Modification : ${rec.modification}`}
          </p>
        </>
      )}
      {msg && <p role="status" className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
    </article>
  );
}
