/**
 * Échelle des six états de la recette (LadderFunnel) : potentiel → constaté → encaissé → réglé → rapproché → disponible,
 * en barres descendantes (entonnoir) sur la rampe ORDINALE (l'ordre se lit dans la couleur). Les états sont emboîtés et
 * ne s'additionnent jamais ; chaque barre donne sa part de l'état mesuré précédent. Un état non mesuré est hachuré,
 * nommé et motivé — jamais dessiné à 0.
 */
import { SIX_ETATS, type MoneyJSON } from '@mosolo/shared';
import { inkOn } from '../../lib/palette';
import { fmtCompact, fmtPct, TipBody, useVizTheme, useVizTip, VizFrame, type Formatter, type VizFrameProps } from './core';

export interface LadderStep {
  /** Code de l'état (POTENTIEL, CONSTATE, ENCAISSE, REGLE, RAPPROCHE, DISPONIBLE) ou niveau de l'échelle. */
  code: string;
  label: string;
  /** Valeur pour la géométrie (contre-valeur indicative) ; null = non mesuré. */
  value: number | null;
  /** Texte exact affiché (montants par devise) ; défaut : valeur formatée. */
  display?: string;
  /** Motif si non mesuré ; détail sinon (définition, source). */
  reason?: string;
  count?: number | null;
}

/** Niveau de l'échelle unifiée tel que servi par /v1/pilotage (sous-ensemble utile). */
export interface LadderLevelLike { level: string; label?: string; measure: 'MONTANT' | 'COMPTE' | 'NON_MESURE'; amounts: MoneyJSON[]; consolidatedCdf: MoneyJSON | null; count: number | null; note?: string; definition?: string }

/**
 * Six états à partir de l'échelle unifiée (onze niveaux) du pilotage : correspondance SIX_ETATS du paquet partagé.
 * Montants par devise dans `display` (jamais additionnés) ; contre-valeur CDF indicative pour la géométrie.
 */
export function sixEtatsFromLadder(levels: readonly LadderLevelLike[], formatAmounts: (a: MoneyJSON[]) => string): LadderStep[] {
  return SIX_ETATS.map((e) => {
    const l = levels.find((x) => x.level === e.niveau);
    if (!l || l.measure === 'NON_MESURE') return { code: e.code, label: e.libelle, value: null, reason: l?.note ?? 'niveau non servi par le serveur' };
    if (l.measure === 'COMPTE') return { code: e.code, label: e.libelle, value: null, count: l.count, reason: `${l.count ?? 0} objet(s) vérifié(s) ; valorisation monétaire non mesurée` };
    return { code: e.code, label: e.libelle, value: l.consolidatedCdf ? Number(l.consolidatedCdf.amount) : 0, display: l.amounts.length ? formatAmounts(l.amounts) : '0', count: l.count, reason: l.definition };
  });
}

export interface LadderFunnelProps extends VizFrameProps {
  steps: readonly LadderStep[];
  format?: Formatter;
  /** Unité de la géométrie (« CDF, contre-valeur indicative »). */
  unit?: string;
}

export function LadderFunnel(p: LadderFunnelProps) {
  const th = useVizTheme();
  const tip = useVizTip();
  const fmt = p.format ?? fmtCompact;
  const max = Math.max(0, ...p.steps.map((s) => s.value ?? 0));
  const empty = p.steps.length === 0 || p.steps.every((s) => s.value === null && !s.count);
  const ramp = th.ordinal;
  const rows = p.steps.map((s, i) => {
    let prev: LadderStep | undefined;
    for (let k = i - 1; k >= 0; k -= 1) if (p.steps[k]!.value !== null) { prev = p.steps[k]; break; }
    const ratio = s.value !== null && prev && prev.value ? (s.value / prev.value) * 100 : null;
    return { s, i, prev, ratio, color: ramp[Math.round((i * (ramp.length - 1)) / Math.max(1, p.steps.length - 1))]! };
  });
  const table = {
    columns: ['État', 'Montant', 'Part de l’état mesuré précédent', 'Nombre'],
    rows: rows.map(({ s, prev, ratio }) => [s.label, s.value === null ? `non mesuré — ${s.reason ?? ''}` : s.display ?? fmt(s.value), ratio === null ? '—' : `${fmtPct(ratio, 0)} de « ${prev!.label} »`, s.count ?? '—']),
  };
  return (
    <VizFrame frame={p} table={table} empty={empty} role="group"
      ariaLabel={`${p.title} : ${rows.map(({ s }) => `${s.label} ${s.value === null ? 'non mesuré' : s.display ?? fmt(s.value)}`).join(' ; ')}. États emboîtés, jamais additionnés.`}>
      <div className="viz-rel" ref={tip.ref}>
      <ol className="viz-ladder">
        {rows.map(({ s, i, prev, ratio, color }) => {
          const w = s.value === null ? 100 : max > 0 ? Math.max(1.5, (s.value / max) * 100) : 1.5;
          const text = s.value === null ? 'Non mesuré' : s.display ?? `${fmt(s.value)}${p.unit ? ` ${p.unit}` : ''}`;
          const body = <TipBody title={`${i + 1}. ${s.label}`} rows={[{ label: p.unit ?? 'montant', value: text }, ...(ratio !== null ? [{ label: `de « ${prev!.label} »`, value: fmtPct(ratio, 0) }] : [])]} note={s.reason} />;
          return (
            <li key={s.code} className={`viz-ladder-row${s.value === null ? ' is-unmeasured' : ''}`}>
              <span className="viz-ladder-label"><span className="viz-ladder-rank" style={{ background: color, color: inkOn(color) }}>{i + 1}</span>{s.label}</span>
              <span className={`viz-ladder-val viz-num${s.value === null ? ' is-nm' : ''}`}>{text}</span>
              <span className="viz-ladder-track" tabIndex={0} role="img" aria-label={`${s.label} : ${text}${ratio !== null ? `, ${fmtPct(ratio, 0)} de « ${prev!.label} »` : ''}${s.value === null && s.reason ? ` — ${s.reason}` : ''}`} {...tip.bind(body)}>
                <span className={`viz-ladder-bar${s.value === null ? ' viz-hatch' : ''}`} style={{ width: `${w}%`, background: s.value === null ? undefined : color }} />
              </span>
              {(ratio !== null || (s.value === null && s.reason)) && <span className="viz-ladder-ratio small muted">{ratio !== null ? `${fmtPct(ratio, 0)} de « ${prev!.label} »` : s.reason}</span>}
            </li>
          );
        })}
      </ol>
      {tip.node}
      </div>
    </VizFrame>
  );
}
