/**
 * Module 48 — capacité disponible selon le budget voté : enveloppes d'investissement (référence de l'acte budgétaire),
 * importées puis certifiées par une seconde personne ; indicateurs « scénarios produits et retenus ».
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Section } from './shared';
import { Field, hasRole, moneyText, useRunner } from './planif';
import { Indicateurs, type Indicator } from '../decision/commun';

export interface Envelope { id: string; period: string; amount: MoneyJSON; actReference: string; label: string; status: string; importedBy: string }

export function EnveloppesBudget({ envelopes, indicators, roles, userId, onDone }: { envelopes: Envelope[]; indicators: Indicator[]; roles: string[] | undefined; userId: string | undefined; onDone: () => void }) {
  const r = useRunner(onDone);
  const [period, setPeriod] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [act, setAct] = useState('');
  const [label, setLabel] = useState('');
  return (
    <>
      <Section title="Indicateurs (module 48)"><Indicateurs items={indicators} /></Section>
      <Section title="Capacité disponible selon le budget voté" sub="Enveloppes d’investissement inscrites au budget voté ; la capacité proposée par l’IA est le minimum entre l’enveloppe restante et les recettes rapprochées.">
        <DataTable caption="Enveloppes" rows={envelopes} rowKey={(e) => e.id} empty={<p className="muted">Aucune enveloppe : la capacité repose sur les seules recettes rapprochées.</p>} columns={[
          { key: 'l', label: 'Enveloppe', primary: true, render: (e) => `${e.label} (${e.period})` },
          { key: 'm', label: 'Montant', num: true, render: (e) => moneyText(e.amount) },
          { key: 'a', label: 'Acte budgétaire', render: (e) => e.actReference },
          { key: 's', label: 'Statut', render: (e) => (e.status === 'IMPORTEE' && hasRole(roles, 'R01', 'R02', 'R05') && e.importedBy !== userId
            ? <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/projets/enveloppes/${e.id}/certification`, { approve: true, motif: 'Conforme au budget voté (vérifié)' }, 'Enveloppe certifiée.')}>Certifier</button>
            : <StatusBadge tone={e.status === 'CERTIFIEE' ? 'good' : e.status === 'IMPORTEE' ? 'warning' : 'neutral'} label={e.status} />) },
        ]} />
        {hasRole(roles, 'R05', 'R06', 'R15', 'R17', 'R18') && (
          <div className="form">
            <Field label="Période (AAAA ou AAAA-Tn)" value={period} onChange={setPeriod} />
            <Field label="Montant" value={amount} onChange={setAmount} />
            <Field label="Devise" value={currency} onChange={setCurrency} />
            <Field label="Référence de l’acte budgétaire" value={act} onChange={setAct} />
            <Field label="Libellé" value={label} onChange={setLabel} />
            <button type="button" className="btn btn-secondary" disabled={r.busy || !period || !amount || act.length < 3 || label.length < 3} onClick={() => void r.run('/v1/pilotage/projets/enveloppes', { period, amount: { amount, currency }, actReference: act, label }, 'Enveloppe importée : certification par une seconde personne.')}>Importer l’enveloppe</button>
            {r.msg && <p className={r.msg.ok ? 'notice notice-ok' : 'notice notice-err'} role="status">{r.msg.text}</p>}
          </div>
        )}
      </Section>
    </>
  );
}
