import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHANNELS, EVENTS, EVENT_CATEGORIES, LANGUAGES, LANGUAGE_CODES, type Channel, type CommunicationEvent, type Severity } from '@mosolo/shared';
import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { PageHead } from '../components/Shell';
import { ChartCard } from '../components/ChartCard';
import { ChartTooltip, useChartColors } from '../components/charts';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { ErrorState, ExampleNotice, Loading } from '../components/States';
import { Icon } from '../components/Icon';
import { api, asList, describeError, NetworkError } from '../lib/api';
import { isDraftLanguage, type UIKey } from '../lib/i18n';
import type { CommunicationsOverview, Delivery } from '../lib/types';
import { normalizeComms, normalizeDeliveries } from '../lib/normalize';
import { DEMO_COMMS, localPreviewHtml } from '../demo/communications';

export const ENTITIES = ['DGIPK', 'DGTK', 'MPF', 'TRESOR'] as const;

const DELIVERY_TONE: Record<string, { tone: Tone; key: UIKey }> = {
  en_file: { tone: 'neutral', key: 'delivery.en_file' }, envoye: { tone: 'good', key: 'delivery.envoye' }, sent: { tone: 'good', key: 'delivery.envoye' },
  delivre: { tone: 'good', key: 'delivery.delivre' }, lu: { tone: 'good', key: 'delivery.lu' },
  echoue: { tone: 'critical', key: 'delivery.echoue' }, failed: { tone: 'critical', key: 'delivery.echoue' },
  journalise: { tone: 'info', key: 'delivery.journalise' }, logged: { tone: 'info', key: 'delivery.journalise' },
  supprime_par_preference: { tone: 'neutral', key: 'delivery.supprime_par_preference' },
};
const SEVERITY_TONE: Record<Severity, Tone> = { info: 'info', success: 'good', warning: 'warning', critical: 'critical' };

