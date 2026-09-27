/**
 * Éléments partagés des écrans ParkSmart et KIN PUB CONTROL : types de l'API, action asynchrone avec erreur,
 * feu de titre, montants par devise, preuve photographique (empreinte SHA-256 calculée sur l'appareil),
 * position GPS, mini-carte vectorielle et décision motivée.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { formatMoney, type MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { Icon } from '../../components/Icon';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { api, describeError, newIdempotencyKey, serverNow } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import type { EvidencePhotoMeta } from './EvidencePhotos';

export const hasRole = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));

// ------------------------------------------------------------------ Types (contrat /v1/parking)

export type Light = 'VERT' | 'AMBRE' | 'ROUGE';

export interface RuleSummary { code: string; version: number | null; status: string; label: string; demo: boolean; currency: string | null; rateTable: Record<string, string>; formula: string | null }

export interface Zone {
  id: string; code: string; name: string; commune: string; quartier: string; kind: 'ZONE_INTEGRALE' | 'ARTERE' | 'SECTEUR';
  geometry: { type: 'Polygon' | 'LineString'; coordinates: [number, number][] }; center: { lat: number; lon: number };
  localityRank: number; capacity: { standard: number; livraison: number; pmr: number }; linearMeters: number | null;
  actReference: string | null; tariffRuleCode: string | null; penaltyRuleCode: string | null; maxDurationMinutes: number | null;
  suspended?: { reason: string; by: string; at: string }; demo: boolean; note?: string;
  legalStatus: 'OUVERTE' | 'ACTE_REQUIS' | 'SUSPENDUE'; tariffRule: RuleSummary | null; penaltyRule: RuleSummary | null;
  occupancy: { active: number; reserved: number; capacity: number; rate: string | null; free: number };
}

export interface ObligationSummary { id: string; amount: MoneyJSON; dueDate: string; status: string; label: string; ruleCode: string; ruleVersion: number; commune: string | null }

export interface Session {
  ticketCode?: string | null;
  id: string; zone: { id: string; code: string; name: string; commune: string; demo: boolean } | null; plate: string;
  status: 'EN_ATTENTE_PAIEMENT' | 'ACTIVE' | 'EXPIREE' | 'TERMINEE' | 'ABANDONNEE'; light: Light;
  startAt: string | null; paidUntil: string | null; remainingMinutes: number; totalMinutes: number; total: MoneyJSON[];
  segments: { kind: string; minutes: number; obligationId: string; amount: MoneyJSON; requestedAt: string; payment: string; paymentReference: string | null }[];
  pendingPayment: string | null; createdAt: string; endedAt: string | null;
}

export interface Violation {
  id: string; reference: string; zoneId: string; commune: string; plate: string; nature: string; lightAtCheck: Light | null;
  agentId: string; createdAt: string; status: 'CONSTATE' | 'VERIFIE' | 'REJETE' | 'RETENU' | 'CLASSE'; holderIdentified: boolean;
  zone: { id: string; code: string; name: string } | null;
  evidence: { photoSha256: string[]; lat: number; lon: number; gpsAccuracyM: number | null; observedAt: string; observations: string; place?: string; photoIds?: string[] } | null;
  photos?: EvidencePhotoMeta[];
  verification?: { by: string; at: string; outcome: string; note: string };
  proposal?: { status: 'PROPOSEE' | 'ACTE_REQUIS'; ruleCode: string | null; ruleVersion: number | null; amount: MoneyJSON | null; basis: string };
  decision?: { by: string; at: string; outcome: string; reason: string; obligationId: string | null; effect: string };
  obligation: (ObligationSummary & { payment: string }) | null;
  contests: { id: string; at: string; grounds: string; stage: string; appealId?: string }[];
}

export interface Reservation {
  id: string; reference: string; zoneId: string; purpose: string; places: number; startAt: string; endAt: string; plate: string | null; notes: string;
  status: string; state: string; payment: string; amount: MoneyJSON | null; obligationId?: string; decision?: { reason: string; at: string };
  zone: { id: string; code: string; name: string } | null; requestedAt: string;
}

export interface Partner {
  id: string; name: string; kind: 'PARKING_PRIVE' | 'MARCHAND'; commune: string; quartier: string; lat: number; lon: number; capacity: number;
  status: 'CONVENTION_EN_COURS' | 'PARTENAIRE' | 'SUSPENDU'; declaredFree?: { places: number; at: string }; demo: boolean; hasOperatorAccount?: boolean;
}

// ------------------------------------------------------------------ Libellés

export const LIGHT_VIEW: Record<Light, { tone: Tone; label: string; icon: string }> = {
  VERT: { tone: 'good', label: 'Titre valide', icon: 'check' },
  AMBRE: { tone: 'warning', label: 'Bientôt expiré', icon: 'clock' },
  ROUGE: { tone: 'critical', label: 'Aucun titre valide', icon: 'x' },
};

export const SESSION_STATUS: Record<Session['status'], { tone: Tone; label: string }> = {
  EN_ATTENTE_PAIEMENT: { tone: 'neutral', label: 'En attente du paiement' },
  ACTIVE: { tone: 'good', label: 'Active' },
  EXPIREE: { tone: 'critical', label: 'Expirée' },
  TERMINEE: { tone: 'info', label: 'Terminée' },
  ABANDONNEE: { tone: 'neutral', label: 'Abandonnée' },
};

export const ZONE_STATUS: Record<Zone['legalStatus'], { tone: Tone; label: string }> = {
  OUVERTE: { tone: 'good', label: 'Ouverte' },
  ACTE_REQUIS: { tone: 'neutral', label: 'Acte requis' },
  SUSPENDUE: { tone: 'warning', label: 'Suspendue' },
};

export const ZONE_KIND: Record<Zone['kind'], string> = { ZONE_INTEGRALE: 'Zone intégrale', ARTERE: 'Artère', SECTEUR: 'Secteur' };

export const NATURE: Record<string, string> = {
  NON_PAIEMENT: 'Non-paiement', DEPASSEMENT: 'Dépassement de durée', STATIONNEMENT_INTERDIT: 'Stationnement interdit',
  PLACE_RESERVEE: 'Place réservée (livraison, PMR)', DOUBLE_FILE: 'Double file',
};

export const VIOLATION_STATUS: Record<Violation['status'], { tone: Tone; label: string }> = {
  CONSTATE: { tone: 'neutral', label: 'Constaté — à vérifier' },
  VERIFIE: { tone: 'warning', label: 'Vérifié — décision attendue' },
  REJETE: { tone: 'info', label: 'Écarté à la vérification' },
  RETENU: { tone: 'serious', label: 'Retenu par décision' },
  CLASSE: { tone: 'info', label: 'Classé' },
};

export const PAYMENT_STATE: Record<string, { tone: Tone; label: string }> = {
  AUCUNE_REFERENCE: { tone: 'neutral', label: 'À payer' },
  REFERENCE_EMISE: { tone: 'warning', label: 'Référence émise' },
  PAYE: { tone: 'info', label: 'Payé (confirmé)' },
  RAPPROCHE: { tone: 'good', label: 'Payé et rapproché' },
};

export const PURPOSE: Record<string, string> = { DEMENAGEMENT: 'Déménagement', CHANTIER: 'Chantier', LIVRAISON: 'Livraison', EVENEMENT: 'Événement' };

export function fmtMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`;
}

// ------------------------------------------------------------------ Petits composants

export function LightBadge({ light, label }: { light: Light; label?: string }) {
  const v = LIGHT_VIEW[light];
  return <StatusBadge tone={v.tone} icon={v.icon} label={label ?? v.label} />;
}

export function Money({ items, empty = '—' }: { items: MoneyJSON[] | MoneyJSON | null | undefined; empty?: string }) {
  const { lang } = useApp();
  const list = !items ? [] : Array.isArray(items) ? items : [items];
  if (list.length === 0) return <span className="muted">{empty}</span>;
  return <span className="num nowrap">{list.map((m) => formatMoney(m, { locale: lang === 'en' ? 'en' : 'fr' })).join(' · ')}</span>;
}

export function DemoTag({ show = true, label = 'Démonstration' }: { show?: boolean; label?: string }) {
  if (!show) return null;
  return <span className="ribbon" title="Donnée fictive de démonstration, sans valeur juridique">{label}</span>;
}

/** Action asynchrone : état occupé, message d'erreur lisible, rappel au succès. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>, onDone?: (r: T) => void): Promise<T | undefined> {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      onDone?.(r);
      return r;
    } catch (e) {
      setError(describeError(e).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="notice notice-err" role="alert">{error}</p> : null;
}

/** Obtenir une référence de paiement pour une obligation (circuit commun, clé d'idempotence). */
export function PayButton({ obligationId, onDone, label = 'Obtenir la référence de paiement' }: { obligationId: string; onDone?: () => void; label?: string }) {
  const [key] = useState(newIdempotencyKey);
  const [ref, setRef] = useState<{ paymentReference: string; amount: MoneyJSON; expiresAt?: string; receivedAt?: string } | null>(null);
  const act = useAction();
  const { fmtDate } = useApp();
  if (ref) {
    return (
      <div className="pk-payref" role="status">
        <p className="caps-sm muted">Référence de paiement</p>
        <p className="pk-ref mono">{ref.paymentReference}</p>
        <p className="small">Montant : <Money items={ref.amount} />{ref.expiresAt ? ` · valable jusqu’au ${fmtDate(ref.expiresAt, true)}` : ''}</p>
        {ref.expiresAt && <ValidityCountdown compact from={ref.receivedAt} until={ref.expiresAt} label="Référence de paiement" />}
        <p className="small muted">Payez par monnaie mobile, banque ou point agréé : la validité démarre à la confirmation signée du prestataire. Aucun agent n’encaisse d’espèces.</p>
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <button type="button" className="btn btn-primary btn-sm" disabled={act.busy}
        onClick={() => void act.run(() => api<{ paymentReference: string; amount: MoneyJSON; expiresAt?: string }>(`/v1/obligations/${encodeURIComponent(obligationId)}/payment-orders`, { method: 'POST', idempotencyKey: key, body: { channel: 'MOBILE_MONEY' } }), (r) => { setRef({ ...r, receivedAt: new Date(serverNow()).toISOString() }); onDone?.(); })}>
        <Icon name="phone" size={16} /> {act.busy ? 'Envoi…' : label}
      </button>
      <ErrorLine error={act.error} />
    </div>
  );
}

/**
 * Preuve photographique : l'empreinte SHA-256 est calculée sur l'appareil ; seule l'empreinte est transmise
 * (le fichier reste sur le terminal jusqu'au dépôt sécurisé des preuves).
 */
export function PhotoHashes({ value, onChange, max = 4, label = 'Photographies (obligatoires)' }: { value: string[]; onChange: (v: string[]) => void; max?: number; label?: string }) {
  const [busy, setBusy] = useState(false);
  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const out = [...value];
    for (const f of Array.from(files).slice(0, max - value.length)) out.push(await sha256Hex(await f.arrayBuffer()));
    onChange(out);
    setBusy(false);
  }
  return (
    <div className="field">
      <span className="label">{label}</span>
      <label className="btn btn-secondary btn-sm pk-file">
        <Icon name="camera" size={16} /> {busy ? 'Calcul de l’empreinte…' : 'Prendre ou joindre une photo'}
        <input type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => void add(e.target.files)} disabled={value.length >= max} />
      </label>
      {value.length > 0 && (
        <ul className="pk-hashes">
          {value.map((h, i) => (
            <li key={h + i}><Icon name="lock" size={14} /> <span className="mono">{h.slice(0, 16)}…</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Retirer la photo">Retirer</button></li>
          ))}
        </ul>
      )}
      <span className="hint">Seule l’empreinte SHA-256 est transmise ; l’heure est celle du serveur.</span>
    </div>
  );
}

