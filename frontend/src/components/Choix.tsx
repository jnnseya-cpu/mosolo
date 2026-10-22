/**
 * Sélecteurs communs (01/10/2026, audit des saisies) : là où un formulaire attendait un CODE tapé à la main (entité
 * « DGIPK », rôle « R06 »), la personne choisit dans une liste lisible ; la valeur envoyée au serveur reste le code
 * attendu. Repli : sans accès à la liste des entités, champ libre avec rappel du format.
 */
import { useId } from 'react';
import { ROLES } from '@mosolo/shared';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';

interface Entite { id: string; name: string; shortName?: string; status?: string }

/** Liste déroulante des entités (services, régies, ministères…) ; valeur = identifiant de l'entité. */
export function ChoixEntite({ label, value, onChange, facultatif = false }: { label: string; value: string; onChange: (v: string) => void; facultatif?: boolean }) {
  const id = useId();
  const q = useApi(() => api<{ items: Entite[] }>('/v1/acces/entities'), []);
  const items = (q.data?.items ?? []).filter((e) => e.status !== 'DISSOUTE');
  if (q.error || (!q.loading && !items.length)) {
    return (
      <div className="field">
        <label className="label" htmlFor={id}>{label}</label>
        <input id={id} value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} placeholder="ex. DGIPK" pattern="[A-Z0-9_-]{2,40}" />
        <p className="small muted">Code de l’entité en majuscules (ex. DGIPK, DGTK, TRESOR).</p>
      </div>
    );
  }
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{facultatif ? '— aucune —' : '— choisir —'}</option>
        {items.map((e) => <option key={e.id} value={e.id}>{e.shortName ? `${e.shortName} — ` : ''}{e.name} ({e.id})</option>)}
      </select>
    </div>
  );
}

const libelleRole = (r: string) => `${(ROLES as Record<string, string>)[r] ?? r} (${r})`;

/** Liste déroulante d'un rôle ; valeur = code du rôle (R06…). `roles` restreint le choix. */
export function ChoixRole({ label, value, onChange, roles, facultatif = false }: { label: string; value: string; onChange: (v: string) => void; roles?: readonly string[]; facultatif?: boolean }) {
  const id = useId();
  const liste = roles ?? Object.keys(ROLES);
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{facultatif ? '— aucun (toute l’entité) —' : '— choisir —'}</option>
        {liste.map((r) => <option key={r} value={r}>{libelleRole(r)}</option>)}
      </select>
    </div>
  );
}

/** Cases à cocher de rôles (ex. délégation de ses propres rôles) ; valeur = liste de codes. */
export function ChoixRoles({ label, roles, value, onChange }: { label: string; roles: readonly string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="field">
      <legend className="label">{label}</legend>
      {roles.length === 0 ? <p className="small muted">Aucun rôle à choisir.</p> : roles.map((r) => (
        <label key={r} className="small" style={{ display: 'block' }}>
          <input type="checkbox" checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} /> {libelleRole(r)}
        </label>
      ))}
    </fieldset>
  );
}
