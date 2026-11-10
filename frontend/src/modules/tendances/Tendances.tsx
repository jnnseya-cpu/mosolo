/**
 * « Veille des tendances (Trend Intelligence) » (10/11/2026) : une hausse de la demande devient un brief versionné,
 * approuvé par une personne ; les agents SEO et marketing y adaptent leurs propositions ; une personne distincte approuve
 * chaque modification exacte de la page propre ; mesure, puis retour arrière en un clic. Aucune clé nouvelle.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError, newIdempotencyKey } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Area, Field, hasRole, Notice, useRunner } from '../pilotage/planif';

interface Source { id: string; libelle: string; famille: string; accesLibelle: string; active: boolean; indisponible: string | null; observations: number; cadence: string }
interface Installation { id: string; libelle: string; environnement: string; gel: { motif: string; by: string } | null; profil: { revision: number; marche: string; locale: string; sujets: number } | null; sources: Source[]; quota: { mois: string; utilises: number; plafond: number } }
interface Etat { doctrine: string[]; installations: Installation[]; ia: { route: string; detail: string; localeEmbarquee: string }; parametres: { valeurs: Record<string, number>; statut: string } }
interface Famille { famille: string; courant: number; baseMediane: number; periodes: number; z: number; porteFranchie: boolean; historiqueSuffisant: boolean; perimee: boolean }
interface Opportunite { id: string; sujet: string; libelle: string; score: number; confiance: number; decision: string; statut: string; vetos: string[]; blocages: string[]; familles: Famille[]; composantes: Record<string, number>; composantesConfiance: Record<string, number>; calculeLe: string }
interface Brief { id: string; briefId: string; version: number; statut: string; creePar: string; creeLe: string; contenu: { topic_id: string; audience: string; intent: string; expires_at: string; allowed_channels: string[]; opportunity_score: number; confidence: number; objective: string } }
interface Action { id: string; type: string; agent: string; canal: string; statut: string; champs: Record<string, string>; auteur: string; briefId: string; briefVersion: number; cibleId: string | null; revisionAttendue: number | null; generation: { route: string; fournisseur: string | null; degrade: boolean; motif: string | null }; erreur?: { code: string; message: string }; recu?: { revision: number } }
interface ActionDetail extends Action { avant: Record<string, string> | null; revisionActuelle: number | null }
interface Page { id: string; slug: string; surface: 'BLOG' | 'PAGE'; statut: string; revisionActive: number | null; sujet: string; revisions: { revision: number; champs: Record<string, string>; creeLe: string }[] }
interface Mesure { methode: string; note: string; avant: { visites: number; cta: number; tauxPct: number | null }; apres: { visites: number; cta: number; tauxPct: number | null }; recommandation: string; statut: string }

const DECISION: Record<string, { label: string; tone: Tone }> = {
  BRIEF: { label: 'Brief à revoir', tone: 'good' }, AUTOMATIQUE_ELIGIBLE: { label: 'Éligible (automatique non activé)', tone: 'good' },
  SURVEILLER: { label: 'Surveillance', tone: 'warning' }, ARCHIVER: { label: 'Archivée', tone: 'neutral' },
};
const STATUT_ACTION: Record<string, { label: string; tone: Tone }> = {
  PROPOSEE: { label: 'À approuver', tone: 'warning' }, APPROUVEE: { label: 'Approuvée (brouillon)', tone: 'info' }, EN_FILE: { label: 'En file', tone: 'info' },
  APPLIQUEE: { label: 'Appliquée', tone: 'good' }, RETABLIE: { label: 'Rétablie', tone: 'neutral' }, CONFLIT: { label: 'Conflit', tone: 'critical' },
  ECHEC: { label: 'Refusée à l’exécution', tone: 'critical' }, RECONCILIATION: { label: 'Rapprochement', tone: 'warning' }, EXPORTEE: { label: 'Exportée', tone: 'neutral' },
};
const TYPE: Record<string, string> = { seo_metadata_patch: 'SEO — titre et description', owned_content_patch: 'Marketing — accroche et appel', seo_page_draft: 'SEO — brouillon de page', organic_social_draft: 'Réseaux sociaux — brouillon' };
const PROPOSANTS = ['R06', 'R07', 'R08', 'R29'];
const APPROBATEURS = ['R02', 'R03'];
const GELEURS = ['R02', 'R26', 'R28'];
const n1 = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

export default function Tendances() {
  const { user, fmtDate } = useApp();
  const roles = user?.roles;
  const etat = useApi(() => api<Etat>('/v1/tendances'), [user?.id]);
  const [instSel, setInstSel] = useState<string | null>(null);
  const inst = instSel ?? etat.data?.installations[0]?.id ?? null;
  const base = inst ? `/v1/tendances/installations/${inst}` : '';
  const [onglet, setOnglet] = useState<'opportunites' | 'briefs' | 'actions' | 'pages' | 'sources'>('opportunites');
  const ops = useApi(inst ? () => api<{ items: Opportunite[] }>(`${base}/opportunites`) : null, [inst]);
  const briefs = useApi(inst ? () => api<{ items: Brief[] }>(`${base}/briefs`) : null, [inst]);
  const actions = useApi(inst ? () => api<{ items: Action[] }>(`${base}/actions`) : null, [inst]);
  const pages = useApi(inst && onglet === 'pages' ? () => api<{ items: Page[] }>(`${base}/pages`) : null, [inst, onglet]);
  const r = useRunner(() => { etat.reload(); ops.reload(); briefs.reload(); actions.reload(); pages.reload(); });
  const [detail, setDetail] = useState<ActionDetail | null>(null);
  const [mesure, setMesure] = useState<Mesure | null>(null);
  const [motif, setMotif] = useState('');
  const [destination, setDestination] = useState('');
  const [csv, setCsv] = useState('');
  const peutProposer = hasRole(roles, ...PROPOSANTS);
  const peutApprouver = hasRole(roles, ...APPROBATEURS);
  const peutGeler = hasRole(roles, ...GELEURS);
  const installation = etat.data?.installations.find((i) => i.id === inst);

  async function approuverBrief(b: Brief) {
    r.setMsg(null);
    try {
      await api(`${base}/briefs/${b.id}/approbation`, { method: 'POST', body: {}, headers: { 'If-Match': String(b.version) } });
      r.setMsg({ ok: true, text: `Brief ${b.briefId} v${b.version} approuvé : il devient le brief actif de ce sujet.` });
      briefs.reload(); ops.reload();
    } catch (e) { const d = describeError(e); r.setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); }
  }
  async function ouvrir(id: string) {
    setMesure(null);
    setDetail(await api<ActionDetail>(`${base}/actions/${id}`));
    try { setMesure(await api<Mesure>(`${base}/actions/${id}/mesure`)); } catch { /* mesure facultative */ }
  }
  async function importer() {
    // CSV « sujet;debut;fin;valeur » → observations de la source d'import (jamais de nom ni de téléphone).
    const lignes = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^sujet[;,]/i.test(l)).map((l, i) => {
      const [texte, debut, fin, valeur] = l.split(/[;,]/).map((x) => x.trim());
      return { sourceId: 'src-import', recordId: `import-${Date.now()}-${i}`, observeLe: new Date(`${fin}T00:00:00Z`).toISOString(), debut: new Date(`${debut}T00:00:00Z`).toISOString(), fin: new Date(`${fin}T00:00:00Z`).toISOString(), texte: texte ?? '', valeur: Number((valeur ?? '').replace(',', '.')) };
    });
    r.setMsg(null);
    try {
      const res = await api<{ acceptees: number; doublons: number }>(`${base}/observations/lot`, { method: 'POST', body: { observations: lignes }, idempotencyKey: newIdempotencyKey() });
      r.setMsg({ ok: true, text: `${res.acceptees} observation(s) acceptée(s), ${res.doublons} doublon(s).` }); setCsv(''); etat.reload();
    } catch (e) { const d = describeError(e); r.setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); }
  }

  return (
    <div className="page page-wide">
      <p className="small"><Link to="/agents-recettes">← Agents IA de recettes</Link></p>
      <PageHead eyebrow="Agents IA de recettes · paiement" title="Veille des tendances (Trend Intelligence)"
        lead="Repérer, dans toute la plateforme, les démarches dont la demande monte ; en faire un brief approuvé par une personne, que suivent les articles du blog, les pages et les rappels — puis mesurer et revenir en arrière si besoin." />
      <Notice msg={r.msg} />
      {etat.loading && !etat.data ? <Loading /> : etat.error ? <ErrorState error={etat.error} onRetry={etat.reload} /> : etat.data && (
        <>
          <section className="callout callout-info" role="note">
            <ul className="small" style={{ margin: 0 }}>{etat.data.doctrine.map((x) => <li key={x}>{x}</li>)}</ul>
          </section>
          <section className="panel" style={{ marginTop: 16 }}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <h2 className="panel-title" style={{ margin: 0 }}>{installation?.libelle ?? 'Aucune installation'}</h2>
              <StatusBadge tone={etat.data.ia.route === 'IA_HOTE' ? 'good' : 'neutral'} label={etat.data.ia.route === 'IA_HOTE' ? 'IA de la plateforme' : 'Modèle déterministe (aucune clé d’IA)'} />
            </div>
            {etat.data.installations.length > 1 && (
              <div className="btn-row">{etat.data.installations.map((i) => <button key={i.id} type="button" className={`btn btn-sm ${i.id === inst ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setInstSel(i.id)}>{i.libelle}</button>)}</div>
            )}
            <p className="small muted">{etat.data.ia.detail} {etat.data.ia.localeEmbarquee}</p>
            {installation && (
              <p className="small">
                Profil : {installation.profil ? `révision ${installation.profil.revision} · ${installation.profil.marche} · ${installation.profil.locale} · ${installation.profil.sujets} sujet(s)` : 'aucun (observation seulement)'} ·
                Générations ce mois-ci : {installation.quota.utilises} / {installation.quota.plafond} ({etat.data.parametres.statut})
              </p>
            )}
            {installation?.gel && <div className="callout callout-warn" data-testid="gel">Installation gelée : {installation.gel.motif}. Aucune nouvelle génération ni exécution ; le retour arrière reste possible.</div>}
            <div className="btn-row">
              {peutProposer && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || !inst} onClick={() => void r.run(`${base}/collecte`, {}, 'Agrégats de la plateforme collectés.')}>Collecter les données propres</button>}
              {peutProposer && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || !inst} onClick={() => void r.run(`${base}/calcul`, {}, 'Opportunités recalculées.')}>Recalculer les opportunités</button>}
              {peutGeler && installation && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`${base}/gel`, { actif: !installation.gel, motif: motif.trim() }, installation.gel ? 'Installation dégelée.' : 'Installation gelée.')}>{installation.gel ? 'Lever le gel' : 'Geler (urgence)'}</button>}
            </div>
            {(peutGeler || peutApprouver) && <Field label="Motif (gel, révocation, retour arrière — 10 caractères au moins)" value={motif} onChange={setMotif} />}
          </section>

          <div className="btn-row" role="tablist" style={{ margin: '16px 0' }}>
            {([['opportunites', 'Opportunités'], ['briefs', 'Briefs'], ['actions', 'Actions des agents'], ['pages', 'Page propre'], ['sources', 'Sources']] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={onglet === k} className={`btn btn-sm ${onglet === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setOnglet(k)}>{l}</button>
            ))}
          </div>

          {onglet === 'opportunites' && (ops.loading && !ops.data ? <Loading /> : ops.data && (ops.data.items.length ? (
            <div className="stack-sm">
              {ops.data.items.map((o) => (
                <article key={o.id} className="card" data-testid={`opportunite-${o.sujet}`}>
                  <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                    <strong>{o.libelle}</strong>
                    <StatusBadge tone={DECISION[o.decision]?.tone ?? 'neutral'} label={DECISION[o.decision]?.label ?? o.decision} />
                  </div>
                  <p className="small">Score d’opportunité <strong>{n1(o.score)}</strong> · confiance <strong>{n1(o.confiance)}</strong> — demande {n1(o.composantes.demande ?? 0)}, adéquation {n1(o.composantes.adequation ?? 0)}, intention {n1(o.composantes.intention ?? 0)}, moment {n1(o.composantes.moment ?? 0)}, préparation {n1(o.composantes.preparation ?? 0)}.</p>
                  <p className="small muted">{o.familles.map((f) => `${f.famille} : ${f.courant} cette semaine contre ${n1(f.baseMediane)} (médiane de ${f.periodes} semaines), z ${n1(f.z)}${f.porteFranchie ? ' ✓' : ''}${f.perimee ? ' — périmée' : ''}`).join(' · ')}</p>
                  {[...o.vetos, ...o.blocages].length > 0 && <ul className="small" style={{ margin: 0 }}>{[...o.vetos, ...o.blocages].map((v) => <li key={v}>{v}</li>)}</ul>}
                  {peutProposer && o.statut === 'ELIGIBLE' && <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`${base}/opportunites/${o.id}/brief`, {}, 'Brief rédigé : il attend l’approbation d’une autre personne.').then(() => setOnglet('briefs'))}>Rédiger le brief</button></div>}
                </article>
              ))}
            </div>
          ) : <EmptyState title="Aucune opportunité">Collecter ou importer des observations, puis recalculer.</EmptyState>))}

          {onglet === 'briefs' && (briefs.data?.items.length ? (
            <DataTable caption="Briefs de croissance (versionnés)" rows={briefs.data.items} rowKey={(b) => b.id} columns={[
              { key: 's', label: 'Sujet', primary: true, render: (b) => <><strong>{b.contenu.topic_id}</strong><span className="small muted" style={{ display: 'block' }}>{b.briefId} v{b.version}</span></> },
              { key: 'a', label: 'Audience et intention', render: (b) => <span className="small">{b.contenu.audience} — {b.contenu.intent}</span> },
              { key: 'v', label: 'Valable jusqu’au', render: (b) => fmtDate(b.contenu.expires_at) },
              { key: 'st', label: 'Statut', render: (b) => <StatusBadge tone={b.statut === 'APPROUVE' ? 'good' : b.statut === 'BROUILLON' ? 'warning' : 'neutral'} label={b.statut === 'APPROUVE' ? 'Approuvé (actif)' : b.statut === 'BROUILLON' ? 'À approuver' : b.statut === 'REVOQUE' ? 'Révoqué' : 'Remplacé'} /> },
              { key: 'x', label: 'Action', render: (b) => (
                <div className="btn-row">
                  {peutApprouver && b.statut === 'BROUILLON' && <button type="button" className="btn btn-primary btn-sm" disabled={b.creePar === user?.id} title={b.creePar === user?.id ? 'L’auteur ne peut pas approuver' : undefined} onClick={() => void approuverBrief(b)}>Approuver</button>}
                  {peutProposer && b.statut === 'APPROUVE' && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run(`${base}/briefs/${b.id}/generation`, {}, 'Agents SEO et marketing : propositions générées à partir du brief.').then(() => setOnglet('actions'))}>Faire travailler les agents</button>}
                  {peutApprouver && b.statut === 'APPROUVE' && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`${base}/briefs/${b.id}/revocation`, { motif: motif.trim() }, 'Brief révoqué : les agents reviennent à leur comportement de base.')}>Révoquer</button>}
                </div>
              ) },
            ]} />
          ) : <EmptyState title="Aucun brief">Rédiger un brief depuis une opportunité éligible.</EmptyState>)}

          {onglet === 'actions' && (
            <>
              {actions.data?.items.length ? (
                <DataTable caption="Propositions des agents" rows={actions.data.items} rowKey={(a) => a.id} columns={[
                  { key: 't', label: 'Proposition', primary: true, render: (a) => <><strong>{TYPE[a.type] ?? a.type}</strong><span className="small muted" style={{ display: 'block' }}>{a.id} · agent {a.agent} · {a.generation.route === 'IA_HOTE' ? `IA (${a.generation.fournisseur})` : 'modèle déterministe'}</span></> },
                  { key: 'c', label: 'Contenu', render: (a) => <span className="small">{Object.values(a.champs).join(' — ')}</span> },
                  { key: 's', label: 'Statut', render: (a) => <StatusBadge tone={STATUT_ACTION[a.statut]?.tone ?? 'neutral'} label={STATUT_ACTION[a.statut]?.label ?? a.statut} /> },
                  { key: 'x', label: 'Action', render: (a) => <button type="button" className="btn btn-secondary btn-sm" onClick={() => void ouvrir(a.id)}>Avant / après</button> },
                ]} />
              ) : <EmptyState title="Aucune proposition">Approuver un brief, puis faire travailler les agents.</EmptyState>}
              {detail && (
                <section className="panel" style={{ marginTop: 16 }} data-testid="detail-action">
                  <h2 className="panel-title">{TYPE[detail.type] ?? detail.type} — {detail.id}</h2>
                  {detail.generation.degrade && <p className="small muted">Rédigé par le modèle déterministe : {detail.generation.motif ?? 'aucune IA disponible'}.</p>}
                  {detail.erreur && <div className="callout callout-warn">{detail.erreur.code} : {detail.erreur.message}</div>}
                  <DataTable caption="Avant / après" rows={Object.keys(detail.champs)} rowKey={(k) => k} columns={[
                    { key: 'k', label: 'Champ', primary: true, render: (k) => k },
                    { key: 'a', label: detail.avant ? `Actuel (révision ${detail.revisionActuelle})` : 'Actuel', render: (k) => <span className="small">{detail.avant?.[k] ?? '—'}</span> },
                    { key: 'b', label: 'Proposé', render: (k) => <span className="small"><strong>{detail.champs[k]}</strong></span> },
                  ]} />
                  <div className="btn-row">
                    {peutApprouver && detail.statut === 'PROPOSEE' && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || detail.auteur === user?.id} onClick={() => void r.run(`${base}/actions/${detail.id}/approbation`, {}, detail.cibleId ? 'Approuvée : exécution par la file (contrôles refaits juste avant l’écriture).' : 'Brouillon approuvé : il peut être exporté.').then(() => ouvrir(detail.id))}>Approuver ce contenu exact</button>}
                    {peutApprouver && detail.statut === 'APPLIQUEE' && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`${base}/actions/${detail.id}/retour`, { motif: motif.trim() }, 'Version précédente rétablie.').then(() => ouvrir(detail.id))}>Revenir en arrière</button>}
                  </div>
                  {peutProposer && detail.statut === 'APPROUVEE' && !detail.cibleId && (
                    <div className="form">
                      <Field label="Où ce brouillon est publié (publication manuelle consignée)" value={destination} onChange={setDestination} />
                      <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || destination.trim().length < 3} onClick={() => void r.run(`${base}/actions/${detail.id}/export`, { destination: destination.trim() }, 'Export consigné.').then(() => ouvrir(detail.id))}>Consigner l’export</button></div>
                    </div>
                  )}
                  {mesure && 'avant' in mesure && (
                    <p className="small" data-testid="mesure">Mesure ({mesure.methode.toLowerCase()}) : avant {mesure.avant.visites} visites, {mesure.avant.cta} clics ; après {mesure.apres.visites} visites, {mesure.apres.cta} clics — {mesure.recommandation.replace(/_/g, ' ').toLowerCase()}. {mesure.note} ({mesure.statut})</p>
                  )}
                </section>
              )}
            </>
          )}

          {onglet === 'pages' && (pages.data?.items.length ? (
            <div className="stack-sm">
              {pages.data.items.map((p) => (
                <article key={p.id} className="card">
                  <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                    <strong>{p.surface === 'BLOG' ? `Article du blog : /blog/${p.slug}` : `/page/${p.slug}`}</strong>
                    <StatusBadge tone={p.statut === 'APPROUVEE' ? 'good' : 'warning'} label={p.statut === 'APPROUVEE' ? `Publiée — révision ${p.revisionActive}` : 'Brouillon (non public)'} />
                  </div>
                  <p className="small muted">{p.revisions.length} révision(s) conservée(s) · sujet {p.sujet}</p>
                  {p.statut === 'APPROUVEE' && <Link className="btn btn-ghost btn-sm" to={p.surface === 'BLOG' ? `/blog/${p.slug}` : `/page/${p.slug}`}>Voir la page publique</Link>}
                  {peutApprouver && p.statut === 'BROUILLON' && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`${base}/pages/${p.id}/approbation`, {}, 'Page publiée.')}>Publier (première approbation)</button>}
                </article>
              ))}
            </div>
          ) : <EmptyState title="Aucune page propre">Une page propre est créée puis approuvée par une personne distincte.</EmptyState>)}

          {onglet === 'sources' && installation && (
            <>
              <DataTable caption="Registre des sources" rows={installation.sources} rowKey={(s) => s.id} columns={[
                { key: 'l', label: 'Source', primary: true, render: (s) => <><strong>{s.libelle}</strong><span className="small muted" style={{ display: 'block' }}>{s.accesLibelle} · {s.cadence}</span></> },
                { key: 'f', label: 'Famille', render: (s) => s.famille },
                { key: 'o', label: 'Observations', num: true, render: (s) => s.observations },
                { key: 'e', label: 'État', render: (s) => (s.indisponible ? <span className="small">{s.indisponible}</span> : <StatusBadge tone={s.active ? 'good' : 'neutral'} label={s.active ? 'Active' : 'Inactive'} />) },
              ]} />
              {peutProposer && (
                <div className="form" style={{ marginTop: 16 }}>
                  <Area label="Import manuel (CSV : sujet;début AAAA-MM-JJ;fin AAAA-MM-JJ;valeur) — jamais de nom ni de téléphone" rows={4} value={csv} onChange={setCsv} />
                  <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" disabled={!csv.trim()} onClick={() => void importer()}>Importer</button></div>
                </div>
              )}
              <p className="small muted">Paramètres : {Object.entries(etat.data.parametres.valeurs).map(([k, v]) => `${k} ${v}`).join(' · ')} — {etat.data.parametres.statut}.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
