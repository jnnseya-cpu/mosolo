/**
 * Module 44 (tableaux ministériels : modules rattachés, part de 10 % calculée / rapprochée / versée), module 45 (salle de
 * contrôle finances et trésorerie : temps réel, incidents, paramètres sensibles, escalade) et module 47 (prévision de
 * trésorerie hebdomadaire, hypothèses jointes, écart prévision / réalisé).
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Section } from '../pilotage/shared';
import { Choice, Field, hasRole } from '../pilotage/planif';
import { date, Ecran, Indicateurs, montant, montants, pct, useRunner, useVue, type Indicator } from './commun';

// ───────────────────────────── module 44 ─────────────────────────────
interface Ministere {
  entity: string; entityName: string; rule: string; indicators: Indicator[];
  modules: { moduleId: string; code: string; label: string; status: string; attachedSince: string | null; actReference: string | null; revenue: { assessed: MoneyJSON[]; reconciled: MoneyJSON[]; payments: number }; performance: { obligations: number; due: number; paid: number; paymentRatePct: string | null; overdue: number }; tutelleShare: MoneyJSON[] }[];
  share: { mode: string; pct: string | null; notice: string; byCurrency: { currency: string; calculated: MoneyJSON; paid: MoneyJSON; remaining: MoneyJSON }[]; versements: { id: string; period: string; amount: MoneyJSON; reference: string; status: string; proposedBy: string }[] };
}

export function TableauMinistere() {
  const { user } = useApp();
  const province = hasRole(user?.roles, 'R01', 'R02', 'R03', 'R05', 'R22', 'R23');
  const list = useVue<{ items: { id: string; name: string }[] }>(province ? '/v1/decision/ministeres' : null);
  const [entity, setEntity] = useState('');
  const ent = province ? entity || list.data?.items[0]?.id || '' : '';
  // Aucun appel avant que l'utilisateur soit connu (sinon appel sans entité ⇒ 400 ENTITY_REQUIRED pour le Gouverneur).
  const q = useVue<Ministere>(!user || (province && !ent) ? null : `/v1/decision/ministere${ent ? `?entity=${encodeURIComponent(ent)}` : ''}`, [ent, user?.id]);
  const r = useRunner(q.reload);
  const [period, setPeriod] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [motif, setMotif] = useState('');
  const tresor = hasRole(user?.roles, 'R17', 'R18');
  return (
    <Ecran eyebrow="Pilotage et décision · module 44" title="Postes ministériels (Tableau de bord ministériel)" lead="Les modules de votre ministère et votre part de recettes ; filtrage strict sur le périmètre du ministère." q={q} msg={r.msg}>
      {(d) => (<>
        {province && list.data && <Section title="Ministère"><Choice label="Ministère" value={ent} onChange={setEntity} options={list.data.items.map((m) => [m.id, m.name])} /></Section>}
        <Section title={`Indicateurs — ${d.entityName}`} sub={d.rule}><Indicateurs items={d.indicators} /></Section>
        <Section title="Modules rattachés (par l’administrateur, § 12A.3) et performance">
          <DataTable caption="Modules" rows={d.modules} rowKey={(m) => m.moduleId} empty={<p className="muted">Aucun module rattaché.</p>} columns={[
            { key: 'm', label: 'Module', primary: true, render: (m) => `${m.code} — ${m.label}` },
            { key: 'a', label: 'Rattaché depuis', render: (m) => (m.attachedSince ? `${m.attachedSince.slice(0, 10)}${m.actReference ? ` (${m.actReference})` : ''}` : '—') },
            { key: 'r', label: 'Recettes rapprochées', num: true, render: (m) => montants(m.revenue.reconciled) },
            { key: 'p', label: 'Paiement à l’échéance', num: true, render: (m) => pct(m.performance.paymentRatePct) },
            { key: 's', label: 'Part de tutelle', num: true, render: (m) => montants(m.tutelleShare) },
          ]} />
        </Section>
        <Section title={`Part de ${d.share.pct ?? '—'} % — calculée, rapprochée, versée`} sub={d.share.notice}>
          <StatusBadge tone={d.share.mode === 'CALCUL' ? 'good' : 'warning'} label={d.share.mode === 'CALCUL' ? 'Calcul (clé active)' : 'Simulation (acte requis)'} />
          <DataTable caption="Part par devise" rows={d.share.byCurrency} rowKey={(c) => c.currency} columns={[
            { key: 'c', label: 'Devise', primary: true, render: (c) => c.currency },
            { key: 'k', label: 'Calculée (sur rapproché)', num: true, render: (c) => montant(c.calculated) },
            { key: 'v', label: 'Versée (constatée)', num: true, render: (c) => montant(c.paid) },
            { key: 'r', label: 'Reste', num: true, render: (c) => montant(c.remaining) },
          ]} />
          <DataTable caption="Versements" rows={d.share.versements} rowKey={(v) => v.id} empty={<p className="muted">Aucun versement constaté.</p>} columns={[
            { key: 'r', label: 'Référence', primary: true, render: (v) => v.reference },
            { key: 'p', label: 'Période', render: (v) => v.period },
            { key: 'm', label: 'Montant', num: true, render: (v) => montant(v.amount) },
            { key: 's', label: 'Statut', render: (v) => v.status },
            { key: 'a', label: 'Validation', render: (v) => (v.status === 'PROPOSE' && tresor && v.proposedBy !== user?.id ? <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/decision/ministere/versements/${v.id}/decision`, { approve: true, motif }, 'Versement constaté (seconde personne).')}>Constater</button> : null) },
          ]} />
          {tresor && (
            <div className="form">
              <p className="small muted">Constat d’un versement par le Trésor (ordre de paiement budgétaire) : validé par une seconde personne ; la plateforme ne décaisse jamais.</p>
              <Field label="Période (AAAA-MM)" value={period} onChange={setPeriod} />
              <Field label="Montant (CDF)" value={amount} onChange={setAmount} />
              <Field label="Référence de l’ordre de paiement" value={reference} onChange={setReference} />
              <Field label="Motif (10 caractères minimum)" value={motif} onChange={setMotif} />
              <button type="button" className="btn btn-secondary" disabled={r.busy || !period || !amount || motif.length < 10} onClick={() => void r.run('/v1/decision/ministere/versements', { entity: d.entity, period, amount: { amount, currency: 'CDF' }, reference, motif }, 'Versement proposé : validation par une seconde personne.')}>Proposer le constat</button>
            </div>
          )}
        </Section>
      </>)}
    </Ecran>
  );
}

// ───────────────────────────── module 45 ─────────────────────────────
interface Salle {
  rule: string; indicators: Indicator[];
  settlements: { today: string; confirmed: { count: number; amounts: MoneyJSON[] }; settled: { count: number; amounts: MoneyJSON[] }; reconciled: { count: number; amounts: MoneyJSON[] }; suspense: { count: number; over48h: number } };
  exceptions: { open: number; overdue: number; slaHours: number; byType: { type: string; open: number; overdue: number }[] };
  incidents: { open: { id: string; title: string; severity: string; status: string; owner: string | null; dueAt: string; overdue: boolean }[]; closedWithProof: number; closedWithoutProof: number };
  sensitiveParameters: { code: string; label: string; total: number; last30Days: number; recent: { at: string; action: string; actor: string; resource: string }[] }[];
  escalations: { id: string; subjectKind: string; subjectId: string; label: string; dueAt: string; escalatedAt: string; acknowledgement?: { by: string; at: string } }[];
}

export function SalleControle() {
  const { user } = useApp();
  const q = useVue<Salle>('/v1/decision/salle-controle');
  const r = useRunner(q.reload);
  const [motif, setMotif] = useState('');
  return (
    <Ecran eyebrow="Pilotage et décision · module 45" title="Salle de contrôle finances et trésorerie" lead="Encaissements, écarts, paramètres sensibles et alertes critiques ; aucune correction silencieuse." q={q} msg={r.msg}>
      {(d) => (<>
        <Section title="Indicateurs" sub={d.rule}><Indicateurs items={d.indicators} /></Section>
        <Section title={`Suivi en temps réel — ${d.settlements.today}`}>
          <p>Confirmés : <strong>{d.settlements.confirmed.count}</strong> ({montants(d.settlements.confirmed.amounts)}) · Réglés : <strong>{d.settlements.settled.count}</strong> · Rapprochés : <strong>{d.settlements.reconciled.count}</strong></p>
          <p>Suspens : {d.settlements.suspense.count} (dont {d.settlements.suspense.over48h} au-delà de 48 h) · Exceptions ouvertes : {d.exceptions.open} (hors délai de {d.exceptions.slaHours} h : {d.exceptions.overdue})</p>
        </Section>
        <Section title="Incidents — propriétaire, sévérité, délai, preuve de clôture" sub={`Clos avec preuve : ${d.incidents.closedWithProof} · clos sans preuve : ${d.incidents.closedWithoutProof}`}>
          <DataTable caption="Incidents" rows={d.incidents.open} rowKey={(i) => i.id} empty={<p className="muted">Aucun incident ouvert.</p>} columns={[
            { key: 't', label: 'Incident', primary: true, render: (i) => `${i.id} — ${i.title}` },
            { key: 's', label: 'Sévérité', render: (i) => i.severity },
            { key: 'o', label: 'Propriétaire', render: (i) => i.owner ?? '—' },
            { key: 'd', label: 'Délai', render: (i) => <StatusBadge tone={i.overdue ? 'critical' : 'good'} label={`${date(i.dueAt)}${i.overdue ? ' (dépassé)' : ''}`} /> },
          ]} />
        </Section>
        <Section title="Paramètres sensibles — surveillance des changements">
          <DataTable caption="Paramètres sensibles" rows={d.sensitiveParameters} rowKey={(p) => p.code} columns={[
            { key: 'l', label: 'Famille', primary: true, render: (p) => p.label },
            { key: 'n', label: '30 jours / total', num: true, render: (p) => `${p.last30Days} / ${p.total}` },
            { key: 'r', label: 'Dernier changement', render: (p) => (p.recent[0] ? `${date(p.recent[0].at)} — ${p.recent[0].action} par ${p.recent[0].actor}` : '—') },
          ]} />
        </Section>
        <Section title="Escalades hors délai" tools={<button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/decision/salle-controle/escalades', {}, 'Escalade vérifiée.')}>Vérifier les délais</button>}>
          <Field label="Motif de prise en charge (10 caractères minimum)" value={motif} onChange={setMotif} />
          <DataTable caption="Escalades" rows={d.escalations} rowKey={(e) => e.id} empty={<p className="muted">Aucune escalade.</p>} columns={[
            { key: 'l', label: 'Objet', primary: true, render: (e) => `${e.label} (${e.subjectId})` },
            { key: 'd', label: 'Échéance', render: (e) => date(e.dueAt) },
            { key: 'a', label: 'Prise en charge', render: (e) => (e.acknowledgement ? `${e.acknowledgement.by} — ${date(e.acknowledgement.at)}` : hasRole(user?.roles, 'R05', 'R17') ? <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/decision/salle-controle/escalades/${e.id}/prise-en-charge`, { motif }, 'Escalade prise en charge.')}>Prendre en charge</button> : 'En attente') },
          ]} />
        </Section>
      </>)}
    </Ecran>
  );
}

// ───────────────────────────── module 47 ─────────────────────────────
interface Forecast { id: string; createdAt: string; scenario: string | null; weeks: number; firstWeek: string; lastWeek: string; sha256: string; lineCount: number; assignation: 'AUCUNE' }
interface Gap { forecastId: string; sha256: string; hypotheses: { id: string; scenario: string; value: string; source: string }[]; rates: { category: string; source: string; ratePct: string | null }[]; rows: { week: string; category: string; commune: string; expected: MoneyJSON; actual: MoneyJSON | null; elapsed: boolean; realisedPct: string | null }[]; totals: { realisedPct: string | null }; rule: string }

export function PrevisionTresorerie() {
  const { user } = useApp();
  const q = useVue<{ items: Forecast[]; indicator: Indicator }>('/v1/decision/previsions');
  const r = useRunner(q.reload);
  const [weeks, setWeeks] = useState('8');
  const [scenario, setScenario] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const gap = useVue<Gap>(open ? `/v1/decision/previsions/${open}/ecart` : null, [open]);
  return (
    <Ecran eyebrow="Pilotage et décision · module 47" title="Prévision de trésorerie hebdomadaire" lead="Par catégorie et par commune, hypothèses jointes ; la prévision ne fixe aucune assignation. Scénarios et sensibilité : « Simulateur de scénarios »." q={q} msg={r.msg}>
      {(d) => (<>
        <Section title="Indicateur"><Indicateurs items={[d.indicator]} /></Section>
        {hasRole(user?.roles, 'R05', 'R06', 'R15', 'R17') && (
          <Section title="Nouvelle prévision">
            <div className="form">
              <Field label="Semaines (1 à 26)" value={weeks} onChange={setWeeks} />
              <Choice label="Scénario (hypothèses du registre)" value={scenario} onChange={setScenario} options={[['', 'Taux observés (365 jours)'], ['PRUDENT', 'Prudent'], ['ATTENDU', 'Attendu'], ['TRANSFORMATIONNEL', 'Transformationnel (ambitieux)']]} />
              <button type="button" className="btn btn-primary" disabled={r.busy} onClick={() => void r.run('/v1/decision/previsions', { weeks: Number(weeks), ...(scenario ? { scenario } : {}) }, 'Prévision figée avec ses hypothèses.')}>Générer</button>
            </div>
          </Section>
        )}
        <Section title="Prévisions figées">
          <DataTable caption="Prévisions" rows={d.items} rowKey={(f) => f.id} empty={<p className="muted">Aucune prévision.</p>} columns={[
            { key: 'i', label: 'Prévision', primary: true, render: (f) => `${f.id} (${f.firstWeek} → ${f.lastWeek})` },
            { key: 's', label: 'Scénario', render: (f) => f.scenario ?? 'Taux observés' },
            { key: 'h', label: 'Empreinte', render: (f) => <span className="mono">{f.sha256.slice(0, 12)}…</span> },
            { key: 'a', label: 'Écart', render: (f) => <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(f.id)}>Écart prévision / réalisé</button> },
          ]} />
        </Section>
        {open && gap.data && (
          <Section title={`Écart prévision / réalisé — ${gap.data.forecastId}`} sub={gap.data.rule}>
            <p>Réalisé / prévu (semaines écoulées) : <strong>{pct(gap.data.totals.realisedPct)}</strong> · Hypothèses jointes : {gap.data.hypotheses.length ? gap.data.hypotheses.map((h) => `${h.scenario} ${h.value} % (${h.source})`).join(' ; ') : 'taux observés'}</p>
            <DataTable caption="Lignes" rows={gap.data.rows} rowKey={(x) => `${x.week}|${x.category}|${x.commune}|${x.expected.currency}`} columns={[
              { key: 'w', label: 'Semaine', primary: true, render: (x) => x.week },
              { key: 'c', label: 'Catégorie / commune', render: (x) => `${x.category} — ${x.commune}` },
              { key: 'e', label: 'Prévu', num: true, render: (x) => montant(x.expected) },
              { key: 'a', label: 'Réalisé', num: true, render: (x) => (x.elapsed ? montant(x.actual) : 'semaine à venir') },
              { key: 'p', label: 'Réalisé / prévu', num: true, render: (x) => pct(x.realisedPct) },
            ]} />
          </Section>
        )}
      </>)}
    </Ecran>
  );
}
