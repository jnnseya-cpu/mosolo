/**
 * Vérification publique d'un badge d'agent (§ 15A.6) : sans connexion, par code court ou QR signé.
 * Divulgation minimale : nom d'usage, structure, module, zone, période — jamais de téléphone ni d'adresse.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context';
import { CoverSplit } from '../../components/Split';
import { Icon } from '../../components/Icon';
import { ValidityCountdown, ValidityLegend } from '../../components/ValidityCountdown';
import { ErrorState } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { BADGE_RESULT, fmtPct, moduleLabel } from './labels';
import { initials } from './common';
import type { PublicBadgeCheck } from './types';
import './terrain.css';
import { ControlesMystereVisuel } from './visuels';

type ReportKind = 'FAUX_AGENT' | 'HORS_ZONE' | 'DEMANDE_ESPECES';

function Report({ code }: { code: string }) {
  const [kind, setKind] = useState<ReportKind>('FAUX_AGENT');
  const [place, setPlace] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ reference: string; message: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      setDone(await api<{ reference: string; message: string }>(`/v1/public/agent-badges/${encodeURIComponent(code || 'SANS-CODE')}/reports`, { method: 'POST', body: { kind, place: place.trim(), description: description.trim() } }));
    } catch (x) { setErr(describeError(x).message); } finally { setBusy(false); }
  }
  if (done) return <p className="notice notice-ok" role="status"><strong>{done.reference}</strong> — {done.message}</p>;
  return (
    <form className="form tr-report" onSubmit={(e) => void send(e)}>
      <p className="section-title">Signaler cet agent</p>
      <p className="small muted">Anonyme : aucune identité n’est demandée. Le signalement est transmis à l’enquêteur anti-fraude.</p>
      <div className="field">
        <label className="label" htmlFor="rp-kind">Motif</label>
        <select id="rp-kind" value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
          <option value="FAUX_AGENT">Badge non vérifiable ou faux agent</option>
          <option value="HORS_ZONE">Agent hors de sa zone</option>
          <option value="DEMANDE_ESPECES">Demande d’argent liquide</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="rp-place">Lieu (commune, avenue, repère)</label>
        <input id="rp-place" value={place} onChange={(e) => setPlace(e.target.value)} required minLength={2} maxLength={200} />
      </div>
      <div className="field">
        <label className="label" htmlFor="rp-desc">Ce qui s’est passé (facultatif)</label>
        <textarea id="rp-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-secondary btn-block" disabled={busy || place.trim().length < 2}><Icon name="megaphone" size={18} /> Envoyer le signalement</button>
    </form>
  );
}

export default function VerifyAgent() {
  const { fmtDate } = useApp();
  const params = useParams();
  const [search] = useSearchParams();
  const nav = useNavigate();
  const initial = params.code ?? search.get('code') ?? '';
  const token = search.get('t') ?? undefined;
  const [code, setCode] = useState(initial);
  const [result, setResult] = useState<PublicBadgeCheck | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ performed: number; withoutIrregularity: number; withoutIrregularityPct: string | null } | null>(null);

  const check = useCallback(async (c: string, t?: string) => {
    const clean = c.trim();
    if (!clean) return;
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await api<PublicBadgeCheck>(`/v1/public/agent-badges/${encodeURIComponent(clean)}${t ? `?t=${encodeURIComponent(t)}` : ''}`));
    } catch (e) { setError(e); } finally { setBusy(false); }
  }, []);

  useEffect(() => { if (initial) void check(initial, token); }, [initial, token, check]);
  useEffect(() => { api<typeof summary>('/v1/public/terrain/mystery-checks/summary').then(setSummary, () => setSummary(null)); }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    nav(`/verifier-agent/${encodeURIComponent(code.trim())}`);
    void check(code);
  }

  const view = result ? BADGE_RESULT[result.result] : null;
  const b = result?.badge;
  return (
    <div className="page page-flush">
      <CoverSplit>
        <div className="form-card verify-card">
          <p className="eyebrow">Vérification publique</p>
          <h1>Vérifier un agent de terrain</h1>
          <p className="lead">Saisissez le code inscrit sur le badge (par exemple AG-7K4M2Q-…) ou scannez son QR avec l’appareil photo de votre téléphone.</p>
          <form onSubmit={submit} className="verify-form">
            <label htmlFor="ag-code" className="label">Code du badge</label>
            <div className="input-row">
              <input id="ag-code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="AG-XXXXXX-X" className="mono" />
              <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>Vérifier</button>
            </div>
          </form>
          <div className="callout callout-danger" role="note">
            <Icon name="cash" size={20} />
            <p><strong>Aucun agent ni sous-traitant n’encaisse d’argent.</strong> Vous payez vous-même, par les canaux officiels (monnaie mobile, banque, point de paiement agréé) ; la quittance est émise par le système.</p>
          </div>

          <div aria-live="polite" className="verify-out">
            {busy && <p className="muted">Vérification…</p>}
            {error !== null && <ErrorState error={error} onRetry={() => void check(code, token)} />}
            {result && view && (
              <div className={`verdict verdict-${view.tone}`}>
                <div className="verdict-icon"><Icon name={view.icon} size={44} /></div>
                <p className="verdict-title">{view.label}</p>
                <p className="small">{view.lead}</p>
                <p className="small muted">Vérifié le {fmtDate(result.checkedAt, true)}</p>
                {b && (
                  <dl className="kv kv-verdict tr-verdict-kv">
                    <div><dt>Nom d’usage</dt><dd><span className="tr-avatar" style={{ width: 40, height: 48, fontSize: 15, display: 'inline-grid', verticalAlign: 'middle', marginRight: 8 }} aria-hidden="true">{initials(b.displayName)}</span>{b.displayName}</dd></div>
                    <div><dt>Structure</dt><dd>{b.structure}{b.structureKind === 'SOUS_TRAITANT_ACCREDITE' ? ' — sous-traitant accrédité' : ' — régie'}</dd></div>
                    <div><dt>Module</dt><dd>{moduleLabel(b.module)}</dd></div>
                    <div><dt>Zone</dt><dd>{b.communes.join(', ')}</dd></div>
                    <div><dt>Période</dt><dd>du {fmtDate(b.validFrom)} au {fmtDate(b.validUntil)}</dd></div>
                    <div><dt>Code</dt><dd className="mono">{b.shortCode}</dd></div>
                  </dl>
                )}
                {b && <ValidityCountdown from={b.validFrom} until={b.validUntil} blocked={result.result === 'SUSPENDU' ? 'Agent suspendu' : result.result === 'REVOQUE' ? 'Badge révoqué' : null} label="Habilitation" />}
                {b && !b.hasPhoto && <p className="small muted">Photo non publiée pour ce badge : comparez le nom d’usage avec le badge présenté.</p>}
              </div>
            )}
            {b && <ValidityLegend />}
            {result && (result.reportable || result.result !== 'VALIDE') && <Report code={result.badge?.shortCode ?? code} />}
            {result?.result === 'VALIDE' && (
              <details className="tr-report">
                <summary className="small">L’agent se trouve hors de sa zone ou vous demande de l’argent ?</summary>
                <Report code={result.badge?.shortCode ?? code} />
              </details>
            )}
          </div>
          <p className="small muted verify-privacy"><Icon name="lock" size={14} /> Aucune donnée personnelle n’est demandée ni affichée : ni téléphone, ni adresse de l’agent. Chaque vérification est journalisée de façon anonyme.</p>
          {summary && summary.performed > 0 && (
            <p className="small muted" style={{ marginTop: 8 }}>
              <Icon name="shieldCheck" size={14} /> Contrôles mystère réalisés auprès des agents et sous-traitants : {summary.performed}, dont {fmtPct(summary.withoutIrregularity > 0 ? summary.withoutIrregularityPct : '0.0')} sans irrégularité (résultats agrégés).
            </p>
          )}
          {/* Visuel (27/09/2026) : les mêmes résultats agrégés, en répartition (aucune donnée personnelle). */}
          {summary && summary.performed > 0 && <ControlesMystereVisuel s={summary} />}
        </div>
      </CoverSplit>
    </div>
  );
}
