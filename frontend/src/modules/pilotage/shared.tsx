/**
 * Pilotage — types du contrat, filtres, graphiques et composants communs (tableaux par profil, Gouverneur,
 * indicateurs, transparence, piste d'audit). Les montants restent en MoneyJSON (chaînes) ; les nombres ne servent
 * qu'à la géométrie des graphiques.
 */
import { useId, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney, type MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { ChartCard, Legend } from '../../components/ChartCard';
import { ChartTooltip, useChartColors } from '../../components/charts';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { api, describeError } from '../../lib/api';
import { compact, plotValue } from '../../lib/money';

// ————————————————————————— contrat —————————————————————————

export interface Amounts { amounts: MoneyJSON[]; consolidatedCdf: MoneyJSON | null; count?: number | null }

export interface LadderLevel extends Amounts {
  rank: number; level: string; label: string; definition: string; measure: 'MONTANT' | 'COMPTE' | 'NON_MESURE'; measured: boolean;
  count: number | null; source: string; dateBasis: string; channelFilterApplies: boolean; note?: string;
}
export interface Contested extends Amounts { label: string; note: string; count: number }
export interface Scope { kind: 'PROVINCE' | 'ENTITE' | 'TERRITOIRE'; label: string; entity?: string; communes?: string[] }
export interface DrillResult { dimension: string; levels: { level: string; label: string }[]; rule: string; rows: { key: string; values: Record<string, Amounts & { count: number }> }[] }
export interface SeriesPoint { month: string; assessed: Amounts; confirmed: Amounts; reconciled: Amounts }

export interface Kpi {
  code: string; domain: string; label: string; question?: string; definition: string; formula: string; source: string;
  unit: '%' | 'h' | 's' | 'j' | 'nombre'; targetLabel: string; better: 'HAUSSE' | 'BAISSE' | 'NEUTRE'; reference: string; measurable: boolean; structural?: boolean;
  value: string | null; numerator?: number; denominator?: number; detail?: string;
  status: 'ATTEINTE' | 'NON_ATTEINTE' | 'SANS_CIBLE' | 'NON_MESURE' | 'NON_CALCULABLE';
  trend: { previous: string | null; window: string; direction: 'HAUSSE' | 'BAISSE' | 'STABLE' | 'INDISPONIBLE'; favorable: boolean | null };
}

export interface Filters { commune?: string; category?: string; entity?: string; channel?: string; period?: string }

export const COMMUNES = [
  'Bandalungwa', 'Barumbu', 'Bumbu', 'Gombe', 'Kalamu', 'Kasa-Vubu', 'Kimbanseke', 'Kinshasa', 'Kintambo', 'Kisenso', 'Lemba', 'Limete',
  'Lingwala', 'Makala', 'Maluku', 'Masina', 'Matete', 'Mont-Ngafula', 'Ndjili', 'Ngaba', 'Ngaliema', 'Ngiri-Ngiri', 'Nsele', 'Selembao',
];
export const CATEGORY_LABELS: Record<string, string> = {
  IMPOT_PROVINCIAL: 'Impôts provinciaux', INTERET_COMMUN: 'Taxes d’intérêt commun', PROVINCIAL_SPECIFIQUE: 'Recettes provinciales spécifiques',
  RECETTE_ETD: 'Recettes des ETD', RECETTE_CENTRALE: 'Recettes centrales', PARTAGEE: 'Recettes partagées', DROIT_ADMINISTRATIF: 'Droits administratifs',
  REDEVANCE_SERVICE: 'Redevances de service', PENALITE: 'Pénalités', CONCESSION_DOMANIALE: 'Concessions domaniales', RECETTE_COMMERCIALE: 'Recettes commerciales',
  ACTE_REQUIS: 'Autres (acte requis)',
};
export const CHANNEL_LABELS: Record<string, string> = {
  MOBILE_MONEY: 'Monnaie mobile', BANK: 'Banque', CARD: 'Carte', AGENT_POINT: 'Point agréé', USSD: 'USSD', QR: 'QR', TRANSFER: 'Virement',
};
export const ENTITIES = ['DGIPK', 'DGTK', 'GOUVERNORAT', 'MINFIN'];
/** Groupe visuel de chaque niveau (base, obligations, paiements, trésor). */
export const LADDER_GROUP: Record<string, number> = {
  potential: 0, verified_base: 0, assessed: 1, due: 1, overdue: 1, initiated: 2, confirmed: 2, settled: 3, reconciled: 3, recorded: 3, available: 3,
};
export const GROUP_LABELS = ['Assiette', 'Obligations', 'Paiements', 'Trésor'];

export function labelOf(dimension: string, key: string): string {
  if (key === 'NON_ATTRIBUE') return 'Lieu non établi';
  if (dimension === 'category') return CATEGORY_LABELS[key] ?? key;
  if (dimension === 'channel') return CHANNEL_LABELS[key] ?? key;
  if (dimension === 'month') return monthLabel(key);
  return key;
}

export function monthLabel(m: string): string {
  const [y, mo] = m.split('-');
  const names = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  return `${names[Number(mo) - 1] ?? mo} ${y?.slice(2)}`;
}

export function qs(f: Filters & Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function currentQuarter(d = new Date()): string {
  return `${d.getUTCFullYear()}-T${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

// ————————————————————————— formats —————————————————————————

export function useFmt() {
  const { lang } = useApp();
  const locale = lang === 'en' ? 'en' : 'fr';
  const money = (m: MoneyJSON) => formatMoney(m, { locale });
  const amounts = (a: MoneyJSON[]) => (a.length ? a.map(money).join(' · ') : '—');
  const cdf = (m: MoneyJSON | null | undefined) => (m ? `${compact(plotValue(m), lang)} CDF` : '—');
  const num = (v: string | null, unit: Kpi['unit']) => {
    if (v === null) return '—';
    const n = Number(v).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR', { maximumFractionDigits: 1 });
    return unit === '%' ? `${n} %` : unit === 'h' ? `${n} h` : unit === 's' ? `${n} s` : unit === 'j' ? `${n} j` : n;
  };
  return { money, amounts, cdf, num, lang };
}

// ————————————————————————— filtres —————————————————————————

export function FiltersBar({ value, onChange, lock }: { value: Filters; onChange: (f: Filters) => void; lock?: Scope | null }) {
  const id = useId();
  const set = (k: keyof Filters, v: string) => onChange({ ...value, [k]: v || undefined });
  const year = new Date().getUTCFullYear();
  const periods = [String(year), `${year}-T1`, `${year}-T2`, `${year}-T3`, `${year}-T4`, String(year - 1)];
  const communes = lock?.communes ?? COMMUNES;
  return (
    <form className="pl-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filtres du tableau">
      <label className="pl-filter" htmlFor={`${id}-c`}><span>Commune</span>
        <select id={`${id}-c`} value={value.commune ?? ''} onChange={(e) => set('commune', e.target.value)}>
          <option value="">{lock?.communes ? 'Tout le périmètre' : 'Toutes'}</option>
          {communes.map((c) => <option key={c} value={c}>{c}</option>)}
          {!lock?.communes && <option value="NON_ATTRIBUE">Lieu non établi</option>}
        </select>
      </label>
      <label className="pl-filter" htmlFor={`${id}-k`}><span>Catégorie</span>
        <select id={`${id}-k`} value={value.category ?? ''} onChange={(e) => set('category', e.target.value)}>
          <option value="">Toutes</option>
          {Object.entries(CATEGORY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label className="pl-filter" htmlFor={`${id}-p`}><span>Période</span>
        <select id={`${id}-p`} value={value.period ?? ''} onChange={(e) => set('period', e.target.value)}>
          <option value="">Depuis l’origine</option>
          {periods.map((p) => <option key={p} value={p}>{p.includes('-T') ? `Trimestre ${p.replace('-', ' ')}` : `Exercice ${p}`}</option>)}
        </select>
      </label>
      <label className="pl-filter" htmlFor={`${id}-ch`}><span>Canal</span>
        <select id={`${id}-ch`} value={value.channel ?? ''} onChange={(e) => set('channel', e.target.value)}>
          <option value="">Tous</option>
          {Object.entries(CHANNEL_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label className="pl-filter" htmlFor={`${id}-e`}><span>Administration</span>
        <select id={`${id}-e`} value={lock?.entity ?? value.entity ?? ''} disabled={!!lock?.entity} onChange={(e) => set('entity', e.target.value)}>
          <option value="">Toutes</option>
          {[...new Set([...(lock?.entity ? [lock.entity] : []), ...ENTITIES])].map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </label>
      {(value.commune || value.category || value.period || value.channel || value.entity) && (
        <button type="button" className="btn btn-ghost btn-sm pl-reset" onClick={() => onChange({})}><Icon name="x" size={16} /> Effacer</button>
      )}
    </form>
  );
}

export function ScopeLine({ scope, generatedAt }: { scope?: Scope; generatedAt?: string }) {
  const { fmtDate } = useApp();
  if (!scope) return null;
  return (
    <p className="small muted pl-scope">
      <Icon name={scope.kind === 'PROVINCE' ? 'globe' : scope.kind === 'TERRITOIRE' ? 'pin' : 'building'} size={14} /> Périmètre : {scope.label}
      {generatedAt ? ` · données réelles au ${fmtDate(generatedAt, true)}` : ''}
    </p>
  );
}

// ————————————————————————— échelle —————————————————————————

export function LadderChart({ levels, contested, className }: { levels: LadderLevel[]; contested?: Contested; className?: string }) {
  const { cat, theme } = useChartColors();
  const f = useFmt();
  const data = levels.map((l) => ({
    name: `${l.rank}. ${l.label}`, level: l.level, measured: l.measure === 'MONTANT',
    value: l.measure === 'MONTANT' && l.consolidatedCdf ? plotValue(l.consolidatedCdf) : 0, group: LADDER_GROUP[l.level] ?? 0, l,
  }));
  const label = (p: unknown) => {
    const { x, y, width, height, index } = p as { x?: number; y?: number; width?: number; height?: number; index?: number };
    const d = data[index ?? 0];
    if (x === undefined || y === undefined || !d) return null;
    const text = d.l.measure === 'NON_MESURE' ? 'Non mesuré (modèle)' : d.l.measure === 'COMPTE' ? `${d.l.count ?? 0} objet(s) vérifié(s)` : d.value === 0 ? '0' : compact(d.value, f.lang);
    return <text x={Number(x) + Number(width ?? 0) + 6} y={Number(y) + Number(height ?? 0) / 2 + 4} fontSize={11} fill={d.measured ? theme.ink : theme.axis} fontStyle={d.measured ? 'normal' : 'italic'} style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</text>;
  };
  return (
    <ChartCard className={className} title="Échelle unifiée de la recette" subtitle="Onze niveaux emboîtés — contre-valeur indicative en 🇨🇩 CDF ; ne jamais additionner deux niveaux" height={levels.length * 30 + 30}
      legend={<Legend items={GROUP_LABELS.map((g, i) => ({ label: g, color: cat[i]! }))} />}
      table={{ columns: ['Niveau', 'Montants (devise légale)', 'Contre-valeur CDF', 'Nombre', 'Source'], rows: levels.map((l) => [`${l.rank}. ${l.label}`, l.measure === 'NON_MESURE' ? 'Non mesuré' : f.amounts(l.amounts), l.measure === 'MONTANT' ? f.cdf(l.consolidatedCdf) : '—', l.count ?? '—', l.source]) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 120, bottom: 4, left: 0 }} barCategoryGap={6}>
          <CartesianGrid horizontal={false} stroke={theme.grid} />
          <XAxis type="number" tickFormatter={(v: number) => compact(v, f.lang)} tick={{ fontSize: 11, fill: theme.axis }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="name" width={170} tick={{ fontSize: 11.5, fill: theme.ink }} axisLine={false} tickLine={false} interval={0} />
          <Tooltip cursor={{ fill: theme.grid, opacity: 0.5 }} content={<ChartTooltip format={(v) => `${compact(v, f.lang)} CDF`} />} />
          <Bar dataKey="value" name="Contre-valeur CDF" radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.level} fill={cat[d.group]} />)}
            <LabelList dataKey="value" content={label} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="small muted chart-note">
        Chaque niveau compte ce qui a atteint au moins ce stade : le confirmé inclut le réglé, qui inclut le rapproché.
        {contested ? ` Hors échelle — ${contested.label.toLowerCase()} : ${contested.count} (${f.amounts(contested.amounts)}).` : ''}
      </p>
    </ChartCard>
  );
}

export function LadderList({ levels }: { levels: LadderLevel[] }) {
  const f = useFmt();
  return (
    <ol className="pl-ladder">
      {levels.map((l) => (
        <li key={l.level} className={l.measure === 'NON_MESURE' ? 'is-model' : ''}>
          <span className={`pl-rank g${LADDER_GROUP[l.level] ?? 0}`}>{l.rank}</span>
          <div className="min0">
            <p className="row-title">{l.label}</p>
            <p className="small muted">{l.definition}</p>
            {l.note && <p className="small muted pl-note">{l.note}</p>}
          </div>
          <div className="pl-ladder-val">
            {l.measure === 'NON_MESURE' ? <StatusBadge tone="neutral" label="Non mesuré — modèle" /> : l.measure === 'COMPTE' ? <strong>{l.count ?? 0} objet(s)</strong> : (
              <><strong>{f.amounts(l.amounts)}</strong><span className="small muted">{l.count ?? 0} · ≈ {f.cdf(l.consolidatedCdf)}</span></>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ————————————————————————— indicateurs —————————————————————————

export function kpiTone(k: Kpi): Tone {
  return k.status === 'ATTEINTE' ? 'good' : k.status === 'NON_ATTEINTE' ? 'critical' : k.status === 'NON_MESURE' ? 'neutral' : 'info';
}
export const KPI_STATUS: Record<Kpi['status'], string> = {
  ATTEINTE: 'Cible atteinte', NON_ATTEINTE: 'Sous la cible', SANS_CIBLE: 'Suivi (sans cible)', NON_MESURE: 'Non mesuré', NON_CALCULABLE: 'Pas encore calculable',
};

export function TrendMark({ k }: { k: Kpi }) {
  const t = k.trend;
  if (t.direction === 'INDISPONIBLE') return <span className="small muted">Tendance indisponible</span>;
  const arrow = t.direction === 'HAUSSE' ? '↑' : t.direction === 'BAISSE' ? '↓' : '→';
  const cls = t.favorable === true ? 'pl-up' : t.favorable === false ? 'pl-down' : '';
  return <span className={`small pl-trend ${cls}`} title={`Valeur il y a ${t.window} : ${t.previous ?? '—'}`}>{arrow} sur {t.window}</span>;
}

export function KpiTiles({ kpis }: { kpis: Kpi[] }) {
  const f = useFmt();
  return (
    <div className="pl-kpis">
      {kpis.map((k) => (
        <div className="pl-kpi" key={k.code}>
          <p className="kpi-label">{k.label}</p>
          <p className="kpi-value">{k.status === 'NON_MESURE' ? 'Non mesuré' : f.num(k.value, k.unit)}</p>
          <div className="kpi-foot">
            <StatusBadge tone={kpiTone(k)} label={KPI_STATUS[k.status]} />
            <TrendMark k={k} />
          </div>
          <p className="small muted">Cible : {k.targetLabel}{k.denominator !== undefined && k.unit === '%' ? ` · ${k.numerator ?? 0}/${k.denominator}` : ''}</p>
        </div>
      ))}
    </div>
  );
}

// ————————————————————————— consultation détaillée —————————————————————————

export function DrillChart({ drill, title, subtitle, levels = ['assessed', 'confirmed', 'reconciled'], className, limit = 12 }: {
  drill: DrillResult; title: string; subtitle?: string; levels?: string[]; className?: string; limit?: number;
}) {
  const { cat, theme } = useChartColors();
  const f = useFmt();
  const [all, setAll] = useState(false);
  const shown = drill.levels.filter((l) => levels.includes(l.level));
  const rows = drill.rows.map((r) => {
    const o: Record<string, string | number> = { name: labelOf(drill.dimension, r.key) };
    shown.forEach((l) => { o[l.level] = plotValue(r.values[l.level]?.consolidatedCdf ?? undefined); });
    return o;
  }).sort((a, b) => Number(b[shown[0]?.level ?? ''] ?? 0) - Number(a[shown[0]?.level ?? ''] ?? 0));
  const visible = all ? rows : rows.slice(0, limit);
  const color = (lvl: string) => cat[LADDER_GROUP[lvl] ?? 0]!;
  return (
    <ChartCard className={className} title={title} subtitle={subtitle ?? 'Contre-valeur indicative en CDF — niveaux côte à côte, jamais additionnés'} height={Math.max(200, visible.length * (shown.length * 10 + 16) + 40)}
      legend={<Legend items={shown.map((l) => ({ label: l.label, color: color(l.level) }))} />}
      actions={rows.length > limit ? <button type="button" className="btn btn-ghost btn-sm" aria-pressed={all} onClick={() => setAll((v) => !v)}>{all ? `Les ${limit} premiers` : `Tout (${rows.length})`}</button> : undefined}
      table={{ columns: ['Clé', ...drill.levels.map((l) => l.label)], rows: drill.rows.map((r) => [labelOf(drill.dimension, r.key), ...drill.levels.map((l) => f.amounts(r.values[l.level]?.amounts ?? []))]) }}>
      {rows.length === 0 ? <p className="muted pl-empty">Aucune donnée pour ces filtres.</p> : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={visible} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 0 }} barCategoryGap={8} barGap={2}>
            <CartesianGrid horizontal={false} stroke={theme.grid} />
            <XAxis type="number" tickFormatter={(v: number) => compact(v, f.lang)} tick={{ fontSize: 11, fill: theme.axis }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11.5, fill: theme.ink }} axisLine={false} tickLine={false} interval={0} />
            <Tooltip cursor={{ fill: theme.grid, opacity: 0.5 }} content={<ChartTooltip format={(v) => `${compact(v, f.lang)} CDF`} />} />
            {shown.map((l) => <Bar key={l.level} dataKey={l.level} name={l.label} fill={color(l.level)} radius={[0, 3, 3, 0]} maxBarSize={10} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

export function SeriesChart({ months, className }: { months: SeriesPoint[]; className?: string }) {
  const { cat, theme } = useChartColors();
  const f = useFmt();
  const data = months.map((m) => ({ label: monthLabel(m.month), assessed: plotValue(m.assessed.consolidatedCdf ?? undefined), confirmed: plotValue(m.confirmed.consolidatedCdf ?? undefined), reconciled: plotValue(m.reconciled.consolidatedCdf ?? undefined) }));
  return (
    <ChartCard className={className} title="Évolution mensuelle" subtitle="Liquidé, confirmé et rapproché par mois — contre-valeur indicative CDF" height={240}
      legend={<Legend items={[{ label: 'Liquidé', color: cat[1]! }, { label: 'Confirmé', color: cat[2]! }, { label: 'Rapproché', color: cat[3]! }]} />}
      table={{ columns: ['Mois', 'Liquidé', 'Confirmé', 'Rapproché'], rows: months.map((m) => [monthLabel(m.month), f.amounts(m.assessed.amounts), f.amounts(m.confirmed.amounts), f.amounts(m.reconciled.amounts)]) }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke={theme.grid} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: theme.axis }} axisLine={{ stroke: theme.grid }} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
          <YAxis tick={{ fontSize: 11, fill: theme.axis }} tickFormatter={(v: number) => compact(v, f.lang)} axisLine={false} tickLine={false} width={60} />
          <Tooltip content={<ChartTooltip format={(v) => `${compact(v, f.lang)} CDF`} />} />
          <Line type="monotone" dataKey="assessed" name="Liquidé" stroke={cat[1]} strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="confirmed" name="Confirmé" stroke={cat[2]} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: cat[2] }} isAnimationActive={false} />
          <Line type="monotone" dataKey="reconciled" name="Rapproché" stroke={cat[3]} strokeWidth={2.5} dot={{ r: 3, strokeWidth: 0, fill: cat[3] }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ————————————————————————— export signé —————————————————————————

interface ExportBundle {
  exportId: string;
  csv: { filename: string; content: string; manifest: Record<string, unknown> & { sha256: string; signature: string } };
  json: { filename: string; content: string; manifest: Record<string, unknown> & { sha256: string; signature: string } };
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportButton({ kind, params, label = 'Export signé' }: { kind: string; params?: Record<string, string | undefined>; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ExportBundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const b = await api<ExportBundle>(`/v1/pilotage/exports/${kind}${qs(params ?? {})}`);
      download(b.csv.filename, b.csv.content, 'text/csv;charset=utf-8');
      download(b.json.filename, b.json.content, 'application/json');
      download(`mosolo-${kind}-${b.exportId}.signature.json`, JSON.stringify({ csv: b.csv.manifest, json: b.json.manifest }, null, 2), 'application/json');
      setDone(b);
    } catch (e) {
      setErr(describeError(e).message);
    } finally { setBusy(false); }
  };
  return (
    <span className="pl-export">
      <button type="button" className="btn btn-secondary btn-sm" onClick={run} disabled={busy} aria-busy={busy}>
        <Icon name="download" size={16} /> {busy ? 'Signature…' : label}
      </button>
      {done && <span className="small muted pl-hash" title={done.csv.manifest.sha256}><Icon name="lock" size={12} /> SHA-256 {done.csv.manifest.sha256.slice(0, 12)}…</span>}
      {err && <span className="small err" role="alert">{err}</span>}
    </span>
  );
}

export function Section({ title, sub, children, tools }: { title: string; sub?: string; children: ReactNode; tools?: ReactNode }) {
  return (
    <section className="panel span-12">
      <header className="panel-head">
        <div><h2 className="panel-title">{title}</h2>{sub && <p className="panel-sub">{sub}</p>}</div>
        {tools && <div className="panel-tools">{tools}</div>}
      </header>
      {children}
    </section>
  );
}
