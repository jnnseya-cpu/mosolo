/**
 * Remises gracieuses : demande motivée sur une règle ACTIVE déclarant un taux de remise, instruction par un agent de
 * recouvrement (R20) distinct du demandeur, décision motivée d'une autorité distincte (R21). Le montant après remise est
 * CALCULÉ par le serveur (taux et plafond déclarés, cumul sur la chaîne) : aucun montant n'est saisi à l'instruction ni
 * à la décision. Une remise ne ramène jamais la créance à zéro (voie : admission en non-valeur).
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge, Chip } from '../../components/StatusBadge';
import { MoneyText } from '../../components/MoneyText';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { hasRole, REMISSION_STATUS, type Arrear, type Remission, type RemissionComputation, type RuleLite } from './types';
import { Msg, useAction } from './actions';
import { RemisesVisuel } from './visuels';
import './recouvrement.css';

type Tab = 'instruire' | 'decider' | 'decidees';

async function load() {
  const [remissions, arrears, rules] = await Promise.all([
    api<Remission[]>('/v1/recouvrement/remises'),
    api<{ items: Arrear[] }>('/v1/recouvrement/arrieres').then((r) => r.items).catch(() => [] as Arrear[]),
    api<RuleLite[]>('/v1/legal-rules').catch(() => [] as RuleLite[]),
  ]);
  return { remissions, arrears, rules };
}

/** Calcul serveur : taux et plafond déclarés, montant original de la chaîne, déjà remis, disponible, plancher calculé. */
export function ComputationBox({ c }: { c: RemissionComputation }) {
  return (
    <section className="rc-box" aria-label="Calcul selon la règle">
      <p className="caps-sm">Calcul selon la règle — non modifiable</p>
      <dl className="kv kv-dense">
        <div><dt>Taux de remise déclaré</dt><dd>{c.rate} %</dd></div>
        <div><dt>Plafond déclaré</dt><dd>{c.cap ? <MoneyText money={c.cap} showIndicative={false} /> : <span className="muted">Aucun plafond en montant déclaré (taux seul)</span>}</dd></div>
        <div><dt>Montant original (chaîne)</dt><dd><MoneyText money={c.originalAmount} showIndicative={false} /></dd></div>
        <div><dt>Réduction maximale cumulée</dt><dd><MoneyText money={c.maxReduction} showIndicative={false} /></dd></div>
        <div><dt>Déjà remis sur la chaîne</dt><dd><MoneyText money={c.alreadyRemitted} showIndicative={false} /></dd></div>
        <div><dt>Encore disponible</dt><dd><MoneyText money={c.available} showIndicative={false} /></dd></div>
        <div><dt>Montant dû actuel</dt><dd><MoneyText money={c.currentAmount} showIndicative={false} /></dd></div>
        <div><dt>Montant après remise calculé</dt><dd><strong><MoneyText money={c.computedAmount} showIndicative={false} /></strong></dd></div>
      </dl>
      <p className="small muted">Déclaré par : {c.declaredBy.join(' · ') || '—'} · chaîne {c.chain.join(' → ')}</p>
    </section>
  );
}

