/**
 * Vérification publique (sans connexion) : plaque / QR d'un bien, quitus fiscal, attestation de bail.
 * Divulgation minimale : jamais de nom, d'adresse ni de montant. La couleur de situation fiscale d'un bien est affichée
 * (le Cahier des exigences prévaut, décision de la Ville) avec sa légende générique, sans détail des obligations.
 */
import { StatusBadge } from '../../components/StatusBadge';
const SITUATION_TONE = { green: 'good', amber: 'warning', red: 'critical', grey: 'neutral', blue: 'info' } as const;
import type { MapStatusColor } from '@mosolo/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context';
import { CoverSplit } from '../../components/Split';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/States';
import { api } from '../../lib/api';
import './fiscal.css';

type Kind = 'bien' | 'quitus' | 'bail';
const KINDS: { id: Kind; label: string; placeholder: string }[] = [
  { id: 'bien', label: 'Plaque d’un bien', placeholder: 'XXXX-XXXX-X' },
  { id: 'quitus', label: 'Quitus fiscal', placeholder: 'XXXX-XXXX-X' },
  { id: 'bail', label: 'Attestation de bail', placeholder: 'XXXX-XXXX-X' },
];
const ENDPOINT: Record<Kind, string> = { bien: '/v1/public/fiscal/plates/', quitus: '/v1/public/fiscal/clearances/', bail: '/v1/public/fiscal/lease-attestations/' };

const VERDICT: Record<string, { tone: string; icon: string; title: string }> = {
  AUTHENTIQUE: { tone: 'good', icon: 'check', title: 'Plaque authentique' },
  VALIDE: { tone: 'good', icon: 'check', title: 'Document valide' },
  BIENTOT_EXPIRE: { tone: 'warning', icon: 'clock', title: 'Valide — expire bientôt' },
  EXPIRE: { tone: 'critical', icon: 'x', title: 'Expiré' },
  REVOQUE: { tone: 'critical', icon: 'ban', title: 'Révoqué' },
  REVOQUEE: { tone: 'critical', icon: 'ban', title: 'Révoquée' },
  REMPLACEE: { tone: 'info', icon: 'replace', title: 'Plaque remplacée' },
  SIGNATURE_INVALIDE: { tone: 'serious', icon: 'alert', title: 'Signature invalide — document non authentique' },
  INCONNU: { tone: 'neutral', icon: 'question', title: 'Code inconnu' },
};

type Result = Record<string, unknown> & { result: string; checkedAt: string };

export default function Verifier() {
  const { fmtDate } = useApp();
  const params = useParams();
  const [search] = useSearchParams();
  const nav = useNavigate();
  const kind: Kind = params.type === 'quitus' || params.type === 'bail' ? params.type : 'bien';
  const initial = params.code ?? '';
  const sig = search.get('s') ?? undefined;
  const [code, setCode] = useState(initial);
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async (k: Kind, c: string, s?: string) => {
    if (!c.trim()) return;
    setBusy(true); setError(null); setRes(null);
    try { setRes(await api<Result>(`${ENDPOINT[k]}${encodeURIComponent(c.trim())}${s ? `?s=${encodeURIComponent(s)}` : ''}`)); } catch (e) { setError(e); } finally { setBusy(false); }
  }, []);
  useEffect(() => { setCode(initial); if (initial) void check(kind, initial, sig); }, [kind, initial, sig, check]);

  function submit(e: FormEvent) {
    e.preventDefault();
    nav(`/fiscal/verifier/${kind}/${encodeURIComponent(code.trim().replace(/[\s-]/g, ''))}`);
  }
  const v = res ? VERDICT[res.result] ?? VERDICT.INCONNU! : null;
  const str = (k: string) => (typeof res?.[k] === 'string' ? (res[k] as string) : null);
  const situation = res && typeof res.situation === 'object' && res.situation !== null ? (res.situation as { color: MapStatusColor; label: string }) : null;

  return (
    <div className="page page-flush">
      <CoverSplit>
        <div className="form-card verify-card">
          <p className="eyebrow">Vérification publique</p>
          <h1>Vérifier un bien, un quitus ou une attestation</h1>
          <p className="lead">Scannez le QR avec l’appareil photo de votre téléphone, ou saisissez le code court inscrit sous le QR.</p>
          <div className="seg seg-wrap" role="group" aria-label="Type de vérification">
            {KINDS.map((k) => (
              <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => { setRes(null); nav(`/fiscal/verifier/${k.id}`); }}>{k.label}</button>
            ))}
          </div>
          <form onSubmit={submit} className="verify-form">
            <label htmlFor="fv-code" className="label">Code court</label>
            <div className="input-row">
              <input id="fv-code" className="mono" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder={KINDS.find((k) => k.id === kind)!.placeholder} />
              <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>Vérifier</button>
            </div>
          </form>
          <div aria-live="polite" className="verify-out">
            {busy && <p className="muted">Vérification…</p>}
            {error !== null && <ErrorState error={error} onRetry={() => void check(kind, code, sig)} />}
            {res && v && (
              <div className={`verdict verdict-${v.tone}`}>
                <div className="verdict-icon"><Icon name={v.icon} size={44} /></div>
                <p className="verdict-title">{v.title}</p>
                {str('message') && <p className="small">{str('message')}</p>}
                <dl className="kv kv-dense kv-verdict">
                  {str('nfiu') && <div><dt>Identifiant (NFIU)</dt><dd className="mono">{str('nfiu')}</dd></div>}
                  {str('number') && <div><dt>Numéro</dt><dd className="mono">{str('number')}</dd></div>}
                  {str('category') && <div><dt>Nature</dt><dd>{str('category')}{res.registered === true ? ' — enregistré' : ''}</dd></div>}
                  {str('commune') && <div><dt>Commune</dt><dd>{str('commune')}</dd></div>}
                  {str('quartier') && <div><dt>Quartier</dt><dd>{str('quartier')}</dd></div>}
                  {situation && <div><dt>Situation fiscale</dt><dd><StatusBadge tone={SITUATION_TONE[situation.color]} label={situation.label} /></dd></div>}
                  {str('unitIgf') && <div><dt>Unité</dt><dd className="mono">{str('unitIgf')}</dd></div>}
                  {str('taxpayerRef') && <div><dt>Contribuable</dt><dd className="mono">{str('taxpayerRef')} <span className="small muted">(masqué)</span></dd></div>}
                  {str('validUntil') && <div><dt>Valide jusqu’au</dt><dd>{fmtDate(str('validUntil')!)}</dd></div>}
                  {str('leaseStart') && <div><dt>Bail depuis</dt><dd>{fmtDate(str('leaseStart')!)}</dd></div>}
                  <div><dt>Vérifié le</dt><dd>{fmtDate(res.checkedAt, true)}</dd></div>
                </dl>
                {str('notice') && <p className="small muted">{str('notice')}</p>}
              </div>
            )}
          </div>
          <p className="small muted verify-privacy"><Icon name="lock" size={14} /> Aucune donnée personnelle ni aucun montant ne sont affichés publiquement ; seule la couleur de situation d’un bien l’est. Une couleur rouge n’entraîne aucune mesure automatique. Chaque vérification est journalisée.</p>
        </div>
      </CoverSplit>
    </div>
  );
}