function normStatus(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function loadOverview(): Promise<{ o: CommunicationsOverview; fallback: boolean }> {
  try {
    return { o: normalizeComms(await api<unknown>('/v1/communications/overview'), DEMO_COMMS), fallback: false };
  } catch (e) {
    if (e instanceof NetworkError) return { o: DEMO_COMMS, fallback: true };
    throw e;
  }
}

function DeliveryRow({ d }: { d: Delivery }) {
  const { tr, fmtDate } = useApp();
  const st = DELIVERY_TONE[normStatus(d.status)] ?? { tone: 'neutral' as Tone, key: 'delivery.en_file' as UIKey };
  return (
    <li className="list-row delivery-row">
      <span className="tag tag-channel">{tr(`channel.${d.channel}` as UIKey)}</span>
      <div className="min0">
        <p className="mono row-title truncate">{d.eventCode}</p>
        <p className="small muted">{d.provider ?? '—'}{d.recipient ? ` · ${d.recipient}` : ''}</p>
      </div>
      <div className="row-side">
        <StatusBadge tone={st.tone} label={tr(st.key)} />
        <time className="small muted nowrap" dateTime={d.at ?? d.createdAt}>{fmtDate(d.at ?? d.createdAt, true)}</time>
      </div>
    </li>
  );
}

export default function Communications() {
  const { tr, lang, user } = useApp();
  const { cat, theme } = useChartColors();
  const ov = useApi(loadOverview, [user?.id]);
  const evq = useApi(async () => {
    try { const v = await api<unknown>('/v1/communications/events'); const l = asList<CommunicationEvent>(v, 'events', 'evenements'); return l.length ? l : EVENTS; }
    catch { return EVENTS; }
  }, [user?.id]);
  const events = evq.data ?? EVENTS;

  const [measure, setMeasure] = useState<'events' | 'sent'>('events');
  const [eventCode, setEventCode] = useState<string>(EVENTS.find((e) => e.code === 'payment.confirmed')?.code ?? EVENTS[0]!.code);
  const [entity, setEntity] = useState<string>('DGIPK');
  const [pLang, setPLang] = useState(lang);
  const [preview, setPreview] = useState<{ html: string; local: boolean } | null>(null);
  const [pBusy, setPBusy] = useState(false);
  const [pErr, setPErr] = useState<string | null>(null);
  const [tBusy, setTBusy] = useState(false);
  const [testOut, setTestOut] = useState<Delivery[] | null>(null);
  const [tErr, setTErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const byCat = useMemo(() => {
    const m = new Map<string, CommunicationEvent[]>();
    for (const e of events) { const l = m.get(e.categorie) ?? []; l.push(e); m.set(e.categorie, l); }
    return m;
  }, [events]);
  const catLabel = (code: string) => EVENT_CATEGORIES.find((c) => c.code === code)?.libelle ?? code;
  const f = filter.trim().toLowerCase();

  async function doPreview() {
    setPBusy(true); setPErr(null);
    try {
      const r = await api<string | { html?: string }>(`/v1/communications/preview/${encodeURIComponent(eventCode)}?lang=${pLang}&entity=${encodeURIComponent(entity)}`, { headers: { Accept: 'text/html, application/json' } });
      const html = typeof r === 'string' ? r : r.html ?? '';
      setPreview({ html, local: false });
    } catch (e) {
      if (e instanceof NetworkError) setPreview({ html: localPreviewHtml(eventCode, tr(`entity.${entity}` as UIKey), pLang), local: true });
      else setPErr(describeError(e).message);
    } finally { setPBusy(false); }
  }
  async function doTest() {
    setTBusy(true); setTErr(null); setTestOut(null);
    try {
      const r = await api<unknown>('/v1/communications/test', { method: 'POST', body: { eventCode, entity } });
      setTestOut(normalizeDeliveries(r));
      ov.reload();
    } catch (e) { setTErr(describeError(e).message); } finally { setTBusy(false); }
  }

  if (ov.loading) return <div className="page"><Loading /></div>;
  if (ov.error !== null || !ov.data) return <div className="page"><PageHead title={tr('comms.title')} /><ErrorState error={ov.error} onRetry={ov.reload} /></div>;
  const o = ov.data.o;
  const fallback = ov.data.fallback;
  const connected = Array.isArray(o.connectedChannels) ? o.connectedChannels.length : o.connectedChannels;
  const cov = CHANNELS.map((c) => {
    const row = o.coverage.find((x) => x.channel === c);
    return { channel: c, name: tr(`channel.short.${c}` as UIKey), value: measure === 'events' ? row?.events ?? 0 : row?.sent ?? 0 };
  });
  const nf = (n: number) => n.toLocaleString(lang === 'en' ? 'en-GB' : 'fr-FR');

  return (
    <div className="page page-wide">
      <PageHead eyebrow={tr('comms.eyebrow')} title={tr('comms.title')} lead={tr('comms.subtitle', { count: o.catalogue.events })} />
      {(o.example || fallback) && <ExampleNotice text={fallback ? tr('comms.fallback') : undefined} />}

      <dl className="stat-strip">
        <div><dt>{tr('comms.catalogue')}</dt><dd>{nf(o.catalogue.events)}</dd></div>
        <div><dt>{tr('comms.categories')}</dt><dd>{nf(o.catalogue.categories)}</dd></div>
        <div><dt>{tr('comms.mandatory')}</dt><dd>{nf(o.catalogue.mandatory)}<span className="stat-note">{tr('comms.mandatoryHint')}</span></dd></div>
        <div><dt>{tr('comms.delivered')}</dt><dd>{nf(o.delivered.delivered)}<span className="stat-of"> / {nf(o.delivered.attempted)}</span></dd></div>
        <div><dt>{tr('comms.channels')}</dt><dd>{connected}<span className="stat-of"> / {CHANNELS.length}</span>
          {Array.isArray(o.connectedChannels) && <span className="stat-note">{o.connectedChannels.map((c) => tr(`channel.short.${c}` as UIKey)).join(' · ')}</span>}</dd></div>
      </dl>

      <div className="dash-grid">
        <ChartCard className="span-7" title={tr('comms.coverage')} subtitle={measure === 'events' ? tr('comms.coverageEvents') : tr('comms.coverageSent')}
          example={o.example || fallback} height={280}
          actions={
            <div className="seg seg-sm" role="group" aria-label={tr('comms.measure')}>
              <button type="button" aria-pressed={measure === 'events'} onClick={() => setMeasure('events')}>{tr('comms.measureEvents')}</button>
              <button type="button" aria-pressed={measure === 'sent'} onClick={() => setMeasure('sent')}>{tr('comms.measureSent')}</button>
            </div>
          }
          table={{ columns: [tr('comms.channel'), tr('comms.measureEvents'), tr('comms.measureSent')], rows: CHANNELS.map((c) => { const r = o.coverage.find((x) => x.channel === c); return [tr(`channel.${c}` as UIKey), r?.events ?? 0, r?.sent ?? 0]; }) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cov} margin={{ top: 20, right: 8, bottom: 4, left: 0 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} stroke={theme.grid} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: theme.ink }} axisLine={{ stroke: theme.grid }} tickLine={false} interval={0} />
              <YAxis tick={{ fontSize: 12, fill: theme.axis }} axisLine={false} tickLine={false} width={36} />
              <Tooltip cursor={{ fill: theme.grid, opacity: 0.5 }} content={<ChartTooltip format={(v) => nf(v)} />} />
              <Bar dataKey="value" name={measure === 'events' ? tr('comms.measureEvents') : tr('comms.measureSent')} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
                {cov.map((c, i) => <Cell key={c.channel} fill={cat[i]} />)}
                <LabelList dataKey="value" position="top" style={{ fontSize: 12, fill: theme.ink, fontVariantNumeric: 'tabular-nums' }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="small muted chart-note">{tr('comms.whatsappNote')}</p>
        </ChartCard>

        <section className="panel span-5" aria-labelledby="recent-title">
          <header className="panel-head"><h2 className="panel-title" id="recent-title">{tr('comms.recent')}</h2><span className="count">{o.recent.length}</span></header>
          {o.recent.length === 0 ? <p className="muted">{tr('comms.noRecent')}</p> : (
            <ul className="list-rows compact-rows">{o.recent.slice(0, 8).map((d) => <DeliveryRow key={d.id} d={d} />)}</ul>
          )}
        </section>

        <section className="panel span-12" aria-labelledby="qa-title">
          <header className="panel-head">
            <div><h2 className="panel-title" id="qa-title">{tr('comms.templateQa')}</h2><p className="panel-sub">{tr('comms.qaSub')}</p></div>
          </header>
          <div className="qa-grid">
            <div className="form">
              <div className="field">
                <label className="label" htmlFor="qa-event">{tr('comms.event')}</label>
                <select id="qa-event" value={eventCode} onChange={(e) => setEventCode(e.target.value)}>
                  {[...byCat.entries()].map(([c, list]) => (
                    <optgroup key={c} label={catLabel(c)}>
                      {list.map((e) => <option key={e.code} value={e.code}>{e.libelle} — {e.code}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="qa-entity">{tr('comms.entity')}</label>
                  <select id="qa-entity" value={entity} onChange={(e) => setEntity(e.target.value)}>
                    {ENTITIES.map((en) => <option key={en} value={en}>{tr(`entity.${en}` as UIKey)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label" htmlFor="qa-lang">{tr('common.language')}</label>
                  <select id="qa-lang" value={pLang} onChange={(e) => setPLang(e.target.value as typeof pLang)}>
                    {LANGUAGE_CODES.map((c) => <option key={c} value={c} lang={c}>{LANGUAGES[c].nativeName}{isDraftLanguage(c) ? ` (${tr('lang.draft')})` : ''}</option>)}
                  </select>
                </div>
              </div>
              <div className="btn-row">
                <button type="button" className="btn btn-primary" onClick={() => void doPreview()} disabled={pBusy}><Icon name="file" size={18} /> {tr('comms.preview')}</button>
                <button type="button" className="btn btn-secondary" onClick={() => void doTest()} disabled={tBusy}><Icon name="send" size={18} /> {tr('comms.sendTest')}</button>
              </div>
              <p className="callout callout-info small"><Icon name="info" size={16} /> <span>{tr('comms.sandboxHint')}</span></p>
              {pErr && <p className="notice notice-err" role="alert">{pErr}</p>}
              {tErr && <p className="notice notice-err" role="alert">{tErr}</p>}
              {testOut && (
                <div role="status">
                  <p className="label">{tr('comms.testResult', { n: testOut.length })}</p>
                  <ul className="list-rows compact-rows">{testOut.map((d, i) => <DeliveryRow key={d.id ?? i} d={d} />)}</ul>
                </div>
              )}
            </div>
            <div className="preview-box">
              {preview ? (
                <>
                  {preview.local && <p className="small example-inline">{tr('comms.localPreview')}</p>}
                  <iframe title={tr('comms.previewFrame')} sandbox="" srcDoc={preview.html} className="preview-frame" />
                </>
              ) : <div className="preview-empty"><Icon name="message" size={28} /><p className="muted">{tr('comms.previewEmpty')}</p></div>}
            </div>
          </div>
        </section>

        <section className="panel span-12" aria-labelledby="cat-title">
          <header className="panel-head">
            <div><h2 className="panel-title" id="cat-title">{tr('comms.catalogueTitle')}</h2><p className="panel-sub">{tr('comms.catalogueSub', { n: events.length, c: byCat.size })}</p></div>
            <div className="panel-tools">
              <label className="sr-only" htmlFor="cat-filter">{tr('comms.filter')}</label>
              <input id="cat-filter" type="search" placeholder={tr('comms.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} className="input-sm" />
            </div>
          </header>
          <div className="accordion">
            {[...byCat.entries()].map(([c, list]) => {
              const items = f ? list.filter((e) => `${e.code} ${e.libelle} ${e.objet}`.toLowerCase().includes(f)) : list;
              if (!items.length) return null;
              return (
                <details key={c} className="acc-item" open={!!f}>
                  <summary><span>{catLabel(c)}</span><span className="count">{items.length}</span><Icon name="chevronDown" size={18} className="acc-chev" /></summary>
                  <ul className="event-list">
                    {items.map((e) => (
                      <li key={e.code} className="event-row">
                        <div className="min0">
                          <p className="row-title">{e.libelle} {e.obligatoire && <span className="tag tag-mandatory">{tr('comms.mandatoryBadge')}</span>}</p>
                          <p className="small mono muted truncate">{e.code}</p>
                          <p className="small">{e.objet}</p>
                        </div>
                        <div className="event-meta">
                          <StatusBadge tone={SEVERITY_TONE[e.gravite]} label={tr(`severity.${e.gravite}` as UIKey)} />
                          <span className="chips">
                            {e.canaux_defaut.map((ch: Channel) => <span key={ch} className="tag tag-channel">{tr(`channel.short.${ch}` as UIKey)}</span>)}
                            {e.whatsapp_optin && <span className="tag tag-channel tag-optin" title={tr('comms.optinHint')}>{tr('channel.short.whatsapp')} · {tr('comms.optin')}</span>}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