function RemissionCard({ r, meId, roles, onDone }: { r: Remission; meId: string | undefined; roles: string[]; onDone: () => void }) {
  const { fmtDate } = useApp();
  const [text, setText] = useState('');
  const { busy, msg, run } = useAction(onDone);
  const st = REMISSION_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
  const url = (p: string) => `/v1/recouvrement/remises/${encodeURIComponent(r.id)}/${p}`;
  const ownRequest = !!meId && meId === r.requestedBy;
  const ownInstruction = !!meId && meId === r.instruction?.by;
  const canInstruct = r.status === 'DEMANDEE' && hasRole(roles, 'R20') && !ownRequest;
  const canDecide = r.status === 'INSTRUITE' && hasRole(roles, 'R21') && !ownRequest && !ownInstruction;
  const unfavorable = r.instruction?.favorable === false;
  const short = text.trim().length < 10;
  return (
    <article className="panel rc-decision">
      <div className="panel-head">
        <div className="min0">
          <p className="panel-title">Remise <span className="mono small">{r.id}</span></p>
          <p className="panel-sub">Obligation <span className="mono">{r.obligationId}</span> · contribuable <span className="mono">{r.taxpayerId}</span> · règle <span className="mono">{r.basisRuleId}</span></p>
        </div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <p className="small">{r.motivation}</p>
      <p className="small muted">Demandée par {r.requestedBy} le {fmtDate(r.requestedAt, true)} · montant après remise demandé <MoneyText money={r.requestedAmount} showIndicative={false} /></p>
      {r.computation && <ComputationBox c={r.computation} />}
      {r.instruction && <p className="small"><Chip>{r.instruction.favorable ? 'Instruction favorable' : 'Instruction défavorable'}</Chip> {r.instruction.by} · {fmtDate(r.instruction.at, true)} — {r.instruction.analysis}</p>}
      {r.decision && (
        <p className="small">Décision de {r.decision.by} le {fmtDate(r.decision.at, true)} — {r.decision.motivation}
          {r.decision.grantedAmount && <> · montant après remise <MoneyText money={r.decision.grantedAmount} showIndicative={false} />{r.decision.fromAmount && <> (au lieu de <MoneyText money={r.decision.fromAmount} showIndicative={false} />)</>}</>}
          {r.rectifyingObligationId && <> · obligation rectificative <span className="mono">{r.rectifyingObligationId}</span></>}
        </p>
      )}
      {(r.status === 'DEMANDEE' || r.status === 'INSTRUITE') && (ownRequest || ownInstruction) && (
        <p className="callout callout-info"><Icon name="lock" size={18} /> Quatre yeux : vous avez {ownRequest ? 'demandé' : 'instruit'} cette remise ; l’étape suivante revient à une autre personne.</p>
      )}
      {canInstruct && (
        <>
          <div className="field">
            <label className="label" htmlFor={`ri-${r.id}`}>Analyse motivée de l’instruction</label>
            <textarea id={`ri-${r.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} minLength={10} maxLength={4000} />
            <span className="hint">L’instruction ne fixe aucun montant : le calcul ci-dessus s’impose.</span>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || short} onClick={() => void run(() => api(url('instruction'), { method: 'POST', body: { favorable: true, analysis: text } }), 'Instruction favorable enregistrée : décision attendue d’une autorité distincte (R21).')}><Icon name="check" size={14} /> Avis favorable</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || short} onClick={() => void run(() => api(url('instruction'), { method: 'POST', body: { favorable: false, analysis: text } }), 'Instruction défavorable enregistrée.')}><Icon name="x" size={14} /> Avis défavorable</button>
          </div>
        </>
      )}
      {canDecide && (
        <>
          <div className="field">
            <label className="label" htmlFor={`rd-${r.id}`}>Motivation de la décision</label>
            <textarea id={`rd-${r.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} minLength={10} maxLength={4000} />
            <span className="hint">{unfavorable ? 'Instruction défavorable : seul le refus est possible.' : 'L’accord retient le montant calculé selon la règle, rejoué par le serveur à la décision.'}</span>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || short || unfavorable} onClick={() => void run(() => api(url('decision'), { method: 'POST', body: { granted: true, motivation: text } }), 'Remise accordée au montant calculé : obligation rectificative émise.')}><Icon name="check" size={14} /> Accorder (montant calculé)</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || short} onClick={() => void run(() => api(url('decision'), { method: 'POST', body: { granted: false, motivation: text } }), 'Remise refusée (motif tracé).')}><Icon name="x" size={14} /> Refuser</button>
          </div>
        </>
      )}
      <Msg msg={msg} />
    </article>
  );
}

