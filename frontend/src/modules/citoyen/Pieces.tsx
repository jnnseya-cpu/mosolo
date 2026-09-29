/**
 * Module 2 — Contrôle des pièces à l'enrôlement : capture photo (empreinte seulement), lecture automatique (OCR sur
 * l'appareil, zone MRZ), vérification de cohérence et score de confiance calculés par le serveur, rapprochements
 * proposés avec les identités existantes (jamais de fusion automatique), cas à risque soumis à revue humaine.
 */
import { useState, type ChangeEvent, type FormEvent } from 'react';
// Parcours par rôle (29/09/2026) : liens adaptés au compte — un écran que le rôle n'utilise pas affiche « Réalisé par : … ».
import { LienEcran as Link } from '../../components/LienEcran';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { analyserTexteDocument, lireImage, type LectureDocument } from '../../lib/documentOcr';
import { ActionMotivee, Tableau } from './common';
import './citoyen.css';
import { PiecesVisuels } from './visuels';

interface Facteur { code: string; libelle: string; points: number; max: number; detail: string }
interface Resultat { id: string; score: number; statut: string; revueHumaine: boolean; facteurs: Facteur[]; rapprochements: { iuc: string; nomMasque: string; motifs: string[] }[]; notice: string; seuil: { valeur: number; mention: string } }
interface Revue extends Resultat { type: string; numeroMasque: string; nomDeclare: string; canal: string; taxpayer: { iuc: string; nomMasque: string } | null }

const TYPES: [string, string][] = [['CARTE_IDENTITE', 'Carte d’identité'], ['PASSEPORT', 'Passeport'], ['CARTE_ELECTEUR', 'Carte d’électeur'], ['PERMIS_CONDUIRE', 'Permis de conduire'], ['NIF', 'NIF'], ['RCCM', 'RCCM']];

