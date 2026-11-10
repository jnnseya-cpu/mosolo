/** Composants partagés du module terrain : badge d'agent, boîte de décision motivée, jauge de progression. */
import { useState, type ReactNode } from 'react';
import { useApp } from '../../context';
import { Drawer } from '../../components/Drawer';
import { Icon } from '../../components/Icon';
import { QrCode } from '../../components/QrCode';
import { StatusBadge } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { describeError } from '../../lib/api';
import { moduleLabel } from './labels';
import type { Badge } from './types';

export const hasRole = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));

export function initials(name: string): string {
  return name.split(/\s+/).filter((w) => /^[A-Za-zÀ-ÿ]/.test(w)).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '·';
}

export function origin(): string {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/** Badge numérique de l'agent (QR signé + code court) — vérifiable publiquement, sans téléphone ni adresse. */
export function BadgeCard({ badge, name, structure }: { badge: Badge; name: string; structure: string }) {
  const { fmtDate } = useApp();
  const active = badge.status === 'ACTIF';
  return (
    <article className={`tr-badge ${active ? '' : 'tr-badge-off'}`} aria-label={`Badge d’agent ${badge.shortCode}`}>
      <div className="tr-badge-head">
        <p>Ville-Province de Kinshasa · Agent de terrain</p>
        <Icon name="shieldCheck" size={18} />
      </div>
      <div className="tr-badge-strip" aria-hidden="true">
        <span style={{ background: 'var(--flag-blue)' }} /><span style={{ background: 'var(--flag-yellow)' }} /><span style={{ background: 'var(--flag-red)' }} />
      </div>
      <div className="tr-badge-body">
        <div className="tr-avatar" aria-hidden="true">{initials(name)}</div>
        <div className="min0">
          <p className="tr-badge-name">{name}</p>
          <p className="tr-sub">{structure}</p>
          <p className="small" style={{ marginTop: 6 }}>{moduleLabel(badge.module)} · {badge.communes.join(', ')}</p>
          <p className="small muted">Valide du {fmtDate(badge.validFrom)} au {fmtDate(badge.validUntil)}</p>
          <div style={{ marginTop: 6 }}>
            <StatusBadge tone={active ? 'good' : 'critical'} label={active ? 'Actif' : badge.status === 'SUSPENDU' ? 'Suspendu' : 'Révoqué'} />
          </div>
          <div style={{ marginTop: 6 }}>
            <ValidityCountdown compact from={badge.validFrom} until={badge.validUntil} blocked={active ? null : badge.status === 'SUSPENDU' ? 'Suspendu' : 'Révoqué'} label="Habilitation" />
          </div>
        </div>
      </div>
      <div className="tr-badge-foot">
        <div className="min0">
          <p className="caps-sm muted">Code de vérification</p>
          <p className="tr-code">{badge.shortCode}</p>
          <p className="small muted">Vérifiable par tous sur la page « Vérifier un agent », par SMS ou au SVI.</p>
        </div>
        <QrCode value={`${origin()}${badge.qrPath}`} size={96} alt={`QR de vérification du badge ${badge.shortCode}`} />
      </div>
    </article>
  );
}

export function Progress({ pct, label }: { pct: string | null; label: ReactNode }) {
  const v = pct ? Math.min(100, Number.parseFloat(pct)) : 0;
  return (
    <div className="tr-progress">
      <span className="small">{label}</span>
      <div className="tr-bar" role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${v}%` }} /></div>
    </div>
  );
}

/**
 * Décision humaine motivée (suspension, validation, rejet…) : le motif est obligatoire et tracé dans l'audit.
 */
export function ReasonDrawer({ open, title, intro, confirmLabel, danger, onClose, onConfirm, children }: {
  open: boolean; title: string; intro?: ReactNode; confirmLabel: string; danger?: boolean; onClose: () => void;
  onConfirm: (reason: string) => Promise<unknown>; children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try { await onConfirm(reason.trim()); setReason(''); onClose(); } catch (e) { const d = describeError(e); setErr(d.message + (d.code ? ` (${d.code})` : '')); } finally { setBusy(false); }
  }
  return (
    <Drawer open={open} title={title} onClose={onClose}>
      <div className="form">
        {intro && <div className="small">{intro}</div>}
        {children}
        <div className="field">
          <label className="label" htmlFor="tr-reason">Motif de la décision (obligatoire, tracé dans l’audit)</label>
          <textarea id="tr-reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
          <span className="hint">Au moins 5 caractères. La décision est nominative et horodatée.</span>
        </div>
        {err && <p className="notice notice-err" role="alert">{err}</p>}
        <button type="button" className={`btn ${danger ? 'btn-secondary' : 'btn-primary'} btn-block`} disabled={busy || reason.trim().length < 5} onClick={() => void submit()}>
          {busy ? '…' : confirmLabel}
        </button>
      </div>
    </Drawer>
  );
}

/** Message de retour d'une action (succès ou erreur RFC 9457 lisible). */
export function useFeedback() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const node = msg ? <p role={msg.ok ? 'status' : 'alert'} className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} style={{ marginBottom: 12 }}>{msg.text}</p> : null;
  const run = async (fn: () => Promise<unknown>, okText: string) => {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: okText }); return true; } catch (e) { const d = describeError(e); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); return false; }
  };
  return { node, run, setMsg };
}
