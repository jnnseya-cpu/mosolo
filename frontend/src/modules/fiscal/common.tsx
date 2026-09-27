/** Éléments communs aux écrans du module fiscal. */
import { useState, type FormEvent, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import type { MapStatusColor } from '@mosolo/shared';
import { useApp } from '../../context';
import { Icon } from '../../components/Icon';
import { QrCode } from '../../components/QrCode';
import type { Tone } from '../../components/StatusBadge';
import { describeError } from '../../lib/api';
import { MAP_STATUS } from '../../lib/status';
import type { ColorResult } from './types';

export function useViewer() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const has = (...rs: string[]) => roles.some((r) => rs.includes(r));
  return { user, roles, has, isTaxpayer: has('R30', 'R31') };
}

/** Pastille de couleur calculée par le serveur : couleur + icône + libellé, motif en infobulle. */
export function ColorChip({ result, compact }: { result: ColorResult; compact?: boolean }) {
  const s = MAP_STATUS[result.color] ?? MAP_STATUS.grey;
  return (
    <span className="map-chip fs-chip" title={result.reason}>
      <span className="map-dot" style={{ background: s.color }} aria-hidden="true"><Icon name={s.icon} size={10} /></span>
      <span>{compact ? COLOR_WORD[result.color] : result.label}</span>
    </span>
  );
}

export const COLOR_WORD: Record<MapStatusColor, string> = { green: 'Vert', amber: 'Ambre', red: 'Rouge', grey: 'Gris', blue: 'Bleu' };

export const PROBATIVE: Record<string, { label: string; tone: Tone }> = {
  DECLARE: { label: 'Déclaré', tone: 'neutral' },
  OBSERVE: { label: 'Observé', tone: 'info' },
  VERIFIE: { label: 'Vérifié', tone: 'good' },
  CONTESTE: { label: 'Contesté', tone: 'serious' },
};

export const RELATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  PROPOSEE: { label: 'Proposée — en instruction', tone: 'warning' },
  VALIDEE: { label: 'Validée', tone: 'good' },
  CONTESTEE: { label: 'Contestée', tone: 'serious' },
  REJETEE: { label: 'Rejetée', tone: 'critical' },
  CLOSE: { label: 'Close', tone: 'neutral' },
};

export const PROOF_LABELS: Record<string, string> = {
  TITRE_FONCIER: 'Titre foncier', CERTIFICAT_ENREGISTREMENT: 'Certificat d’enregistrement', ACTE_DE_VENTE: 'Acte de vente',
  CONTRAT_DE_LOCATION: 'Contrat de location', ATTESTATION_COUTUMIERE: 'Attestation coutumière', ACTE_SUCCESSORAL: 'Acte successoral',
  MANDAT_DE_GESTION: 'Mandat de gestion', CONSTAT_TERRAIN: 'Constat de terrain', AUTRE: 'Autre pièce',
};

export const PERIODICITY: Record<string, string> = { MENSUELLE: 'mensuel', TRIMESTRIELLE: 'trimestriel', SEMESTRIELLE: 'semestriel', ANNUELLE: 'annuel' };

/** Navigation entre les écrans du module (liens, pas d'état). */
export function FiscalTabs() {
  const { isTaxpayer, has } = useViewer();
  const links: { to: string; label: string; icon: string; show: boolean }[] = [
    { to: '/fiscal/biens', label: isTaxpayer ? 'Mes biens' : 'Biens et relations', icon: 'building', show: true },
    { to: '/fiscal/declarations', label: 'Déclarations', icon: 'file', show: isTaxpayer || has('R06', 'R07', 'R11', 'R12') },
    { to: '/fiscal/exonerations', label: 'Exonérations', icon: 'scale', show: isTaxpayer || has('R06', 'R07', 'R11', 'R12', 'R13', 'R14', 'R22', 'R24') },
    { to: '/fiscal/corrections', label: 'Corrections', icon: 'replace', show: has('R06', 'R07', 'R11') },
    { to: '/fiscal/quitus', label: 'Quitus', icon: 'shieldCheck', show: true },
    { to: '/fiscal/baux', label: 'Attestations de bail', icon: 'ticket', show: isTaxpayer },
    { to: '/fiscal/carte', label: 'Carte', icon: 'pin', show: true },
  ];
  return (
    <nav className="fs-tabs" aria-label="Démarches fiscales">
      {links.filter((l) => l.show).map((l) => (
        <NavLink key={l.to} to={l.to} className={({ isActive }) => `fs-tab${isActive ? ' active' : ''}`}>
          <Icon name={l.icon} size={16} /> <span>{l.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/** QR de vérification publique (chemin signé fourni par le serveur). */
export function VerifyQr({ path, code, caption, size = 120 }: { path: string; code: string; caption: string; size?: number }) {
  const url = `${window.location.origin}${path}`;
  return (
    <figure className="fs-qr">
      <QrCode value={url} size={size} alt={`QR de vérification — ${caption}`} />
      <figcaption>
        <span className="mono">{code}</span>
        <a className="small" href={path}>Vérifier</a>
      </figcaption>
    </figure>
  );
}

/** Mini-formulaire « motif obligatoire » pour une décision (valider, rejeter, révoquer…). */
export function ReasonAction({ label, confirmLabel, tone = 'primary', minLength = 3, onSubmit, children }: {
  label: string; confirmLabel: string; tone?: 'primary' | 'secondary'; minLength?: number;
  onSubmit: (reason: string) => Promise<unknown>; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await onSubmit(reason.trim()); setOpen(false); setReason(''); } catch (x) { setErr(describeError(x).message); } finally { setBusy(false); }
  }
  if (!open) return <button type="button" className={`btn btn-${tone} btn-sm`} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form className="fs-reason" onSubmit={(e) => void go(e)}>
      {children}
      <label className="label" htmlFor={`rs-${label}`}>Motif (obligatoire, tracé dans l’audit)</label>
      <textarea id={`rs-${label}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={minLength} maxLength={1000} />
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <div className="btn-row">
        <button type="submit" className={`btn btn-${tone} btn-sm`} disabled={busy || reason.trim().length < minLength}>{busy ? 'Envoi…' : confirmLabel}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Annuler</button>
      </div>
    </form>
  );
}

/** Note « données d'exemple » (tout ce qui vient du jeu de démonstration est signalé). */
export function DemoNote({ children }: { children?: ReactNode }) {
  return (
    <p className="example-notice" role="note">
      <Icon name="info" size={16} />
      <span>{children ?? 'Données de démonstration fictives : personnes, biens, pièces et montants sont des exemples non opposables.'}</span>
    </p>
  );
}