/** Position GPS de l'appareil (saisie manuelle possible si la géolocalisation est refusée). */
export function GpsField({ lat, lon, onChange }: { lat: string; lon: string; onChange: (lat: string, lon: string, accuracy?: number) => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  function locate() {
    if (!navigator.geolocation) { setMsg('Géolocalisation indisponible : saisir la position.'); return; }
    setMsg('Localisation…');
    navigator.geolocation.getCurrentPosition(
      (p) => { onChange(p.coords.latitude.toFixed(6), p.coords.longitude.toFixed(6), Math.round(p.coords.accuracy)); setMsg(`Précision ≈ ${Math.round(p.coords.accuracy)} m`); },
      () => setMsg('Position refusée : saisir la position.'),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }
  return (
    <div className="field">
      <span className="label">Position GPS</span>
      <div className="pk-gps">
        <input aria-label="Latitude" inputMode="decimal" value={lat} onChange={(e) => onChange(e.target.value, lon)} placeholder="Latitude" />
        <input aria-label="Longitude" inputMode="decimal" value={lon} onChange={(e) => onChange(lat, e.target.value)} placeholder="Longitude" />
        <button type="button" className="btn btn-secondary btn-sm" onClick={locate}><Icon name="gps" size={16} /> Localiser</button>
      </div>
      {msg && <span className="hint">{msg}</span>}
    </div>
  );
}

/** Décision motivée (motif obligatoire, tracé dans le journal d'audit). */
export function ReasonForm({ confirmLabel, onSubmit, danger, children, placeholder = 'Motif de la décision (obligatoire)' }: {
  confirmLabel: string; onSubmit: (reason: string) => Promise<unknown>; danger?: boolean; children?: ReactNode; placeholder?: string;
}) {
  const [reason, setReason] = useState('');
  const act = useAction();
  function go(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 5) { act.setError('Motif trop court (5 caractères au moins).'); return; }
    void act.run(() => onSubmit(reason.trim()), () => setReason(''));
  }
  return (
    <form className="form pk-reason" onSubmit={go}>
      {children}
      <label className="field">
        <span className="label">Motif</span>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} />
      </label>
      <ErrorLine error={act.error} />
      <button type="submit" className={`btn ${danger ? 'btn-secondary' : 'btn-primary'} btn-sm`} disabled={act.busy}>{act.busy ? 'Envoi…' : confirmLabel}</button>
    </form>
  );
}

