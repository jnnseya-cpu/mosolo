/**
 * État de certification d'un compte pour un public (§ 24) : en vigueur jusqu'au…, ou liste de ce qui manque.
 * Réutilisable (habilitation des agents de terrain). Silencieux si la lecture n'est pas permise ou si le module
 * d'apprentissage est absent : la garde serveur reste la seule décision.
 */
import { useApi } from '../../hooks/useApi';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { PROFIL_LIBELLE, type EtatCertification as Etat, type ProfilCertifie } from './types';
import './apprentissage.css';

export function EtatCertificationView({ etat }: { etat: Etat }) {
  const nom = PROFIL_LIBELLE[etat.profil];
  if (etat.valide) {
    return (
      <div className="notice notice-ok ap-etat" role="status">
        <Icon name="shieldCheck" size={16} /> Certification « {nom} » en vigueur jusqu’au {etat.certificat?.valableJusquau}
        {etat.certificat?.demo ? ' — certificat de démonstration [EXEMPLE]' : ''}.
        {etat.aRevoir && <span className="small"> {etat.aRevoir}</span>}
      </div>
    );
  }
  return (
    <div className="notice notice-err ap-etat" role="status">
      <p><Icon name="alert" size={16} /> Certification « {nom} » non valide — ce qui manque :</p>
      <ul className="plain-list small">{etat.manquants.map((m) => <li key={m}>{m}</li>)}</ul>
    </div>
  );
}

export function EtatCertification({ userId, profil }: { userId: string; profil: ProfilCertifie }) {
  const q = useApi(() => api<Etat>(`/v1/apprentissage/certifications/${encodeURIComponent(userId)}?profil=${profil}`), [userId, profil]);
  if (!q.data || !q.data.applicable) return null;
  return <EtatCertificationView etat={q.data} />;
}
