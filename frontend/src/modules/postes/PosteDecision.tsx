/**
 * Postes de décision des autorités (catalogue n° 41 « Postes de décision des autorités », ancien « Centre de commandement
 * exécutif » ; n° 44 « Postes ministériels », ancien « Tableaux de bord ministériels ») — Cahier nouvelle version, ch. 27.
 * L'écran s'ouvre sur ce qui attend une décision, toujours (écran 1 — Décider), sans aucun filtre ni période à choisir ;
 * les vues du menu sont l'écran 2 (Situer) ; le détail est atteint par un clic (écran 3 — Comprendre).
 * Les tableaux de bord existants restent disponibles (/gouverneur, /pilotage/tableaux, /decision/*).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../../context';
import { api, apiBlob, describeError } from '../../lib/api';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { visibleNav } from '../../components/Shell';
import {
  BandeauHorsLigne, Bloc, ChiffreView, FicheCard, Illustrations, MenuPoste, PhoneFrame, Reperes, ReglesEcrans, SixEtats, usePosteApi, useTempsRendu,
  type Chiffre, type Commun, type Fiche, type Illustration,
} from './common';

type Accueil = Commun & Record<string, unknown>;
interface Alerte { id: string; type: string; gravite: string; cause: string; ageJours: number; enjeu: Chiffre | null; lien: string }
interface ExecRow { id: string; acteLibelle: string; acteType: string; decision: { objet: string; date: string; autorite: string }; responsable: { libelle: string }; echeance: string; etat: string; etatLabel: string; joursRestants: number | null; enRetard: boolean; joursRetard: number; blocageLibelle: string | null; note?: string; exemple?: boolean; preuve?: { reference: string; publieLe?: string } }

// ————————————————————————— écran d'accueil par profil —————————————————————————

export function PosteGouverneur({ a, onDone }: { a: Accueil; onDone: () => void }) {
  const b1 = a.bloc1 as { titre: string; fiches: Fiche[] };
  const b2 = a.bloc2 as { titre: string; chiffres: Chiffre[] };
  const b3 = a.bloc3 as { titre: string; alertes: Alerte[]; total: number };
  const com = a.communes as { mesure: boolean; note: string; communes: { commune: string; couleur: string; tauxPct: string | null; lien: string }[] };
  const ill = a.illustrations ?? {};
  return (
    <>
      <Bloc titre="Ce qui attend votre décision" sous={a.entete.libelle} id="ps-b1">
        <Link to="/poste-de-decision/decisions" className="ps-entete"><strong>{a.entete.enAttente}</strong> en attente · <strong>{a.entete.urgentes}</strong> urgente{a.entete.urgentes > 1 ? 's' : ''}</Link>
        {b1.fiches.length ? b1.fiches.map((f) => <FicheCard key={f.id} f={f} onDone={onDone} />) : <EmptyState title="Aucune décision en attente" icon="check" />}
      </Bloc>
      <Bloc titre="La Ville aujourd’hui · exercice en cours" id="ps-b2">
        <div className="ps-grille">{b2.chiffres.map((c) => <ChiffreView key={c.code} c={c} grand />)}</div>
        <Illustrations items={ill.LA_VILLE} />
      </Bloc>
      <Bloc titre="Ce qui ne va pas" id="ps-b3">
        {b3.alertes.length ? <ul className="ps-alertes">{b3.alertes.map((x) => (
          <li key={x.id}><Link to={x.lien}><strong>{x.cause}</strong></Link><span className="ps-small"> — ouverte depuis {x.ageJours} j · <Link to="/audit">saisir l’audit</Link></span>{x.enjeu && <ChiffreView c={x.enjeu} />}</li>
        ))}</ul> : <p className="ps-small">Aucune alerte au-delà des seuils dans votre périmètre.</p>}
        <Illustrations items={ill.CE_QUI_NE_VA_PAS} />
      </Bloc>
      <Bloc titre="Communes" sous={com.note} id="ps-b4">
        <Link to="/poste-de-decision/communes" className="ps-vignette" aria-label="Carte des communes, couleur selon l’écart à l’objectif">
          {com.communes.map((c) => <span key={c.commune} className={`ps-commune c-${c.couleur.toLowerCase()}`} title={`${c.commune} : ${c.tauxPct ?? 'non mesuré'} %`}>{c.commune.slice(0, 3)}</span>)}
        </Link>
        <Illustrations items={ill.COMMUNES} />
      </Bloc>
    </>
  );
}

function PosteCabinet({ a, onDone }: { a: Accueil; onDone: () => void }) {
  const fi = a.fileInstruction as { libelle: string; texte: string };
  const items = a.aTraiter as { id: string; objet: string; etatLabel: string; etat: string; detail: string; position: string | null; exemple: boolean; reexamenLe?: string }[];
  const suivi = a.decidePasExecute as { id: string; objet: string; jalon: string; detail: string; enRetard: boolean }[];
  const cg = a.corbeilleGouverneur as { chiffre: Chiffre };
  return (
    <>
      <Bloc titre="File d’instruction" sous={fi.libelle}>
        <p className="ps-small">{fi.texte}</p>
        <ChiffreView c={cg.chiffre} />
      </Bloc>
      <Bloc titre="À traiter">
        <ul className="ps-liste">{items.map((i) => (
          <li key={i.id}><strong>{i.objet}</strong> <StatusBadge tone={i.etat === 'INSTRUIT' ? 'good' : i.etat === 'INCOMPLET' ? 'critical' : 'warning'} label={i.etatLabel} />
            <span className="ps-small"> {i.detail}{i.position ? ` · ${i.position}` : ''}{i.reexamenLe ? ` · réexamen le ${i.reexamenLe}` : ''}{i.exemple ? ' · [EXEMPLE]' : ''}</span></li>
        ))}</ul>
        <Link to="/poste-de-decision/instruction" className="btn btn-secondary btn-sm">Instruire : renvoyer, réclamer une pièce, reformuler</Link>
        <Illustrations items={a.illustrations?.FILE_INSTRUCTION} />
      </Bloc>
      <Bloc titre="Décidé, pas encore exécuté">
        <ul className="ps-liste">{suivi.map((s) => <li key={s.id}><strong>{s.objet}</strong> <StatusBadge tone={s.enRetard ? 'critical' : 'info'} label={s.jalon} /><span className="ps-small"> {s.detail}</span></li>)}</ul>
      </Bloc>
      {(a.fiches as Fiche[]).length > 0 && <Bloc titre="Ma corbeille">{(a.fiches as Fiche[]).map((f) => <FicheCard key={f.id} f={f} onDone={onDone} />)}</Bloc>}
      <p className="ps-small">{String(a.traceNote ?? '')}</p>
    </>
  );
}

function TableExecution({ rows, onDone }: { rows: ExecRow[]; onDone?: () => void }) {
  const [motif, setMotif] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function relancer(id: string) {
    try { await api(`/v1/postes/executions/${id}/relance`, { method: 'POST', body: { motif } }); setMsg('Relance nominative enregistrée.'); onDone?.(); } catch (e) { setMsg(describeError(e).message); }
  }
  return (
    <>
      <ul className="ps-liste">{rows.map((r) => (
        <li key={r.id}>
          <strong>{r.acteLibelle}</strong> <StatusBadge tone={r.etat === 'EXECUTE' ? 'good' : r.enRetard ? 'critical' : 'info'} label={r.enRetard && r.etat !== 'EXECUTE' ? `Retard ${r.joursRetard} j` : r.etat === 'EXECUTE' ? 'Exécuté' : `Échéance ${r.echeance}`} />
          <span className="ps-small"> Décidé le {r.decision.date.slice(0, 10)} ({r.decision.autorite}) · {r.acteType} · {r.responsable.libelle} · {r.etatLabel}{r.note ? ` · ${r.note}` : ''}{r.blocageLibelle ? ` · ${r.blocageLibelle}` : ''}{r.preuve ? ` · ${r.preuve.reference}` : ''}{r.exemple ? ' · [EXEMPLE]' : ''}</span>
          {r.etat !== 'EXECUTE' && !r.id.startsWith('INSTR:') && <button type="button" className="btn btn-ghost btn-sm" disabled={motif.trim().length < 10} onClick={() => void relancer(r.id)}>Relancer nommément</button>}
        </li>
      ))}</ul>
      <label className="label">Motif de relance (10 caractères au moins)<textarea rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} /></label>
      {msg && <p className="ps-small" role="status">{msg}</p>}
    </>
  );
}

function PosteSecretariat({ a, onDone }: { a: Accueil; onDone: () => void }) {
  const ind = a.indicateur as { principal: Chiffre; periode: string; retards: { total: number; auDela30: number } };
  return (
    <>
      <Bloc titre="Ce qui a été décidé est-il fait ?">
        <div className="ps-grille">
          <ChiffreView c={ind.principal} grand />
          <div className="ps-chiffre"><span className="ps-valeur ps-valeur-grand">{ind.retards.total}</span><span className="ps-libelle">Actes en retard</span><span className="ps-small">Dont {ind.retards.auDela30} au-delà de 30 jours · {ind.periode}</span></div>
        </div>
        <Illustrations items={a.illustrations?.INDICATEUR} />
      </Bloc>
      <Bloc titre="Actes à produire"><TableExecution rows={a.actes as ExecRow[]} onDone={onDone} /></Bloc>
      <p className="ps-small">{String(a.phrase)}</p>
    </>
  );
}

function PosteMinistre({ a, onDone }: { a: Accueil; onDone: () => void }) {
  const d = a.mesDecisions as { libelle: string; fiches: Fiche[] };
  const fin = a.finances as { seuilsDelegation: { id: string; valeur: number; statut: string; modification: string; lien: string }[]; arbitrageAssignations: { enAttente: number; ecart: Chiffre; lien: string } } | undefined;
  return (
    <>
      <Bloc titre="Mes décisions" sous={d.libelle}>{d.fiches.length ? d.fiches.map((f) => <FicheCard key={f.id} f={f} onDone={onDone} />) : <EmptyState title="Aucune décision de mon périmètre" icon="check" />}</Bloc>
      <Bloc titre="Mes recettes · face aux objectifs">
        <div className="ps-grille">{(a.mesRecettes as Chiffre[]).map((c) => <ChiffreView key={c.code} c={c} />)}</div>
        <Illustrations items={a.illustrations?.MES_RECETTES as Illustration[] | undefined} />
      </Bloc>
      <Bloc titre="Mes exceptions">
        <ul className="ps-liste">{(a.mesExceptions as { titre: string; detail: string }[]).map((x) => <li key={x.titre}><strong>{x.titre}</strong><span className="ps-small"> — {x.detail}</span></li>)}</ul>
        <Illustrations items={a.illustrations?.MES_EXCEPTIONS as Illustration[] | undefined} />
      </Bloc>
      {fin && (
        <Bloc titre="Compétences propres du ministre des Finances">
          <p><Link to={fin.arbitrageAssignations.lien}>Arbitrage des assignations</Link> — {fin.arbitrageAssignations.enAttente} en attente</p>
          <ChiffreView c={fin.arbitrageAssignations.ecart} />
          <p><Link to="/tresor">Vue consolidée de trésorerie</Link></p>
          {fin.seuilsDelegation.map((s) => <p key={s.id} className="ps-small">Seuil de délégation (exonération, dégrèvement) : {s.valeur.toLocaleString('fr-FR')} CDF — {s.statut}. <Link to={s.lien}>{s.modification}</Link></p>)}
        </Bloc>
      )}
      <p className="ps-small">{String(a.phrase)} <Link to="/decision/ministere">Tableau ministériel détaillé (module 44)</Link></p>
    </>
  );
}

function PosteAutorite({ a }: { a: Accueil }) {
  const rec = a.recettes as Chiffre[];
  const cat = a.parCategorie as Chiffre[];
  const real = a.realisations as { items: { titre: string; statut: string; commune: string }[]; lien: string; note: string };
  return (
    <>
      <p className="ps-bandeau" role="note">{String(a.bandeau)}</p>
      <Bloc titre="Recettes provinciales"><div className="ps-grille">{rec.map((c) => <ChiffreView key={c.code} c={c} grand />)}</div><Illustrations items={a.illustrations?.RECETTES} /></Bloc>
      <Bloc titre="Par catégorie" sous="part de l’objectif de l’exercice">{cat.length ? <div className="ps-grille">{cat.map((c) => <ChiffreView key={c.code} c={c} />)}</div> : <p className="ps-small">Aucune recette rapprochée par catégorie dans le périmètre déclaré.</p>}<Illustrations items={a.illustrations?.PAR_CATEGORIE} /></Bloc>
      <Bloc titre="Réalisations financées">{real.items.length ? <ul className="ps-liste">{real.items.map((r) => <li key={r.titre + r.commune}><strong>{r.titre}</strong> — {r.statut} · {r.commune}</li>)}</ul> : <p className="ps-small">{real.note}</p>}<Link to={real.lien}>Tableau public de transparence</Link><Illustrations items={a.illustrations?.REALISATIONS} /></Bloc>
      <p className="ps-small">{String(a.phrase)}</p>
    </>
  );
}

function PosteDirection({ a, onDone }: { a: Accueil; onDone: () => void }) {
  const t = a.travail as { lien: string; note: string; enAttente: number };
  return (
    <>
      <Bloc titre="Ce qui relève de votre signature" sous={a.entete.libelle}>{(a.fiches as Fiche[]).length ? (a.fiches as Fiche[]).map((f) => <FicheCard key={f.id} f={f} onDone={onDone} />) : <EmptyState title="Aucune décision en attente" icon="check" />}</Bloc>
      <Bloc titre="File de travail (poste de travail)"><p className="ps-small">{t.note}</p><Link className="btn btn-secondary btn-sm" to={t.lien}>Ouvrir la file de travail ({t.enAttente})</Link></Bloc>
    </>
  );
}

export function AccueilPoste({ a, onDone }: { a: Accueil; onDone: () => void }) {
  switch (a.profil) {
    case 'GOUVERNEUR': return <PosteGouverneur a={a} onDone={onDone} />;
    case 'DIRECTEUR_CABINET': return <PosteCabinet a={a} onDone={onDone} />;
    case 'SECRETAIRE_EXECUTIF': return <PosteSecretariat a={a} onDone={onDone} />;
    case 'MINISTRE': return <PosteMinistre a={a} onDone={onDone} />;
    case 'AUTORITE_HABILITEE': return <PosteAutorite a={a} />;
    default: return <PosteDirection a={a} onDone={onDone} />;
  }
}

// ————————————————————————— vues du menu (écran 2) et détail (écran 3) —————————————————————————

function VueGenerique({ vue, d, onDone }: { vue: string; d: Record<string, unknown>; onDone: () => void }) {
  const fiches = (d.fiches ?? d.corbeille) as (Fiche & { rang?: number })[] | undefined;
  const chiffres = [...((d.sixEtats as Chiffre[] | undefined) ?? []), ...((d.parCategorie as Chiffre[] | undefined) ?? []), ...((d.parCommune as Chiffre[] | undefined) ?? [])];
  const [msg, setMsg] = useState<string | null>(null);
  const [motif, setMotif] = useState('');
  const [reexamen, setReexamen] = useState('');
  async function post(path: string, body: unknown, ok: string) {
    try { await api(path, { method: 'POST', body }); setMsg(ok); onDone(); } catch (e) { const x = describeError(e); setMsg(x.message + (x.code ? ` (${x.code})` : '')); }
  }
  return (
    <div className="ps-vue">
      {msg && <p className="ps-small" role="status">{msg}</p>}
      {fiches && vue !== 'ordre-du-jour' && (fiches.length ? fiches.map((f) => <FicheCard key={f.id} f={f} onDone={onDone} />) : <EmptyState title="Aucune fiche" icon="check" />)}
      {vue === 'ordre-du-jour' && fiches && (
        <Bloc titre="Ordre du jour du Gouverneur" sous={`${String(d.taille)} élément(s) · cible ${String(d.cible)}`}>
          <label className="label">Motif (obligatoire, enregistré)<textarea rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} /></label>
          <label className="label">Date de réexamen (pour « Différer »)<input type="date" value={reexamen} onChange={(e) => setReexamen(e.target.value)} /></label>
          <ol className="ps-liste">{fiches.map((f) => (
            <li key={f.id}><strong>{f.objet}</strong>
              <span className="btn-row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void post('/v1/postes/cabinet/ordre-du-jour', { ficheId: f.id, action: 'MONTER', motif }, 'Dossier monté.')}>Monter</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void post('/v1/postes/cabinet/ordre-du-jour', { ficheId: f.id, action: 'DESCENDRE', motif }, 'Dossier descendu.')}>Descendre</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void post('/v1/postes/cabinet/ordre-du-jour', { ficheId: f.id, action: 'DIFFERER', motif, reexamenLe: reexamen }, 'Dossier différé.')}>Différer</button>
              </span></li>
          ))}</ol>
          {(d.differes as { id: string; objet: string; reexamenLe: string }[]).map((x) => <p key={x.id} className="ps-small">Différé : {x.objet} — réexamen le {x.reexamenLe}</p>)}
        </Bloc>
      )}
      {vue === 'instruction' && (
        <Bloc titre="Instruction" sous={`Prêts pour le Gouverneur : ${String(d.pretsPourGouverneur)}`}>
          <label className="label">Motif (obligatoire, enregistré)<textarea rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} /></label>
          <ul className="ps-liste">{(d.items as { id: string; dossierId: string | null; objet: string; etat: string; etatLabel: string; detail: string }[]).map((i) => (
            <li key={i.id}><strong>{i.objet}</strong> <StatusBadge tone={i.etat === 'INSTRUIT' ? 'good' : i.etat === 'INCOMPLET' ? 'critical' : 'warning'} label={i.etatLabel} /><span className="ps-small"> {i.detail}</span>
              {i.dossierId && <span className="btn-row">{['TRANSMETTRE', 'RENVOYER', 'RECLAMER_PIECE', 'REFORMULER'].map((ac) => (
                <button key={ac} type="button" className="btn btn-ghost btn-sm" onClick={() => void post(`/v1/postes/cabinet/dossiers/${i.dossierId}/preparation`, { action: ac, motif }, 'Geste de préparation enregistré.')}>
                  {{ TRANSMETTRE: 'Transmettre au Gouverneur', RENVOYER: 'Renvoyer au service', RECLAMER_PIECE: 'Réclamer une pièce', REFORMULER: 'Demander une reformulation' }[ac]}
                </button>))}</span>}
            </li>))}</ul>
        </Bloc>
      )}
      {(vue === 'suivi') && <Bloc titre="Décidé, pas encore exécuté"><ul className="ps-liste">{(d.decidePasExecute as { id: string; objet: string; jalon: string; detail: string }[]).map((s) => <li key={s.id}><strong>{s.objet}</strong> — {s.jalon}<span className="ps-small"> {s.detail}</span></li>)}</ul></Bloc>}
      {(vue === 'execution' || vue === 'mes-engagements') && <Bloc titre={vue === 'execution' ? 'Exécution' : 'Mes engagements'}><TableExecution rows={(d.actes ?? d.engagements) as ExecRow[]} onDone={onDone} /></Bloc>}
      {vue === 'retards' && <Bloc titre="Retards" sous={String(d.regle)}><TableExecution rows={d.retards as ExecRow[]} onDone={onDone} /></Bloc>}
      {vue === 'documentation' && <Bloc titre="Documentation"><ul className="ps-liste">{(d.documents as { id: string; acte: string; libelle: string; reference: string | null; version: string | null; publieLe: string | null; etat: string }[]).map((x) => <li key={x.id}><strong>{x.acte} — {x.libelle}</strong><span className="ps-small"> {x.reference ?? 'référence à produire'} · version {x.version ?? '—'} · publié le {x.publieLe ?? '—'} · {x.etat}</span></li>)}</ul></Bloc>}
      {(vue === 'coordination') && (
        <Bloc titre="Coordination" sous={String(d.note ?? 'sans accès aux dossiers individuels')}>
          <ul className="ps-liste">{((d.services ?? d.interservices) as { entity: string; nom: string; enAttente: number; instructionsEnRetard: number; actesEnRetard: number }[]).map((s) => <li key={s.entity}><strong>{s.nom}</strong><span className="ps-small"> — {s.enAttente} en attente · {s.instructionsEnRetard} instruction(s) en retard · {s.actesEnRetard} acte(s) en retard</span></li>)}</ul>
          {(d.actions as { libelle: string; lien: string }[] | undefined)?.map((x) => <Link key={x.lien} to={x.lien} className="btn btn-ghost btn-sm">{x.libelle}</Link>)}
          {(d.calendrierInstitutionnel as { instance: string; frequence: string; prochaine: string | null }[] | undefined)?.map((c) => <p key={c.instance} className="ps-small">{c.instance} ({c.frequence}) — prochaine : {c.prochaine ?? 'à fixer'}</p>)}
        </Bloc>
      )}
      {vue === 'mes-services' && <Bloc titre="Mes services" sous={String(d.note)}><ul className="ps-liste">{(d.services as { entity: string; nom: string; enAttente: number; instructionsEnRetard: number; actesEnRetard: number }[]).map((s) => <li key={s.entity}><strong>{s.nom}</strong><span className="ps-small"> — {s.enAttente} en attente · {s.instructionsEnRetard} instruction(s) en retard · {s.actesEnRetard} acte(s) en retard</span></li>)}</ul></Bloc>}
      {vue === 'mes-exceptions' && <Bloc titre="Mes exceptions"><ul className="ps-liste">{(d.exceptions as { titre: string; detail: string; instruction: string }[]).map((x, k) => <li key={k}><strong>{x.titre}</strong><span className="ps-small"> — {x.detail} · {x.instruction}</span></li>)}</ul></Bloc>}
      {vue === 'alertes' && (
        <>
          <Bloc titre="Déperditions">{(d.deperditions as Alerte[]).length ? <ul className="ps-alertes">{(d.deperditions as Alerte[]).map((x) => <li key={x.id}><strong>{x.cause}</strong><span className="ps-small"> — {x.ageJours} j</span>{x.enjeu && <ChiffreView c={x.enjeu} />}</li>)}</ul> : <p className="ps-small">Aucune alerte de déperdition.</p>}</Bloc>
          <Bloc titre="Fraudes en cours d’instruction"><p>{(d.fraudesEnInstruction as { nombre: number; note: string }).nombre} dossier(s) <span className="ps-small">— {(d.fraudesEnInstruction as { note: string }).note}</span></p></Bloc>
          <Bloc titre="Délais dépassés"><ul className="ps-liste">{(d.delaisDepasses as { type: string; objet: string; echeance: string; lien: string }[]).map((x) => <li key={x.objet}><Link to={x.lien}>{x.objet}</Link><span className="ps-small"> — échéance {x.echeance}</span></li>)}</ul></Bloc>
        </>
      )}
      {vue === 'communes' && (
        <Bloc titre="Communes" sous={String(d.note)}>
          <ol className="ps-liste">{(d.classement as { commune: string; tauxPct: string | null; couleur: string; couverture: Chiffre; responsable: { nom: string; role: string; interpeller: string } | null }[]).map((c) => (
            <li key={c.commune}><strong>{c.commune}</strong> <span className={`ps-commune c-${c.couleur.toLowerCase()}`}>{c.tauxPct ?? '—'} %</span><ChiffreView c={c.couverture} />
              {c.responsable && <span className="ps-small">Responsable : {c.responsable.nom} ({c.responsable.role}) — <Link to={c.responsable.interpeller}>interpeller</Link></span>}</li>
          ))}</ol>
        </Bloc>
      )}
      {vue === 'mon-habilitation' && (
        <Bloc titre="Mon habilitation">
          <p>Périmètre : {(d.habilitation as { perimetre: { libelle: string } }).perimetre.libelle} · valable jusqu’au {(d.habilitation as { au: string }).au} ({String(d.expireDans)} jours)</p>
          <p className="ps-small">{String(d.regle)}</p>
          <ul className="ps-liste">{(d.consultations as { id: string; at: string; vue: string }[]).map((c) => <li key={c.id}>{new Date(c.at).toLocaleString('fr-FR')} — {c.vue}</li>)}</ul>
        </Bloc>
      )}
      {vue === 'realisations' && <Bloc titre="Réalisations"><p className="ps-small">{String(d.note)}</p><ul className="ps-liste">{(d.items as { titre: string; statut: string; commune: string }[]).map((r) => <li key={r.titre + r.commune}>{r.titre} — {r.statut} · {r.commune}</li>)}</ul><Link to="/transparence">Tableau public de transparence</Link></Bloc>}
      {chiffres.length > 0 && <Bloc titre="Chiffres" sous="état, date, taux et source sur chacun"><div className="ps-grille">{chiffres.map((c) => <ChiffreView key={c.code} c={c} />)}</div></Bloc>}
      {d.historique !== undefined && vue !== 'mes-decisions' && (
        <Bloc titre="Historique de mes décisions">
          <ul className="ps-liste">{(d.historique as { id: string; at: string; geste: string; objet: string; motif: string; parDelegationDe?: string }[]).map((g) => <li key={g.id}>{g.at.slice(0, 10)} — {g.geste} — {g.objet}<span className="ps-small"> · {g.motif}{g.parDelegationDe ? ` · par délégation de ${g.parDelegationDe}` : ''}</span></li>)}</ul>
        </Bloc>
      )}
    </div>
  );
}

function Recherche() {
  const { user } = useApp();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ type: string; libelle: string; lien: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Écrans de la plateforme accessibles au titre des habilitations (le menu reste court : on les atteint par la recherche).
  const ecrans = visibleNav(user?.roles).filter((n) => q.trim().length >= 2 && (n.label ?? n.to).toLowerCase().includes(q.trim().toLowerCase())).map((n) => ({ type: 'ÉCRAN', libelle: n.label ?? n.to, lien: n.to }));
  async function chercher() {
    setErr(null);
    try { setRes((await api<{ resultats: { type: string; libelle: string; lien: string }[] }>(`/v1/postes/recherche?q=${encodeURIComponent(q)}`)).resultats); } catch (e) { setErr(describeError(e).message); }
  }
  return (
    <Bloc titre="Rechercher" sous="une commune, une recette, un dossier, une décision">
      <form className="ps-search" onSubmit={(e) => { e.preventDefault(); void chercher(); }}>
        <input type="search" aria-label="Rechercher" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Commune, recette, dossier, décision, écran…" />
        <button type="submit" className="btn btn-primary btn-sm" disabled={q.trim().length < 2}>Rechercher</button>
      </form>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <ul className="ps-liste">{[...res, ...ecrans].map((r, k) => <li key={k}><StatusBadge tone="neutral" label={r.type} /> <Link to={r.lien}>{r.libelle}</Link></li>)}</ul>
    </Bloc>
  );
}

export function NoteLundi() {
  const n = usePosteApi<{ courante: { id: string; sha256: string; version: number; produiteLe: string; contenu: { titre: string; semaine: { code: string; lundi: string; dimanche: string }; arreteAu: string; recettes: Chiffre[]; decisions: { date: string; geste: string; objet: string; effet: string; parDelegationDe?: string }[]; communes: { base: string; enAvance: { commune: string; valeur: string | null }[]; enRetard: { commune: string; valeur: string | null }[] }; alertes: { cause: string; ageJours: number }[]; echeances7j: { objet: string; echeance: string }[]; remontees: { objet: string; raisons: string[] }[]; indicateursHorsCible: { code: string; libelle: string; valeur: string | null; cible: string }[]; sources: string[]; ia: string } }; historique: { id: string; semaine: { code: string }; version: number; sha256: string; produiteLe: string }[]; horsConnexion: string }>('/v1/postes/notes', 'note');
  async function imprimer(id: string) {
    const blob = await apiBlob(`/v1/postes/notes/${id}/impression`);
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
  }
  if (n.loading && !n.data) return <Loading />;
  if (n.error) return <ErrorState error={n.error} onRetry={n.reload} />;
  if (!n.data) return null;
  const c = n.data.courante.contenu;
  return (
    <div className="ps-note">
      <BandeauHorsLigne depuis={n.horsLigne} />
      <Bloc titre={`${c.titre} — semaine ${c.semaine.code}`} sous={`du ${c.semaine.lundi} au ${c.semaine.dimanche}, arrêtée au ${c.arreteAu}`}>
        <p className="ps-small">Produite le {new Date(n.data.courante.produiteLe).toLocaleString('fr-FR')} · version {n.data.courante.version} · empreinte SHA-256 <code>{n.data.courante.sha256.slice(0, 16)}…</code> · {c.ia}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void imprimer(n.data!.courante.id)}>Imprimer ou enregistrer en PDF</button>
      </Bloc>
      <Bloc titre="Décisions prises et leurs effets">{c.decisions.length ? <ul className="ps-liste">{c.decisions.map((d, k) => <li key={k}>{d.date} — {d.geste} — {d.objet} : <strong>{d.effet}</strong>{d.parDelegationDe ? ` (par délégation de ${d.parDelegationDe})` : ''}</li>)}</ul> : <p className="ps-small">Aucune décision cette semaine.</p>}</Bloc>
      <Bloc titre="Recettes de la semaine dans les six états"><div className="ps-grille">{c.recettes.map((x) => <ChiffreView key={x.code} c={x} />)}</div></Bloc>
      <Bloc titre="Communes" sous={c.communes.base}><p>En avance : {c.communes.enAvance.map((x) => x.commune).join(', ') || '—'}</p><p>En retard : {c.communes.enRetard.map((x) => x.commune).join(', ') || '—'}</p></Bloc>
      <Bloc titre="Alertes ouvertes et leur ancienneté">{c.alertes.length ? <ul className="ps-liste">{c.alertes.map((a, k) => <li key={k}>{a.cause} — {a.ageJours} j</li>)}</ul> : <p className="ps-small">Aucune.</p>}</Bloc>
      <Bloc titre="Décisions attendues dans les sept jours">{c.echeances7j.length ? <ul className="ps-liste">{c.echeances7j.map((e, k) => <li key={k}>{e.echeance} — {e.objet}</li>)}</ul> : <p className="ps-small">Aucune.</p>}</Bloc>
      {c.remontees.length > 0 && <Bloc titre="Éléments remontés"><ul className="ps-liste">{c.remontees.map((r, k) => <li key={k}>{r.objet} — {r.raisons.join(' ; ')}</li>)}</ul></Bloc>}
      {c.indicateursHorsCible.length > 0 && <Bloc titre="Indicateurs hors cible"><ul className="ps-liste">{c.indicateursHorsCible.map((k) => <li key={k.code}>{k.libelle} : {k.valeur ?? 'non mesuré'} (cible : {k.cible})</li>)}</ul></Bloc>}
      <Bloc titre="Sources"><p className="ps-small">{c.sources.join(' · ')}</p><p className="ps-small">{n.data.horsConnexion}</p></Bloc>
      <Bloc titre="Historique des notes"><ul className="ps-liste">{n.data.historique.map((h) => <li key={h.id}>{h.semaine.code} · v{h.version} · {new Date(h.produiteLe).toLocaleString('fr-FR')} · <code>{h.sha256.slice(0, 12)}</code></li>)}</ul></Bloc>
    </div>
  );
}

function Detail({ id, onDone }: { id: string; onDone: () => void }) {
  const [finalite, setFinalite] = useState('');
  const [path, setPath] = useState(`/v1/postes/fiches/${encodeURIComponent(id)}`);
  const d = usePosteApi<{ fiche: Fiche; historique: { id: string; at: string; geste: string; motif: string }[] }>(path, `fiche.${id}`);
  if (d.loading && !d.data) return <Loading />;
  if (d.error) {
    const e = describeError(d.error);
    if (e.code === 'FINALITE_REQUISE') {
      return (
        <Bloc titre="Dossier nominatif" sous="finalité déclarée, enregistrée et journalisée">
          <label className="label">Finalité de la consultation<textarea rows={2} value={finalite} onChange={(ev) => setFinalite(ev.target.value)} /></label>
          <button type="button" className="btn btn-primary btn-sm" disabled={finalite.trim().length < 10} onClick={() => setPath(`/v1/postes/fiches/${encodeURIComponent(id)}?finalite=${encodeURIComponent(finalite)}`)}>Déclarer et consulter</button>
        </Bloc>
      );
    }
    return <ErrorState error={d.error} onRetry={d.reload} />;
  }
  if (!d.data) return null;
  return (
    <>
      <BandeauHorsLigne depuis={d.horsLigne} />
      <FicheCard f={d.data.fiche} onDone={() => { d.reload(); onDone(); }} lienDetail={false} />
      <p><Link to={d.data.fiche.ecran}>Ouvrir l’écran de la source</Link></p>
      {d.data.historique.length > 0 && <Bloc titre="Historique"><ul className="ps-liste">{d.data.historique.map((g) => <li key={g.id}>{g.at.slice(0, 16)} — {g.geste} — {g.motif}</li>)}</ul></Bloc>}
    </>
  );
}

function Delegations() {
  const d = usePosteApi<{ items: { id: string; delegant: string; delegataire: string; delegantId: string; categorieLibelle: string; perimetre: string; debut: string; fin: string; statut: string; motif: string; ficheId?: string }[] }>('/v1/postes/delegations', 'delegations');
  const { user } = useApp();
  const [motif, setMotif] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function revoquer(id: string) {
    try { await api(`/v1/postes/delegations/${id}/revocation`, { method: 'POST', body: { motif } }); setMsg('Délégation révoquée.'); d.reload(); } catch (e) { setMsg(describeError(e).message); }
  }
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorState error={d.error} onRetry={d.reload} />;
  return (
    <Bloc titre="Délégations" sous="personne nommée, durée déterminée, périmètre déclaré ; expiration automatique">
      <p className="ps-small">Pour décider les éléments d’un module source, le délégataire utilise ses propres droits, ou une délégation de rôle approuvée par une personne distincte (<Link to="/acces/delegations">Accès et délégations, module 51</Link>).</p>
      {d.data?.items.length ? <ul className="ps-liste">{d.data.items.map((x) => (
        <li key={x.id}><strong>{x.categorieLibelle}</strong> — {x.delegant} → {x.delegataire} <StatusBadge tone={x.statut === 'ACTIVE' ? 'good' : x.statut === 'PROGRAMMEE' ? 'info' : 'neutral'} label={x.statut} />
          <span className="ps-small"> du {x.debut} au {x.fin} · {x.perimetre} · {x.motif}</span>
          {x.delegantId === user?.id && (x.statut === 'ACTIVE' || x.statut === 'PROGRAMMEE') && <button type="button" className="btn btn-ghost btn-sm" disabled={motif.trim().length < 10} onClick={() => void revoquer(x.id)}>Révoquer</button>}
        </li>))}</ul> : <EmptyState title="Aucune délégation" icon="users" />}
      <label className="label">Motif de révocation (10 caractères au moins)<textarea rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} /></label>
      {msg && <p className="ps-small" role="status">{msg}</p>}
    </Bloc>
  );
}

function IndicateursCorbeilles() {
  const d = usePosteApi<{ regle: string; seuil: number; jours: number; statut: string; autorites: { userId: string; nom: string; role: string; taille: number; joursConsecutifsAuDela: number; alerte: boolean; chiffre: Chiffre }[] }>('/v1/postes/indicateurs', 'indicateurs');
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorState error={d.error} onRetry={d.reload} />;
  if (!d.data) return null;
  return (
    <Bloc titre="Taille des corbeilles" sous={`alerte au-delà de ${d.data.seuil} éléments pendant ${d.data.jours} jours (${d.data.statut})`}>
      <p className="ps-small">{d.data.regle}</p>
      <ul className="ps-liste">{d.data.autorites.map((x) => <li key={x.userId}><strong>{x.nom}</strong> ({x.role}) {x.alerte && <StatusBadge tone="critical" label="Revoir les seuils de délégation" />}<ChiffreView c={x.chiffre} /></li>)}</ul>
    </Bloc>
  );
}

export default function PosteDecision() {
  const { vue, id } = useParams();
  const { user } = useApp();
  const acc = usePosteApi<Accueil>('/v1/postes/accueil', 'accueil');
  const sousVue = vue && !['fiche', 'note', 'rechercher', 'delegations', 'indicateurs'].includes(vue) ? vue : null;
  const v = usePosteApi<Record<string, unknown>>(sousVue ? `/v1/postes/vues/${sousVue}` : null, `vue.${sousVue ?? ''}`);
  const tempsMs = useTempsRendu(!!acc.data);
  const reload = () => { acc.reload(); v.reload(); };
  if (acc.loading && !acc.data) return <div className="page"><Loading /></div>;
  if (acc.error) return <div className="page"><ErrorState error={acc.error} onRetry={acc.reload} /><p><Link to="/poste-de-travail">Poste de travail</Link></p></div>;
  if (!acc.data) return null;
  const a = acc.data;
  const titre = String((a as Record<string, unknown>).titre ?? 'Poste de décision');
  return (
    <div className="page ps-page" data-temps-rendu={tempsMs ?? undefined}>
      <PhoneFrame titre={titre}>
        <BandeauHorsLigne depuis={acc.horsLigne} />
        <MenuPoste menu={a.menu} actif={vue} />
        {!vue && <AccueilPoste a={a} onDone={reload} />}
        {vue === 'fiche' && id && <Detail id={id} onDone={reload} />}
        {vue === 'note' && <NoteLundi />}
        {vue === 'rechercher' && <Recherche />}
        {vue === 'delegations' && <Delegations />}
        {vue === 'indicateurs' && <IndicateursCorbeilles />}
        {sousVue && (v.loading && !v.data ? <Loading /> : v.error ? <ErrorState error={v.error} onRetry={v.reload} /> : v.data ? <><BandeauHorsLigne depuis={v.horsLigne} /><VueGenerique vue={sousVue} d={v.data} onDone={reload} /></> : null)}
        {a.profil !== 'AUTORITE_HABILITEE' && <p className="ps-liens"><Link to="/poste-de-decision/note">La note du lundi (hors connexion)</Link> · <Link to="/poste-de-decision/delegations">Mes délégations</Link>{user?.roles.includes('R01') && <> · <Link to="/gouverneur">Tableau de bord du Gouverneur</Link></>}</p>}
        <Reperes items={a.reperes} />
        <SixEtats etats={a.sixEtats} />
      </PhoneFrame>
      <ReglesEcrans regles={a.regles} sixEtats={a.sixEtats} pied={a.pied} />
    </div>
  );
}
