import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** QR de vérification (image générée localement, aucun service externe). */
export function QrCode({ value, size = 112, alt }: { value: string; size?: number; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width: size * 2, color: { dark: '#111111', light: '#FFFFFF' } })
      .then((u) => { if (alive) setSrc(u); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [value, size]);
  if (!src) return <div className="qr-box" style={{ width: size, height: size }} aria-hidden="true" />;
  return <img className="qr-box" src={src} width={size} height={size} alt={alt} />;
}
