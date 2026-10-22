/**
 * Module 8 — Cadastre fiscal géospatial : couches (sensibles restreintes par rôle), cartes de chaleur par commune,
 * couverture par zone et catégorie, historique spatial et hiérarchie d'un objet, levé de géométrie avec précision et
 * source, objets superposés ou dupliqués (revue, jamais fusion) et cas difficiles. Le cadastre fiscal ne tranche pas
 * les droits réels.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ActionMotivee, BlocIndicateurs, Tableau } from './common';
import './citoyen.css';
import { CadastreVisuels } from './visuels';

interface Couche { code: string; libelle: string; sensible: boolean; restreinte: boolean; total: number | null; parCommune: { commune: string; total: number | null }[] | null }
interface Revue { id: string; nature: string; distanceM: number | null; statut: string; objetsDetail: { id: string; igf?: string | null; categorie?: string; commune?: string; quartier?: string }[] }
interface Cas { id: string; type: string; libelle: string; commune: string; quartier?: string; statut: string; note: string; effetFiscal: string; objectId?: string }
interface Historique { objectId: string; igf: string | null; geometries: { version: number; type: string; precisionM: number | null; source: string; at: string; motif: string }[]; evenements: { at: string; nature: string; detail: string }[] }
interface Hierarchie { niveaux: { niveau: string; libelle: string; igf?: string | null }[] }

const TYPES_CAS: Record<string, string> = { SANS_ADRESSE: 'Objet sans adresse', HABITAT_INFORMEL: 'Habitat informel', GPS_IMPRECIS: 'GPS imprécis', LITIGE_LIMITES: 'Litige de limites' };
const SOURCES = ['LEVE_GPS_TERRAIN', 'AUTO_DECLARATION', 'IMAGERIE_SOUS_LICENCE', 'CADASTRE_FONCIER', 'DONNEES_ADMINISTRATIVES'];

function Objet() {
  const [id, setId] = useState('');
  const [h, setH] = useState<Historique | null>(null);
  const [hi, setHi] = useState<Hierarchie | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [g, setG] = useState({ type: 'POINT', coords: '', precisionM: '5', source: 'LEVE_GPS_TERRAIN', motif: '' });
  async function charger(e?: FormEvent) {
    e?.preventDefault(); setErr(null);
    try {
      setH(await api<Historique>(`/v1/citoyen/cadastre/objets/${encodeURIComponent(id)}/historique`));
      setHi(await api<Hierarchie>(`/v1/citoyen/cadastre/objets/${encodeURIComponent(id)}/hierarchie`));
    } catch (x) { setErr(describeError(x).message); }
  }
  async function lever(e: FormEvent) {
    e.preventDefault(); setErr(null);
    // Saisie « lat,lon ; lat,lon ; … » (ordre usuel au terrain) convertie en [lon, lat].
    const coordonnees = g.coords.split(';').map((p) => p.split(',').map((n) => Number(n.trim()))).filter((p) => p.length === 2 && p.every(Number.isFinite)).map(([lat, lon]) => [lon, lat]);
    try { await api(`/v1/citoyen/cadastre/objets/${encodeURIComponent(id)}/geometries`, { method: 'POST', body: { type: g.type, coordonnees, precisionM: Number(g.precisionM), source: g.source, motif: g.motif } }); await charger(); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <section className="panel stack-sm" aria-label="Objet">
      <p className="panel-title">Historique spatial et hiérarchie d’un objet</p>
      <form className="cit-inline" onSubmit={(e) => void charger(e)}>
        <input aria-label="Identifiant de l’objet" placeholder="Identifiant de l’objet" required value={id} onChange={(e) => setId(e.target.value)} />
        <button type="submit" className="btn btn-secondary btn-sm">Afficher</button>
      </form>
      {err && <p className="notice notice-err small" role="alert">{err}</p>}
      {hi && <p className="small">{hi.niveaux.map((n) => `${n.niveau} : ${n.libelle}${n.igf ? ` (${n.igf})` : ''}`).join(' › ')}</p>}
      {h && (
        <>
          <Tableau entetes={['Version', 'Type', 'Précision', 'Source', 'Date', 'Motif']} vide="Aucune géométrie." lignes={h.geometries.map((x) => [x.version, x.type, x.precisionM === null ? 'inconnue' : `${x.precisionM} m`, x.source, x.at.slice(0, 10), x.motif])} />
          <ul className="plain-list small">{h.evenements.map((ev, i) => <li key={i}>{ev.at.slice(0, 10)} — {ev.nature} : {ev.detail}</li>)}</ul>
          <form className="stack-sm" onSubmit={(e) => void lever(e)} aria-label="Lever une géométrie">
            <div className="field-row">
              <div className="field"><label className="label" htmlFor="geo-type">Type</label><select id="geo-type" value={g.type} onChange={(e) => setG({ ...g, type: e.target.value })}><option value="POINT">Point</option><option value="POLYGONE">Polygone</option></select></div>
              <div className="field"><label className="label" htmlFor="geo-prec">Précision (m)</label><input id="geo-prec" inputMode="decimal" value={g.precisionM} onChange={(e) => setG({ ...g, precisionM: e.target.value })} /></div>
              <div className="field"><label className="label" htmlFor="geo-src">Source</label><select id="geo-src" value={g.source} onChange={(e) => setG({ ...g, source: e.target.value })}>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
            </div>
            <div className="field"><label className="label" htmlFor="geo-coords">Sommets (lat,lon ; lat,lon ; …)</label><input id="geo-coords" value={g.coords} onChange={(e) => setG({ ...g, coords: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="geo-motif">Motif</label><input id="geo-motif" value={g.motif} onChange={(e) => setG({ ...g, motif: e.target.value })} /></div>
            <button type="submit" className="btn btn-primary btn-sm">Enregistrer la géométrie</button>
          </form>
        </>
      )}
    </section>
  );
}

export default function Cadastre() {
  const { user } = useApp();
  const couches = useApi(() => api<{ couches: Couche[]; notice: string }>(user ? '/v1/citoyen/cadastre/couches' : '/v1/public/cadastre/couches'), [user?.id]);
  const [ind, setInd] = useState('couverture');
  const chaleur = useApi(user ? () => api<{ lignes: { commune: string; objets: number; valeur: string | null; detail: string }[] }>(`/v1/citoyen/cadastre/chaleur?indicateur=${ind}`) : null, [user?.id, ind]);
  const sup = useApi(user ? () => api<{ items: Revue[]; notice: string }>('/v1/citoyen/cadastre/superpositions') : null, [user?.id]);
  const cas = useApi(user ? () => api<Cas[]>('/v1/citoyen/cadastre/cas') : null, [user?.id]);
  const kpi = useApi(user ? () => api<Record<string, unknown>>('/v1/citoyen/cadastre/indicateurs') : null, [user?.id]);
  const [nc, setNc] = useState({ type: 'SANS_ADRESSE', commune: '', quartier: '', repere: '', photoFacadeSha256: '', unitesEstimees: '', objectId: '', objetsVoisins: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  async function ouvrir(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      await api('/v1/citoyen/cadastre/cas', { method: 'POST', body: {
        type: nc.type, commune: nc.commune, note: nc.note, ...(nc.quartier ? { quartier: nc.quartier } : {}), ...(nc.repere ? { repere: nc.repere } : {}),
        ...(nc.photoFacadeSha256 ? { photoFacadeSha256: nc.photoFacadeSha256 } : {}), ...(nc.unitesEstimees ? { unitesEstimees: Number(nc.unitesEstimees) } : {}),
        ...(nc.objectId ? { objectId: nc.objectId } : {}), ...(nc.objetsVoisins ? { objetsVoisins: nc.objetsVoisins.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      } });
      cas.reload();
    } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <div className="stack">
      <PageHead eyebrow="Module 8" title="Cadastre fiscal géospatial" lead="Commune → quartier → avenue → parcelle → bâtiment → étage → unité → activité. Le cadastre fiscal ne tranche pas les droits réels." />
      {couches.loading ? <Loading /> : couches.error ? <ErrorState error={couches.error} onRetry={couches.reload} /> : couches.data && (
        <section className="panel stack-sm" aria-label="Couches">
          <p className="panel-title">Couches</p>
          <p className="small muted">{couches.data.notice}</p>
          <Tableau entetes={['Couche', 'Total', 'Accès']} vide="—" lignes={couches.data.couches.map((c) => [c.libelle, c.total ?? '—', c.restreinte ? 'Réservée aux rôles habilités' : c.sensible ? 'Sensible (accès habilité)' : 'Ouverte'])} />
        </section>
      )}
      {user && (
        <>
          {couches.data && <CadastreVisuels couches={couches.data.couches} chaleur={chaleur.data?.lignes ?? null} indicateur={ind} cas={cas.data ?? null} />}
          <BlocIndicateurs titre="Indicateurs du module 8" indicateurs={kpi.data} />
          <section className="panel stack-sm" aria-label="Carte de chaleur">
            <p className="panel-title">Carte de chaleur par commune</p>
            <select aria-label="Indicateur de chaleur" value={ind} onChange={(e) => setInd(e.target.value)}>
              <option value="potentiel">Potentiel</option><option value="conformite">Conformité</option><option value="couverture">Couverture du recensement</option><option value="recettes">Recettes</option>
            </select>
            {chaleur.data && <Tableau entetes={['Commune', 'Objets', 'Valeur', 'Détail']} vide="—" lignes={chaleur.data.lignes.filter((l) => l.objets > 0).map((l) => [l.commune, l.objets, l.valeur ?? 'masqué', l.detail])} />}
          </section>
          <section className="panel stack-sm" aria-label="Superpositions">
            <p className="panel-title">Objets superposés ou dupliqués (revue)</p>
            {sup.data && <p className="small muted">{sup.data.notice}</p>}
            <ul className="plain-list small">{(sup.data?.items ?? []).map((r) => (
              <li key={r.id}>{r.nature === 'CHEVAUCHEMENT' ? 'Chevauchement' : 'Doublon probable'} : {r.objetsDetail.map((o) => o.igf ?? o.id).join(' / ')}{r.distanceM !== null ? ` (${r.distanceM} m)` : ''} — {r.statut}
                {r.statut === 'A_EXAMINER' && <span className="cit-inline">
                  <ActionMotivee label="Objets distincts" tone="secondary" onSubmit={(motif) => api(`/v1/citoyen/cadastre/superpositions/${r.id}/decision`, { method: 'POST', body: { decision: 'DISTINCTS', motif } }).then(sup.reload)} />
                  <ActionMotivee label="Doublon confirmé" onSubmit={(motif) => api(`/v1/citoyen/cadastre/superpositions/${r.id}/decision`, { method: 'POST', body: { decision: 'DOUBLON_CONFIRME', motif } }).then(sup.reload)} />
                </span>}
              </li>))}</ul>
          </section>
          <section className="panel stack-sm" aria-label="Cas difficiles">
            <p className="panel-title">Cas difficiles</p>
            <Tableau entetes={['Cas', 'Commune', 'Statut', 'Note', 'Effet', 'Décision']} vide="Aucun cas ouvert." lignes={(cas.data ?? []).map((c) => [
              c.libelle, `${c.commune}${c.quartier ? ` › ${c.quartier}` : ''}`, c.statut, c.note, c.effetFiscal,
              c.statut === 'RESOLU' ? '—' : <span className="cit-inline">
                {c.type === 'LITIGE_LIMITES' && c.statut === 'OUVERT' && <ActionMotivee label="Renvoyer au service foncier" tone="secondary" onSubmit={(motif) => api(`/v1/citoyen/cadastre/cas/${c.id}/decision`, { method: 'POST', body: { statut: 'RENVOYE_SERVICE_FONCIER', motif } }).then(cas.reload)} />}
                <ActionMotivee label="Résolu" onSubmit={(motif) => api(`/v1/citoyen/cadastre/cas/${c.id}/decision`, { method: 'POST', body: { statut: 'RESOLU', motif } }).then(cas.reload)} />
              </span>,
            ])} />
            <form className="stack-sm" onSubmit={(e) => void ouvrir(e)} aria-label="Ouvrir un cas difficile">
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="cas-type">Type</label><select id="cas-type" value={nc.type} onChange={(e) => setNc({ ...nc, type: e.target.value })}>{Object.entries(TYPES_CAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                <div className="field"><label className="label" htmlFor="cas-com">Commune</label><input id="cas-com" value={nc.commune} onChange={(e) => setNc({ ...nc, commune: e.target.value })} /></div>
                <div className="field"><label className="label" htmlFor="cas-q">Quartier</label><input id="cas-q" value={nc.quartier} onChange={(e) => setNc({ ...nc, quartier: e.target.value })} /></div>
              </div>
              {nc.type === 'SANS_ADRESSE' && <div className="field-row">
                <div className="field"><label className="label" htmlFor="cas-rep">Repère de voisinage</label><input id="cas-rep" value={nc.repere} onChange={(e) => setNc({ ...nc, repere: e.target.value })} /></div>
                <div className="field"><label className="label" htmlFor="cas-ph">Empreinte SHA-256 de la photo de façade</label><input id="cas-ph" value={nc.photoFacadeSha256} onChange={(e) => setNc({ ...nc, photoFacadeSha256: e.target.value })} /></div>
              </div>}
              {nc.type === 'HABITAT_INFORMEL' && <div className="field"><label className="label" htmlFor="cas-u">Unités estimées de la grappe</label><input id="cas-u" inputMode="numeric" value={nc.unitesEstimees} onChange={(e) => setNc({ ...nc, unitesEstimees: e.target.value })} /></div>}
              {nc.type === 'LITIGE_LIMITES' && <div className="field-row">
                <div className="field"><label className="label" htmlFor="cas-o">Objet</label><input id="cas-o" value={nc.objectId} onChange={(e) => setNc({ ...nc, objectId: e.target.value })} /></div>
                <div className="field"><label className="label" htmlFor="cas-v">Objets voisins (séparés par des virgules)</label><input id="cas-v" value={nc.objetsVoisins} onChange={(e) => setNc({ ...nc, objetsVoisins: e.target.value })} /></div>
              </div>}
              <div className="field"><label className="label" htmlFor="cas-note">Note</label><input id="cas-note" value={nc.note} onChange={(e) => setNc({ ...nc, note: e.target.value })} /></div>
              <button type="submit" className="btn btn-primary btn-sm">Ouvrir le cas</button>
              {err && <p className="notice notice-err small" role="alert">{err}</p>}
            </form>
          </section>
          <Objet />
        </>
      )}
    </div>
  );
}
