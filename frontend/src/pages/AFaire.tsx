/**
 * « À faire » (30/09/2026, demande du maître d'ouvrage) : l'usager n'a rien à vérifier lui-même. Tout ce qui le concerne
 * est ici, en un seul endroit, avec une action par ligne :
 *  - « À faire maintenant » (payer, régulariser, renouveler, compléter, passer un contrôle) ;
 *  - « En cours de vérification par l'administration » (rien à faire : l'usager suit l'état) ;
 *  - « À jour » (titres, autorisations, pièces valides et leur échéance).
 * Données : GET /v1/moi/a-faire (compte unique, mêmes droits). Les liens ne mènent qu'aux écrans de l'usager.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';
import { MoneyText } from '../components/MoneyText';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { ErrorState, Loading } from '../components/States';

interface Ligne {
  id: string; groupe: 'A_FAIRE' | 'EN_VERIFICATION' | 'A_JOUR'; categorie: string; libelle: string; etat: string;
  echeance: string | null; montant: MoneyJSON | null; urgence: 'EN_RETARD' | 'BIENTOT' | 'NORMALE';
  action: { libelle: string; lien: string; obligationId?: string } | null;
}
interface AFaireData { aFaire: Ligne[]; enVerification: Ligne[]; aJour: Ligne[]; regles: { principe: string; renouvellementJours: number; statut: string } }

const URGENCE: Record<Ligne['urgence'], { label: string; tone: Tone } | null> = {
  EN_RETARD: { label: 'En retard', tone: 'critical' },
  BIENTOT: { label: 'Bientôt', tone: 'warning' },
  NORMALE: null,
};
const ETAT_LISIBLE: Record<string, string> = {
  CONFIRMATION_BANCAIRE: 'Paiement reçu — confirmation bancaire en cours',
  PAYEE_EN_RAPPROCHEMENT: 'Payée — rapprochement bancaire en cours',
  ENREGISTRE_A_VERIFIER: 'Enregistré — vérification par l’administration',
  EN_COURS: 'En cours',
  DEPOSE: 'Déposée', DEPOSEE: 'Déposée', DEMANDEE: 'Demandée', EN_INSTRUCTION: 'En instruction', ECART_A_INSTRUIRE: 'Écart en cours d’examen',
  ECART_CONSTATE: 'Écart constaté — votre réponse est attendue', EMISE: 'À payer', EN_RETARD: 'En retard', EXIGIBLE: 'Exigible',
  PARTIELLEMENT_PAYEE: 'Partiellement payée', OUVERT: 'Dossier ouvert', RETENU: 'Constat retenu', VERIFIE: 'Constat vérifié',
  EN_ATTENTE_PAIEMENT: 'En attente de paiement', AUCUN_CONTROLE: 'Aucun contrôle technique', DEFAVORABLE: 'Contrôle défavorable',
  VALIDE: 'Valide', VALIDEE: 'Validée', ACTIF: 'Actif', EMIS: 'Émis', FAVORABLE: 'Favorable', ACCEPTE: 'Acceptée', ACCORDEE: 'Accordée',
  RAPPROCHEE: 'Rapprochée', ATTRIBUE: 'Attribué', ACCREDITE: 'Accréditée', DECLARE: 'Déclaré', EXPIRE: 'Expiré',
};
const lisible = (s: string) => ETAT_LISIBLE[s] ?? s.toLowerCase().replace(/_/g, ' ');

export function AFaire({ taxpayerId, onPay }: { taxpayerId: string; onPay: (obligationId: string) => void }) {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<AFaireData>(`/v1/moi/a-faire${user?.taxpayerId === taxpayerId ? '' : `?taxpayerId=${encodeURIComponent(taxpayerId)}`}`), [taxpayerId, user?.id]);
  const [voirAJour, setVoirAJour] = useState(false);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d) return null;

  const action = (l: Ligne) => {
    if (!l.action) return null;
    if (l.action.obligationId) return <button type="button" className="btn btn-primary btn-sm" onClick={() => onPay(l.action!.obligationId!)}>{l.action.libelle}</button>;
    if (l.action.lien.startsWith('/espace#')) {
      const target = l.action.lien.slice('/espace#'.length);
      return <button type="button" className="btn btn-secondary btn-sm" onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' })}>{l.action.libelle}</button>;
    }
    return <Link className={`btn btn-sm ${l.groupe === 'A_FAIRE' ? 'btn-primary' : 'btn-secondary'}`} to={l.action.lien}>{l.action.libelle}</Link>;
  };
  const liste = (rows: Ligne[], testid: string) => (
    <ul className="afaire-list" data-testid={testid}>
      {rows.map((l) => (
        <li key={`${l.groupe}-${l.id}`} className="afaire-item">
          <div className="afaire-main">
            <span className="small muted">{l.categorie}</span>
            <strong className="afaire-title">{l.libelle}</strong>
            <span className="small">
              {lisible(l.etat)}
              {l.echeance && <> · échéance {fmtDate(l.echeance)}</>}
              {l.montant && <> · <MoneyText money={l.montant} showIndicative={false} /></>}
            </span>
          </div>
          <div className="afaire-side">
            {URGENCE[l.urgence] && <StatusBadge tone={URGENCE[l.urgence]!.tone} label={URGENCE[l.urgence]!.label} />}
            {action(l)}
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="section afaire" aria-labelledby="sec-afaire" id="a-faire">
      <div className="section-head"><h2 id="sec-afaire">À faire</h2><span className="count">{d.aFaire.length}</span></div>
      <p className="small muted">{d.regles.principe}</p>
      {d.aFaire.length === 0
        ? <div className="callout callout-info" role="status"><Icon name="check" size={18} /><span>Rien à faire pour le moment : vous êtes à jour.</span></div>
        : liste(d.aFaire, 'afaire-maintenant')}
      {d.enVerification.length > 0 && (
        <>
          <h3 className="afaire-sub">En cours de vérification par l’administration <span className="count">{d.enVerification.length}</span></h3>
          <p className="small muted">Rien à faire de votre côté : vous êtes prévenu dès qu’une décision est prise.</p>
          {liste(d.enVerification, 'afaire-verification')}
        </>
      )}
      {d.aJour.length > 0 && (
        <>
          <h3 className="afaire-sub">
            <button type="button" className="btn-link" aria-expanded={voirAJour} onClick={() => setVoirAJour(!voirAJour)}>
              <Icon name="chevronDown" size={16} className={voirAJour ? 'side-rot' : undefined} /> À jour <span className="count">{d.aJour.length}</span>
            </button>
          </h3>
          {voirAJour && liste(d.aJour, 'afaire-a-jour')}
        </>
      )}
    </section>
  );
}
