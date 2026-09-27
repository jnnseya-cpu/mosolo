/**
 * Composants communs des écrans « Pilotage et décision », « Plateforme et accès » et « Recettes spécifiques »
 * (spécification fonctionnelle, modules 41 à 58) : indicateurs mesurés ou « non mesuré » avec motif, chargement
 * d'une vue, montants par devise. Le serveur reste seul juge des droits : l'interface n'affiche qu'une aide.
 */
import type { ReactNode } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi, type ApiState } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { Notice, useRunner } from '../pilotage/planif';
import '../pilotage/pilotage.css';

export interface Indicator { code: string; label: string; measured: boolean; value: string | null; unit?: string; reason?: string; target?: number | string; meetsTarget?: boolean | null }

/** Indicateurs du module : valeur calculée sur les données réelles, ou « non mesuré » avec la donnée source manquante. */
export function Indicateurs({ items }: { items: Indicator[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div className="pl-kpis" aria-label="Indicateurs du module">
      {items.map((k) => (
        <div className="pl-kpi" key={k.code}>
          <p className="kpi-label">{k.label}</p>
          <p className="kpi-value">{k.measured && k.value !== null ? `${k.value}${k.unit ? ` ${k.unit}` : ''}` : 'Non mesuré'}</p>
          <div className="kpi-foot">
            {k.measured ? <StatusBadge tone={k.meetsTarget === false ? 'warning' : 'good'} label={k.meetsTarget === false ? 'Hors cible' : 'Mesuré'} /> : <StatusBadge tone="neutral" label="Non mesuré" />}
            {k.target !== undefined && <span className="small muted">Cible : {k.target}{k.unit && k.unit !== '' ? ` ${k.unit}` : ''}</span>}
          </div>
          {!k.measured && k.reason && <p className="small muted">{k.reason}</p>}
        </div>
      ))}
    </div>
  );
}

/** Chargement d'une vue du serveur, relancé au changement d'utilisateur de démonstration. */
export function useVue<T>(path: string | null, deps: unknown[] = []): ApiState<T> {
  const { user } = useApp();
  return useApi(path ? () => api<T>(path) : null, [user?.id, path, ...deps]);
}

/** Gabarit d'écran : en-tête, message d'action, chargement / erreur, contenu. */
export function Ecran<T>({ eyebrow, title, lead, q, msg, children, wide = true }: {
  eyebrow: string; title: string; lead: ReactNode; q: ApiState<T>; msg?: ReturnType<typeof useRunner>['msg']; children: (d: T) => ReactNode; wide?: boolean;
}) {
  return (
    <div className={wide ? 'page page-wide' : 'page'}>
      <PageHead eyebrow={eyebrow} title={title} lead={lead} />
      {msg !== undefined && <Notice msg={msg} />}
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data ? <div className="dash-grid">{children(q.data)}</div> : null}
    </div>
  );
}

export const montants = (ms: MoneyJSON[] | undefined | null) => (ms && ms.length ? ms.map((m) => `${Number(m.amount).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${m.currency}`).join(' · ') : '—');
export const montant = (m: MoneyJSON | null | undefined) => (m ? montants([m]) : '—');
export const pct = (v: string | null | undefined) => (v === null || v === undefined ? 'non mesuré' : `${Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);
export const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function Statut({ code, map }: { code: string; map: Record<string, [string, Tone]> }) {
  const [label, tone] = map[code] ?? [code, 'neutral' as Tone];
  return <StatusBadge tone={tone} label={label} />;
}

export { useRunner };