// ------------------------------------------------------------------ Mini-carte vectorielle (sans tuiles externes)

export interface MapShape { id: string; type: 'Polygon' | 'LineString'; coordinates: [number, number][]; color: string; label: string; dashed?: boolean }
export interface MapPoint { id: string; lat: number; lon: number; color: string; label: string; ring?: boolean }

export function MiniMap({ shapes = [], points = [], height = 280, caption, onSelect }: {
  shapes?: MapShape[]; points?: MapPoint[]; height?: number; caption: string; onSelect?: (id: string) => void;
}) {
  const all: [number, number][] = [...shapes.flatMap((s) => s.coordinates), ...points.map((p) => [p.lon, p.lat] as [number, number])];
  if (all.length === 0) return <p className="muted small">Aucun élément à cartographier.</p>;
  const lons = all.map((p) => p[0]);
  const lats = all.map((p) => p[1]);
  const pad = 0.004;
  const minLon = Math.min(...lons) - pad, maxLon = Math.max(...lons) + pad, minLat = Math.min(...lats) - pad, maxLat = Math.max(...lats) + pad;
  const W = 1000;
  const H = Math.max(360, Math.round((W * (maxLat - minLat)) / Math.max(maxLon - minLon, 1e-6)));
  const x = (lon: number) => ((lon - minLon) / (maxLon - minLon)) * W;
  const y = (lat: number) => ((maxLat - lat) / (maxLat - minLat)) * H;
  const path = (c: [number, number][], closed: boolean) => c.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ') + (closed ? ' Z' : '');
  return (
    <figure className="pk-map" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={caption}>
        <rect x="0" y="0" width={W} height={H} className="pk-map-bg" />
        {shapes.map((s) => (
          <g key={s.id} onClick={() => onSelect?.(s.id)} style={onSelect ? { cursor: 'pointer' } : undefined}>
            <title>{s.label}</title>
            <path d={path(s.coordinates, s.type === 'Polygon')} fill={s.type === 'Polygon' ? s.color : 'none'} fillOpacity={0.18}
              stroke={s.color} strokeWidth={s.type === 'Polygon' ? 3 : 9} strokeLinecap="round" strokeDasharray={s.dashed ? '14 10' : undefined} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {points.map((p) => (
          <g key={p.id} onClick={() => onSelect?.(p.id)} style={onSelect ? { cursor: 'pointer' } : undefined}>
            <title>{p.label}</title>
            {p.ring && <circle cx={x(p.lon)} cy={y(p.lat)} r={20} fill="none" stroke={p.color} strokeWidth={3} />}
            <circle cx={x(p.lon)} cy={y(p.lat)} r={11} fill={p.color} stroke="var(--surface)" strokeWidth={3} />
          </g>
        ))}
      </svg>
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}

/** Tuiles d'indicateurs (libellé, valeur, pied). */
export function Kpis({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode }[] }) {
  return (
    <dl className="pk-kpis">
      {items.map((k) => (
        <div key={k.label}>
          <dt>{k.label}</dt>
          <dd>{k.value}{k.sub !== undefined && <small>{k.sub}</small>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function pctText(v: string | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v.replace('.', ',')} %`;
}
