/**
 * Postes de décision (Cahier nouvelle version, ch. 27, et maquettes des cinq postes) — composants communs :
 * cadre « téléphone » (360 px d'abord), chiffre jamais nu (§ 27.10), fiche de décision à neuf blocs (§ 27.3) avec ses
 * quatre issues motivées, repères, bloc commun des règles, illustrations [EXEMPLE] distinctes des chiffres calculés,
 * consultation hors connexion (note du lundi et fiches en attente conservées sur l'appareil, par utilisateur).
 * Le serveur reste seul juge des droits : l'interface n'affiche qu'une aide.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useEcranAccessible } from '../../components/LienEcran';
import { useApp } from '../../context';
import { api, describeError, NetworkError, safeGet, safeSet } from '../../lib/api';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { annoncer } from '../../lib/annonce';
import { Icon } from '../../components/Icon';
import './postes.css';

// ————————————————————————— types des charges utiles —————————————————————————

export interface Chiffre {
  code: string; libelle: string; valeur: string | null; unite: string; etat: string; etatLabel: string; estimation: boolean; date: string;
  equivalents?: { CDF: string | null; USD: string | null }; taux?: { devise: string; cdfParUnite: string; date: string; source: string; nature: string };
  comparaison: { type: string; libelle: string; valeur: string | null; ecart: string | null; tendance: string };
  deltaDuJour?: string | null; hypotheses?: string[]; source: { libelle: string; chemin: string[]; api: string }; exemple?: boolean; mention?: string;
}
export interface ActionFiche { code: 'APPROUVER' | 'REFUSER' | 'DELEGUER' | 'COMPLEMENT'; libelle: string; possible: boolean; raison?: string; motifObligatoire: true }
export interface Fiche {
  id: string; source: string; module: string; categorie: { code: string; libelle: string; niveau: string } | null; presence: string[];
  remontee?: { niveau: number; raisons: string[] }; delegation?: { id: string; delegantId: string; delegant: string; source: string };
  objet: string; demandeur: { id: string | null; libelle: string; serviceInstructeur: string; validationAmont: string | null };
  enjeu: { texte: string; chiffres: Chiffre[]; nombre: string | null; commune: string | null; figures: { libelle: string; valeur: string; unite: string }[] };
  echeance: { date: string; joursRestants: number; urgente: boolean; enRetard: boolean; consequenceSilence: string };
  fondement: string[]; position: { recommandation: string; reserves: string[] }; siRienNestDecide: string;
  pieces: { replie: true; nombre: number; items: { libelle: string; reference?: string; sha256?: string }[] };
  actions: ActionFiche[]; delegationSuggeree?: { userId: string; libelle: string }; individuel: boolean; information: boolean; gravite: string;
  complements: { at: string; motif: string; repondu: boolean }[]; ecran: string; exemple: boolean; enjeuCdf: string;
}
export interface MenuEntree { code: string; libelle: string; ouvre: string; pourquoi: string }
export interface Repere { valeur: string; libelle: string }
export interface Illustration extends Partial<Chiffre> { texte?: { titre: string; detail: string; enjeu?: string }; exemple: true; mention: string }
export interface Commun {
  profil: string; titre: string; zeroSaisie: true; exercice: string; genereLe: string; menu: MenuEntree[]; reperes: Repere[];
  regles: { titre: string; texte: string }[]; sixEtats: string[]; pied: string; habilitations: string;
  budget: { temps: string; frequence: string; support: string } | null;
  entete: { enAttente: number; urgentes: number; libelle: string };
  corbeille: { taille: number; differes: { id: string; objet: string; reexamenLe: string }[]; nonPresentables: number };
  illustrations?: Record<string, Illustration[]>;
}

// ————————————————————————— consultation hors connexion (§ 27.11) —————————————————————————

const CLE = (userId: string | undefined, cle: string) => `mosolo.postes.${userId ?? 'anonyme'}.${cle}`;
export function lireHorsLigne<T>(userId: string | undefined, cle: string): { at: string; data: T } | null {
  try { const raw = safeGet(CLE(userId, cle)); return raw ? JSON.parse(raw) as { at: string; data: T } : null; } catch { return null; }
}
export function ecrireHorsLigne(userId: string | undefined, cle: string, data: unknown): void {
  try { safeSet(CLE(userId, cle), JSON.stringify({ at: new Date().toISOString(), data })); } catch { /* stockage plein : la consultation en ligne reste possible */ }
}

