/**
 * Trousse de visualisation KINSHASA MOSOLO (27/09/2026) — point d'entrée unique.
 * Règles, palette validée et catalogue : docs/document-maitre/charte-visualisation.md.
 * Agrégations pour dériver un graphique d'une liste existante : frontend/src/lib/aggregate.ts.
 */
export {
  useVizTheme, vizTheme, VizFrame, VizTable, VizLoading, VizEmpty, VizUnmeasured, vizPlaceholder, TipBody, useVizTip, RechartsTip, HatchDef,
  useElementWidth, foldSeries, categoryAxisWidth, clip, fmtNombre, fmtCompact, fmtPct, fmtDevise, fmtValeur, TEXTE_VIDE,
  type VizTheme, type VizStateProps, type VizFrameProps, type LegendItem, type TipRow, type Formatter, type SeriesDef,
} from './core';
export { KpiTile, KpiGrid, type KpiTileProps } from './KpiTile';
export { Sparkline, TrendBadge, type SparklineProps, type TrendBadgeProps, type Better } from './Sparkline';
export { BarChartViz, type BarChartVizProps, type BarRow } from './BarChartViz';
export { StackedBarViz, type StackedBarVizProps } from './StackedBarViz';
export { LineAreaViz, type LineAreaVizProps, type TimePoint } from './LineAreaViz';
export { DonutViz, type DonutVizProps, type DonutSlice } from './DonutViz';
export { GaugeMeter, ProgressMeter, meterState, type GaugeMeterProps, type ProgressMeterProps, type MeterProps } from './Meters';
export { StatusDistribution, ETATS_PAIEMENT, type StatusDistributionProps, type StatusItem } from './StatusDistribution';
export { HeatGrid, MatrixHeat, ScaleLegend, heatStep, type HeatGridProps, type MatrixHeatProps, type CommuneCell } from './HeatGrid';
export { LadderFunnel, sixEtatsFromLadder, type LadderFunnelProps, type LadderStep, type LadderLevelLike } from './LadderFunnel';
export { TimelineStrip, type TimelineStripProps, type TimelineEvent } from './TimelineStrip';
export { ChartGrid } from './ChartGrid';
export { COMMUNES_KINSHASA, COMMUNE_LAYOUT, COMMUNE_ABBR } from './communes';
