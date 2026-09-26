import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { PublicReceiptCheck } from '@mosolo/shared';
import { useApp } from '../context';
import { CoverSplit } from '../components/Split';
import { Icon } from '../components/Icon';
import { MoneyText } from '../components/MoneyText';
import { ErrorState } from '../components/States';
import { api } from '../lib/api';
import type { UIKey } from '../lib/i18n';
import { revenueCategoryLabel } from '../lib/labels';
import type { PublicReceiptResult } from '../lib/types';

const VIEW: Record<PublicReceiptCheck, { icon: string; tone: string; key: UIKey }> = {
  VALID: { icon: 'check', tone: 'good', key: 'verify.valid' },
  PENDING: { icon: 'clock', tone: 'warning', key: 'verify.pending' },
  CANCELLED: { icon: 'ban', tone: 'critical', key: 'verify.cancelled' },
  REPLACED: { icon: 'replace', tone: 'info', key: 'verify.replaced' },
  FRAUD_SUSPECTED: { icon: 'alert', tone: 'serious', key: 'verify.fraud' },
  UNKNOWN: { icon: 'question', tone: 'neutral', key: 'verify.unknown' },
};

/** Extrait le code d'un contenu de QR (URL …/verifier/CODE, ?code=CODE, ou code nu). */
export function extractCode(raw: string): string {
  const s = raw.trim();
  try {
    const u = new URL(s);
    const q = u.searchParams.get('code');
    if (q) return q;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? s;
  } catch {
    return s;
  }
}

function Scanner({ onCode, onClose }: { onCode: (c: string) => void; onClose: () => void }) {
  const { tr } = useApp();
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null; let stop = false; let timer = 0;
    const Detector = window.BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) { setErr(tr('verify.scanUnsupported')); return; }
    const det = new Detector({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s;
      if (!video.current) return;
      video.current.srcObject = s;
      void video.current.play();
      const tick = async () => {
        if (stop || !video.current) return;
        try {
          const codes = await det.detect(video.current);
          const first = codes[0];
          if (first?.rawValue) { onCode(extractCode(first.rawValue)); return; }
        } catch { /* image pas prête */ }
        timer = window.setTimeout(() => void tick(), 300);
      };
      void tick();
    }).catch(() => setErr(tr('verify.cameraDenied')));
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode, tr]);
  return (
    <div className="scanner">
      {err ? <p className="notice notice-err">{err}</p> : <video ref={video} className="scanner-video" muted playsInline aria-label={tr('verify.scanning')} />}
      <button type="button" className="btn btn-secondary" onClick={onClose}><Icon name="close" size={18} /> {tr('verify.stopScan')}</button>
    </div>
  );
}

export default function Verify() {
  const { tr, fmtDate, lang } = useApp();
  const params = useParams();
  const [search] = useSearchParams();
  const nav = useNavigate();
  const initial = params.code ?? search.get('code') ?? '';
  const [code, setCode] = useState(initial);
  const [result, setResult] = useState<PublicReceiptResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false);
  const canScan = typeof window !== 'undefined' && !!window.BarcodeDetector;

  const check = useCallback(async (c: string) => {
    const clean = extractCode(c);
    if (!clean) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api<PublicReceiptResult>(`/v1/public/receipts/${encodeURIComponent(clean)}`);
      setResult(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { if (initial) void check(initial); }, [initial, check]);

  const onScan = useCallback((c: string) => { setScan(false); setCode(c); nav(`/verifier/${encodeURIComponent(c)}`); }, [nav]);

  function submit(e: FormEvent) { e.preventDefault(); void check(code); }

  const view = result ? VIEW[result.status] ?? VIEW.UNKNOWN : null;
  return (
    <div className="page page-flush">
      <CoverSplit>
        <div className="form-card verify-card">
          <p className="eyebrow">{tr('verify.eyebrow')}</p>
          <h1>{tr('verify.title')}</h1>
          <p className="lead">{tr('verify.prompt')}</p>
          <form onSubmit={submit} className="verify-form">
            <label htmlFor="rc-code" className="label">{tr('verify.codeLabel')}</label>
            <div className="input-row">
              <input id="rc-code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false}
                placeholder="Q-2027-000123-7F3A" className="mono" />
              <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>{tr('verify.button')}</button>
            </div>
          </form>
          {canScan ? (
            scan ? <Scanner onCode={onScan} onClose={() => setScan(false)} /> : (
              <button type="button" className="btn btn-secondary btn-block" onClick={() => setScan(true)}><Icon name="camera" size={18} /> {tr('verify.scan')}</button>
            )
          ) : <p className="small muted">{tr('verify.scanUnsupported')}</p>}

          <div aria-live="polite" className="verify-out">
            {busy && <p className="muted">{tr('common.loading')}</p>}
            {error !== null && <ErrorState error={error} onRetry={() => void check(code)} />}
            {result && view && (
              <div className={`verdict verdict-${view.tone}`}>
                <div className="verdict-icon"><Icon name={view.icon} size={44} /></div>
                <p className="verdict-title">{tr(view.key)}</p>
                {result.status === 'REPLACED' && result.replacedBy && <p>{tr('verify.replacedBy', { n: result.replacedBy })}</p>}
                {result.status === 'CANCELLED' && result.reason && <p>{result.reason}</p>}
                {result.verifiedAt && <p className="small muted">{tr('verify.checkedAt', { date: fmtDate(result.verifiedAt, true) })}</p>}
                {(result.status === 'VALID' || result.status === 'PENDING') && (
                  <dl className="kv kv-verdict">
                    {result.amount && <div><dt>{tr('verify.amount')}</dt><dd><MoneyText money={result.amount} /></dd></div>}
                    {(result.paidOn ?? result.date ?? result.paidAt) && <div><dt>{tr('verify.date')}</dt><dd>{fmtDate(result.paidOn ?? result.date ?? result.paidAt)}</dd></div>}
                    {(result.category ?? result.revenueCategory) && <div><dt>{tr('verify.category')}</dt><dd>{result.category ?? revenueCategoryLabel(lang, result.revenueCategory ?? '')}</dd></div>}
                    {(result.beneficiaryAdministration ?? result.beneficiary ?? result.administration) && <div><dt>{tr('verify.beneficiary')}</dt><dd>{result.beneficiaryAdministration ?? result.beneficiary ?? result.administration}</dd></div>}
                    {(result.taxpayerRefSuffix ?? result.taxpayerRefLast4) && <div><dt>{tr('verify.ref4')}</dt><dd className="mono">{result.taxpayerRefSuffix ?? `…${result.taxpayerRefLast4}`}</dd></div>}
                  </dl>
                )}
              </div>
            )}
          </div>
          <p className="small muted verify-privacy"><Icon name="lock" size={14} /> {tr('verify.privacy')}</p>
        </div>
      </CoverSplit>
    </div>
  );
}
