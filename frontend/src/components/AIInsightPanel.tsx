import { useState } from 'react';
import type { AIRecommendation, Confidence } from '@mosolo/shared';
import { useApp } from '../context';
import { api, describeError } from '../lib/api';
import type { UIKey } from '../lib/i18n';
import { Icon } from './Icon';
import { StatusBadge, type Tone } from './StatusBadge';

const CONF_KEY: Record<Confidence, UIKey> = { HIGH: 'ai.confidence.high', MEDIUM: 'ai.confidence.medium', LOW: 'ai.confidence.low' };
const CONF_TONE: Record<Confidence, Tone> = { HIGH: 'good', MEDIUM: 'warning', LOW: 'serious' };
const STATUS_KEY: Record<AIRecommendation['status'], UIKey> = {
  EMISE: 'ai.status.EMISE', ACCEPTEE: 'ai.status.ACCEPTEE', REJETEE: 'ai.status.REJETEE', MODIFIEE: 'ai.status.MODIFIEE',
};

interface Props {
  rec: AIRecommendation | null;
  loading?: boolean;
  error?: string | null;
  example?: boolean;
  compact?: boolean;
  onDecided?: (r: AIRecommendation) => void;
  onRefresh?: () => void;
}

/**
 * Panneau d'analyse (§ 23.5.7) : les huit champs du format standard, le bloc de décision
 * et l'avertissement. L'IA recommande ; seul un agent habilité décide.
 */
export function AIInsightPanel({ rec, loading, error, example, compact, onDecided, onRefresh }: Props) {
  const { tr, fmtDate } = useApp();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [local, setLocal] = useState<AIRecommendation | null>(null);
  const r = local && rec && local.id === rec.id ? local : rec;

  async function decide(decision: 'ACCEPTEE' | 'REJETEE') {
    if (!r) return;
    if (decision === 'REJETEE' && !reason.trim()) { setMsg({ ok: false, text: tr('ai.reasonRequired') }); return; }
    setBusy(true); setMsg(null);
    try {
      const out = await api<AIRecommendation | undefined>(`/v1/ai/recommendations/${encodeURIComponent(r.id)}/decide`, {
        method: 'POST', body: { decision, reason: reason.trim() || tr('ai.defaultReason') },
      });
      const next: AIRecommendation = out && typeof out === 'object' && 'id' in out ? out : { ...r, status: decision, decisionReason: reason };
      setLocal(next);
      setMsg({ ok: true, text: tr(decision === 'ACCEPTEE' ? 'ai.accepted' : 'ai.rejected') });
      onDecided?.(next);
    } catch (e) {
      setMsg({ ok: false, text: describeError(e).message });
    } finally {
      setBusy(false);
    }
  }

  const fields: [UIKey, string | undefined][] = r ? [
    ['ai.situation', r.situation], ['ai.insight', r.insight], ['ai.risk', r.risk], ['ai.recommendation', r.recommendation],
    ['ai.nextAction', r.nextAction], ['ai.owner', r.owner], ['ai.deadline', r.deadline],
  ] : [];

  return (
    <section className={`panel ai-panel ${compact ? 'ai-compact' : ''}`} aria-labelledby={r ? `ai-${r.id}` : undefined} aria-busy={loading}>
      <header className="panel-head">
        <h2 className="panel-title" id={r ? `ai-${r.id}` : undefined}>
          <Icon name="mark" size={14} className="ai-mark" /> {tr('ai.panel.title')}
        </h2>
        <div className="panel-tools">
          {example && <span className="ribbon">{tr('common.exampleShort')}</span>}
          {r && <StatusBadge tone={r.status === 'ACCEPTEE' ? 'good' : r.status === 'REJETEE' ? 'critical' : 'neutral'} label={tr(STATUS_KEY[r.status])} />}
          {onRefresh && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading}>
              <Icon name="refresh" size={16} /> {tr('ai.refresh')}
            </button>
          )}
        </div>
      </header>
      {loading && <p className="muted">{tr('ai.loading')}</p>}
      {error && !loading && <p className="muted">{error}</p>}
      {r && !loading && (
        <>
          <dl className="ai-fields">
            {fields.map(([k, v]) => (
              <div className="ai-field" key={k}>
                <dt>{tr(k)}</dt>
                <dd>{v || '—'}</dd>
              </div>
            ))}
            <div className="ai-field">
              <dt>{tr('ai.confidence')}</dt>
              <dd><StatusBadge tone={CONF_TONE[r.confidence]} label={tr(CONF_KEY[r.confidence])} /></dd>
            </div>
          </dl>
          {r.decision && (
            <div className="ai-decision">
              <h3 className="eyebrow">{tr('ai.decisionBlock')}</h3>
              <dl className="kv">
                <div><dt>{tr('ai.bestOption')}</dt><dd>{r.decision.bestOption}</dd></div>
                <div><dt>{tr('ai.alternativeOption')}</dt><dd>{r.decision.alternativeOption}</dd></div>
                <div><dt>{tr('ai.riskOfInaction')}</dt><dd>{r.decision.riskOfInaction}</dd></div>
                <div><dt>{tr('ai.financialImpact')}</dt><dd>{r.decision.financialImpact}</dd></div>
                <div><dt>{tr('ai.operationalImpact')}</dt><dd>{r.decision.operationalImpact}</dd></div>
              </dl>
            </div>
          )}
          {r.sources?.length > 0 && !compact && (
            <p className="small muted">{tr('ai.sources')} : {r.sources.join(' · ')}</p>
          )}
          <p className="ai-disclaimer"><Icon name="info" size={16} /> <span>{tr('ai.disclaimer')}</span></p>
          <p className="small muted">
            {tr('ai.meta', { agent: r.agent, model: r.modelVersion, date: fmtDate(r.createdAt, true) })}
            {r.decidedBy && ` · ${tr('ai.decidedBy', { who: r.decidedBy })}`}
          </p>
          {r.status === 'EMISE' && (
            <div className="ai-actions">
              <label className="field">
                <span className="label">{tr('ai.reason')}</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('ai.reasonPlaceholder')} />
              </label>
              <div className="btn-row">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide('ACCEPTEE')}>
                  <Icon name="check" size={18} /> {tr('ai.accept')}
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void decide('REJETEE')}>
                  <Icon name="x" size={18} /> {tr('ai.reject')}
                </button>
              </div>
            </div>
          )}
          {msg && <p role="status" className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
        </>
      )}
    </section>
  );
}
