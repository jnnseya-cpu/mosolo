/**
 * « Fraudes sur les preuves » (30/09/2026, consigne du maître d'ouvrage : « un code ne sert qu'une personne ; tout
 * verrouiller ; retrouver tous ceux qui sont impliqués ») : dossiers ouverts par la détection (plaque différente, copie
 * du même code, gilet par son seul numéro, vignette technique sur un autre véhicule), chaîne complète de la fraude
 * (achat, QR animé, impressions, vérifications, contrôles, agents qui ont laissé passer), instruction par un enquêteur,
 * décision par une personne distincte. Aucune sanction automatique : amendes et mesures disciplinaires par l'autorité
 * compétente.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';

interface Dossier {
  id: string; kind: string; libelle: string; titre: string | null; reference?: string; detail: string; openedAt: string; detectedBy: string;
  acceptedBy: { controllerId: string; controlId: string; at: string }[]; status: 'A_INSTRUIRE' | 'EN_INSTRUCTION' | 'DECIDE'; investigatorId?: string;
  decision?: { by: string; at: string; outcome: string; motif: string };
}
interface Liste { items: Dossier[]; agents: { agent: string; dossiers: number; etablis: number }[]; seuils: Record<string, string | number> }
interface Chaine {
  dossier: Dossier;
  titre: { numero: string; type: string; etat: string; motifEtat: string | null; emisLe: string; plaque: string | null; achat: { payeur: string; titulaire: string | null; referencePaiement: string | null; quittances: string[]; montant: MoneyJSON | null } } | null;
  qrAnimeGenere: { at: string; acteur: string }[]; impressions: { at: string }[]; verificationsPubliques: { at: string; acteur: string }[];
  controles: { id: string; at: string; agent: string; lieu: { label?: string; commune?: string }; methode: string; resultat: string; motif: string | null; horsLigne: boolean }[];
  agentsAyantLaissePasser: { agent: string; controles: number }[];
  recettePerdueProposee: { montant: MoneyJSON; base: string; statut: string } | null;
  doctrine: string[];
}

const ETAT: Record<Dossier['status'], { label: string; tone: 'critical' | 'warning' | 'good' }> = {
  A_INSTRUIRE: { label: 'À instruire', tone: 'critical' }, EN_INSTRUCTION: { label: 'En instruction', tone: 'warning' }, DECIDE: { label: 'Décidé', tone: 'good' },
};

export default function FraudesPreuves() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Liste>('/v1/titres/fraudes'), [user?.id]);
  const [sel, setSel] = useState<string | null>(null);
  const ch = useApi(sel ? () => api<Chaine>(`/v1/titres/fraudes/${encodeURIComponent(sel)}`) : null, [sel]);
  const [motif, setMotif] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(path: string, body: unknown, ok: string) {
    setMsg(null);
    try { await api(path, { method: 'POST', body }); setMsg({ ok: true, text: ok }); q.reload(); ch.reload(); }
    catch (e) { const d = describeError(e); setMsg({ ok: false, text: d.message }); }
  }
  const d = q.data;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Anti-fraude · preuves" title="Fraudes sur les preuves"
        lead="Code présenté pour un autre véhicule, copie du même code en plusieurs lieux, gilet par son seul numéro, vignette sur un autre véhicule : la preuve est bloquée à titre conservatoire et le dossier arrive ici. Un enquêteur instruit ; une autre personne décide." />
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role="status">{msg.text}</p>}
      {q.loading && !d ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : d && (
        <>
          <DataTable caption="Dossiers de fraude" rows={d.items} rowKey={(x) => x.id} empty={<EmptyState title="Aucun dossier" icon="shieldCheck">Aucune fraude détectée sur les preuves.</EmptyState>} columns={[
            { key: 'd', label: 'Dossier', primary: true, render: (x) => <><strong>{x.libelle}</strong><span className="small muted" style={{ display: 'block' }}>{x.id} · {fmtDate(x.openedAt, true)} · {x.titre ?? x.reference ?? ''}</span></> },
            { key: 'a', label: 'Agents ayant laissé passer', render: (x) => <span className="small">{[...new Set(x.acceptedBy.map((a) => a.controllerId))].join(', ') || '—'}</span> },
            { key: 'e', label: 'État', render: (x) => <StatusBadge tone={ETAT[x.status].tone} label={ETAT[x.status].label} /> },
            { key: 'o', label: '', render: (x) => <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSel(x.id)}>Chaîne de la fraude</button> },
          ]} />
          {d.agents.length > 0 && (
            <section className="panel" style={{ marginTop: 16 }}>
              <h2 className="panel-title">Suivi qualité des agents</h2>
              <p className="small muted">Agents ayant accepté des preuves ensuite mises en cause. Signalement à la hiérarchie ; toute mesure disciplinaire relève de l’autorité compétente.</p>
              <ul className="plain-list small">{d.agents.map((a) => <li key={a.agent}><strong>{a.agent}</strong> — {a.dossiers} dossier(s), dont {a.etablis} fraude(s) établie(s)</li>)}</ul>
            </section>
          )}
          <p className="small muted">Seuils de détection : {Object.entries(d.seuils).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
        </>
      )}
      {sel && (ch.loading && !ch.data ? <Loading /> : ch.error ? <ErrorState error={ch.error} onRetry={ch.reload} /> : ch.data && (
        <section className="panel" style={{ marginTop: 16 }} data-testid="chaine-fraude">
          <h2 className="panel-title"><Icon name="history" size={18} /> Chaîne de la fraude — {ch.data.dossier.id}</h2>
          <p className="small">{ch.data.dossier.detail}</p>
          {ch.data.titre && (
            <dl className="kv kv-dense">
              <div><dt>Titre</dt><dd>{ch.data.titre.numero} ({ch.data.titre.type}) — état {ch.data.titre.etat}{ch.data.titre.plaque ? ` — plaque ${ch.data.titre.plaque}` : ''}</dd></div>
              <div><dt>Acheté par</dt><dd className="mono">{ch.data.titre.achat.payeur}{ch.data.titre.achat.titulaire && ch.data.titre.achat.titulaire !== ch.data.titre.achat.payeur ? ` pour ${ch.data.titre.achat.titulaire}` : ''} · {fmtDate(ch.data.titre.emisLe, true)} · paiement {ch.data.titre.achat.referencePaiement ?? '—'}</dd></div>
              <div><dt>QR animé généré</dt><dd>{ch.data.qrAnimeGenere.length} fois{ch.data.qrAnimeGenere[0] ? ` (par ${[...new Set(ch.data.qrAnimeGenere.map((x) => x.acteur))].join(', ')})` : ''}</dd></div>
              <div><dt>Imprimé / vérifié publiquement</dt><dd>{ch.data.impressions.length} impression(s) · {ch.data.verificationsPubliques.length} vérification(s)</dd></div>
            </dl>
          )}
          <DataTable caption="Présentations du code" rows={ch.data.controles} rowKey={(x) => x.id} columns={[
            { key: 't', label: 'Quand', primary: true, render: (x) => fmtDate(x.at, true) },
            { key: 'l', label: 'Où', render: (x) => x.lieu.label ?? x.lieu.commune ?? '—' },
            { key: 'a', label: 'Agent', render: (x) => x.agent },
            { key: 'r', label: 'Résultat', render: (x) => <><StatusBadge tone={x.resultat === 'VALIDE' ? 'good' : 'critical'} label={x.resultat} />{x.motif && <span className="small muted" style={{ display: 'block' }}>{x.motif}</span>}</> },
          ]} />
          {ch.data.recettePerdueProposee && <p className="small"><strong>Recette perdue proposée :</strong> {ch.data.recettePerdueProposee.montant.amount} {ch.data.recettePerdueProposee.montant.currency} — {ch.data.recettePerdueProposee.base} ({ch.data.recettePerdueProposee.statut}).</p>}
          <ul className="small muted">{ch.data.doctrine.map((x) => <li key={x}>{x}</li>)}</ul>
          {ch.data.dossier.status !== 'DECIDE' && (
            <div className="stack-sm">
              {ch.data.dossier.status === 'A_INSTRUIRE' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void run(`/v1/titres/fraudes/${sel}/instruction`, {}, 'Dossier pris en instruction.')}>Prendre en instruction (enquêteur)</button>}
              <label className="label" htmlFor="fr-motif">Motif de la décision (20 caractères au moins)</label>
              <textarea id="fr-motif" value={motif} onChange={(e) => setMotif(e.target.value)} rows={2} />
              <div className="btn-row">
                <button type="button" className="btn btn-primary btn-sm" disabled={motif.trim().length < 20} onClick={() => void run(`/v1/titres/fraudes/${sel}/decision`, { outcome: 'FRAUDE_ETABLIE', motif, retenirRecettePerdue: true }, 'Fraude établie : titre révoqué, recette perdue retenue, autorité compétente saisie.')}>Fraude établie</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={motif.trim().length < 20} onClick={() => void run(`/v1/titres/fraudes/${sel}/decision`, { outcome: 'CLASSEMENT', motif }, 'Classé : blocage levé.')}>Classer (blocage levé)</button>
              </div>
            </div>
          )}
          {ch.data.dossier.decision && <p className="small"><strong>Décision :</strong> {ch.data.dossier.decision.outcome} par {ch.data.dossier.decision.by} — {ch.data.dossier.decision.motif}</p>}
        </section>
      ))}
    </div>
  );
}
