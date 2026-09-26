/** Éléments communs aux écrans du module Intégrité : libellés, pastilles, sélection de pièces par empreinte. */
import { useState, type ReactNode } from 'react';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { describeError } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';

export const CATEGORY_LABELS: Record<string, string> = {
  DEMANDE_ESPECES: "Demande d'espèces par un agent",
  FAUX_AGENT: 'Faux agent ou agent non vérifiable',
  FAUSSE_QUITTANCE: 'Fausse quittance',
  POINT_PAIEMENT_IRREGULIER: 'Point de paiement irrégulier',
  PRELEVEMENT_WEWA: 'Prélèvement irrégulier sur un wewa',
  SOUS_TRAITANT_ENCAISSE: 'Sous-traitant qui encaisse',
  COMPORTEMENT_AGENT: "Comportement abusif d'un agent",
  AUTRE: 'Autre irrégularité',
};

export const CHANNEL_LABELS: Record<string, string> = {
  WEB: 'Web', SMS: 'SMS', SVI: 'Serveur vocal', NUMERO_GRATUIT: 'Numéro gratuit', GUICHET: 'Guichet',
};

export const SEVERITY_LABELS: Record<string, string> = { FAIBLE: 'Faible', MOYENNE: 'Moyenne', ELEVEE: 'Élevée', CRITIQUE: 'Critique' };
const SEVERITY_TONE: Record<string, Tone> = { FAIBLE: 'neutral', MOYENNE: 'warning', ELEVEE: 'serious', CRITIQUE: 'critical' };

export function SeverityBadge({ value }: { value?: string }) {
  if (!value) return <span className="muted small">—</span>;
  return <StatusBadge tone={SEVERITY_TONE[value] ?? 'neutral'} label={SEVERITY_LABELS[value] ?? value} />;
}

const STATUS: Record<string, [string, Tone]> = {
  // signalements
  RECU: ['Reçu', 'info'], QUALIFIE: ['Qualifié', 'warning'], TRANSMIS: ['Transmis', 'warning'], CLOS: ['Clos', 'good'],
  // alertes
  A_EXAMINER: ['À examiner', 'serious'], EN_EXAMEN: ['En examen', 'warning'], CLOTURE_PROPOSEE: ['Clôture proposée', 'info'],
  CLASSEE: ['Classée', 'good'], DOSSIER_OUVERT: ['Dossier ouvert', 'info'],
  // dossiers
  OUVERT: ['Ouvert', 'info'], EN_INSTRUCTION: ['En instruction', 'warning'], CONCLUSIONS_DEPOSEES: ['Conclusions déposées', 'serious'], DECIDE: ['Décidé', 'good'],
  // contrôles mystère
  PLANIFIE: ['Planifié', 'info'], REALISE: ['Réalisé', 'warning'], SUITE_DONNEE: ['Suite donnée', 'good'],
  CONFORME: ['Conforme', 'good'], NON_CONFORME: ['Non conforme', 'critical'], NON_REALISABLE: ['Non réalisable', 'neutral'],
  // incidents
  DECLARE: ['Déclaré', 'serious'], EN_COURS: ['En cours', 'warning'], CONTENU: ['Contenu', 'info'], RESOLU: ['Résolu', 'good'],
  // données
  RECUE: ['Reçue', 'info'], EN_TRAITEMENT: ['En traitement', 'warning'], REPONDUE: ['Répondue', 'good'], REJETEE: ['Rejetée', 'neutral'],
  // revue
  A_CONFIRMER: ['À confirmer', 'warning'], MAINTENU: ['Maintenu', 'good'], RETRAIT_A_EXECUTER: ['Retrait à exécuter', 'critical'],
  OUVERTE: ['Ouverte', 'warning'], CLOTUREE: ['Clôturée', 'good'],
};

export function StateBadge({ value }: { value: string }) {
  const [label, tone] = STATUS[value] ?? [value, 'neutral' as Tone];
  return <StatusBadge tone={tone} label={label} />;
}

export const DECISION_LABELS: Record<string, string> = {
  CLASSEMENT_SANS_SUITE: 'Classement sans suite',
  SAISINE_AUTORITE_COMPETENTE: 'Saisine de l’autorité compétente',
  SUSPENSION_CONSERVATOIRE_ACCES: 'Suspension conservatoire d’un accès technique',
  RENVOI_DISCIPLINAIRE: 'Renvoi à l’autorité hiérarchique',
};

export const FINDING_LABELS: Record<string, string> = { FONDE: 'Faits établis', NON_FONDE: 'Faits non établis', INSUFFISANT: 'Éléments insuffisants' };

export interface Evidence { sha256: string; label: string }

/**
 * Sélection de pièces : le fichier reste sur l'appareil ; seule son empreinte SHA-256 est transmise
 * (preuve d'intégrité sans transfert du document).
 */
export function EvidencePicker({ value, onChange, max = 5 }: { value: Evidence[]; onChange: (v: Evidence[]) => void; max?: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true); setErr(null);
    try {
      const next = [...value];
      for (const f of Array.from(files).slice(0, max - value.length)) {
        next.push({ sha256: await sha256Hex(await f.arrayBuffer()), label: f.name.slice(0, 180) });
      }
      onChange(next);
    } catch (e) {
      setErr(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ig-evidence">
      <label className="btn btn-secondary btn-sm ig-file">
        <Icon name="upload" size={16} /> {busy ? 'Calcul de l’empreinte…' : 'Ajouter une pièce'}
        <input type="file" multiple onChange={(e) => void onFiles(e.target.files)} disabled={busy || value.length >= max} />
      </label>
      <span className="hint">Le fichier ne quitte pas votre appareil : seule son empreinte est transmise.</span>
      {err && <p className="err">{err}</p>}
      {value.length > 0 && (
        <ul className="ig-evidence-list">
          {value.map((e, i) => (
            <li key={e.sha256 + i}>
              <Icon name="file" size={16} />
              <span className="truncate">{e.label}</span>
              <span className="mono small muted">{e.sha256.slice(0, 10)}…</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Retirer ${e.label}`}><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Tuile d'indicateur. */
export function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="kpi">
      <p className="kpi-label caps-sm">{label}</p>
      <p className="kpi-value">{value}</p>
      {sub && <div className="kpi-foot"><span className="kpi-sub">{sub}</span></div>}
    </div>
  );
}

/** Message d'erreur d'une action (formulaire). */
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  const d = describeError(error);
  return <p className="callout callout-danger" role="alert"><Icon name="alert" size={18} /><span>{d.message}{d.code ? ` (${d.code})` : ''}</span></p>;
}

/** Exécute une action et gère l'état d'envoi et d'erreur. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, reset: () => setError(null) };
}

export function hasRole(roles: string[] | undefined, ...wanted: string[]): boolean {
  return !!roles && roles.some((r) => wanted.includes(r));
}

/** Onglets simples (boutons segmentés accessibles). */
export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; count?: number }[]; label: string }) {
  return (
    <div className="seg seg-wrap ig-tabs" role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.id} type="button" aria-pressed={value === it.id} onClick={() => onChange(it.id)}>
          {it.label}{it.count !== undefined && <span className="ig-tab-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}