/** Chargement avec repli hors connexion : la dernière réponse est conservée sur l'appareil (par utilisateur). */
export function usePosteApi<T>(path: string | null, cle: string) {
  const { user } = useApp();
  // `pour` : chemin auquel appartiennent les données (29/09/2026) — en passant d'une vue à l'autre, les données de la
  // vue précédente ne sont jamais rendues avec la nouvelle vue (plantage « undefined.map » relevé par le parcours réel).
  const [state, setState] = useState<{ pour: string | null; data: T | null; error: unknown; loading: boolean; horsLigne: string | null }>({ pour: path, data: null, error: null, loading: !!path, horsLigne: null });
  const [tick, setTick] = useState(0);
  const uid = user?.id;
  useEffect(() => {
    if (!path) { setState((s) => ({ ...s, pour: null, loading: false })); return; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api<T>(path).then(
      (d) => { if (!alive) return; ecrireHorsLigne(uid, cle, d); setState({ pour: path, data: d, error: null, loading: false, horsLigne: null }); },
      (e: unknown) => {
        if (!alive) return;
        const c = e instanceof NetworkError ? lireHorsLigne<T>(uid, cle) : null;
        setState(c ? { pour: path, data: c.data, error: null, loading: false, horsLigne: c.at } : { pour: path, data: null, error: e, loading: false, horsLigne: null });
      },
    );
    return () => { alive = false; };
  }, [path, cle, uid, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const aJour = state.pour === path;
  return { data: aJour ? state.data : null, error: aJour ? state.error : null, loading: aJour ? state.loading : !!path, horsLigne: aJour ? state.horsLigne : null, reload };
}

export function BandeauHorsLigne({ depuis }: { depuis: string | null }) {
  if (!depuis) return null;
  return <p className="ps-offline" role="status"><Icon name="offline" size={16} /> Hors connexion — données conservées sur l’appareil, consultées le {new Date(depuis).toLocaleString('fr-FR')}.</p>;
}

// ————————————————————————— cadre « téléphone » des maquettes —————————————————————————

export function heureKinshasa(d = new Date()): string {
  try { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kinshasa' }).format(d); } catch { return d.toISOString().slice(11, 16); }
}

export function PhoneFrame({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <div className="ps-phone">
      <div className="ps-statusbar" aria-hidden="true"><span>{heureKinshasa()} Kinshasa</span><span>KINSHASA MOSOLO</span></div>
      <header className="ps-phone-head"><p className="ps-app">KINSHASA MOSOLO</p><h1>{titre}</h1></header>
      <div className="ps-phone-body">{children}</div>
    </div>
  );
}

export function Bloc({ titre, sous, children, id }: { titre: string; sous?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="ps-bloc" aria-labelledby={id}>
      <h2 className="ps-bloc-title" id={id}>{titre}{sous && <span className="ps-bloc-sub"> — {sous}</span>}</h2>
      {children}
    </section>
  );
}

// ————————————————————————— chiffres (§ 27.10) —————————————————————————

const nf = (v: string | null | undefined, unite?: string) => {
  if (v === null || v === undefined || v === '') return 'non mesuré';
  const n = Number(v.replace(',', '.').replace('−', '-'));
  if (!Number.isFinite(n) || /[a-zA-Z]/.test(v)) return v;
  const digits = unite === '%' ? 1 : n !== Math.trunc(n) && Math.abs(n) < 1000 ? 2 : 0;
  return n.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
};
const tone = (etat: string): Tone => (['RAPPROCHE', 'REGLE'].includes(etat) ? 'good' : etat === 'ENCAISSE' ? 'info' : etat === 'POTENTIEL_ESTIME' ? 'warning' : 'neutral');

/** Chiffre jamais nu : état, comparaison, date de production, taux, source cliquable en trois niveaux au plus. */
export function ChiffreView({ c, grand = false }: { c: Chiffre; grand?: boolean }) {
  const lien = c.source.chemin[Math.min(1, c.source.chemin.length - 1)] ?? '/poste-de-decision';
  // Parcours par rôle (29/09/2026) : la source n'est cliquable que si l'écran est utilisable par la personne.
  const utilisable = useEcranAccessible();
  const titre = `Source : ${c.source.libelle} (${c.source.chemin.join(' › ')})`;
  const contenu = (<>
    <span className={grand ? 'ps-valeur ps-valeur-grand' : 'ps-valeur'}>{nf(c.valeur, c.unite)}{c.valeur !== null && <small> {c.unite}</small>}</span>
    <span className="ps-libelle">{c.libelle}</span>
  </>);
  return (
    <div className={`ps-chiffre${c.estimation ? ' ps-estimation' : ''}${c.exemple ? ' ps-exemple' : ''}`} data-etat={c.etat}>
      {utilisable(lien) ? <Link to={lien} className="ps-chiffre-lien" title={titre}>{contenu}</Link> : <span className="ps-chiffre-lien" title={titre}>{contenu}</span>}
      <span className="ps-meta">
        <StatusBadge tone={tone(c.etat)} label={`État · ${c.etatLabel}`} />
        {c.estimation && <StatusBadge tone="warning" label="Estimation" />}
        {c.exemple && <StatusBadge tone="neutral" label="[EXEMPLE]" />}
      </span>
      {c.equivalents?.USD && <span className="ps-small">≈ {nf(c.equivalents.USD)} USD</span>}
      <span className="ps-small">{c.comparaison.libelle}{c.comparaison.ecart ? ` · écart ${c.comparaison.ecart}` : ''}</span>
      {c.deltaDuJour !== undefined && c.deltaDuJour !== null && <span className="ps-small">Aujourd’hui : {nf(c.deltaDuJour)} {c.unite}</span>}
      {c.hypotheses?.length ? <span className="ps-small">Hypothèses : {c.hypotheses.join(' ; ')}</span> : null}
      <span className="ps-small ps-date">Produit le {new Date(c.date).toLocaleString('fr-FR')}{c.taux ? ` · 1 ${c.taux.devise} = ${nf(c.taux.cdfParUnite)} CDF (${c.taux.date}, ${c.taux.source})` : ''}</span>
    </div>
  );
}

export function SixEtats({ etats }: { etats: string[] }) {
  return <p className="ps-six" aria-label="Les six états d’une recette">{etats.map((e) => <span key={e}>{e}</span>)}</p>;
}

// ————————————————————————— illustrations des maquettes ([EXEMPLE]) —————————————————————————

export function Illustrations({ items, titre = 'Illustration de la maquette' }: { items?: Illustration[]; titre?: string }) {
  if (!items?.length) return null;
  return (
    <details className="ps-illustration">
      <summary>[EXEMPLE] {titre} — non contractuel</summary>
      <p className="ps-small">{items[0]!.mention}</p>
      <ul>
        {items.map((i, k) => (
          <li key={k}>
            {i.texte ? <><strong>{i.texte.titre}</strong><span className="ps-small"> — {i.texte.detail}</span></>
              : <><strong>{i.valeur} {i.unite}</strong> <span>{i.libelle}</span> <span className="ps-small">— État · {i.etatLabel}{i.comparaison?.libelle ? ` · ${i.comparaison.libelle}` : ''}</span></>}
          </li>
        ))}
      </ul>
    </details>
  );
}

// ————————————————————————— fiche de décision (§ 27.3) —————————————————————————

export const MOTIF_MIN = 10;

/** Garde d'interface de l'action (le serveur décide) : motif écrit obligatoire, délégataire et date pour « Déléguer ». */
export function gardeAction(a: ActionFiche, motif: string, deleg?: { userId: string; jusquau: string }): string | null {
  if (!a.possible) return a.raison ?? 'Action indisponible.';
  if (motif.trim().length < MOTIF_MIN) return `Motif écrit obligatoire (${MOTIF_MIN} caractères au moins).`;
  if (a.code === 'DELEGUER' && (!deleg?.userId || !deleg.jusquau)) return 'Délégation : personne nommée et date de fin requises.';
  return null;
}

export function FicheCard({ f, onDone, lienDetail = true }: { f: Fiche; onDone?: () => void; lienDetail?: boolean }) {
  const { user } = useApp();
  const [ouverte, setOuverte] = useState<ActionFiche['code'] | null>(null);
  const [motif, setMotif] = useState('');
  const [deleg, setDeleg] = useState({ userId: f.delegationSuggeree?.userId ?? '', jusquau: '' });
  const [candidats, setCandidats] = useState<{ id: string; nom: string; roles: string[] }[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const idMotif = useId();
  const action = f.actions.find((a) => a.code === ouverte);
  // Clavier seul (deuxième passe adverse, 27/09/2026) : à l'ouverture d'une issue, le focus va au motif à saisir au
  // lieu de rester sur le bouton (sinon trois boutons à traverser avant d'atteindre le champ).
  useEffect(() => {
    if (ouverte) document.getElementById(idMotif)?.focus();
  }, [ouverte, idMotif]);
  useEffect(() => {
    if (ouverte !== 'DELEGUER' || !f.categorie) return;
    api<{ items: { id: string; nom: string; roles: string[] }[] }>(`/v1/postes/delegations/candidats?categorie=${f.categorie.code}`).then((r) => setCandidats(r.items), () => setCandidats([]));
  }, [ouverte, f.categorie]);
  async function envoyer() {
    if (!action) return;
    const g = gardeAction(action, motif, deleg);
    if (g) { setMsg({ ok: false, text: g }); return; }
    setBusy(true); setMsg(null);
    try {
      await api(`/v1/postes/fiches/${encodeURIComponent(f.id)}/action`, { method: 'POST', body: { action: action.code, motif, ...(action.code === 'DELEGUER' ? { delegataireId: deleg.userId, jusquau: deleg.jusquau } : {}) } });
      const text = `${action.libelle} : enregistré et journalisé.`;
      setMsg({ ok: true, text }); setOuverte(null); setMotif('');
      // La fiche décidée peut quitter la corbeille au rechargement : annonce globale et focus sur le contenu principal
      // (sinon message et focus perdus avec la carte — constaté au clavier le 27/09/2026).
      annoncer(`${f.objet} — ${text}`);
      if (onDone) { onDone(); document.getElementById('main')?.focus(); }
    } catch (e) {
      const d = describeError(e); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') });
    } finally { setBusy(false); }
  }
  const j = f.echeance.joursRestants;
  return (
    <article className={`ps-fiche${f.echeance.urgente || f.echeance.enRetard ? ' ps-urgente' : ''}${f.exemple ? ' ps-exemple' : ''}`} aria-label={f.objet}>
      <header className="ps-fiche-head">
        <p className="ps-cat">{f.categorie?.libelle ?? f.module}{f.exemple && ' · [EXEMPLE]'}</p>
        <h3>{lienDetail ? <Link to={`/poste-de-decision/fiche/${encodeURIComponent(f.id)}`}>{f.objet}</Link> : f.objet}</h3>
        <div className="ps-badges">
          {(f.echeance.urgente || f.echeance.enRetard) && <StatusBadge tone="critical" label={f.echeance.enRetard ? 'Échéance dépassée' : 'Urgent'} />}
          {f.presence.includes('REMONTEE') && <StatusBadge tone="warning" label="Remonté (lecture et relance)" />}
          {f.delegation && <StatusBadge tone="info" label={`Par délégation de ${f.delegation.delegant}`} />}
          {f.information && <StatusBadge tone="neutral" label="Pour information" />}
        </div>
      </header>
      <dl className="ps-blocs">
        <div><dt>Demandeur</dt><dd>{f.demandeur.libelle}<span className="ps-small"> — {f.demandeur.serviceInstructeur}{f.demandeur.validationAmont ? ` · ${f.demandeur.validationAmont}` : ''}</span></dd></div>
        <div><dt>Enjeu</dt><dd>{f.enjeu.texte}{f.enjeu.figures.length > 0 && <span className="ps-figures">{f.enjeu.figures.map((x) => <span key={x.libelle}><strong>{x.valeur} {x.unite}</strong> {x.libelle}</span>)}</span>}
          {f.enjeu.chiffres.map((c) => <ChiffreView key={c.code} c={c} />)}</dd></div>
        <div><dt>Échéance</dt><dd><strong>{j >= 0 ? `${j} jour${j > 1 ? 's' : ''}` : `${-j} jour${-j > 1 ? 's' : ''} de retard`}</strong> ({f.echeance.date}). {f.echeance.consequenceSilence}</dd></div>
        <div><dt>Fondement</dt><dd>{f.fondement.join(' ; ')}</dd></div>
        <div><dt>Position du service</dt><dd>{f.position.recommandation}{f.position.reserves.map((r) => <span key={r} className="ps-reserve">Réserve : {r}</span>)}</dd></div>
        <div><dt>Si rien n’est décidé</dt><dd>{f.siRienNestDecide}</dd></div>
      </dl>
      <details className="ps-pieces">
        <summary>Pièces ({f.pieces.nombre}) — repliées</summary>
        {f.pieces.items.length ? <ul>{f.pieces.items.map((p) => <li key={p.libelle}>{p.libelle}{p.reference ? ` — ${p.reference}` : ''}</li>)}</ul>
          : <p className="ps-small">{f.individuel ? 'Dossier nominatif : ouvert depuis le détail avec une finalité déclarée et journalisée.' : 'Aucune pièce jointe.'}</p>}
      </details>
      <div className="ps-actions" role="group" aria-label="Quatre issues, toutes motivées et journalisées">
        {f.actions.map((a) => (
          <button key={a.code} type="button" className={`btn btn-sm ${a.code === 'APPROUVER' ? 'btn-primary' : 'btn-secondary'}`} disabled={!a.possible || busy}
            title={a.possible ? undefined : a.raison} aria-pressed={ouverte === a.code} onClick={() => { setOuverte(ouverte === a.code ? null : a.code); setMsg(null); }}>
            {a.libelle}
          </button>
        ))}
      </div>
      {f.actions.some((a) => !a.possible) && <p className="ps-small ps-raison">{f.actions.find((a) => !a.possible)!.raison}</p>}
      {action && (
        <div className="ps-form">
          <label htmlFor={idMotif} className="label">Motif écrit ({action.libelle}) — obligatoire et journalisé</label>
          <textarea id={idMotif} rows={3} value={motif} onChange={(e) => setMotif(e.target.value)} />
          {action.code === 'DELEGUER' && (
            <div className="ps-deleg">
              <label className="label">Personne nommée (rang inférieur)
                <select value={deleg.userId} onChange={(e) => setDeleg({ ...deleg, userId: e.target.value })}>
                  <option value="">— choisir —</option>
                  {f.delegationSuggeree && !candidats.some((c) => c.id === f.delegationSuggeree!.userId) && <option value={f.delegationSuggeree.userId}>{f.delegationSuggeree.libelle}</option>}
                  {candidats.map((c) => <option key={c.id} value={c.id}>{c.nom} — {c.roles.join(', ')}</option>)}
                </select>
              </label>
              <label className="label">Jusqu’au<input type="date" value={deleg.jusquau} onChange={(e) => setDeleg({ ...deleg, jusquau: e.target.value })} /></label>
            </div>
          )}
          <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void envoyer()}>Confirmer — {action.libelle}</button></div>
        </div>
      )}
      {msg && <p className={msg.ok ? 'notice notice-ok' : 'notice notice-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      {user && !f.actions.some((a) => a.possible && a.code !== 'COMPLEMENT') && f.presence.includes('REMONTEE') && <p className="ps-small">Remonté au-delà des seuils : lecture et relance ; la décision reste au titulaire du droit.</p>}
    </article>
  );
}

// ————————————————————————— menu, repères, règles —————————————————————————

export function MenuPoste({ menu, actif }: { menu: MenuEntree[]; actif?: string }) {
  return (
    <nav className="ps-menu" aria-label="Menu du poste">
      {menu.map((m) => <Link key={m.code} to={`/poste-de-decision/${m.code}`} aria-current={actif === m.code ? 'page' : undefined} title={m.ouvre}>{m.libelle}</Link>)}
    </nav>
  );
}

export function Reperes({ items }: { items: Repere[] }) {
  return <ul className="ps-reperes" aria-label="Repères">{items.map((r) => <li key={r.valeur}><strong>{r.valeur}</strong><span>{r.libelle}</span></li>)}</ul>;
}

export function ReglesEcrans({ regles, sixEtats, pied }: { regles: { titre: string; texte: string }[]; sixEtats: string[]; pied: string }) {
  return (
    <aside className="ps-regles" aria-label="Les règles qui tiennent ces écrans">
      <h2>Les règles qui tiennent ces écrans</h2>
      <SixEtats etats={sixEtats} />
      <ul>{regles.map((r) => <li key={r.titre}><strong>{r.titre}</strong> — {r.texte}</li>)}</ul>
      <p className="ps-small">{pied}</p>
    </aside>
  );
}

/** Mesure le temps de rendu de l'écran d'accueil (test des 90 secondes, rendu local). */
export function useTempsRendu(pret: boolean) {
  const t0 = useRef(typeof performance !== 'undefined' ? performance.now() : 0);
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => { if (pret && ms === null) setMs(Math.round(performance.now() - t0.current)); }, [pret, ms]);
  return ms;
}
