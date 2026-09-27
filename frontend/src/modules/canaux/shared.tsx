/** Éléments communs des écrans « canaux » : pictogrammes normalisés, types d'API, formats. */
import type { MoneyJSON } from '@mosolo/shared';
import { Icon } from '../../components/Icon';

/** Catalogue identique à celui du serveur (GET /v1/public/pictograms) : la couleur est toujours doublée d'une forme. */
export const PICTOS: Record<string, { label: string; shape: string; color: string; icon: string }> = {
  PARCELLE: { label: 'Parcelle', shape: 'carre', color: 'palm', icon: 'grid' },
  LOGEMENT_LOUE: { label: 'Logement loué', shape: 'maison', color: 'flag-blue', icon: 'home' },
  COMMERCE: { label: 'Commerce', shape: 'etal', color: 'gold', icon: 'store' },
  VEHICULE: { label: 'Véhicule', shape: 'roue', color: 'navy', icon: 'car' },
  PANNEAU: { label: 'Panneau publicitaire', shape: 'rectangle', color: 'flag-red', icon: 'megaphone' },
  PAYER: { label: 'Payer', shape: 'cercle', color: 'palm', icon: 'cash' },
  CONTESTER: { label: 'Contester', shape: 'triangle', color: 'gold', icon: 'scale' },
  VERIFIER: { label: 'Vérifier', shape: 'bouclier', color: 'flag-blue', icon: 'shieldCheck' },
  ECHEANCE: { label: 'Échéance', shape: 'horloge', color: 'navy', icon: 'clock' },
  LIEU_PAIEMENT: { label: 'Où payer', shape: 'repere', color: 'navy', icon: 'pin' },
  ZERO_ESPECES_AGENT: { label: "Aucun agent ne reçoit d'argent", shape: 'barre', color: 'flag-red', icon: 'ban' },
  GRATUIT: { label: 'Enrôlement gratuit', shape: 'etoile', color: 'palm', icon: 'star' },
};

export function Pictogram({ code, size = 40, showLabel = false }: { code: string; size?: number; showLabel?: boolean }) {
  const p = PICTOS[code] ?? PICTOS.PARCELLE!;
  return (
    <span className="cx-picto-wrap">
      <span className={`cx-picto cx-shape-${p.shape}`} style={{ width: size, height: size, ['--cx-c' as string]: `var(--${p.color})` }} role="img" aria-label={p.label} title={p.label}>
        <Icon name={p.icon} size={Math.round(size * 0.5)} />
      </span>
      {showLabel && <span className="cx-picto-label">{p.label}</span>}
    </span>
  );
}

export const POINT_TYPE_LABEL: Record<string, string> = {
  GUICHET_BANCAIRE_MOSOLO: 'Guichet bancaire (guichet MOSOLO)',
  AGENCE_BANCAIRE: 'Agence bancaire',
  AGENT_MONNAIE_MOBILE: 'Agent de monnaie mobile',
  TPE_PRESTATAIRE: 'Terminal d’un prestataire habilité',
};

export const POINT_STATUS: Record<string, { tone: 'good' | 'warning' | 'critical' | 'neutral' | 'info'; label: string }> = {
  ACTIF: { tone: 'good', label: 'Actif' },
  REFERENCE: { tone: 'info', label: 'Référencé (non actif)' },
  SUSPENDU: { tone: 'critical', label: 'Suspendu' },
  RETIRE: { tone: 'neutral', label: 'Retiré' },
};

/** Statuts d'un jour de caisse (console du point, revue du Trésor). */
export const DAY_STATUS: Record<string, { tone: 'good' | 'warning' | 'critical' | 'info'; label: string }> = {
  OUVERTE: { tone: 'info', label: 'Caisse ouverte' }, CLOTUREE: { tone: 'warning', label: 'Clôturée — versement à déclarer' },
  DECLAREE: { tone: 'warning', label: 'Versement déclaré — en attente du relevé bancaire' },
  VERSEE: { tone: 'good', label: 'Versée au compte public (relevé bancaire rapproché)' }, ECART: { tone: 'critical', label: 'Écart — exception ouverte' },
};

export interface PublicPoint {
  id: string; name: string; type: string; operator: string; commune: string; quartier: string; address: string;
  lat: number; lon: number; hours: string; status: 'ACTIF' | 'SUSPENDU'; guichetId: string | null; demo: boolean;
}
export interface Guichet { id: string; name: string; commune: string; address: string; hours: string; services: string[]; bankPointId: string; demo: boolean }

export interface ReceiptPrint {
  duplicata: boolean; collectionId: string; shortCode: string; receiptNumber: string; receiptCode: string; receiptStatus: string; mention: string;
  amount: MoneyJSON; paymentReference: string; revenueCategory: string; revenue: string; administration: string; beneficiaryAlias: string;
  taxpayerRefSuffix: string; paidAt: string; collectedAt: string; qrPayload: string; verificationPath: string;
  point: { id: string; name: string; operator: string; commune: string; approvalReference: string };
  pictograms: string[]; notices: string[];
}

export interface CardView {
  number: string; numberFormatted: string; status: string; iuc: string; commune: string; holderDisplayName: string; photoSha256: string | null;
  issuedAt: string; qrToken: string; previousCardNumber: string | null; replacedByNumber: string | null; free: boolean; mention: string;
}

/** Jour de caisse à Kinshasa (UTC+1). */
export function kinshasaToday(): string {
  return new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
}

export function hasRole(roles: string[] | undefined, ...wanted: string[]): boolean {
  return !!roles && roles.some((r) => wanted.includes(r));
}

/** URL de vérification publique d'une carte (cible du QR). */
export function cardVerifyUrl(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/canaux/verifier-carte?t=${encodeURIComponent(token)}`;
}

export function DemoRibbon({ text = 'Données de démonstration fictives' }: { text?: string }) {
  return <span className="ribbon">{text}</span>;
}
