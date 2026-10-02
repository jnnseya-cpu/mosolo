/**
 * Grands redevables — module 56 : portefeuille dédié (brasseries, télécoms, carrières, grandes entreprises),
 * gestionnaire dédié et rotation, conventions (déclaration et rapprochement), gestion de cas (garanties, décisions tracées).
 * La désignation d'un redevable se fait dans « Modules sectoriels ».
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Section } from '../pilotage/shared';
import { Area, Choice, Field, hasRole } from '../pilotage/planif';
import { date, Ecran, Indicateurs, montant, montants, useRunner, useVue, type Indicator } from '../decision/commun';
import { GrandsRedevablesVisuels } from './visuels';

interface Item {
  taxpayerId: string; name: string; sectors: { code: string; label: string }[];
  manager: { id: string; name: string; since: string; rotation: { dueAt: string; due: boolean } } | null;
  managers: { managerId: string; from: string; to: string | null; endReason: string | null }[];
  conventions: { id: string; reference: string; periodicity: string; status: string; proposedBy: string; compliance: { expected: number; declared: number; validated: number; openGaps: number } | null }[];
  revenue: MoneyJSON[]; overdueObligations: number; guarantees: { nature: string; status: string; amount: MoneyJSON }[];
  journal: { id: string; at: string; by: string; kind: string; text: string }[];
}
interface Vue { portfolio: Item[]; withoutManager: number; rotationsDue: number; rule: string; params: { managerMaxTenureMonths: number; status: string }; indicators: Indicator[] }

export default function GrandsRedevables() {
  const { user } = useApp();
  const q = useVue<Vue>('/v1/grands-redevables');
  const r = useRunner(q.reload);
  const [sel, setSel] = useState('');
  const [manager, setManager] = useState('');
  const [motif, setMotif] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState('NOTE');
  const [ref, setRef] = useState('');
  const [object, setObject] = useState('');
  const [periodicity, setPeriodicity] = useState('MENSUELLE');
  const [instrument, setInstrument] = useState('');
  const [article, setArticle] = useState('');
  const [sha, setSha] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const cadre = hasRole(user?.roles, 'R06', 'R07');
  return (
    <Ecran eyebrow="Recettes spécifiques · module 56" title="Grands redevables" lead="Suivi rapproché des redevables à fort enjeu par un gestionnaire dédié ; rotation des gestionnaires ; décisions tracées." q={q} msg={r.msg}>
      {(d) => {
        const it = d.portfolio.find((p) => p.taxpayerId === (sel || d.portfolio[0]?.taxpayerId));
        return (<>
          {d.portfolio.length > 0 && <GrandsRedevablesVisuels portfolio={d.portfolio} />}
          <Section title="Indicateurs" sub={`${d.rule} Durée maximale d’affectation : ${d.params.managerMaxTenureMonths} mois (${d.params.status}).`}><Indicateurs items={d.indicators} /></Section>
          <Section title={`Portefeuille dédié (${d.withoutManager} sans gestionnaire, ${d.rotationsDue} rotation(s) due(s))`}>
            <DataTable caption="Portefeuille" rows={d.portfolio} rowKey={(p) => p.taxpayerId} empty={<p className="muted">Aucun grand redevable désigné (voir « Modules sectoriels »).</p>} columns={[
              { key: 'n', label: 'Redevable', primary: true, render: (p) => `${p.name} (${p.taxpayerId})` },
              { key: 's', label: 'Secteurs', render: (p) => p.sectors.map((s) => s.label).join(', ') },
              { key: 'g', label: 'Gestionnaire dédié', render: (p) => (p.manager ? <>{p.manager.name} {p.manager.rotation.due && <StatusBadge tone="warning" label="Rotation due" />}</> : <StatusBadge tone="critical" label="À désigner" />) },
              { key: 'r', label: 'Recettes confirmées', num: true, render: (p) => montants(p.revenue) },
              { key: 'o', label: 'Échues impayées', num: true, render: (p) => p.overdueObligations },
              { key: 'a', label: 'Dossier', render: (p) => <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSel(p.taxpayerId)}>Ouvrir</button> },
            ]} />
          </Section>
          {it && (<>
            <Section title={`Dossier — ${it.name}`} sub={`Gestionnaires : ${it.managers.map((m) => `${m.managerId} (${m.from.slice(0, 10)} → ${m.to ? m.to.slice(0, 10) : 'en cours'}${m.endReason ? `, ${m.endReason}` : ''})`).join(' ; ') || 'aucun'}`}>
              {cadre && (
                <div className="form">
                  <Field label="Gestionnaire dédié (identifiant, agent de la cellule)" value={manager} onChange={setManager} />
                  <Field label="Motif" value={motif} onChange={setMotif} />
                  <button type="button" className="btn btn-primary" disabled={r.busy || !manager || motif.length < 10} onClick={() => void r.run(`/v1/grands-redevables/${it.taxpayerId}/gestionnaire`, { managerId: manager, motif }, 'Gestionnaire désigné.')}>{it.manager ? 'Rotation du gestionnaire' : 'Désigner'}</button>
                </div>
              )}
              <p>Garanties : {it.guarantees.map((g) => `${g.nature} ${montant(g.amount)} (${g.status})`).join(' ; ') || 'aucune'} — <a href="/recouvrement/rendement">gérer les garanties</a></p>
            </Section>
            <Section title="Conventions — déclaration et rapprochement">
              <DataTable caption="Conventions" rows={it.conventions} rowKey={(c) => c.id} empty={<p className="muted">Aucune convention.</p>} columns={[
                { key: 'r', label: 'Convention', primary: true, render: (c) => `${c.reference} (${c.periodicity})` },
                { key: 's', label: 'Statut', render: (c) => c.status },
                { key: 'c', label: 'Périodes attendues / déclarées / validées', num: true, render: (c) => (c.compliance ? `${c.compliance.expected} / ${c.compliance.declared} / ${c.compliance.validated} (écarts : ${c.compliance.openGaps})` : '—') },
                { key: 'a', label: 'Décision', render: (c) => (c.status === 'PROPOSEE' && cadre && c.proposedBy !== user?.id ? <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/grands-redevables/conventions/${c.id}/decision`, { approve: true, motif: 'Convention conforme au protocole' }, 'Convention active.')}>Approuver</button> : null) },
              ]} />
              {hasRole(user?.roles, 'R07', 'R11') && (
                <div className="form">
                  <Field label="Référence" value={ref} onChange={setRef} />
                  <Area label="Objet" value={object} onChange={setObject} rows={2} />
                  <Choice label="Périodicité des déclarations" value={periodicity} onChange={setPeriodicity} options={[['MENSUELLE', 'Mensuelle'], ['TRIMESTRIELLE', 'Trimestrielle'], ['ANNUELLE', 'Annuelle']]} />
                  <Field label="Instrument juridique (registre)" value={instrument} onChange={setInstrument} />
                  <Field label="Article" value={article} onChange={setArticle} />
                  <Field label="Empreinte SHA-256 de la convention signée" value={sha} onChange={setSha} />
                  <Field label="Début" type="date" value={from} onChange={setFrom} />
                  <Field label="Fin" type="date" value={to} onChange={setTo} />
                  <button type="button" className="btn btn-secondary" disabled={r.busy || !ref || object.length < 10 || !instrument} onClick={() => void r.run(`/v1/grands-redevables/${it.taxpayerId}/conventions`, { reference: ref, object, sectors: it.sectors.map((s) => s.code), periodicity, legalBasis: { instrumentId: instrument, article }, signedSha256: sha, from, to }, 'Convention proposée : approbation par un cadre.')}>Proposer la convention</button>
                </div>
              )}
            </Section>
            <Section title="Journal du dossier — décisions tracées">
              <div className="form">
                <Choice label="Nature" value={kind} onChange={setKind} options={[['NOTE', 'Note'], ['ECHANGE', 'Échange avec le redevable'], ...(cadre ? [['DECISION', 'Décision motivée'] as [string, string]] : [])]} />
                <Area label="Texte" value={text} onChange={setText} rows={2} />
                <button type="button" className="btn btn-secondary" disabled={r.busy || text.length < 5} onClick={() => void r.run(`/v1/grands-redevables/${it.taxpayerId}/journal`, { kind, text }, 'Inscrit au journal.')}>Inscrire</button>
              </div>
              <DataTable caption="Journal" rows={it.journal} rowKey={(j) => j.id} empty={<p className="muted">Journal vide.</p>} columns={[
                { key: 'a', label: 'Date', render: (j) => date(j.at) },
                { key: 'k', label: 'Nature', render: (j) => j.kind },
                { key: 't', label: 'Texte', primary: true, render: (j) => `${j.text} — ${j.by}` },
              ]} />
            </Section>
          </>)}
        </>);
      }}
    </Ecran>
  );
}
