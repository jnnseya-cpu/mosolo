/**
 * Téléchargement de la quittance électronique en PDF signé (§ 18A.4 : « Quittance électronique (PDF) — contenu complet
 * du § 19, signature électronique »). La page de vérification et l'impression restent disponibles.
 */
import { useState } from 'react';
import { apiBlob, describeError } from '../lib/api';
import { Icon } from './Icon';

export function ReceiptPdfButton({ receipt, label = 'PDF signé' }: { receipt: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function download() {
    setBusy(true); setErr(null);
    try {
      const blob = await apiBlob(`/v1/tresor/receipts/${encodeURIComponent(receipt)}/pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quittance-${receipt}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setErr(describeError(e).message);
    } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void download()} disabled={busy} aria-label={`Télécharger la quittance ${receipt} en PDF signé`}>
        <Icon name="download" size={16} /> {busy ? 'Préparation…' : label}
      </button>
      {err && <span role="alert" className="small notice-err">{err}</span>}
    </>
  );
}
