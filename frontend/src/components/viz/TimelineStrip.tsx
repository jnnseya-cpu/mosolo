/**
 * Frise d'événements (TimelineStrip) : un couloir par catégorie (4 au plus conseillés, 8 au maximum ; au-delà :
 * « Autres »), des points de 8 px cerclés de surface, un axe de dates en jours de Kinshasa, infobulle par point
 * (survol, toucher, clavier), légende, vue tableau chronologique.
 */
import { kinshasaDay, periodLabel } from '../../lib/aggregate';
import { TipBody, useVizTheme, useVizTip, VizFrame, type VizFrameProps } from './core';

export interface TimelineEvent { id: string; at: string; category: string; label: string; href?: string }

export interface TimelineStripProps extends VizFrameProps {
  events: readonly TimelineEvent[];
  /** Ordre (et couleur) des catégories ; défaut : ordre d'apparition. */
  categories?: readonly string[];
  /** Bornes (jours de Kinshasa « AAAA-MM-JJ ») ; défaut : premier → dernier événement. */
  from?: string;
  to?: string;
}

const DAY = 86400000;

export function TimelineStrip(p: TimelineStripProps) {
  const th = useVizTheme();
  const tip = useVizTip();
  const seen = [...new Set(p.events.map((e) => e.category))];
  const declared = p.categories ? [...p.categories, ...seen.filter((c) => !p.categories!.includes(c))] : seen;
  const palette = declared.length > 8 ? [...declared.slice(0, 7), 'Autres'] : declared;
  const catOf = (c: string) => (palette.includes(c) ? c : 'Autres');
  // La couleur suit la catégorie déclarée (jamais son rang d'affichage) ; seuls les couloirs occupés sont dessinés.
  const colorOf = (c: string) => (c === 'Autres' && declared.length > 8 ? th.deemph : th.cat[palette.indexOf(c) % 8]!);
  const cats = palette.filter((c) => p.events.some((e) => catOf(e.category) === c));
  const events = p.events.map((e) => ({ ...e, day: kinshasaDay(e.at) ?? e.at.slice(0, 10), cat: catOf(e.category) })).sort((a, b) => a.at.localeCompare(b.at));
  const from = p.from ?? events[0]?.day ?? '';
  const to = p.to ?? events[events.length - 1]?.day ?? '';
  const t0 = Date.parse(`${from}T00:00:00Z`);
  const t1 = Date.parse(`${to}T00:00:00Z`) + DAY;
  const span = Math.max(DAY, t1 - t0);
  const pos = (at: string) => {
    const t = Date.parse(at) + 3600000; // instant ramené à l'heure de Kinshasa
    const tt = Number.isNaN(t) ? Date.parse(`${at}T12:00:00Z`) : t;
    return Math.max(0, Math.min(100, ((tt - t0) / span) * 100));
  };
  // Liste vide (aucune borne) : pas de graduation — sinon new Date(NaN).toISOString() lève RangeError et l'état vide plante.
  const ticks = Number.isFinite(t0) && Number.isFinite(span) ? [0, 0.5, 1].map((f) => new Date(t0 + f * (span - DAY)).toISOString().slice(0, 10)) : [];
  const table = { columns: ['Date (Kinshasa)', 'Catégorie', 'Événement'], rows: events.map((e) => [e.day, e.category, e.label]) };
  return (
    <VizFrame frame={p} table={table} legend={cats.length >= 2 ? cats.map((c) => ({ label: c, color: colorOf(c) })) : undefined} empty={events.length === 0} role="group">
      <div className="viz-timeline" ref={tip.ref}>
        {cats.map((c) => (
          <div key={c} className="viz-timeline-lane">
            <span className="viz-timeline-cat small">{c}</span>
            <div className="viz-timeline-track" style={{ borderColor: th.grid }}>
              {events.filter((e) => e.cat === c).map((e) => (
                <span key={e.id} role="img" tabIndex={0} className="viz-timeline-dot" style={{ left: `${pos(e.at)}%`, background: colorOf(c), boxShadow: `0 0 0 2px ${th.surface}` }}
                  aria-label={`${e.day} — ${e.category} : ${e.label}`}
                  {...tip.bind(<TipBody title={periodLabel(e.day, 'day') + ` ${e.day.slice(0, 4)}`} rows={[{ label: e.category, value: e.label, color: colorOf(c) }]} />)} />
              ))}
            </div>
          </div>
        ))}
        <div className="viz-timeline-axis small muted viz-num" aria-hidden="true">
          {ticks.map((d, i) => <span key={`${d}-${i}`}>{periodLabel(d, 'day')}</span>)}
        </div>
        {tip.node}
      </div>
    </VizFrame>
  );
}
