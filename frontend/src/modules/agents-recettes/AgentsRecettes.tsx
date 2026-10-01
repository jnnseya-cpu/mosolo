/**
 * « Agents IA de recettes » (01/10/2026) : sept familles d'agents qui proposent — une personne décide. Élargir
 * l'assiette, faciliter le paiement, arrêter les fuites, recouvrer intelligemment, mesurer avant de changer un tarif,
 * garder la confiance de la population, guider les agents de terrain. Aucune charge nouvelle, aucune sanction
 * automatique, aucune donnée personnelle dans les propositions.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { MoneyText } from '../../components/MoneyText';
import { Area, Choice, Field, hasRole, Notice, useRunner } from '../pilotage/planif';

type Mode = 'NOUVEAU' | 'EXISTANT' | 'SOURCE' | 'SIMULATION';
interface Agent { code: string; nom: string; famille: string; agentIa: string; mode: Mode; mission: string; donnees: string[]; jamais: string; lien?: string; propositions: { aDecider: number; acceptees: number; ecartees: number } }
interface Catalogue { doctrine: string[]; familles: { code: string; ordre: number; libelle: string; but: string }[]; agents: Agent[]; parametres: { valeurs: Record<string, number>; statut: string }; sources: { kind: string; libelle: string; agent: string; lots: number; valides: number }[] }
interface Proposition { id: string; agent: string; titre: string; detail: string; commune?: string; montant?: MoneyJSON; rang?: number; effet: string; lien?: string; statut: string; at: string; decision?: { by: string; motif: string; resultat?: string } }
interface Lot { id: string; kind: string; libelle: string; reference: string; lignes: number; statut: string; deposePar: string; deposeLe: string }
interface Doleance { id: string; reference: string; at: string; commune: string; libelle: string; service: string; echeance: string; statut: string; texte: string; agentId: string | null; enRetard: boolean; reponse: { texte: string } | null; analyseIa: { categorieSuggeree: string | null; resume: string; urgence: string | null; fournisseur: string } | null }
interface EtatIa { actif: boolean; mode: string; fournisseurs: { id: string; nom: string; cleConfiguree: boolean; modele: string }[]; doleances: boolean; statut: string; regle: string }
interface ReponseIa { mode: string; texte: string; fournisseur: string | null; modele?: string }
interface Humeur { communes: { commune: string; doleances: number; recours: number; niveau: string }[]; satisfaction: { reponses: number; noteMoyenne: number | null }; note: string; seuils: { statut: string } }
interface Equite { propositions: number; seuilRatio: number; lignes: { commune: string; propositions: number; partPropositionsPct: number; partRegistrePct: number; ratio: number | null; signale: boolean }[]; note: string; statut: string }

const MODE: Record<Mode, { label: string; tone: Tone }> = {
  NOUVEAU: { label: 'Agent calculé', tone: 'good' }, SOURCE: { label: 'Alimenté par une source importée', tone: 'info' },
  EXISTANT: { label: 'Circuit déjà en service', tone: 'neutral' }, SIMULATION: { label: 'Simulateur', tone: 'warning' },
};
const STATUT: Record<string, { label: string; tone: Tone }> = { PROPOSEE: { label: 'À décider', tone: 'warning' }, ACCEPTEE: { label: 'Acceptée', tone: 'good' }, ECARTEE: { label: 'Écartée', tone: 'neutral' } };
const NIVEAU: Record<string, Tone> = { CALME: 'good', ATTENTION: 'warning', ALERTE: 'critical' };
const LANCEURS = ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R08', 'R15', 'R17', 'R20', 'R22', 'R23'];
const DECIDEURS = ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R08', 'R20', 'R21'];
const COLONNES_SOURCE = ['ref', 'lat', 'lon', 'commune', 'plaque', 'categorie', 'operateur', 'observe', 'libelle'] as const;

/** CSV « ref;lat;lon;commune;plaque;categorie;operateur;observe;libelle » → lignes (jamais de nom ni de téléphone). */
function lignesCsv(texte: string) {
  return texte.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^ref[;,]/i.test(l)).map((l) => {
    const c = l.split(/[;,]/).map((x) => x.trim());
    const o: Record<string, string | number> = {};
    COLONNES_SOURCE.forEach((k, i) => {
      const v = c[i];
      if (!v) return;
      o[k] = ['lat', 'lon', 'observe'].includes(k) ? Number(v.replace(',', '.')) : v;
    });
    return o;
  });
}