export default function Pieces() {
  const { user } = useApp();
  const citoyen = !!user && user.roles.some((r) => r === 'R30' || r === 'R31');
  const reviewer = !!user && user.roles.some((r) => ['R09', 'R11', 'R07', 'R12', 'R22'].includes(r));
  const revues = useApi(reviewer ? () => api<Revue[]>('/v1/citoyen/enrolement/pieces/revues') : null, [user?.id]);
  const [f, setF] = useState({ type: 'CARTE_IDENTITE', numero: '', nomDeclare: '', taxpayerId: '', telephone: '', dateExpiration: '' });
  const [photo, setPhoto] = useState<string | null>(null);
  const [lecture, setLecture] = useState<LectureDocument | null>(null);
  const [res, setRes] = useState<Resultat | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhoto(await sha256Hex(await file.arrayBuffer()));
    setMsg('Lecture automatique en cours sur l’appareil…');
    try {
      const l = analyserTexteDocument(await lireImage(file));
      setLecture(l);
      setF((x) => ({ ...x, numero: x.numero || l.numero || '', nomDeclare: x.nomDeclare || l.nom || '' }));
      setMsg('Lecture proposée : vérifiez et corrigez avant de contrôler.');
    } catch { setMsg('Lecture automatique indisponible : saisissez les informations.'); }
  }
  async function controler(e: FormEvent) {
    e.preventDefault(); setMsg(null); setRes(null);
    try {
      setRes(await api<Resultat>('/v1/citoyen/enrolement/pieces', { method: 'POST', body: {
        type: f.type, numero: f.numero, nomDeclare: f.nomDeclare, ...(citoyen && user?.taxpayerId ? { taxpayerId: user.taxpayerId } : f.taxpayerId ? { taxpayerId: f.taxpayerId } : {}),
        ...(f.telephone ? { telephone: f.telephone } : {}), ...(f.dateExpiration ? { dateExpiration: f.dateExpiration } : {}), ...(photo ? { photoSha256: photo } : {}),
        ...(lecture ? { lectureAuto: { texte: lecture.texte.slice(0, 4000), ...(lecture.nom ? { nom: lecture.nom } : {}), ...(lecture.numero ? { numero: lecture.numero } : {}), ...(lecture.mrzLigne2 ? { mrzLigne2: lecture.mrzLigne2 } : {}) } } : {}),
      } }));
      revues.reload();
    } catch (x) { setMsg(describeError(x).message); }
  }
  return (
    <div className="stack">
      <PageHead eyebrow="Module 2" title="Contrôle des pièces et score de confiance" lead="Enrôlement gratuit sur tous les canaux. Déclarer un rôle n’établit ni la propriété ni la dette : cela ouvre une instruction." />
      <p className="small"><Link to="/canaux/enrolement">Enrôlement assisté (agent, guichet : consentement lu, témoin)</Link> · <Link to="/fiscal/reprise">Enrôlement par lots (e-DGRK)</Link> · <Link to="/mon-espace/profils">Parcours par profil</Link> · <Link to="/acces/identite">Registre d’identité</Link></p>
      <form className="panel stack-sm" onSubmit={(e) => void controler(e)} aria-label="Contrôler une pièce">
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="pc-type">Type de pièce</label><select id="pc-type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div className="field"><label className="label" htmlFor="pc-photo">Photo de la pièce</label><input id="pc-photo" type="file" accept="image/*" capture="environment" onChange={(e) => void onPhoto(e)} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="pc-num">Numéro</label><input id="pc-num" value={f.numero} onChange={(e) => setF({ ...f, numero: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="pc-nom">Nom déclaré</label><input id="pc-nom" value={f.nomDeclare} onChange={(e) => setF({ ...f, nomDeclare: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="pc-exp">Date d’expiration</label><input id="pc-exp" type="date" value={f.dateExpiration} onChange={(e) => setF({ ...f, dateExpiration: e.target.value })} /></div>
        </div>
        {!citoyen && <div className="field-row">
          <div className="field"><label className="label" htmlFor="pc-tp">Compte (identifiant, facultatif)</label><input id="pc-tp" value={f.taxpayerId} onChange={(e) => setF({ ...f, taxpayerId: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="pc-tel">Téléphone (facultatif)</label><input id="pc-tel" value={f.telephone} onChange={(e) => setF({ ...f, telephone: e.target.value })} /></div>
        </div>}
        {lecture?.mrzLigne2 && <p className="small muted">Zone MRZ lue : <span className="mono">{lecture.mrzLigne2}</span></p>}
        <button type="submit" className="btn btn-primary btn-sm">Contrôler la pièce</button>
        {msg && <p className="notice small" role="status">{msg}</p>}
      </form>
      {res && (
        <section className="panel stack-sm" role="status" aria-label="Résultat du contrôle">
          <StatusBadge tone={res.revueHumaine ? 'warning' : 'good'} label={`Score de confiance ${res.score}/100 — ${res.revueHumaine ? 'cas à risque, revue humaine' : 'cohérent'}`} />
          <PiecesVisuels facteurs={res.facteurs} revues={null} />
          <ul className="plain-list small">{res.facteurs.map((x) => <li key={x.code}>{x.libelle} : {x.points}/{x.max} — {x.detail}</li>)}</ul>
          {res.rapprochements.length > 0 && <p className="small">Rapprochements possibles (sans fusion) : {res.rapprochements.map((r) => `${r.iuc} ${r.nomMasque} (${r.motifs.join(', ')})`).join(' ; ')}</p>}
          <p className="small muted">{res.notice} Seuil : {res.seuil.valeur} ({res.seuil.mention}).</p>
        </section>
      )}
      {reviewer && (
        <section className="panel stack-sm" aria-label="Cas à risque">
          <p className="panel-title">Cas à risque en attente de revue humaine</p>
          <PiecesVisuels facteurs={null} revues={revues.data ?? null} />
          <Tableau entetes={['Pièce', 'Nom déclaré', 'Compte', 'Score', 'Rapprochements', 'Décision']} vide="Aucun cas à risque."
            lignes={(revues.data ?? []).map((r) => [`${r.type} ${r.numeroMasque}`, r.nomDeclare, r.taxpayer ? `${r.taxpayer.iuc}` : '—', `${r.score}/100`, r.rapprochements.map((x) => `${x.iuc} (${x.motifs.join(', ')})`).join(' ; ') || '—',
              <span key="d" className="cit-inline">
                <ActionMotivee label="Valider" onSubmit={(motif) => api(`/v1/citoyen/enrolement/pieces/${r.id}/decision`, { method: 'POST', body: { decision: 'VALIDEE', motif } }).then(revues.reload)} />
                <ActionMotivee label="Demander un complément" tone="secondary" onSubmit={(motif) => api(`/v1/citoyen/enrolement/pieces/${r.id}/decision`, { method: 'POST', body: { decision: 'COMPLEMENT_DEMANDE', motif } }).then(revues.reload)} />
                <ActionMotivee label="Rejeter" tone="secondary" onSubmit={(motif) => api(`/v1/citoyen/enrolement/pieces/${r.id}/decision`, { method: 'POST', body: { decision: 'REJETEE', motif } }).then(revues.reload)} />
              </span>])} />
        </section>
      )}
    </div>
  );
}
