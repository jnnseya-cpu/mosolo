/**
 * Module 10 — Registre des activités et patentes : établissements (entreprise, activité, catégorie, localisation,
 * dirigeants), patente et autorisations liées, obligations déterminées par les règles du registre, commerces visibles
 * sans patente active (signal ⇒ vérification, jamais une dette ; visite seulement dans une mission autorisée),
 * recoupement de fichiers transmis sous protocole (codes marchands Mobile Money, livraisons brassicoles, RCCM).
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ActionMotivee, Tableau } from './common';
import './citoyen.css';

interface Etab { objectId: string; igf: string | null; entreprise: string | null; etablissement: string; activite: string | null; categorie: string | null; localisation: { commune: string; quartier: string }; dirigeants: { nom: string; fonction: string }[]; patente: { active: boolean; titre: { numero: string; statut: string } | null; exigible: boolean }; autorisations: { code: string; libelle: string; statut: string }[]; signauxOuverts: number }
interface Signal { id: string; objectId: string; etablissement: string | null; commune: string; motif: string; source: string; detail: string; statut: string }
interface Oblig { conclusion: string; regles: { code: string; version: number; statut: string; applicable: boolean; motif: string | null }[]; titres: { code: string; libelle: string; acte: { status: string } | null }[] }

export default function Activites() {
  const { user } = useApp();
  const agent = !!user && !user.roles.some((r) => r === 'R30' || r === 'R31');
  const reg = useApi(user ? () => api<{ lignes: Etab[]; notice: string }>('/v1/citoyen/activites') : null, [user?.id]);
  const sig = useApi(agent ? () => api<Signal[]>('/v1/citoyen/activites/signaux') : null, [user?.id]);
  const [ob, setOb] = useState<(Oblig & { id: string }) | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [lot, setLot] = useState({ source: 'CODES_MARCHANDS_MM', lignes: '' });
  async function obligations(id: string) {
    setMsg(null);
    try { setOb({ ...(await api<Oblig>(`/v1/citoyen/activites/${encodeURIComponent(id)}/obligations`)), id }); } catch (x) { setMsg(describeError(x).message); }
  }
  async function detecter() {
    setMsg(null);
    try { const r = await api<{ crees: number; notice: string }>('/v1/citoyen/activites/detection', { method: 'POST' }); setMsg(`${r.crees} signal(aux) ouvert(s). ${r.notice}`); sig.reload(); reg.reload(); } catch (x) { setMsg(describeError(x).message); }
  }
  async function recouper(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    const lignes = lot.lignes.split('\n').map((l) => l.split(';').map((s) => s.trim())).filter((l) => l[0]).map(([reference, nom, commune]) => ({ reference: reference!, ...(nom ? { nom } : {}), ...(commune ? { commune } : {}) }));
    try { const r = await api<{ rapproches: number; inconnus: unknown[]; signaux: string[]; protocole: string }>('/v1/citoyen/activites/recoupements', { method: 'POST', body: { source: lot.source, lignes } }); setMsg(`${r.rapproches} rapproché(s), ${r.inconnus.length} commerce(s) non enregistré(s), ${r.signaux.length} signal(aux). ${r.protocole}`); sig.reload(); } catch (x) { setMsg(describeError(x).message); }
  }
  return (
    <div className="stack">
      <PageHead eyebrow="Module 10" title="Registre des activités et patentes" lead="Existence d’une activité ≠ assujettissement : la règle décide. Pas de visite sans mission autorisée." />
      <p className="small"><Link to="/titres/catalogue">Patente : certificat à QR vérifiable, renouvellement par Mobile Money avec rappel ambre</Link> · <Link to="/services/entreprises">Autorisation d’exploitation (débits de boissons : catégorie, horaires)</Link> · <Link to="/services/marches">Commerces de marché</Link></p>
      {msg && <p className="notice small" role="status">{msg}</p>}
      {reg.loading ? <Loading /> : reg.error ? <ErrorState error={reg.error} onRetry={reg.reload} /> : reg.data && (
        <section className="panel stack-sm" aria-label="Établissements">
          <p className="panel-title">Établissements</p>
          <Tableau entetes={['Établissement', 'Entreprise', 'Activité', 'Lieu', 'Dirigeants', 'Patente', 'Autorisations', '']} vide="Aucun établissement."
            lignes={reg.data.lignes.map((l) => [l.etablissement, l.entreprise ?? '—', `${l.activite ?? '—'}${l.categorie ? ` (${l.categorie})` : ''}`, `${l.localisation.commune} › ${l.localisation.quartier}`,
              l.dirigeants.map((d) => `${d.nom} (${d.fonction})`).join(', ') || '—',
              <StatusBadge key="p" tone={l.patente.active ? 'good' : 'warning'} label={l.patente.active ? `Active ${l.patente.titre?.numero ?? ''}` : l.patente.exigible ? 'Sans patente active' : 'Non exigible (acte requis)'} />,
              l.autorisations.map((a) => `${a.libelle} — ${a.statut}`).join(', ') || '—',
              <button key="o" type="button" className="btn btn-link btn-sm" onClick={() => void obligations(l.objectId)}>Obligations</button>])} />
        </section>
      )}
      {ob && (
        <section className="panel stack-sm" aria-label="Obligations de l’établissement">
          <p className="panel-title">Obligations — {ob.id}</p>
          <p className="small">{ob.conclusion}</p>
          <ul className="plain-list small">{ob.regles.map((r) => <li key={`${r.code}${r.version}`}>{r.code} v{r.version} — {r.statut} — {r.applicable ? 'applicable' : `non applicable (${r.motif})`}</li>)}{ob.titres.map((t) => <li key={t.code}>Titre {t.libelle} — acte : {t.acte?.status ?? '—'}</li>)}</ul>
        </section>
      )}
      {agent && (
        <>
          <section className="panel stack-sm" aria-label="Commerces sans patente">
            <p className="panel-title">Commerces visibles sans patente active</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void detecter()}>Détecter sur le registre</button>
            <Tableau entetes={['Établissement', 'Commune', 'Motif', 'Source', 'Détail', 'Statut', 'Décision']} vide="Aucun signal." lignes={(sig.data ?? []).map((s) => [s.etablissement ?? s.objectId, s.commune, s.motif, s.source, s.detail, s.statut,
              ['A_VERIFIER', 'EN_MISSION'].includes(s.statut) ? <span className="cit-inline">
                <ActionMotivee label="Confirmer" onSubmit={(motif) => api(`/v1/citoyen/activites/signaux/${s.id}/decision`, { method: 'POST', body: { statut: 'CONFIRME', motif } }).then(sig.reload)} />
                <ActionMotivee label="Écarter" tone="secondary" onSubmit={(motif) => api(`/v1/citoyen/activites/signaux/${s.id}/decision`, { method: 'POST', body: { statut: 'ECARTE', motif } }).then(sig.reload)} />
                {s.statut === 'A_VERIFIER' && <ActionMotivee label="Rattacher à une mission (identifiant)" tone="secondary" onSubmit={(missionId) => api(`/v1/citoyen/activites/signaux/${s.id}/mission`, { method: 'POST', body: { missionId } }).then(sig.reload)} />}
              </span> : '—'])} />
          </section>
          <form className="panel stack-sm" onSubmit={(e) => void recouper(e)} aria-label="Recoupement">
            <p className="panel-title">Recoupement (fichier transmis sous protocole)</p>
            <select aria-label="Source" value={lot.source} onChange={(e) => setLot({ ...lot, source: e.target.value })}>
              <option value="CODES_MARCHANDS_MM">Codes marchands Mobile Money</option><option value="LIVRAISONS_BRASSICOLES">Livraisons brassicoles</option><option value="RCCM">RCCM</option>
            </select>
            <textarea aria-label="Lignes (référence ; nom ; commune)" rows={4} value={lot.lignes} onChange={(e) => setLot({ ...lot, lignes: e.target.value })} placeholder="référence ; nom ; commune (une ligne par établissement)" />
            <button type="submit" className="btn btn-primary btn-sm">Rapprocher</button>
          </form>
        </>
      )}
    </div>
  );
}
