import { useCallback, useEffect, useState, type FormEvent } from 'react';
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
import '../modules/tresor/tresor.css';
import { QrScanner } from '../components/QrScanner';
import { AttenteBaseLegale } from '../modules/juridique/AttenteBaseLegale';

/** Statuts publics étendus (§ 19.2) : contrepassée et remboursée s'ajoutent au vocabulaire du socle. */
type PublicStatus = PublicReceiptCheck | 'REVERSED' | 'REFUNDED';
type VerifyResult = Omit<PublicReceiptResult, 'status'> & {
  status: PublicStatus; replaces?: string; statusSince?: string; duplicate?: { duplicateNo: number; issued: boolean };
};

/** Libellés des statuts ajoutés (le socle i18n ne les connaît pas encore). */
const EXTRA_VIEW: Record<'REVERSED' | 'REFUNDED', { icon: string; tone: string; title: string }> = {
  REVERSED: { icon: 'ban', tone: 'critical', title: 'Quittance non valable — contrepassée' },
  REFUNDED: { icon: 'ban', tone: 'critical', title: 'Quittance non valable — paiement remboursé' },
};

const VIEW: Record<PublicReceiptCheck, { icon: string; tone: string; key: UIKey }> = {
  VALID: { icon: 'check', tone: 'good', key: 'verify.valid' },
  PENDING: { icon: 'clock', tone: 'warning', key: 'verify.pending' },
  CANCELLED: { icon: 'ban', tone: 'critical', key: 'verify.cancelled' },
  REPLACED: { icon: 'replace', tone: 'info', key: 'verify.replaced' },
  FRAUD_SUSPECTED: { icon: 'alert', tone: 'serious', key: 'verify.fraud' },
  REVERSED: { icon: 'ban', tone: 'critical', key: 'verify.reversed' },
  REFUNDED: { icon: 'ban', tone: 'critical', key: 'verify.refunded' },
  UNKNOWN: { icon: 'question', tone: 'neutral', key: 'verify.unknown' },
};

/**
 * Lit le contenu d'un QR : charge utile signée « MOSOLO1|CODE|SIGNATURE[|DUPLICATA-n] », URL …/verifier/CODE (?duplicata=n),
 * ?code=CODE, ou code nu. Le numéro de duplicata éventuel est contrôlé côté serveur.
 */
export function parseScan(raw: string): { code: string; duplicateNo?: number } {
  const s = raw.trim();
  if (s.startsWith('MOSOLO1|')) {
    const parts = s.split('|');
    const dup = /^DUPLICATA-(\d+)$/.exec(parts[3] ?? '');
    return { code: parts[1] ?? '', ...(dup ? { duplicateNo: Number(dup[1]) } : {}) };
  }
  try {
    const u = new URL(s);
    const d = u.searchParams.get('duplicata');
    const n = d !== null && /^\d+$/.test(d) ? Number(d) : undefined;
    return { code: extractCode(s), ...(n !== undefined ? { duplicateNo: n } : {}) };
  } catch {
    return { code: extractCode(s) };
  }
}

/** Extrait le code d'un contenu de QR (URL …/verifier/CODE, ?code=CODE, ou code nu). */
export function extractCode(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('MOSOLO1|')) return s.split('|')[1] ?? '';
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

