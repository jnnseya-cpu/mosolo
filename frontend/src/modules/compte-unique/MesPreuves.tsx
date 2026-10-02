/**
 * « Mes preuves (contrôle) » — 30/09/2026, demande du maître d'ouvrage : en cas de contrôle ou d'inspection, l'usager
 * ouvre EN UN CLIC (bouton permanent de l'en-tête, « Mon espace », menu) toutes ses preuves en cours de validité, chacune
 * avec son code QR et son code en clair. L'agent scanne ou saisit le code : la vérification passe par le résolveur
 * universel des preuves (/preuve/<code>, SMS, WhatsApp, USSD, version légère), jamais par l'usager.
 * Hors ligne : la dernière liste chargée reste affichée (commodité de l'appareil ; le serveur reste la référence).
 */
import { useEffect, useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { QrCode } from '../../components/QrCode';
import { MoneyText } from '../../components/MoneyText';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { EmptyState, ErrorState, Loading } from '../../components/States';

interface Preuve {
  famille: 'STATIONNEMENT' | 'TITRE' | 'AUTORISATION' | 'QUITUS' | 'PUBLICITE' | 'CONDUCTEUR' | 'QUITTANCE';
  libelle: string; code: string; numero: string | null; sujet: string | null;
  valideDepuis: string | null; valideJusqua: string | null; montant: MoneyJSON | null;
}
interface MesPreuvesData { preuves: Preuve[]; genereLe: string; consigne: string }

const FAMILLE: Record<Preuve['famille'], string> = {
  STATIONNEMENT: 'Stationnement', TITRE: 'Titre ou pass', AUTORISATION: 'Autorisation', QUITUS: 'Quitus fiscal',
  PUBLICITE: 'Publicité', CONDUCTEUR: 'Conducteur', QUITTANCE: 'Quittance',
};
const CLE_CACHE = 'mosolo.mesPreuves';

/** Adresse de vérification publique d'un code (ce que l'agent ouvre en scannant). */
const urlPreuve = (code: string) => `${window.location.origin}/preuve/${encodeURIComponent(code)}`;

export default function MesPreuves() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<MesPreuvesData>('/v1/moi/preuves'), [user?.id]);
  const [cache, setCache] = useState<MesPreuvesData | null>(null);
  const [plein, setPlein] = useState<Preuve | null>(null);
  const [famille, setFamille] = useState<Preuve['famille'] | 'TOUTES'>('TOUTES');

  // Dernière liste connue : conservée sur l'appareil pour un contrôle sans réseau (jamais la référence).
  useEffect(() => {
    try {
      if (q.data) localStorage.setItem(`${CLE_CACHE}.${user?.id}`, JSON.stringify(q.data));
      else if (q.error && !cache) { const raw = localStorage.getItem(`${CLE_CACHE}.${user?.id}`); if (raw) setCache(JSON.parse(raw) as MesPreuvesData); }
    } catch { /* stockage indisponible : sans effet */ }
  }, [q.data, q.error, user?.id, cache]);

  const d = q.data ?? cache;
  const familles = d ? [...new Set(d.preuves.map((p) => p.famille))] : [];
  const liste = d ? d.preuves.filter((p) => famille === 'TOUTES' || p.famille === famille) : [];

  return (
    <div className="page">
      <PageHead eyebrow="Mon espace · contrôle" title="Mes preuves"
        lead="En cas de contrôle ou d’inspection, montrez le code QR : l’agent le scanne ou saisit le code. Vous n’avez rien d’autre à faire." />
      {q.loading && !d ? <Loading /> : !d && q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : d && (
        <>
          {!q.data && cache && (
            <div className="callout callout-warn" role="status"><Icon name="offline" size={18} /><span>Hors ligne : dernière liste enregistrée sur cet appareil ({fmtDate(cache.genereLe)}). L’agent vérifie chaque code sur le serveur.</span></div>
          )}
          <div className="callout callout-info" role="note"><Icon name="shieldCheck" size={18} /><span>{d.consigne}</span></div>
          {familles.length > 1 && (
            <div className="seg preuves-filtres" role="tablist" aria-label="Type de preuve">
              <button type="button" role="tab" aria-selected={famille === 'TOUTES'} onClick={() => setFamille('TOUTES')}>Toutes ({d.preuves.length})</button>
              {familles.map((f) => <button key={f} type="button" role="tab" aria-selected={famille === f} onClick={() => setFamille(f)}>{FAMILLE[f]}</button>)}
            </div>
          )}
          {liste.length === 0 ? (
            <EmptyState title="Aucune preuve en cours de validité" icon="qr">Vos titres, tickets, autorisations et quittances apparaîtront ici dès leur émission.</EmptyState>
          ) : (
            <ul className="preuves-grid" data-testid="mes-preuves">
              {liste.map((p) => (
                <li key={`${p.famille}-${p.code}`} className="preuve-carte">
                  <span className="small muted">{FAMILLE[p.famille]}</span>
                  <strong>{p.libelle}</strong>
                  {p.sujet && <span className="small">{p.sujet}</span>}
                  <button type="button" className="preuve-qr" onClick={() => setPlein(p)} aria-label={`Agrandir le code QR — ${p.libelle}`}>
                    <QrCode value={urlPreuve(p.code)} size={148} alt={`Code QR de vérification ${p.code}`} />
                  </button>
                  <span className="mono preuve-code">{p.code}</span>
                  {p.valideJusqua ? <ValidityCountdown from={p.valideDepuis} until={p.valideJusqua} compact /> : <span className="small muted">{p.famille === 'QUITTANCE' ? 'Preuve de paiement permanente' : 'En vigueur'}</span>}
                  {p.montant && <span className="small"><MoneyText money={p.montant} showIndicative={false} /></span>}
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setPlein(p)}><Icon name="qr" size={16} /> Montrer à l’agent</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {plein && (
        <div className="preuve-plein" role="dialog" aria-modal="true" aria-label={`Preuve — ${plein.libelle}`} onClick={() => setPlein(null)}>
          <div className="preuve-plein-carte" onClick={(e) => e.stopPropagation()}>
            <strong>{plein.libelle}</strong>
            {plein.sujet && <span>{plein.sujet}</span>}
            <QrCode value={urlPreuve(plein.code)} size={300} alt={`Code QR de vérification ${plein.code}`} />
            <span className="mono preuve-code-grand">{plein.code}</span>
            {plein.valideJusqua && <ValidityCountdown from={plein.valideDepuis} until={plein.valideJusqua} />}
            <button type="button" className="btn btn-secondary" onClick={() => setPlein(null)}>Fermer</button>
          </div>
        </div>
      )}
    </div>
  );
}