function RequestForm({ arrears, rules, onDone }: { arrears: Arrear[]; rules: RuleLite[]; onDone: () => void }) {
  const [obligationId, setObligationId] = useState('');
  const arrear = arrears.find((a) => a.obligationId === obligationId.trim());
  const eligible = rules.filter((r) => r.status === 'ACTIVE' && r.exemptions.length > 0 && (!arrear || r.code === arrear.ruleCode));
  const [ruleId, setRuleId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [motivation, setMotivation] = useState('');
  const { busy, msg, run } = useAction(onDone);
  const cur = arrear?.amount.currency ?? currency;
  const basisRuleId = ruleId || eligible[0]?.id || '';
  function submit(e: FormEvent) {
    e.preventDefault();
    const requestedAmount = { amount: amount.trim(), currency: cur } as MoneyJSON;
    void run(() => api('/v1/recouvrement/remises', { method: 'POST', body: { obligationId: obligationId.trim(), basisRuleId, requestedAmount, motivation } }),
      'Demande enregistrée : le montant après remise a été calculé selon la règle (voir la carte).');
  }
  return (
    <form className="form panel" onSubmit={submit} aria-label="Demander une remise">
      <p className="panel-title">Demander une remise</p>
      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor="rm-obl">Obligation</label>
          <input id="rm-obl" list="rm-obl-list" value={obligationId} onChange={(e) => { setObligationId(e.target.value); setRuleId(''); }} required />
          <datalist id="rm-obl-list">{arrears.map((a) => <option key={a.obligationId} value={a.obligationId}>{a.label}</option>)}</datalist>
          {arrear && <span className="hint">Dû : <MoneyText money={arrear.amount} showIndicative={false} /> · règle {arrear.ruleCode}</span>}
        </div>
        <div className="field">
          <label className="label" htmlFor="rm-rule">Règle fondant la remise (ACTIVE, même code)</label>
          <select id="rm-rule" value={basisRuleId} onChange={(e) => setRuleId(e.target.value)} required>
            {!eligible.length && <option value="">Aucune règle ACTIVE déclarant une base de remise</option>}
            {eligible.map((r) => <option key={r.id} value={r.id}>{r.code} v{r.version} — {r.label}</option>)}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor="rm-amt">Montant après remise demandé</label>
          <input id="rm-amt" inputMode="decimal" pattern="\d{1,15}(\.\d{1,2})?" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          <span className="hint">Plancher demandé : le serveur retient le plus élevé entre cette demande et le calcul selon le taux déclaré.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="rm-cur">Devise</label>
          <select id="rm-cur" value={cur} disabled={!!arrear} onChange={(e) => setCurrency(e.target.value)}>
            <option value="USD">USD</option><option value="CDF">CDF</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="rm-mot">Motivation</label>
        <textarea id="rm-mot" rows={3} value={motivation} onChange={(e) => setMotivation(e.target.value)} required minLength={10} maxLength={4000} />
        <span className="hint">Demande d’un agent de recouvrement : elle vaut instruction ; la décision revient à une autorité distincte (R21).</span>
      </div>
      <Msg msg={msg} />
      <button type="submit" className="btn btn-primary" disabled={busy || !basisRuleId || motivation.trim().length < 10}><Icon name="send" size={16} /> Demander</button>
    </form>
  );
}

export default function Remises() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const q = useApi(load, [user?.id]);
  const [picked, setTab] = useState<Tab | null>(null);
  // Vue par défaut selon le rôle (connu après chargement de l'utilisateur) : décision pour R21, instruction sinon.
  const tab: Tab = picked ?? (hasRole(roles, 'R21') ? 'decider' : 'instruire');
  const d = q.data;
  const all = d?.remissions ?? [];
  const groups: Record<Tab, Remission[]> = {
    instruire: all.filter((r) => r.status === 'DEMANDEE'),
    decider: all.filter((r) => r.status === 'INSTRUITE'),
    decidees: all.filter((r) => r.status === 'ACCORDEE' || r.status === 'REFUSEE'),
  };
  return (
    <div className="page page-wide rc-page">
      <PageHead eyebrow="Recouvrement" title="Remises gracieuses" lead="Le taux et le plafond viennent de la règle ACTIVE ; le montant après remise est calculé par le serveur, jamais saisi. Instruction par un agent (R20), décision par une autorité distincte (R21).">
        <Link className="btn btn-ghost" to="/recouvrement"><Icon name="arrowRight" size={16} className="rc-flip" /> File de recouvrement</Link>
      </PageHead>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {d && (
        <>
          <RemisesVisuel remissions={all} />
          {hasRole(roles, 'R20') && <RequestForm arrears={d.arrears} rules={d.rules} onDone={q.reload} />}
          <div className="seg seg-wrap" role="group" aria-label="Vue">
            <button type="button" aria-pressed={tab === 'instruire'} onClick={() => setTab('instruire')}>À instruire <span className="count">{groups.instruire.length}</span></button>
            <button type="button" aria-pressed={tab === 'decider'} onClick={() => setTab('decider')}>À décider <span className="count">{groups.decider.length}</span></button>
            <button type="button" aria-pressed={tab === 'decidees'} onClick={() => setTab('decidees')}>Décidées <span className="count">{groups.decidees.length}</span></button>
          </div>
          <div className="rc-grid">
            {groups[tab].length === 0 && <EmptyState title="Aucune remise" icon="check" />}
            {groups[tab].map((r) => <RemissionCard key={r.id} r={r} meId={user?.id} roles={roles} onDone={q.reload} />)}
          </div>
          <p className="small muted rc-foot">L’effacement total d’une créance ne passe jamais par une remise : voir l’<Link to="/recouvrement/non-valeurs">admission en non-valeur</Link>.</p>
        </>
      )}
    </div>
  );
}
