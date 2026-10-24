/**
 * Pièce justificative par empreinte : le fichier reste sur l'appareil, seule son empreinte SHA-256 est transmise
 * (preuve d'intégrité sans transfert du document).
 */
import { useId, useState } from 'react';
import { sha256Hex } from '../lib/crypto';

export function EmpreinteFichier({ label, value, onChange }: { label: string; value: string; onChange: (sha256: string) => void }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  async function pick(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setBusy(true);
    try { onChange(await sha256Hex(await f.arrayBuffer())); } finally { setBusy(false); }
  }
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} type="file" onChange={(e) => void pick(e.target.files)} disabled={busy} />
      <span className="hint mono">{value ? `Empreinte : ${value.slice(0, 16)}…` : 'Le fichier reste sur l’appareil : seule son empreinte est transmise.'}</span>
    </div>
  );
}

/** Montants par devise (jamais additionnés entre devises). */
export function montants(t: Record<string, string> | { amount: string; currency: string }[] | string | null | undefined): string {
  if (!t) return '—';
  if (typeof t === 'string') return t === 'NON_MESURE' ? 'Non mesuré' : t;
  const list = Array.isArray(t) ? t.map((m) => `${m.amount} ${m.currency}`) : Object.entries(t).map(([c, v]) => `${v} ${c}`);
  return list.length ? list.join(' · ') : '—';
}
