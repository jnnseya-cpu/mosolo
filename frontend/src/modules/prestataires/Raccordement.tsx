/**
 * « Prestataires de paiement — état de raccordement » (Trésor R17, administration de la plateforme R26, sécurité R28).
 * Par prestataire : variables présentes ou manquantes (NOMS seulement, jamais une valeur secrète), mode, URL exacte du
 * webhook à communiquer, schéma de signature attendu, dernier webhook et résultat de sa vérification, dernière
 * interrogation serveur à serveur, opérateurs, alias de règlement du coffre, disjoncteur, hypothèses à confirmer.
 * « Tester la connexion » : appel réel inoffensif documenté, sinon validation à blanc — le résultat dit lequel.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { ChartGrid, StackedBarViz, fmtNombre } from '../../components/viz';
import type { UIKey } from '../../lib/i18n';

interface Variable { name: string; present: boolean; secret: boolean; requiredForReal: boolean; role: string; source?: 'ENVIRONNEMENT' | 'CONSOLE' | 'ABSENTE' }
interface PlatformStatus { at: string; state: string | null; level: 'NORMAL' | 'DEGRADE' | 'INCONNU'; guardian: boolean; detail: string | null }
interface Reception { receivedAt: string; verification: string; httpStatus: number; outcome: string; eventTypes: string[] }
interface StatusQuery { at: string; outcome: string; rawStatus: string | null; detail: string; providerIntentId: string; paymentReference?: string }
interface Check { label: string; ok: boolean; detail?: string }
interface ConnTest { kind: 'APPEL_REEL' | 'VALIDATION_A_BLANC'; ok: boolean; endpoint?: string; httpStatus?: number; durationMs?: number; proves: string; detail: string; checks: Check[]; at: string; by: string }
interface Circuit { state: 'FERME' | 'OUVERT' | 'SEMI_OUVERT'; consecutiveFailures: number; failureThreshold: number; cooldownMs: number; timeoutMs: number; maxRetries: number; reopensAt: string | null }
interface ProviderReadiness {
  id: string; label: string; registered: boolean; configuration: string; configurationLabel: string; mode: string | null; modeLabel: string;
  variables: Variable[]; missingForReal: string[]; webhookUrl: string; webhookUrlReady: boolean; signatureScheme: string; baseUrl: string | null;
  operators: string[]; settlementAccount: { alias: string | null; inVault: boolean; locked: boolean; version: number | null; entity: string | null; holderName: string | null };
  lastWebhook: Reception | null; lastStatusQuery: StatusQuery | null; lastConnectionTest: ConnTest | null; circuit: Circuit | null;
  webhooksByResult: { key: string; count: number }[]; ordersByStatus: { key: string; count: number }[]; suspense: number;
  assumptions: { sujet: string; hypothese: string }[];
  /** Points tranchés par la documentation publique du prestataire (29/09/2026). */
  confirmed?: { sujet: string; fait: string; hypotheseAnterieure?: string }[]; confirmedSource?: string;
  returnUrl?: string; platformStatus?: PlatformStatus | null; resolutionCheck?: boolean;
  /** Erreur de configuration signalée par le prestataire (ex. scope_denied : clé sans la portée requise). */
  configurationIssue?: { at: string; method: string; path: string; code: string; bp: string | null } | null;
}
interface Readiness { generatedAt: string; demoMode: boolean; publicUrl: { value: string | null; valid: boolean; note: string }; providers: ProviderReadiness[]; doctrine: string[]; configError?: string | null }

const CONFIG_TONE: Record<string, 'good' | 'info' | 'warning' | 'critical' | 'neutral'> = { COMPLETE: 'good', BAC_A_SABLE_DEMO: 'info', PARTIELLE: 'warning', NON_CONFIGURE: 'neutral' };
const MODE_TONE: Record<string, 'good' | 'info' | 'warning'> = { LIVE: 'good', TEST: 'info', SANDBOX_LOCAL: 'warning' };
const CIRCUIT: Record<Circuit['state'], { tone: 'good' | 'warning' | 'critical'; label: string }> = {
  FERME: { tone: 'good', label: 'Disjoncteur fermé (appels admis)' }, SEMI_OUVERT: { tone: 'warning', label: 'Disjoncteur semi-ouvert (appel d’essai)' }, OUVERT: { tone: 'critical', label: 'Disjoncteur ouvert (prestataire déclaré indisponible)' },
};
const S2S: Record<string, { tone: 'good' | 'warning' | 'critical' | 'info'; label: string }> = {
  CONFIRME: { tone: 'good', label: 'Confirmé serveur à serveur' }, EN_ATTENTE: { tone: 'warning', label: 'État non final' },
  CONTREDIT: { tone: 'critical', label: 'Contredit par le prestataire' }, ECHEC_APPEL: { tone: 'critical', label: 'Prestataire injoignable' },
};
const RESULT_LABEL: Record<string, string> = {
  ACCEPTE: 'Accepté', INVALID_SIGNATURE: 'Signature invalide', SIGNATURE_MISSING: 'Signature absente', TIMESTAMP_OUT_OF_WINDOW: 'Horodatage hors fenêtre', CORPS_REFUSE: 'Corps refusé',
};
const resultLabel = (k: string) => RESULT_LABEL[k] ?? (k.startsWith('REFUSE_') ? `Refusé après vérification (${k.slice(7)})` : k);