export default function Verify() {
  const { tr, fmtDate, lang } = useApp();
  const params = useParams();
  const [search] = useSearchParams();
  const nav = useNavigate();
  const initial = params.code ?? search.get('code') ?? '';
  const initialDup = search.get('duplicata');
  const [code, setCode] = useState(initial);
  const [dupNo, setDupNo] = useState<number | undefined>(initialDup && /^\d+$/.test(initialDup) ? Number(initialDup) : undefined);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false);

  const check = useCallback(async (c: string, duplicateNo?: number) => {
    const parsed = parseScan(c);
    const clean = parsed.code;
    if (!clean) return;
    const dup = parsed.duplicateNo ?? duplicateNo;
    setBusy(true); setError(null); setResult(null);
    try {
      const qs = dup !== undefined ? `?duplicata=${dup}` : '';
      const r = await api<VerifyResult>(`/v1/public/receipts/${encodeURIComponent(clean)}${qs}`);
      setResult(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { if (initial) void check(initial, dupNo); }, [initial, check]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScan = useCallback((raw: string) => {
    const p = parseScan(raw);
    setScan(false); setCode(p.code); setDupNo(p.duplicateNo);
    nav(`/verifier/${encodeURIComponent(p.code)}${p.duplicateNo !== undefined ? `?duplicata=${p.duplicateNo}` : ''}`);
  }, [nav]);

  function submit(e: FormEvent) { e.preventDefault(); void check(code, dupNo); }

  const extra = result && (result.status === 'REVERSED' || result.status === 'REFUNDED') ? EXTRA_VIEW[result.status] : null;
  const base = result && !extra ? VIEW[result.status as PublicReceiptCheck] ?? VIEW.UNKNOWN : null;
  const view = extra ? { icon: extra.icon, tone: extra.tone } : base;
  const title = extra ? extra.title : base ? tr(base.key) : '';
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
              <input id="rc-code" value={code} onChange={(e) => { setCode(e.target.value); setDupNo(undefined); }} autoCapitalize="characters" autoComplete="off" spellCheck={false}
                placeholder="Q-2026-KIN-000000123-6" className="mono" />
              <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>{tr('verify.button')}</button>
            </div>
          </form>
          {scan ? <QrScanner onResult={onScan} onClose={() => setScan(false)} /> : (
            <button type="button" className="btn btn-secondary btn-block" onClick={() => setScan(true)}><Icon name="camera" size={18} /> {tr('verify.scan')}</button>
          )}

          <div aria-live="polite" className="verify-out">
            {busy && <p className="muted">{tr('common.loading')}</p>}
            {error !== null && <ErrorState error={error} onRetry={() => void check(code, dupNo)} />}
            {result && view && (
              <div className={`verdict verdict-${view.tone}`}>
                <div className="verdict-icon"><Icon name={view.icon} size={44} /></div>
                <p className="verdict-title">{title}</p>
                {result.duplicate && (
                  <p className="vr-dup"><Icon name="file" size={14} /> Duplicata n° {result.duplicate.duplicateNo} — {result.duplicate.issued ? 'délivré par le système, même numéro que l’original' : 'jamais délivré par le système'}</p>
                )}
                {result.status === 'REPLACED' && result.replacedBy && (
                  <p>{tr('verify.replacedBy', { n: result.replacedBy })}{' '}
                    <button type="button" className="btn-link" onClick={() => { setCode(result.replacedBy!); setDupNo(undefined); nav(`/verifier/${encodeURIComponent(result.replacedBy!)}`); }}>Vérifier la quittance en vigueur</button></p>
                )}
                {(result.status === 'CANCELLED' || result.status === 'REVERSED' || result.status === 'REFUNDED') && result.reason && <p>{result.reason}</p>}
                {result.statusSince && result.status !== 'VALID' && result.status !== 'PENDING' && <p className="small muted">Statut en vigueur depuis le {fmtDate(result.statusSince)}.</p>}
                {result.message && result.status === 'UNKNOWN' && result.message.includes('contrôle') && <p className="vr-note">{result.message}</p>}
                {result.replaces && <p className="small muted">Remplace la quittance n° {result.replaces}, désormais non valable.</p>}
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
                {/* Valeur juridique de la quittance électronique : points J7 et J17 (registre des points juridiques). */}
                {(result.status === 'VALID' || result.status === 'PENDING') && <AttenteBaseLegale fonction="QUITTANCE_ELECTRONIQUE" compact />}
              </div>
            )}
          </div>
          <p className="small muted verify-privacy"><Icon name="lock" size={14} /> {tr('verify.privacy')}</p>
        </div>
      </CoverSplit>
    </div>
  );
}
