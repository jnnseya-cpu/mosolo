/**
 * Console des prestataires connectés (BitriPay, KODA) — Trésor et exploitation.
 * Configuration masquée, statistiques, journal des webhooks signés, annonces de règlement, attentes prestataire.
 * La simulation d'une confirmation signée n'existe qu'en bac à sable local (jamais en production).
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import './prestataires.css';
import type { UIKey } from '../../lib/i18n';

interface Connector {
  id: string; label: string; mode: 'SANDBOX_LOCAL' | 'TEST' | 'LIVE'; baseUrl: string; apiKey: string; webhookSecret: string;
  settlementAccountAlias: string; exponents: Record<string, number>; allowedOperators?: string[]; operators?: string[];
  connectedAccountId?: string | null; applicationFee?: string; hmacRequired?: boolean; ed25519PublicKeyConfigured?: boolean; successUrl?: string;
}
interface Stat { id: string; orders: number; confirmed: number; reconciled: number; webhooks: number }
interface Ev { provider: string; eventId: string; receivedAt: string; eventType: string; outcome: string; status: string | null; paymentReference: string | null; receiptStatus: string | null; reason: string | null }
interface Order { paymentReference: string; provider: string; status: string; amount: MoneyJSON; providerIntentId: string; sandbox: boolean | null; createdAt: string }
interface Console {
  connectors: Connector[]; stats: Stat[]; events: Ev[]; recentOrders: Order[]; doctrine: string[];
  settlementAnnouncements: { id: string; provider: string; paymentReference?: string; settlementId?: string; amountMatchesOrder?: boolean; receivedAt: string }[];
  holds: { id: string; provider: string; paymentReference?: string; receivedAt: string }[];
}

const MODE: Record<Connector['mode'], { tone: 'warning' | 'info' | 'good'; label: string }> = {
  SANDBOX_LOCAL: { tone: 'warning', label: 'Bac à sable local' }, TEST: { tone: 'info', label: 'Environnement de test' }, LIVE: { tone: 'good', label: 'Production' },
};
const OUTCOME: Record<string, { tone: 'good' | 'info' | 'warning' | 'neutral'; label: string }> = {
  PROCESSED: { tone: 'good', label: 'Traité' }, SETTLEMENT_ANNOUNCED: { tone: 'info', label: 'Annonce de règlement' },
  HELD: { tone: 'warning', label: 'Attente prestataire' }, IGNORED: { tone: 'neutral', label: 'Ignoré' },
};
const STATUS_TONE: Record<string, 'good' | 'info' | 'warning' | 'neutral' | 'critical'> = { CONFIRME: 'info', RAPPROCHE: 'good', REGLE: 'good', INITIE: 'warning', ECHOUE: 'critical' };
const NAME: Record<string, string> = { bitripay: 'BitriPay', koda: 'KODA' };

export default function Prestataires() {
  const { fmtDate, user, tr } = useApp();
  const q = useApi(() => api<Console>('/v1/providers/connectors'), [user?.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canSimulate = !!user?.roles.some((r) => r === 'R17' || r === 'R26');

  async function simulate(o: Order, event: 'succeeded' | 'settled' | 'ambiguous') {
    setBusy(`${o.paymentReference}:${event}`); setMsg(null);
    try {
      const r = await api<{ results: { outcome: string; status?: string; receiptStatus?: string }[] }>(`/v1/providers/${o.provider}/sandbox-simulate`, { method: 'POST', body: { paymentReference: o.paymentReference, event } });
      const x = r.results[0];
      setMsg({ ok: true, text: `Webhook signé reçu et vérifié : ${OUTCOME[x?.outcome ?? '']?.label ?? x?.outcome}${x?.status ? ` — paiement ${tr(`payment.status.${x.status}` as UIKey).toLowerCase()}` : ''}${x?.receiptStatus ? `, quittance ${x.receiptStatus.toLowerCase()}` : ''}.` });
      q.reload();
    } catch (e) {
      setMsg({ ok: false, text: describeError(e).message });
    } finally { setBusy(null); }
  }

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Trésor · paiements" title="Prestataires connectés"
        lead="BitriPay et KODA, prestataires candidats : ils collectent par monnaie mobile et QR, confirment par webhook signé et règlent le compte public. MOSOLO orchestre, il ne détient jamais les fonds.">
        <button type="button" className="btn btn-ghost btn-sm" onClick={q.reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      <ExampleNotice text="Prestataires candidats, non désignés : l’activation en production exige l’agrément BCC, une convention et une procédure de passation. Sans clé API, chaque connecteur fonctionne en bac à sable local." />
      {q.loading && <Loading />}
      {!!q.error && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <div className="stack">
          <div className="pr-grid">
            {q.data.connectors.map((c) => {
              const st = q.data!.stats.find((s) => s.id === c.id);
              return (
                <section key={c.id} className={`panel pr-card pr-${c.id}`} aria-labelledby={`pr-${c.id}`}>
                  <div className="pr-card-head">
                    <span className="pr-logo" aria-hidden="true">{c.label.slice(0, 1)}</span>
                    <div className="min0">
                      <h2 className="panel-title" id={`pr-${c.id}`}>{c.label}</h2>
                      <p className="small muted mono truncate">{c.baseUrl}</p>
                    </div>
                    <StatusBadge tone={MODE[c.mode].tone} label={MODE[c.mode].label} />
                  </div>
                  <div className="pr-kpis">
                    <div><span className="kpi-label caps-sm">Ordres</span><strong>{st?.orders ?? 0}</strong></div>
                    <div><span className="kpi-label caps-sm">Confirmés</span><strong>{st?.confirmed ?? 0}</strong></div>
                    <div><span className="kpi-label caps-sm">Rapprochés</span><strong>{st?.reconciled ?? 0}</strong></div>
                    <div><span className="kpi-label caps-sm">Webhooks</span><strong>{st?.webhooks ?? 0}</strong></div>
                  </div>
                  <dl className="kv kv-dense">
                    <div><dt>Clé API</dt><dd className="mono">{c.apiKey || '— (bac à sable)'}</dd></div>
                    <div><dt>Secret de webhook</dt><dd className="mono">{c.webhookSecret}</dd></div>
                    <div><dt>Signature</dt><dd>{c.id === 'koda' ? 'HMAC-SHA256 du corps brut (x-koda-signature)' : `HMAC t=,v1= (±5 min)${c.ed25519PublicKeyConfigured ? ' + Ed25519' : ''}`}</dd></div>
                    <div><dt>Compte de règlement</dt><dd><span className="mono">{c.settlementAccountAlias}</span> <span className="small muted">— compte public du coffre</span></dd></div>
                    <div><dt>Unités mineures</dt><dd>{Object.entries(c.exponents).map(([k, v]) => `${k} : ${v} décimale${v > 1 ? 's' : ''}`).join(' · ')}</dd></div>
                    <div><dt>Opérateurs</dt><dd>{(c.allowedOperators ?? c.operators ?? []).join(', ')}</dd></div>
                    {c.id === 'bitripay' && <div><dt>Compte connecté</dt><dd>{c.connectedAccountId ?? 'Compte propre de la Ville'}</dd></div>}
                    {c.applicationFee && <div><dt>Frais d’application</dt><dd><StatusBadge tone="good" label="Interdit sur la recette" /></dd></div>}
                  </dl>
                </section>
              );
            })}
          </div>

          <ul className="pr-doctrine">{q.data.doctrine.map((d) => <li key={d}><Icon name="shieldCheck" size={16} /> {d}</li>)}</ul>

          <section className="panel" aria-labelledby="pr-orders">
            <div className="panel-head"><div><h2 className="panel-title" id="pr-orders">Ordres de paiement par prestataire</h2><p className="panel-sub">Références créées par les contribuables ; chaque confirmation arrive par webhook signé</p></div></div>
            {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role="status">{msg.text}</p>}
            {q.data.recentOrders.length === 0 ? <EmptyState title="Aucun ordre lié à un prestataire pour l’instant" icon="phone" /> : (
              <ul className="list-rows">
                {q.data.recentOrders.map((o) => (
                  <li key={o.paymentReference} className="list-row">
                    <div className="min0">
                      <p className="row-title"><span className="mono">{o.paymentReference}</span> · {NAME[o.provider] ?? o.provider}</p>
                      <p className="small muted">Intention <span className="mono">{o.providerIntentId}</span> · {fmtDate(o.createdAt, true)}</p>
                    </div>
                    <div className="row-side">
                      <MoneyText money={o.amount} />
                      <StatusBadge tone={STATUS_TONE[o.status] ?? 'neutral'} label={tr(`payment.status.${o.status}` as UIKey)} />
                      {canSimulate && o.sandbox && (
                        <span className="pr-sim">
                          {o.status === 'INITIE' && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void simulate(o, 'succeeded')}>Simuler la confirmation signée</button>}
                          {o.status === 'INITIE' && o.provider === 'bitripay' && <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void simulate(o, 'ambiguous')}>Résultat ambigu</button>}
                          {o.status === 'CONFIRME' && o.provider === 'bitripay' && <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void simulate(o, 'settled')}>Annonce de règlement</button>}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="pr-two">
            <section className="panel" aria-labelledby="pr-events">
              <div className="panel-head"><h2 className="panel-title" id="pr-events">Journal des webhooks signés</h2><span className="count">{q.data.events.length}</span></div>
              {q.data.events.length === 0 ? <EmptyState title="Aucun webhook reçu" icon="send" /> : (
                <ul className="list-rows compact-rows">
                  {q.data.events.map((e) => (
                    <li key={`${e.provider}:${e.eventId}`} className="list-row">
                      <div className="min0">
                        <p className="row-title"><span className="mono small">{e.eventType}</span></p>
                        <p className="small muted">{NAME[e.provider]} · {e.paymentReference ?? '—'} · {fmtDate(e.receivedAt, true)}</p>
                      </div>
                      <StatusBadge tone={OUTCOME[e.outcome]?.tone ?? 'neutral'} label={OUTCOME[e.outcome]?.label ?? e.outcome} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="panel" aria-labelledby="pr-settle">
              <div className="panel-head"><h2 className="panel-title" id="pr-settle">Annonces de règlement et attentes</h2></div>
              <p className="small muted">Une annonce du prestataire est un indice de rapprochement, jamais un règlement : seul le relevé du compte public fait passer un paiement à « rapproché ».</p>
              {q.data.settlementAnnouncements.length === 0 && q.data.holds.length === 0 ? <EmptyState title="Rien à signaler" icon="check" /> : (
                <ul className="list-rows compact-rows">
                  {q.data.settlementAnnouncements.map((a) => (
                    <li key={a.id} className="list-row">
                      <div className="min0"><p className="row-title">{NAME[a.provider]} · <span className="mono">{a.settlementId ?? a.id}</span></p><p className="small muted">{a.paymentReference ?? '—'} · {fmtDate(a.receivedAt, true)}</p></div>
                      <StatusBadge tone={a.amountMatchesOrder === false ? 'critical' : 'info'} label={a.amountMatchesOrder === false ? 'Montant discordant' : 'Annonce — attend le relevé'} />
                    </li>
                  ))}
                  {q.data.holds.map((h) => (
                    <li key={h.id} className="list-row">
                      <div className="min0"><p className="row-title">{NAME[h.provider]} · résultat opérateur inconnu</p><p className="small muted">{h.paymentReference ?? '—'} · {fmtDate(h.receivedAt, true)}</p></div>
                      <StatusBadge tone="warning" label="Exception ouverte — aucune quittance" />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
