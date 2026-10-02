/**
 * Module 3 — Attestation de situation : photographie signée du compte (objets et couleur de situation, obligations,
 * restes à payer, éligibilité au quitus) à l'heure du serveur, vérifiable par un tiers sous forme minimale. Le quitus
 * fiscal garde son propre circuit (délivré lorsque ses conditions sont réunies).
 */
import { useState } from 'react';
// Parcours par rôle (29/09/2026) : liens adaptés au compte — un écran que le rôle n'utilise pas affiche « Réalisé par : … ».
import { LienEcran as Link } from '../../components/LienEcran';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { QrCode } from '../../components/QrCode';
import { api, describeError } from '../../lib/api';
import { Tableau } from './common';
import './citoyen.css';
import { SituationVisuels } from './visuels';

interface Attestation { numero: string; emiseLe: string; aJour: boolean; objets: { id: string; igf: string | null; categorie: string; commune: string; libelle: string }[]; obligations: { total: number; parStatut: Record<string, number>; resteAPayer: { amount: string; currency: string }[]; contestees: number }; quitus: { eligible: boolean; bloquants: number; mention: string } | null; verification: string; notice: string }

export default function Situation() {
  const { user, fmtDate } = useApp();
  const [a, setA] = useState<Attestation | null>(null);
  const [tp, setTp] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const citoyen = !!user && user.roles.some((r) => r === 'R30' || r === 'R31');
  async function emettre() {
    setErr(null);
    try { setA(await api<Attestation>('/v1/citoyen/situation/attestations', { method: 'POST', body: citoyen ? {} : { taxpayerId: tp } })); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <div className="stack">
      <PageHead eyebrow="Module 3 — Mon espace MOSOLO" title="Attestation de situation" lead="Vos objets, obligations et restes à payer à la date du jour, attestés et vérifiables. Aucune donnée de tiers." />
      <p className="small"><Link to="/espace">Mon espace MOSOLO</Link> · <Link to="/fiscal/quitus">Quitus fiscal (lorsque les conditions sont réunies)</Link> · <Link to="/mes-arrieres">Échéancier et recours</Link></p>
      <div className="panel stack-sm">
        {!citoyen && <input aria-label="Identifiant du contribuable" placeholder="Identifiant du contribuable" value={tp} onChange={(e) => setTp(e.target.value)} />}
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void emettre()}>Obtenir mon attestation de situation</button>
        {err && <p className="notice notice-err small" role="alert">{err}</p>}
      </div>
      {a && (
        <section className="panel stack-sm" aria-label="Attestation">
          <p className="panel-title">Attestation <span className="mono">{a.numero}</span> — {fmtDate(a.emiseLe, true)}</p>
          <StatusBadge tone={a.aJour ? 'good' : 'warning'} label={a.aJour ? 'Compte à jour' : 'Obligations ouvertes'} />
          <p className="small">Obligations : {a.obligations.total} ; contestées : {a.obligations.contestees} ; reste à payer : {a.obligations.resteAPayer.map((m) => `${m.amount} ${m.currency}`).join(' + ') || '0'}</p>
          <SituationVisuels parStatut={a.obligations.parStatut} objets={a.objets} />
          {a.quitus && <p className="small">Quitus : {a.quitus.eligible ? 'conditions réunies' : `${a.quitus.bloquants} obligation(s) bloquante(s)`} — {a.quitus.mention}</p>}
          <Tableau entetes={['Objet', 'Catégorie', 'Commune', 'Situation']} vide="Aucun objet rattaché." lignes={a.objets.map((o) => [o.igf ?? o.id, o.categorie, o.commune, o.libelle])} />
          <QrCode value={a.verification} size={120} alt={`QR de vérification de l’attestation ${a.numero}`} />
          <p className="small muted">{a.notice}</p>
        </section>
      )}
    </div>
  );
}
