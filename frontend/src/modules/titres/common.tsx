/**
 * Éléments communs des écrans de titres : statut (couleur + icône + texte, jamais la couleur seule),
 * QR dynamique régénéré toutes les 30 s, signal sonore de contrôle.
 */
import { useEffect, useRef, useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { Icon } from '../../components/Icon';
import type { OverduePenaltiesData } from '../../components/OverduePenalties';
import { QrCode } from '../../components/QrCode';
import { api, describeError } from '../../lib/api';

export type StatusColor = 'gris' | 'vert' | 'ambre' | 'rouge' | 'bleu' | 'noir';

export interface StatusView {
  status: string;
  color: StatusColor | string;
  icon: string;
  signal?: string;
  text: string;
  remainingSeconds?: number;
  serverTime?: string;
  validity?: { band: string; pct: number | null; from: string; until: string };
}

export interface CredentialView {
  id: string;
  number: string;
  shortCode: string;
  typeCode: string;
  typeLabel: string;
  prefix?: string;
  module: string;
  modelLabel: string;
  subject: { plate?: string; driverId?: string; motoId?: string; label?: string };
  place: { commune: string | null; label: string; basis: string };
  attribution: { commune: string | null; basis: string };
  validFrom: string;
  validUntil: string;
  usesTotal?: number;
  usesLeft?: number;
  state: string;
  stateReason?: string;
  receiptNumbers: string[];
  paymentReference?: string;
  amount?: MoneyJSON;
  staticToken: string;
  issuedAt: string;
  demo: boolean;
  status: StatusView;
}

export interface IssuancePayment {
  commune: string | null;
  obligationId: string;
  paymentOrderId: string;
  paymentReference: string;
  amount: MoneyJSON;
  expiresAt: string;
  status: 'EN_ATTENTE' | 'PAYE' | 'EXPIRE' | 'ECHOUE';
}

export interface Issuance {
  id: string;
  status: string;
  channel: string;
  createdAt: string;
  context?: string;
  groupPayer?: { kind: string; id: string; label: string };
  items: { typeCode: string; subject: { plate?: string; label?: string }; credentialId?: string }[];
  payments: IssuancePayment[];
}

export interface ControlView {
  controlId: string;
  result: 'VALIDE' | 'INVALIDE' | 'EXPIRE';
  status: string;
  color: string;
  icon: string;
  signal: string;
  text: string;
  remainingSeconds?: number;
  serverTime: string;
  validFrom?: string;
  validUntil?: string;
  validity?: { band: string; pct: number | null; from: string; until: string };
  module?: string;
  typeLabel?: string;
  prefix?: string;
  plate?: string;
  zone?: string;
  alreadyUsed?: { at: string; place: { label?: string; lat?: number; lon?: number } };
  nothingToPay: boolean;
  constat?: { id: string; notice: string };
  driverVerified?: boolean | null;
  offline?: boolean;
  penalitesImpayees?: OverduePenaltiesData;
  /** Anti-fraude (30/09/2026) : preuve bloquée à titre conservatoire, dossier ouvert. */
  fraude?: { kind: string; label: string; caseId: string };
}

export const STATUS_LABEL: Record<string, string> = {
  PAS_ENCORE_ACTIF: 'Pas encore actif', VALIDE: 'Valide', BIENTOT_EXPIRE: 'Bientôt expiré', CRITIQUE: 'Valide — expire très bientôt', EXPIRE: 'Expiré',
  SUSPENDU: 'Suspendu', INVALIDE: 'Invalide', INCONNU: 'Inconnu',
};

export const ISSUANCE_LABEL: Record<string, string> = {
  EN_ATTENTE_PAIEMENT: 'En attente de paiement', PARTIELLEMENT_EMISE: 'Partiellement émise', EMISE: 'Titre(s) émis',
  EXPIREE: 'Référence expirée — rien n’est dû', ANNULEE: 'Annulée — rien n’est dû',
};

export function useCountdown(initialSeconds: number | undefined): number | undefined {
  const [left, setLeft] = useState(initialSeconds);
  useEffect(() => {
    setLeft(initialSeconds);
    if (initialSeconds === undefined) return;
    const start = Date.now();
    const t = window.setInterval(() => setLeft(initialSeconds - Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [initialSeconds]);
  return left;
}

/** Pastille de statut d'un titre : couleur + icône + texte. */
export function TitleStatus({ status, compact }: { status: StatusView; compact?: boolean }) {
  return (
    <span className={`tt-status tt-${status.color}${compact ? ' tt-status-sm' : ''}`}>
      <Icon name={status.icon} size={compact ? 14 : 16} />
      <span>{compact ? STATUS_LABEL[status.status] ?? status.status : status.text}</span>
    </span>
  );
}

/** Signal sonore de contrôle : court (valide) ou distinct (expiré, invalide). Silencieux si l'audio est indisponible. */
export function playSignal(kind: string): void {
  if (kind !== 'COURT' && kind !== 'DISTINCT') return;
  try {
    // Conversion justifiée : préfixe Safari historique (webkitAudioContext) absent des types DOM standard.
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tones = kind === 'COURT' ? [[880, 0, 0.12]] : [[330, 0, 0.18], [247, 0.22, 0.3]];
    for (const [f, at, dur] of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f!;
      g.gain.value = 0.08;
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at!);
      o.stop(ctx.currentTime + at! + dur!);
    }
    window.setTimeout(() => void ctx.close(), 800);
  } catch { /* audio indisponible */ }
}

interface DynamicQrData { token: string; expiresAt: string; windowSeconds: number; serverTime: string; status: StatusView; validUntil: string }

/**
 * QR dynamique : jeton de la fenêtre serveur de 30 s, régénéré automatiquement. L'anneau animé et le compte à rebours
 * rendent une capture d'écran immédiatement reconnaissable ; un code copié devient invalide à la fenêtre suivante.
 */
export function DynamicQr({ credentialId, size = 148 }: { credentialId: string; size?: number }) {
  const [data, setData] = useState<DynamicQrData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState(30);
  const offset = useRef(0);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const d = await api<DynamicQrData>(`/v1/titres/${encodeURIComponent(credentialId)}/qr`);
        if (!alive) return;
        offset.current = new Date(d.serverTime).getTime() - Date.now();
        setData(d);
        setErr(null);
        const ms = Math.max(1000, new Date(d.expiresAt).getTime() - (Date.now() + offset.current) + 200);
        timer = window.setTimeout(() => void load(), ms);
      } catch (e) {
        if (!alive) return;
        setErr(describeError(e).message);
        timer = window.setTimeout(() => void load(), 10_000);
      }
    };
    void load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [credentialId]);
  useEffect(() => {
    if (!data) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((new Date(data.expiresAt).getTime() - (Date.now() + offset.current)) / 1000)));
    tick();
    const t = window.setInterval(tick, 250);
    return () => window.clearInterval(t);
  }, [data]);
  if (err && !data) return <p className="notice notice-err small">QR indisponible : {err}</p>;
  if (!data) return <div className="tt-qr-wrap" style={{ width: size + 24, height: size + 24 }} aria-hidden="true" />;
  const pct = Math.round((left / data.windowSeconds) * 100);
  return (
    <figure className="tt-qr">
      <div className={`tt-qr-wrap tt-ring-${data.status.color}`} style={{ ['--pct' as string]: `${pct}%` }}>
        <span className="tt-qr-spin" aria-hidden="true" />
        <QrCode value={data.token} size={size} alt="QR dynamique du titre, régénéré toutes les 30 secondes" />
      </div>
      <figcaption className="small">
        <span className="tt-qr-count" aria-live="off"><Icon name="refresh" size={13} /> Nouveau code dans {left} s</span>
        <span className="muted"> · une capture d’écran est refusée au contrôle</span>
      </figcaption>
    </figure>
  );
}