export function Raccordement() {
  const { fmtDate, user, tr } = useApp();
  const q = useApi(() => api<Readiness>('/v1/providers/readiness'), [user?.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function tester(id: string) {
    setBusy(id); setMsg(null);
    try {
      const r = await api<ConnTest>(`/v1/providers/${id}/test-connection`, { method: 'POST', body: {} });
      setMsg({ ok: r.ok, text: `${r.kind === 'APPEL_REEL' ? `Appel réel ${r.endpoint ?? ''}` : 'Validation à blanc (aucun appel)'} : ${r.ok ? 'réussi' : 'en échec'} — ${r.detail}` });
      q.reload();
    } catch (e) {
      setMsg({ ok: false, text: describeError(e).message });
    } finally { setBusy(null); }
  }

  async function copier(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(url); } catch { setCopied(null); }
  }

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  const d = q.data;
  const resultKeys = [...new Set(d.providers.flatMap((p) => p.webhooksByResult.map((r) => r.key)))];
  const statusKeys = [...new Set(d.providers.flatMap((p) => p.ordersByStatus.map((r) => r.key)))];

  return (
    <section className="panel pr-ready" aria-labelledby="pr-ready-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="pr-ready-title">Prestataires de paiement — état de raccordement</h2>
          <p className="panel-sub">Prêt à recevoir les clés et le webhook : noms des variables et présence seulement, jamais une valeur secrète.</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={q.reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </div>
      <p className={`notice ${d.publicUrl.valid ? 'notice-ok' : 'notice-err'}`} role="status">
        Adresse publique (MOSOLO_PUBLIC_URL) : <span className="mono">{d.publicUrl.value ?? '— absente —'}</span> · {d.publicUrl.note}
      </p>
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role="status">{msg.text}</p>}
      {d.configError && <p className="notice notice-err" role="alert">Dernière configuration non appliquée (console « Clés et raccordements ») : {d.configError} Les connecteurs précédents restent en service.</p>}
      {user?.roles.some((r) => r === 'R26' || r === 'R28') && <p className="small"><Link to="/plateforme/cles">Définir ou faire tourner les clés et secrets (console « Clés et raccordements », deux personnes)</Link></p>}

      <ChartGrid min={300} label="Raccordement en graphiques">
        <StackedBarViz title="Webhooks reçus par résultat" subtitle="acceptés, refusés à la vérification ou après contrôle" emptyText="Aucun webhook reçu" mode="absolute" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example={d.demoMode}
          series={resultKeys.map((k) => ({ key: k, label: resultLabel(k) }))}
          rows={d.providers.map((p) => ({ key: p.id, label: p.label, values: Object.fromEntries(resultKeys.map((k) => [k, p.webhooksByResult.find((r) => r.key === k)?.count ?? 0])) }))} />
        <StackedBarViz title="Ordres par état et par prestataire" subtitle="références liées à une intention prestataire" emptyText="Aucun ordre lié à un prestataire" mode="absolute" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example={d.demoMode}
          series={statusKeys.map((k) => ({ key: k, label: tr(`payment.status.${k}` as UIKey) }))}
          rows={d.providers.map((p) => ({ key: p.id, label: p.label, values: Object.fromEntries(statusKeys.map((k) => [k, p.ordersByStatus.find((r) => r.key === k)?.count ?? 0])) }))} />
      </ChartGrid>

      <div className="pr-grid">
        {d.providers.map((p) => (
          <article key={p.id} className={`panel pr-card pr-${p.id}`} aria-labelledby={`prr-${p.id}`}>
            <div className="pr-card-head">
              <span className="pr-logo" aria-hidden="true">{p.label.slice(0, 1)}</span>
              <div className="min0">
                <h3 className="panel-title" id={`prr-${p.id}`}>{p.label}</h3>
                <p className="small muted">{p.configurationLabel}</p>
              </div>
              <StatusBadge tone={p.mode ? MODE_TONE[p.mode] ?? 'neutral' : 'neutral'} label={p.modeLabel} />
            </div>
            <dl className="kv kv-dense">
              <div><dt>Configuration</dt><dd><StatusBadge tone={CONFIG_TONE[p.configuration] ?? 'neutral'} label={p.configuration === 'COMPLETE' ? 'Complète' : p.configuration === 'PARTIELLE' ? 'Partielle' : p.configuration === 'BAC_A_SABLE_DEMO' ? 'Démonstration' : 'Non configuré'} /></dd></div>
              <div>
                <dt>Webhook à communiquer</dt>
                <dd>
                  <span className="mono pr-url">{p.webhookUrl}</span>{' '}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copier(p.webhookUrl)} disabled={!p.webhookUrlReady}>{copied === p.webhookUrl ? 'Copiée' : 'Copier'}</button>
                </dd>
              </div>
              <div><dt>Signature attendue</dt><dd className="small">{p.signatureScheme}</dd></div>
              {p.returnUrl && <div><dt>Page de retour du payeur</dt><dd><span className="mono pr-url">{p.returnUrl}?ref=…</span> <span className="small muted">— commodité ; l’état réel est lu dans MOSOLO</span></dd></div>}
              {p.id === 'bitripay' && <div><dt>Confirmation supplémentaire</dt><dd className="small">{p.resolutionCheck ? 'GET /payment_resolution exigé avant quittance (CONFIRMED)' : 'Désactivée (BITRIPAY_RESOLUTION_CHECK=false)'}</dd></div>}
              {p.configurationIssue && <div><dt>Configuration refusée par le prestataire</dt><dd><StatusBadge tone="critical" label={`${p.configurationIssue.code}${p.configurationIssue.bp ? ` (${p.configurationIssue.bp})` : ''}`} /> <span className="small muted">{p.configurationIssue.method} {p.configurationIssue.path} · {fmtDate(p.configurationIssue.at, true)} — {p.configurationIssue.code === 'scope_denied' ? 'clé sans la portée requise : à corriger chez le prestataire' : 'clé refusée'}</span></dd></div>}
              {p.platformStatus && <div><dt>État de la plateforme (GET /status)</dt><dd><StatusBadge tone={p.platformStatus.level === 'NORMAL' ? 'good' : p.platformStatus.level === 'DEGRADE' ? 'warning' : 'neutral'} label={p.platformStatus.level === 'NORMAL' ? 'Fonctionnement normal' : p.platformStatus.level === 'DEGRADE' ? `Mode dégradé${p.platformStatus.guardian ? ' (gardien)' : ''}` : 'État illisible'} /> <span className="small muted">{p.platformStatus.state ?? ''} · {fmtDate(p.platformStatus.at, true)}</span></dd></div>}
              <div><dt>URL de l’API</dt><dd className="mono small">{p.baseUrl ?? '—'}</dd></div>
              <div><dt>Opérateurs</dt><dd>{p.operators.length ? p.operators.join(', ') : '—'}</dd></div>
              <div>
                <dt>Compte de règlement</dt>
                <dd>
                  <span className="mono">{p.settlementAccount.alias ?? '—'}</span>{' '}
                  <StatusBadge tone={p.settlementAccount.inVault ? 'good' : 'critical'} label={p.settlementAccount.inVault ? `Coffre, verrouillé (v${p.settlementAccount.version ?? '?'})` : 'Absent du coffre'} />
                  {p.settlementAccount.holderName && <span className="small muted"> — {p.settlementAccount.holderName}</span>}
                </dd>
              </div>
              <div>
                <dt>Dernier webhook</dt>
                <dd>{p.lastWebhook ? <>{fmtDate(p.lastWebhook.receivedAt, true)} · <StatusBadge tone={p.lastWebhook.verification === 'VALIDE' && p.lastWebhook.httpStatus < 400 ? 'good' : 'critical'} label={`${p.lastWebhook.verification === 'VALIDE' ? 'Signature valide' : resultLabel(p.lastWebhook.verification)} · HTTP ${p.lastWebhook.httpStatus} · ${p.lastWebhook.outcome}`} /></> : 'Aucun reçu'}</dd>
              </div>
              <div>
                <dt>Dernière interrogation serveur à serveur</dt>
                <dd>{p.lastStatusQuery ? <>{fmtDate(p.lastStatusQuery.at, true)} · <StatusBadge tone={S2S[p.lastStatusQuery.outcome]?.tone ?? 'info'} label={S2S[p.lastStatusQuery.outcome]?.label ?? p.lastStatusQuery.outcome} /> <span className="small muted">{p.lastStatusQuery.rawStatus ?? ''}</span></> : 'Aucune'}</dd>
              </div>
              {p.circuit && <div><dt>Appels sortants</dt><dd><StatusBadge tone={CIRCUIT[p.circuit.state].tone} label={CIRCUIT[p.circuit.state].label} /> <span className="small muted">délai {p.circuit.timeoutMs / 1000} s, {p.circuit.maxRetries} nouvelle(s) tentative(s), ouverture après {p.circuit.failureThreshold} échecs pour {p.circuit.cooldownMs / 1000} s — valeurs par défaut, à confirmer</span></dd></div>}
              {p.suspense > 0 && <div><dt>Événements en suspens</dt><dd><StatusBadge tone="warning" label={`${p.suspense} — jamais portés sur une obligation`} /></dd></div>}
            </dl>

            <details className="pr-vars">
              <summary>Variables ({p.variables.filter((v) => v.present).length}/{p.variables.length} présentes{p.missingForReal.length ? ` — manquantes pour le réel : ${p.missingForReal.join(', ')}` : ''})</summary>
              <ul className="list-rows compact-rows">
                {p.variables.map((v) => (
                  <li key={v.name} className="list-row">
                    <div className="min0"><p className="row-title mono small">{v.name}{v.secret ? ' (secret)' : ''}</p><p className="small muted">{v.role}</p></div>
                    <StatusBadge tone={v.present ? 'good' : v.requiredForReal ? 'warning' : 'neutral'} label={v.present ? (v.source === 'CONSOLE' ? 'Présente (console)' : 'Présente') : v.requiredForReal ? 'Manquante (requise en réel)' : 'Absente (défaut)'} />
                  </li>
                ))}
              </ul>
            </details>

            <div className="pr-test">
              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void tester(p.id)}>
                <Icon name="refresh" size={16} /> Tester la connexion
              </button>
              <span className="small muted">{p.mode && p.mode !== 'SANDBOX_LOCAL' ? 'Appel réel inoffensif (lecture seule).' : 'Validation à blanc : aucun appel au prestataire.'}</span>
              {p.lastConnectionTest && (
                <div className="pr-test-res">
                  <StatusBadge tone={p.lastConnectionTest.ok ? 'good' : 'critical'} label={`${p.lastConnectionTest.kind === 'APPEL_REEL' ? `Appel réel ${p.lastConnectionTest.endpoint ?? ''}` : 'Validation à blanc'} — ${p.lastConnectionTest.ok ? 'réussi' : 'échec'}`} />
                  <p className="small">{p.lastConnectionTest.proves}</p>
                  <ul className="small">{p.lastConnectionTest.checks.map((c) => <li key={c.label}>{c.ok ? '✓' : '✗'} {c.label}{c.detail ? ` — ${c.detail}` : ''}</li>)}</ul>
                  <p className="small muted">{fmtDate(p.lastConnectionTest.at, true)} · {p.lastConnectionTest.by}</p>
                </div>
              )}
            </div>

            {p.confirmed && p.confirmed.length > 0 && (
              <details className="pr-vars">
                <summary>Points confirmés par la documentation du prestataire ({p.confirmed.length})</summary>
                <ul className="small">{p.confirmed.map((c) => <li key={c.sujet}><strong>{c.sujet}</strong> — {c.fait}{c.hypotheseAnterieure ? <span className="muted"> (hypothèse antérieure : {c.hypotheseAnterieure})</span> : null}</li>)}</ul>
                {p.confirmedSource && <p className="small muted">Source : {p.confirmedSource}.</p>}
              </details>
            )}
            <details className="pr-vars">
              <summary>Points à confirmer avec le prestataire ({p.assumptions.length})</summary>
              <ul className="small">{p.assumptions.map((a) => <li key={a.sujet}><strong>{a.sujet}</strong> — {a.hypothese} <em>À CONFIRMER AVEC LE PRESTATAIRE.</em></li>)}</ul>
            </details>
          </article>
        ))}
      </div>
      <ul className="pr-doctrine">{d.doctrine.map((x) => <li key={x}><Icon name="shieldCheck" size={16} /> {x}</li>)}</ul>
    </section>
  );
}
