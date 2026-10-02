/**
 * Arbitrage entre entités (§ 10A.3, § 10A.4 ; H.4.3, J22) : une seule revendication par fait générateur.
 * La seconde revendication est bloquée, un dossier est ouvert au comité juridique et tarifaire ; avis juridique,
 * puis décision humaine motivée par une autorité distincte et étrangère au litige. Aucune obligation n'est
 * annulée ni créée en double automatiquement : la rectification éventuelle passe par le circuit de réclamation.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { Chip } from '../../components/StatusBadge';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { FACT_LABEL, hasRole, Status, useAction, type Arbitration } from './common';
import { ArbitragesVisuels, circuitArbitrage } from './visuels';
import './acces.css';
// Parcours par rôle (29/09/2026) : un écran vide propose la prochaine action utile du travail du jour.
import { SuiteDuTravail } from '../../components/SuiteDuTravail';

interface Rule { id: string; code: string; label: string; status: string; administeringEntity: string }

function subjectText(a: Arbitration): string {
  if (a.kind === 'COMPETENCE_MODULE') return `Compétence « ${a.subject.revenueScope} »${a.subject.ruleCodes?.length ? ` (règles ${a.subject.ruleCodes.join(', ')})` : ''}`;
  return `${FACT_LABEL[a.subject.factCode ?? ''] ?? a.subject.factCode} · objet ${a.subject.objectId} · période ${a.subject.period}`;
}

function ClaimForm({ userId, entity, onDone }: { userId: string; entity: string; onDone: () => void }) {
  const act = useAction(userId);
  const rules = useApi(() => api<Rule[]>('/v1/legal-rules'), [userId]);
  const [f, setF] = useState({ objectId: '', factCode: 'PROPRIETE_BATIE', period: String(new Date().getFullYear()), basis: '', liquidate: false, ruleId: '' });
  const own = useMemo(() => (rules.data ?? []).filter((r) => r.status === 'ACTIVE' && r.administeringEntity === entity), [rules.data, entity]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.liquidate) {
      const r = await act.run(() => api<{ obligation: { id: string } | null }>('/v1/acces/claims/liquidations', { method: 'POST', body: { ruleId: f.ruleId, objectId: f.objectId.trim(), factCode: f.factCode, period: f.period, basis: f.basis.trim(), inputs: {} } }),
        (r) => `Revendication acceptée ; obligation ${r.obligation?.id ?? ''} liquidée par le circuit commun.`);
      if (r) onDone();
      return;
    }
    const r = await act.run(() => api('/v1/acces/claims', { method: 'POST', body: { objectId: f.objectId.trim(), factCode: f.factCode, period: f.period, basis: f.basis.trim() } }), 'Revendication acceptée : aucune autre entité ne détient ce fait générateur.');
    onDone();
    return r;
  }
  return (
    <form className="panel form" onSubmit={(e) => void submit(e)} aria-labelledby="cl-title">
      <h2 className="panel-title" id="cl-title">Revendiquer un fait générateur</h2>
      <p className="small muted">Au nom de votre entité ({entity}). Si une autre entité détient déjà ce fait pour le même objet et la même période, la revendication est bloquée et un dossier d’arbitrage s’ouvre ; le citoyen ne voit aucune double obligation.</p>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="cl-o">Objet (identifiant)</label><input id="cl-o" className="mono" value={f.objectId} onChange={(e) => setF({ ...f, objectId: e.target.value })} placeholder="OBJ-DEMO-PARCELLE-01" required /></div>
        <div className="field"><label className="label" htmlFor="cl-p">Période</label><input id="cl-p" className="mono" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} required /></div>
      </div>
      <div className="field"><label className="label" htmlFor="cl-f">Fait générateur</label>
        <select id="cl-f" value={f.factCode} onChange={(e) => setF({ ...f, factCode: e.target.value })}>{Object.entries(FACT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="cl-b">Base de la revendication</label><input id="cl-b" value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })} placeholder="Texte, article, délibération…" required /></div>
      <label className="ac-check"><input type="checkbox" checked={f.liquidate} onChange={(e) => setF({ ...f, liquidate: e.target.checked })} /> Liquider ensuite par le circuit commun (règle ACTIVE de mon entité)</label>
      {f.liquidate && (
        <div className="field"><label className="label" htmlFor="cl-r">Règle</label>
          <select id="cl-r" value={f.ruleId} onChange={(e) => setF({ ...f, ruleId: e.target.value })} required><option value="">—</option>{own.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.label}</option>)}</select>
          {own.length === 0 && <span className="hint">Aucune règle ACTIVE administrée par votre entité : liquidation impossible (tarif : acte requis).</span>}</div>
      )}
      {act.node}
      <button type="submit" className="btn btn-primary" disabled={act.busy}><Icon name="scale" size={18} /> Revendiquer</button>
    </form>
  );
}

export default function Arbitrages() {
  const { user, fmtDate } = useApp();
  const roles = user?.roles ?? [];
  const list = useApi(() => api<{ items: Arbitration[] }>('/v1/acces/arbitrations'), [user?.id]);
  const [open, setOpen] = useState<string | null>(null);
  const [op, setOp] = useState({ text: '', recommendedEntity: '' });
  const [dec, setDec] = useState({ winnerEntity: '', motif: '', actReference: '' });
  const act = useAction(user?.id);
  const current = (list.data?.items ?? []).find((a) => a.id === open) ?? null;
  const canClaim = hasRole(roles, 'R06', 'R07', 'R11');
  const circuit = list.data ? circuitArbitrage(list.data.items) : null;

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Multi-entités" title="Revendications et arbitrages" lead="Une seule revendication par fait générateur. Lorsque deux entités revendiquent le même objet pour la même période, la seconde est bloquée et le comité juridique et tarifaire tranche : jamais de double perception." />
      {list.data && <ArbitragesVisuels items={list.data.items} />}
      <div className="ac-grid">
        <div className="ac-stack">
          {canClaim && user && <ClaimForm userId={user.id} entity={user.entity ?? ''} onDone={list.reload} />}
          <div className="panel">
            <h2 className="panel-title">Circuit</h2>
            <ol className="ac-timeline small">
              <li>Blocage automatique de la seconde revendication (aucune obligation créée).{circuit && <strong className="vz-circuit-count">— {circuit.bloques} dossier(s)</strong>}</li>
              <li>Avis juridique motivé (juriste du comité).{circuit && <strong className="vz-circuit-count">— {circuit.avis} avis rendu(s)</strong>}</li>
              <li>Décision par une autorité distincte, étrangère aux entités en litige, avec second facteur.{circuit && <strong className="vz-circuit-count">— {circuit.decides} décision(s)</strong>}</li>
              <li>Rectification éventuelle d’une obligation déjà émise : circuit de réclamation, jamais d’office.{circuit && <strong className="vz-circuit-count">— {circuit.rectifications} rectification(s)</strong>}</li>
            </ol>
          </div>
        </div>
        <section className="panel" aria-labelledby="arb-title">
          <header className="panel-head"><h2 className="panel-title" id="arb-title">Dossiers d’arbitrage</h2><span className="count">{list.data?.items.length ?? 0}</span></header>
          {list.loading && <Loading />}
          {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
          {list.data && (list.data.items.length === 0 ? <EmptyState title="Aucun dossier dans votre périmètre" icon="scale"><SuiteDuTravail /></EmptyState> : (
            <div className="ac-card-list">
              {list.data.items.map((a) => (
                <button key={a.id} type="button" className="ac-card" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => { setOpen(a.id); setOp({ text: '', recommendedEntity: '' }); setDec({ winnerEntity: '', motif: '', actReference: '' }); }}>
                  <div className="ac-card-head">
                    <div className="min0"><p className="ac-card-title">{a.id} — {a.kind === 'FAIT_GENERATEUR' ? 'Fait générateur' : 'Compétence de module'}</p><p className="small">{subjectText(a)}</p></div>
                    <Status s={a.status} />
                  </div>
                  <div className="ac-chips">{a.claimants.map((c, i) => <Chip key={i}>{c.entity}{c.holder ? ' · détenteur' : ' · revendiquant'}</Chip>)}{a.demo && <Chip>Démonstration</Chip>}</div>
                </button>
              ))}
            </div>
          ))}
        </section>
      </div>

      <Drawer open={!!current} title={current ? `Dossier ${current.id}` : ''} onClose={() => setOpen(null)}>
        {current && (
          <div className="stack">
            {current.demo && <ExampleNotice text="Dossier de démonstration (entités et fiches fictives)." />}
            <div className="row-between"><Status s={current.status} /><span className="small muted">Ouvert le {fmtDate(current.openedAt, true)}</span></div>
            <p>{subjectText(current)}</p>
            <div className="ac-claimants">
              {current.claimants.map((c, i) => (
                <div key={i} className="ac-claimant">
                  <span className="row-title">{c.entity}</span>
                  <span className="small muted">{c.holder ? 'Détenait déjà la revendication' : 'Seconde revendication (bloquée)'}{c.moduleConfigId ? ` · fiche ${c.moduleConfigId}` : ''}{c.claimId ? ` · ${c.claimId}` : ''}</span>
                </div>
              ))}
            </div>
            {current.existingObligationIds.length > 0 && <p className="ac-guard"><Icon name="info" size={16} /> <span>Obligation(s) déjà émise(s) par le détenteur : {current.existingObligationIds.join(', ')}. Aucune seconde obligation n’a été créée.</span></p>}
            {current.opinion && (
              <div className="ac-card"><p className="caps-sm muted">Avis juridique — {current.opinion.by} · {fmtDate(current.opinion.at, true)}</p><p>{current.opinion.text}</p>{current.opinion.recommendedEntity && <p className="small">Entité recommandée : <strong>{current.opinion.recommendedEntity}</strong></p>}</div>
            )}
            {current.decision && (
              <div className="ac-card"><p className="caps-sm muted">Décision — {current.decision.by} · {fmtDate(current.decision.at, true)}</p>
                <p>Compétence attribuée à <strong>{current.decision.winnerEntity}</strong> — {current.decision.motif}</p>
                <p className="small">Acte : {current.decision.actReference}</p>
                {current.decision.rectificationRequired && <p className="ac-guard ac-guard-warn"><Icon name="alert" size={16} /> <span>Une obligation déjà émise relève d’une autre entité : rectification par le circuit de réclamation (aucune annulation d’office).</span></p>}
              </div>
            )}
            {current.status !== 'DECIDE' && hasRole(roles, 'R13', 'R14') && (
              <div className="ac-inline-form">
                <p className="ac-section-title">Avis juridique</p>
                <div className="field"><label className="label" htmlFor="op-t">Analyse</label><textarea id="op-t" rows={4} value={op.text} onChange={(e) => setOp({ ...op, text: e.target.value })} /></div>
                <div className="field"><label className="label" htmlFor="op-r">Entité recommandée</label><select id="op-r" value={op.recommendedEntity} onChange={(e) => setOp({ ...op, recommendedEntity: e.target.value })}><option value="">—</option>{current.claimants.map((c) => <option key={c.entity} value={c.entity}>{c.entity}</option>)}</select></div>
                <button type="button" className="btn btn-primary" disabled={act.busy || op.text.trim().length < 10} onClick={() => void act.run(() => api(`/v1/acces/arbitrations/${current.id}/opinion`, { method: 'POST', body: { text: op.text, ...(op.recommendedEntity ? { recommendedEntity: op.recommendedEntity } : {}) } }), 'Avis juridique enregistré.').then(() => list.reload())}>Rendre l’avis</button>
              </div>
            )}
            {current.status !== 'DECIDE' && hasRole(roles, 'R01', 'R02', 'R05') && (
              <div className="ac-inline-form">
                <p className="ac-section-title">Décision motivée</p>
                {!current.opinion && <p className="small muted">Avis juridique requis avant décision.</p>}
                <div className="field"><label className="label" htmlFor="dc-w">Entité compétente</label><select id="dc-w" value={dec.winnerEntity} onChange={(e) => setDec({ ...dec, winnerEntity: e.target.value })}><option value="">—</option>{[...new Set(current.claimants.map((c) => c.entity))].map((e) => <option key={e} value={e}>{e}</option>)}</select></div>
                <div className="field"><label className="label" htmlFor="dc-m">Motif</label><textarea id="dc-m" rows={3} value={dec.motif} onChange={(e) => setDec({ ...dec, motif: e.target.value })} /></div>
                <div className="field"><label className="label" htmlFor="dc-a">Référence de l’acte</label><input id="dc-a" value={dec.actReference} onChange={(e) => setDec({ ...dec, actReference: e.target.value })} /></div>
                <button type="button" className="btn btn-primary" disabled={act.busy || !dec.winnerEntity || dec.motif.trim().length < 5 || dec.actReference.trim().length < 3}
                  onClick={() => void act.run(() => api(`/v1/acces/arbitrations/${current.id}/decision`, { method: 'POST', body: dec }), 'Décision enregistrée et journalisée.').then(() => list.reload())}><Icon name="scale" size={18} /> Décider</button>
              </div>
            )}
            {act.node}
          </div>
        )}
      </Drawer>
    </div>
  );
}