export default function AgentsRecettes() {
  const { user, fmtDate } = useApp();
  const roles = user?.roles;
  const q = useApi(() => api<Catalogue>('/v1/agents-recettes'), [user?.id]);
  const [sel, setSel] = useState<string | null>(null);
  const liste = useApi(sel ? () => api<{ items: Proposition[] }>(`/v1/agents-recettes/${sel}`) : null, [sel]);
  const r = useRunner(() => { q.reload(); liste.reload(); sources.reload(); doleances.reload(); });
  const [motif, setMotif] = useState('');
  const [onglet, setOnglet] = useState<'agents' | 'simulateurs' | 'sources' | 'confiance'>('agents');
  const sources = useApi(onglet === 'sources' ? () => api<{ items: Lot[] }>('/v1/agents-recettes/sources') : null, [onglet]);
  const doleances = useApi(onglet === 'confiance' ? () => api<{ items: Doleance[]; alertes: { type: string; id: string; doleances: number }[] }>('/v1/agents-recettes/doleances') : null, [onglet]);
  const humeur = useApi(onglet === 'confiance' ? () => api<Humeur>('/v1/agents-recettes/humeur') : null, [onglet]);
  const equite = useApi(onglet === 'confiance' ? () => api<Equite>('/v1/agents-recettes/equite') : null, [onglet]);
  const [regul, setRegul] = useState({ fenetreJours: '60', remisePenalitesPct: '100', devise: 'CDF' });
  const [regulRes, setRegulRes] = useState<Record<string, unknown> | null>(null);
  const [impact, setImpact] = useState({ ruleCode: '', variationPct: '10' });
  const [impactRes, setImpactRes] = useState<{ contribuables: number; devise: string; alerte: string | null; note: string; parCommune: { cle: string; contribuables: number; avant: MoneyJSON; apres: MoneyJSON }[]; parRang: { cle: string | number; contribuables: number; hausseMoyenne: MoneyJSON }[] } | null>(null);
  const [src, setSrc] = useState({ kind: 'SNEL', reference: '', csv: '' });
  const [reponse, setReponse] = useState('');
  const ia = useApi(() => api<EtatIa>('/v1/agents-recettes/ia'), [user?.id]);
  const [analyse, setAnalyse] = useState<ReponseIa | null>(null);
  const [questionIa, setQuestionIa] = useState('');
  const [reponseIa, setReponseIa] = useState<ReponseIa | null>(null);
  const peutLancer = hasRole(roles, ...LANCEURS);
  const peutDecider = hasRole(roles, ...DECIDEURS);
  const d = q.data;
  const agentSel = d?.agents.find((a) => a.code === sel);

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Recettes · IA" title="Agents IA de recettes"
        lead="Plus de recettes de ceux qui devraient déjà payer et des fuites — jamais en alourdissant ceux qui paient. L’IA propose, une personne décide." />
      <Notice msg={r.msg} />
      {q.loading && !d ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : d && (
        <>
          <section className="callout callout-info" role="note">
            <ul className="small" style={{ margin: 0 }}>{d.doctrine.map((x) => <li key={x}>{x}</li>)}</ul>
          </section>
          {ia.data && (
            <section className="panel" style={{ marginTop: 16 }} data-testid="ia-etat">
              <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                <h2 className="panel-title" style={{ margin: 0 }}>Fournisseurs d’IA</h2>
                <StatusBadge tone={ia.data.actif ? 'good' : 'neutral'} label={ia.data.actif ? `Actif : ${ia.data.fournisseurs.filter((f) => f.cleConfiguree).map((f) => f.nom).join(', ')}` : 'Règles internes (aucune clé)'} />
              </div>
              <p className="small muted">{ia.data.fournisseurs.map((f) => `${f.nom} — ${f.cleConfiguree ? `clé configurée (${f.modele})` : 'sans clé'}`).join(' · ')}. {ia.data.regle} {ia.data.statut}.</p>
              {peutLancer && (
                <div className="form">
                  <Area label="Poser une question à l’IA (données agrégées seulement)" rows={2} value={questionIa} onChange={setQuestionIa} />
                  <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || questionIa.trim().length < 5} onClick={() => void r.run<ReponseIa>('/v1/agents-recettes/question', { question: questionIa.trim() }, 'Réponse reçue.').then(setReponseIa)}>Demander</button></div>
                  {reponseIa && <div className="callout callout-info" style={{ whiteSpace: 'pre-wrap' }} data-testid="ia-reponse"><strong>{reponseIa.fournisseur ? `${reponseIa.fournisseur} (${reponseIa.modele})` : 'Règles internes'} :</strong> {reponseIa.texte}</div>}
                </div>
              )}
            </section>
          )}
          <div className="btn-row" role="tablist" style={{ margin: '16px 0' }}>
            {([['agents', 'Agents et propositions'], ['simulateurs', 'Simulateurs'], ['sources', 'Sources externes'], ['confiance', 'Confiance et équité']] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={onglet === k} className={`btn btn-sm ${onglet === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setOnglet(k)}>{l}</button>
            ))}
          </div>

          {onglet === 'agents' && (
            <>
              {d.familles.map((f) => (
                <section key={f.code} className="panel" style={{ marginBottom: 16 }}>
                  <h2 className="panel-title">{f.ordre}. {f.libelle}</h2>
                  <p className="small muted">{f.but}</p>
                  <div className="stack-sm">
                    {d.agents.filter((a) => a.famille === f.code).map((a) => (
                      <article key={a.code} className="card" data-testid={`agent-${a.code}`}>
                        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                          <strong>{a.nom}</strong>
                          <StatusBadge tone={MODE[a.mode].tone} label={MODE[a.mode].label} />
                        </div>
                        <p className="small">{a.mission}</p>
                        <p className="small muted">Jamais : {a.jamais} · Agent du catalogue IA : {a.agentIa}</p>
                        <div className="btn-row">
                          {(a.mode === 'NOUVEAU' || a.mode === 'SOURCE') && peutLancer && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => { setSel(a.code); void r.run(`/v1/agents-recettes/${a.code}/lancer`, {}, `« ${a.nom} » : propositions calculées.`); }}>Lancer l’agent</button>}
                          {(a.mode === 'NOUVEAU' || a.mode === 'SOURCE') && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSel(a.code)}>Propositions ({a.propositions.aDecider} à décider)</button>}
                          {a.mode === 'SIMULATION' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOnglet('simulateurs')}>Ouvrir le simulateur</button>}
                          {a.lien && <Link className="btn btn-ghost btn-sm" to={a.lien}>Ouvrir le circuit</Link>}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
              {sel && agentSel && (
                <section className="panel" data-testid="propositions">
                  <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                    <h2 className="panel-title" style={{ margin: 0 }}>Propositions — {agentSel.nom}</h2>
                    {peutLancer && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => { setAnalyse(null); void r.run<ReponseIa>(`/v1/agents-recettes/${agentSel.code}/analyse`, {}, 'Analyse reçue.').then(setAnalyse); }}>Analyse de l’IA</button>}
                  </div>
                  {analyse && <div className="callout callout-info" style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}><strong>{analyse.fournisseur ? `${analyse.fournisseur} (${analyse.modele})` : 'Règles internes'} :</strong> {analyse.texte}<span className="small muted" style={{ display: 'block' }}>L’IA propose ; une personne décide de chaque proposition.</span></div>}
                  {liste.loading && !liste.data ? <Loading /> : liste.error ? <ErrorState error={liste.error} onRetry={liste.reload} /> : (
                    <DataTable caption={`Propositions — ${agentSel.nom}`} rows={liste.data?.items ?? []} rowKey={(p) => p.id}
                      empty={<EmptyState title="Aucune proposition" icon="analysis">Lancez l’agent : il calcule ses propositions sur les données disponibles.</EmptyState>} columns={[
                        { key: 't', label: 'Proposition', primary: true, render: (p) => <><strong>{p.rang ? `${p.rang}. ` : ''}{p.titre}</strong><span className="small muted" style={{ display: 'block' }}>{p.detail}</span><span className="small" style={{ display: 'block' }}>Si acceptée : {p.effet}</span></> },
                        { key: 'c', label: 'Commune', render: (p) => p.commune || '—' },
                        { key: 'm', label: 'Montant en jeu', num: true, render: (p) => (p.montant ? <MoneyText money={p.montant} showIndicative={false} /> : '—') },
                        { key: 's', label: 'Décision', render: (p) => p.statut !== 'PROPOSEE'
                          ? <><StatusBadge tone={STATUT[p.statut]?.tone ?? 'neutral'} label={STATUT[p.statut]?.label ?? p.statut} />{p.decision && <span className="small muted" style={{ display: 'block' }}>{p.decision.motif}{p.decision.resultat ? ` — ${p.decision.resultat}` : ''}</span>}</>
                          : peutDecider ? (
                            <div className="btn-row">
                              <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/agents-recettes/propositions/${p.id}/decision`, { accepter: true, motif }, 'Proposition acceptée.')}>Accepter</button>
                              <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/agents-recettes/propositions/${p.id}/decision`, { accepter: false, motif }, 'Proposition écartée.')}>Écarter</button>
                            </div>
                          ) : <StatusBadge tone="warning" label="À décider" /> },
                      ]} />
                  )}
                  {peutDecider && <Field label="Motif de décision (10 caractères au moins)" value={motif} onChange={setMotif} />}
                </section>
              )}
              <p className="small muted">Paramètres des agents ({d.parametres.statut}) : {Object.entries(d.parametres.valeurs).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
            </>
          )}

          {onglet === 'simulateurs' && (
            <div className="stack">
              <section className="panel">
                <h2 className="panel-title">Fenêtre de régularisation (simulation)</h2>
                <p className="small muted">Pénalités remises si paiement dans la fenêtre : montants en jeu et recouvrement attendu au taux observé. Toute remise exige un acte.</p>
                <div className="form">
                  <Field label="Durée de la fenêtre (jours)" value={regul.fenetreJours} onChange={(v) => setRegul({ ...regul, fenetreJours: v })} />
                  <Field label="Remise des pénalités (%)" value={regul.remisePenalitesPct} onChange={(v) => setRegul({ ...regul, remisePenalitesPct: v })} />
                  <Choice label="Devise" value={regul.devise} onChange={(v) => setRegul({ ...regul, devise: v })} options={[['CDF', 'CDF'], ['USD', 'USD']]} />
                  <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run<Record<string, unknown>>('/v1/agents-recettes/simulations/regularisation', { fenetreJours: Number(regul.fenetreJours), remisePenalitesPct: Number(regul.remisePenalitesPct), devise: regul.devise }, 'Simulation calculée (aucun effet).').then(setRegulRes)}>Simuler</button></div>
                </div>
                {regulRes && (
                  <dl className="kv" data-testid="simulation-regularisation">
                    <div><dt>Dossiers en retard</dt><dd>{String(regulRes.dossiers)} ({String(regulRes.contribuables)} contribuables)</dd></div>
                    <div><dt>Principal en retard</dt><dd><MoneyText money={regulRes.principalEnRetard as MoneyJSON} showIndicative={false} /></dd></div>
                    <div><dt>Pénalités remises</dt><dd><MoneyText money={regulRes.penalitesRemises as MoneyJSON} showIndicative={false} /></dd></div>
                    <div><dt>Taux de paiement après échéance observé</dt><dd>{regulRes.tauxObserve === null ? 'non mesuré' : `${String(regulRes.tauxObserve)} %`}</dd></div>
                    <div><dt>Recouvrement attendu (borne basse)</dt><dd>{regulRes.recouvrementAttenduBorneBasse ? <MoneyText money={regulRes.recouvrementAttenduBorneBasse as MoneyJSON} showIndicative={false} /> : 'non mesuré'}</dd></div>
                    <p className="small muted">{String(regulRes.note)}</p>
                  </dl>
                )}
              </section>
              <section className="panel">
                <h2 className="panel-title">Impact d’un changement de tarif (simulation)</h2>
                <p className="small muted">Avant toute modification : qui paierait plus, par commune et par rang de localité. Le changement réel passe par le circuit des règles (quatre visas) et un acte.</p>
                <div className="form">
                  <Field label="Code de la règle" value={impact.ruleCode} onChange={(v) => setImpact({ ...impact, ruleCode: v })} />
                  <Field label="Variation (%)" value={impact.variationPct} onChange={(v) => setImpact({ ...impact, variationPct: v })} />
                  <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy || impact.ruleCode.trim().length < 2} onClick={() => void r.run<typeof impactRes>('/v1/agents-recettes/simulations/impact-tarif', { ruleCode: impact.ruleCode.trim(), variationPct: Number(impact.variationPct) }, 'Simulation calculée (aucun effet).').then(setImpactRes)}>Simuler</button></div>
                </div>
                {impactRes && (
                  <>
                    {impactRes.alerte && <p className="callout callout-warn" role="alert">{impactRes.alerte}</p>}
                    <DataTable caption="Par rang de localité" rows={impactRes.parRang} rowKey={(x) => String(x.cle)} columns={[
                      { key: 'r', label: 'Rang', primary: true, render: (x) => `Rang ${x.cle}` },
                      { key: 'n', label: 'Contribuables', num: true, render: (x) => x.contribuables },
                      { key: 'h', label: 'Hausse moyenne', num: true, render: (x) => <MoneyText money={x.hausseMoyenne} showIndicative={false} /> },
                    ]} />
                    <DataTable caption="Par commune" rows={impactRes.parCommune} rowKey={(x) => x.cle} columns={[
                      { key: 'c', label: 'Commune', primary: true, render: (x) => x.cle },
                      { key: 'n', label: 'Contribuables', num: true, render: (x) => x.contribuables },
                      { key: 'a', label: 'Avant', num: true, render: (x) => <MoneyText money={x.avant} showIndicative={false} /> },
                      { key: 'p', label: 'Après', num: true, render: (x) => <MoneyText money={x.apres} showIndicative={false} /> },
                    ]} />
                    <p className="small muted">{impactRes.note}</p>
                  </>
                )}
              </section>
            </div>
          )}

          {onglet === 'sources' && (
            <div className="stack">
              <section className="panel">
                <h2 className="panel-title">Déposer un lot (imagerie, SNEL, REGIDESO, marchands, plaques, observations)</h2>
                <p className="small muted">Jamais de nom ni de téléphone : référence, position, commune, plaque, catégorie, opérateur (identifiant fiscal), nombre observé. Validation par une seconde personne avant usage.</p>
                <div className="form">
                  <Choice label="Source" value={src.kind} onChange={(v) => setSrc({ ...src, kind: v })} options={d.sources.map((s) => [s.kind, s.libelle])} />
                  <Field label="Référence du lot (extrait, convention, date)" value={src.reference} onChange={(v) => setSrc({ ...src, reference: v })} />
                  <Area label="Lignes (CSV : ref;lat;lon;commune;plaque;categorie;operateur;observe;libelle)" rows={6} value={src.csv} onChange={(v) => setSrc({ ...src, csv: v })} />
                  <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy || src.reference.trim().length < 3 || !src.csv.trim()} onClick={() => void r.run('/v1/agents-recettes/sources', { kind: src.kind, reference: src.reference.trim(), lignes: lignesCsv(src.csv) }, 'Lot déposé : validation par une seconde personne requise.')}>Déposer</button></div>
                </div>
              </section>
              {sources.loading && !sources.data ? <Loading /> : sources.error ? <ErrorState error={sources.error} onRetry={sources.reload} /> : (
                <DataTable caption="Lots déposés" rows={sources.data?.items ?? []} rowKey={(l) => l.id} empty={<EmptyState title="Aucun lot" icon="upload" />} columns={[
                  { key: 'l', label: 'Lot', primary: true, render: (l) => <><strong>{l.libelle}</strong><span className="small muted" style={{ display: 'block' }}>{l.reference} · {l.lignes} ligne(s) · déposé le {fmtDate(l.deposeLe, true)}</span></> },
                  { key: 's', label: 'État', render: (l) => <StatusBadge tone={l.statut === 'VALIDE' ? 'good' : l.statut === 'REJETE' ? 'critical' : 'warning'} label={l.statut === 'A_VALIDER' ? 'À valider' : l.statut === 'VALIDE' ? 'Validé' : 'Rejeté'} /> },
                  { key: 'a', label: '', render: (l) => l.statut === 'A_VALIDER' && hasRole(roles, 'R05', 'R06', 'R07', 'R08', 'R22') && l.deposePar !== user?.id ? (
                    <div className="btn-row">
                      <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/agents-recettes/sources/${l.id}/validation`, { approuver: true, motif }, 'Lot validé.')}>Valider</button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/agents-recettes/sources/${l.id}/validation`, { approuver: false, motif }, 'Lot rejeté.')}>Rejeter</button>
                    </div>
                  ) : null },
                ]} />
              )}
              <Field label="Motif de validation (10 caractères au moins)" value={motif} onChange={setMotif} />
            </div>
          )}

          {onglet === 'confiance' && (
            <div className="stack">
              <section className="panel">
                <h2 className="panel-title">Baromètre du mécontentement (30 jours)</h2>
                {humeur.loading && !humeur.data ? <Loading /> : humeur.error ? <ErrorState error={humeur.error} onRetry={humeur.reload} /> : humeur.data && (
                  <>
                    <DataTable caption="Signaux par commune" rows={humeur.data.communes.filter((c) => c.niveau !== 'CALME').concat(humeur.data.communes.filter((c) => c.niveau === 'CALME').slice(0, 5))} rowKey={(c) => c.commune} columns={[
                      { key: 'c', label: 'Commune', primary: true, render: (c) => c.commune },
                      { key: 'd', label: 'Doléances', num: true, render: (c) => c.doleances },
                      { key: 'r', label: 'Recours', num: true, render: (c) => c.recours },
                      { key: 'n', label: 'Niveau', render: (c) => <StatusBadge tone={NIVEAU[c.niveau] ?? 'neutral'} label={c.niveau === 'CALME' ? 'Calme' : c.niveau === 'ATTENTION' ? 'Attention' : 'Alerte'} /> },
                    ]} />
                    <p className="small muted">{humeur.data.note} Avis de satisfaction : {humeur.data.satisfaction.reponses} réponse(s){humeur.data.satisfaction.noteMoyenne !== null ? `, note moyenne ${humeur.data.satisfaction.noteMoyenne}` : ''}. Seuils {humeur.data.seuils.statut}.</p>
                  </>
                )}
              </section>
              <section className="panel">
                <h2 className="panel-title">Doléances des usagers</h2>
                {doleances.loading && !doleances.data ? <Loading /> : doleances.error ? <ErrorState error={doleances.error} onRetry={doleances.reload} /> : doleances.data && (
                  <>
                    {doleances.data.alertes.length > 0 && <p className="callout callout-warn" role="alert">Alertes : {doleances.data.alertes.map((a) => `${a.type === 'COMMUNE' ? 'commune' : 'agent'} ${a.id} (${a.doleances})`).join(' · ')}</p>}
                    <DataTable caption="Doléances" rows={doleances.data.items} rowKey={(x) => x.id} empty={<EmptyState title="Aucune doléance" icon="message" />} columns={[
                      { key: 'd', label: 'Doléance', primary: true, render: (x) => <><strong>{x.reference} — {x.libelle}</strong><span className="small" style={{ display: 'block' }}>{x.texte}</span><span className="small muted" style={{ display: 'block' }}>{x.commune} · {x.service}{x.agentId ? ` · agent mis en cause ${x.agentId}` : ''} · réponse attendue le {x.echeance}</span>{x.analyseIa && <span className="small" style={{ display: 'block' }}>Suggestion de l’IA ({x.analyseIa.fournisseur}) : {x.analyseIa.resume}{x.analyseIa.categorieSuggeree ? ` · catégorie ${x.analyseIa.categorieSuggeree}` : ''}{x.analyseIa.urgence ? ` · urgence ${x.analyseIa.urgence}` : ''}</span>}</> },
                      { key: 's', label: 'État', render: (x) => <StatusBadge tone={x.statut === 'REPONDUE' ? 'good' : x.enRetard ? 'critical' : 'warning'} label={x.statut === 'REPONDUE' ? 'Répondue' : x.enRetard ? 'En retard' : 'Ouverte'} /> },
                      { key: 'a', label: '', render: (x) => x.statut === 'OUVERTE' ? <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || reponse.trim().length < 10} onClick={() => void r.run(`/v1/agents-recettes/doleances/${x.id}/reponse`, { texte: reponse }, 'Réponse envoyée.')}>Répondre</button> : <span className="small muted">{x.reponse?.texte}</span> },
                    ]} />
                    <Area label="Réponse à la doléance (10 caractères au moins)" rows={2} value={reponse} onChange={setReponse} />
                    <p className="small muted">L’auteur d’une doléance n’est jamais affiché ; l’agent mis en cause ne voit ni ne traite les doléances qui le concernent.</p>
                  </>
                )}
              </section>
              <section className="panel">
                <h2 className="panel-title">Contrôle d’équité des propositions de l’IA</h2>
                {equite.loading && !equite.data ? <Loading /> : equite.error ? <ErrorState error={equite.error} onRetry={equite.reload} /> : equite.data && (
                  <>
                    <DataTable caption="Part des propositions et part du registre par commune" rows={equite.data.lignes.filter((l) => l.propositions > 0 || l.signale)} rowKey={(l) => l.commune}
                      empty={<EmptyState title="Aucune proposition localisée sur 30 jours" icon="analysis" />} columns={[
                        { key: 'c', label: 'Commune', primary: true, render: (l) => l.commune },
                        { key: 'p', label: 'Propositions', num: true, render: (l) => `${l.propositions} (${l.partPropositionsPct} %)` },
                        { key: 'r', label: 'Part du registre', num: true, render: (l) => `${l.partRegistrePct} %` },
                        { key: 'x', label: 'Ratio', num: true, render: (l) => (l.ratio === null ? '—' : l.ratio) },
                        { key: 's', label: '', render: (l) => (l.signale ? <StatusBadge tone="warning" label="À examiner" /> : <StatusBadge tone="good" label="Équilibré" />) },
                      ]} />
                    <p className="small muted">{equite.data.note} Seuil {equite.data.seuilRatio} ({equite.data.statut}).</p>
                  </>
                )}
              </section>
              <p className="small"><Link to="/ou-va-votre-argent">Page publique « Où va votre argent »</Link></p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
