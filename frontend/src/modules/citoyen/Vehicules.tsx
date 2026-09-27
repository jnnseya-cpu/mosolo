/**
 * Module 11 — Véhicules et circulation : contrôle par plaque « payée / non régularisée » avec date du dernier paiement
 * (vignette et taxe de circulation sur le même objet, même scan ; consultation journalisée ; aucune immobilisation
 * décidée par l'algorithme), référentiel des véhicules et mutations, import et rapprochement du registre des
 * immatriculations (écarts revus par une personne), liquidation par catégorie et exercice sur règle ACTIVE.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ActionMotivee, Tableau } from './common';
import './citoyen.css';

interface Vue { code: string; statut: 'PAYEE' | 'NON_REGULARISEE'; titre: { numero: string; texte: string } | null; exigible: boolean }
interface Controle { plaque: string; enregistre: boolean; categorie: string | null; vignette: Vue; taxeCirculation: Vue; dernierPaiement: string | null; heureServeur: string; notice: string; horsLigne: string }
interface Vehicule { objectId: string; plaque: string; categorie: string | null; usage: string | null; proprietaire: { nom: string } | null; commune: string; mutations: { nature: string; id: string; statut: string; date: string }[] }
interface Lot { id: string; source: string; recuLe: string; lignes: number; rapproches: unknown[]; ecarts: { plaque: string; champ: string; registre: string; mosolo: string; statut: string }[]; inconnus: { plaque: string }[] }

function Pastille({ v, label }: { v: Vue; label: string }) {
  return <StatusBadge tone={!v.exigible ? 'neutral' : v.statut === 'PAYEE' ? 'good' : 'critical'} label={`${label} : ${!v.exigible ? 'non exigible (acte requis)' : v.statut === 'PAYEE' ? `payée${v.titre ? ` — ${v.titre.texte}` : ''}` : 'non régularisée'}`} />;
}

export default function Vehicules() {
  const { user, fmtDate } = useApp();
  const [plaque, setPlaque] = useState('');
  const [ctl, setCtl] = useState<Controle | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const list = useApi(user ? () => api<Vehicule[]>('/v1/citoyen/vehicules') : null, [user?.id]);
  const lots = useApi(user && user.roles.some((r) => ['R06', 'R07', 'R11'].includes(r)) ? () => api<Lot[]>('/v1/citoyen/vehicules/immatriculations') : null, [user?.id]);
  const [imp, setImp] = useState({ source: '', lignes: '' });
  const [liq, setLiq] = useState({ categorie: '', exercice: String(new Date().getFullYear()) });
  async function controler(e: FormEvent) {
    e.preventDefault(); setMsg(null); setCtl(null);
    try { setCtl(await api<Controle>(`/v1/citoyen/vehicules/${encodeURIComponent(plaque)}/controle`)); } catch (x) { setMsg(describeError(x).message); }
  }
  async function importer(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    const lignes = imp.lignes.split('\n').map((l) => l.split(';').map((s) => s.trim())).filter((l) => l[0]).map(([p, categorie, usage]) => ({ plaque: p!, ...(categorie ? { categorie } : {}), ...(usage ? { usage } : {}) }));
    try { const r = await api<Lot & { notice: string }>('/v1/citoyen/vehicules/immatriculations', { method: 'POST', body: { source: imp.source, lignes } }); setMsg(`${r.rapproches.length} rapproché(s), ${r.ecarts.length} écart(s) à revoir, ${r.inconnus.length} inconnu(s) à enrôler. ${r.notice}`); lots.reload(); } catch (x) { setMsg(describeError(x).message); }
  }
  async function liquider(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    try { const r = await api<{ liquidees: string[]; dejaLiquidees: string[]; sansRedevable: string[] }>('/v1/citoyen/vehicules/liquidations', { method: 'POST', body: liq }); setMsg(`${r.liquidees.length} obligation(s) liquidée(s) ; ${r.dejaLiquidees.length} déjà liquidée(s) ; ${r.sansRedevable.length} sans redevable.`); } catch (x) { setMsg(describeError(x).message); }
  }
  return (
    <div className="stack">
      <PageHead eyebrow="Module 11" title="Véhicules et circulation" lead="Vignette et taxe spéciale de circulation sur le même objet véhicule, contrôlées par le même scan de plaque." />
      <p className="small"><Link to="/titres/controle">Contrôle hors ligne (paquet signé des titres)</Link> · <Link to="/fiscal/dependances">Mutation : conditions (quitus, vignette)</Link> · <Link to="/services/mobilite">Déclarer une mutation</Link></p>
      <form className="panel stack-sm" onSubmit={(e) => void controler(e)} aria-label="Contrôle par plaque">
        <p className="panel-title">Contrôle par plaque</p>
        <div className="cit-inline"><input aria-label="Plaque" placeholder="Plaque" value={plaque} onChange={(e) => setPlaque(e.target.value)} /><button type="submit" className="btn btn-primary btn-sm">Contrôler</button></div>
        {ctl && (
          <div className="stack-sm" role="status">
            <p className="small">Plaque <span className="mono">{ctl.plaque}</span> {ctl.enregistre ? `— ${ctl.categorie ?? 'catégorie non renseignée'}` : '— véhicule non enregistré'}</p>
            <div className="cit-inline"><Pastille v={ctl.vignette} label="Vignette" /><Pastille v={ctl.taxeCirculation} label="Taxe de circulation" /></div>
            <p className="small">Dernier paiement : {ctl.dernierPaiement ? fmtDate(ctl.dernierPaiement, true) : 'aucun'} · heure serveur {fmtDate(ctl.heureServeur, true)}</p>
            <p className="small muted">{ctl.notice} {ctl.horsLigne}</p>
          </div>
        )}
      </form>
      {msg && <p className="notice small" role="status">{msg}</p>}
      {list.data && (
        <section className="panel stack-sm" aria-label="Référentiel">
          <p className="panel-title">Référentiel des véhicules</p>
          <Tableau entetes={['Plaque', 'Catégorie', 'Usage', 'Propriétaire', 'Commune', 'Mutations']} vide="Aucun véhicule." lignes={list.data.map((v) => [v.plaque, v.categorie ?? '—', v.usage ?? '—', v.proprietaire?.nom ?? '—', v.commune, v.mutations.map((m) => `${m.date} ${m.nature} (${m.statut})`).join(', ') || '—'])} />
        </section>
      )}
      {lots.data && (
        <>
          <form className="panel stack-sm" onSubmit={(e) => void importer(e)} aria-label="Registre des immatriculations">
            <p className="panel-title">Importer et rapprocher le registre des immatriculations</p>
            <input aria-label="Source du fichier" placeholder="Source (fichier transmis sous protocole)" value={imp.source} onChange={(e) => setImp({ ...imp, source: e.target.value })} />
            <textarea aria-label="Lignes (plaque ; catégorie ; usage)" rows={4} value={imp.lignes} onChange={(e) => setImp({ ...imp, lignes: e.target.value })} placeholder="plaque ; catégorie ; usage" />
            <button type="submit" className="btn btn-primary btn-sm">Rapprocher</button>
          </form>
          <ul className="plain-list small">{lots.data.map((l) => (
            <li key={l.id}><strong>{l.id}</strong> — {l.source} : {l.lignes} ligne(s), {l.inconnus.length} inconnu(s)
              <ul className="plain-list">{l.ecarts.map((e) => <li key={`${e.plaque}${e.champ}`}>{e.plaque} · {e.champ} : registre « {e.registre} » / MOSOLO « {e.mosolo} » — {e.statut}
                {e.statut === 'A_REVOIR' && <span className="cit-inline">
                  <ActionMotivee label="Retenir le registre" onSubmit={(motif) => api(`/v1/citoyen/vehicules/immatriculations/${l.id}/ecarts`, { method: 'POST', body: { plaque: e.plaque, champ: e.champ, retenu: 'REGISTRE_RETENU', motif } }).then(lots.reload)} />
                  <ActionMotivee label="Retenir MOSOLO" tone="secondary" onSubmit={(motif) => api(`/v1/citoyen/vehicules/immatriculations/${l.id}/ecarts`, { method: 'POST', body: { plaque: e.plaque, champ: e.champ, retenu: 'MOSOLO_RETENU', motif } }).then(lots.reload)} />
                </span>}</li>)}</ul>
            </li>))}</ul>
          <form className="panel stack-sm" onSubmit={(e) => void liquider(e)} aria-label="Liquidation par catégorie">
            <p className="panel-title">Liquider par catégorie et exercice (règle ACTIVE « VIG-catégorie » requise)</p>
            <div className="cit-inline">
              <input aria-label="Catégorie" placeholder="Catégorie (ex. MINIBUS)" value={liq.categorie} onChange={(e) => setLiq({ ...liq, categorie: e.target.value })} />
              <input aria-label="Exercice" value={liq.exercice} onChange={(e) => setLiq({ ...liq, exercice: e.target.value })} />
              <button type="submit" className="btn btn-primary btn-sm">Liquider</button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
