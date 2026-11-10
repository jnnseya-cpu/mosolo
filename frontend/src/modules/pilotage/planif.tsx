/**
 * Planification et pilotage stratégique — composants communs des écrans (base de référence, pilote, scénarios,
 * assignations, instructions, accords de service, projets, partage légal, registre des modèles d'IA).
 * Le serveur reste seul juge des droits (séparation des tâches, périmètre) : l'interface n'affiche qu'une aide.
 */
import { useId, useState, type ReactNode } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { api, describeError } from '../../lib/api';
import { StatusBadge, type Tone } from '../../components/StatusBadge';

export const hasRole = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));

export interface Msg { ok: boolean; text: string }

/** Exécution d'une action (POST) avec message de résultat et rechargement. */
export function useRunner(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  async function run<T = unknown>(path: string, body: unknown, ok: string): Promise<T | null> {
    setBusy(true); setMsg(null);
    try {
      const r = await api<T>(path, { method: 'POST', body });
      setMsg({ ok: true, text: ok }); onDone();
      return r;
    } catch (e) {
      const d = describeError(e);
      setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') });
      return null;
    } finally { setBusy(false); }
  }
  return { busy, msg, setMsg, run };
}

export function Notice({ msg }: { msg: Msg | null }) {
  if (!msg) return null;
  return <p className={msg.ok ? 'notice notice-ok' : 'notice notice-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>;
}

export function Field({ label, value, onChange, placeholder, type = 'text', hint }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="small muted">{hint}</p>}
    </div>
  );
}

export function Area({ label, value, onChange, rows = 4, hint }: { label: string; value: string; onChange: (v: string) => void; rows?: number; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="small muted">{hint}</p>}
    </div>
  );
}

export function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  const id = useId();
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    </div>
  );
}

export const moneyText = (m: MoneyJSON | null | undefined) => (m ? `${Number(m.amount).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${m.currency}` : '—');
export const moneysText = (ms: MoneyJSON[] | undefined) => (ms && ms.length ? ms.map(moneyText).join(' · ') : '—');
export const pctText = (v: string | null | undefined) => (v === null || v === undefined ? 'non mesuré' : `${Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);

export const CERT_STATUS: Record<string, { label: string; tone: Tone }> = {
  IMPORTEE: { label: 'Importée — certification attendue', tone: 'warning' },
  CERTIFIEE: { label: 'Certifiée (deux personnes)', tone: 'good' },
  REJETEE: { label: 'Rejetée', tone: 'critical' },
  REMPLACEE: { label: 'Remplacée', tone: 'neutral' },
};
export function CertBadge({ status }: { status: string }) {
  const s = CERT_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <StatusBadge tone={s.tone} label={s.label} />;
}

/** Garde de certification : la personne qui a importé ne certifie jamais (quatre yeux). */
export function certifyGuard(item: { status: string; importedBy: string }, user: { id: string; roles: string[] } | null, roles: string[]): string | null {
  if (item.status !== 'IMPORTEE') return 'Déjà décidé.';
  if (!hasRole(user?.roles, ...roles)) return 'Certification réservée à une personne habilitée.';
  if (item.importedBy === user?.id) return 'Vous avez importé ce jeu : une autre personne certifie.';
  return null;
}

export function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return <div className={`callout ${tone === 'warn' ? 'callout-warn' : 'callout-info'}`} role="note">{children}</div>;
}
