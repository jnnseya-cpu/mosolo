/**
 * Vérification publique — plaque QR d'un support publicitaire et badge d'un contrôleur (sans connexion).
 * Situation minimale : aucune donnée nominative de l'exploitant.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { ValidityCountdown, ValidityLegend } from '../../components/ValidityCountdown';
import { api } from '../../lib/api';
import { ErrorLine, useAction } from '../parking/shared';
import { AD_TYPE, DEVICE_STATUS, type DeviceStatus } from './types';
import '../parking/parking.css';

interface PublicDevice { reference: string; type: string; commune: string; surfaceM2: string; faces: number; status: DeviceStatus; authorized: boolean; validFrom?: string | null; validUntil: string | null; notice: string }
interface PublicBadge { badge: string; name: string | null; accredited: boolean; validFrom?: string | null; validUntil: string | null; communes: string[]; status: string }

export default function AdVerify() {
  const [params] = useSearchParams();
  const [plate, setPlate] = useState(params.get('plaque') ?? '');
  const [badgeId, setBadgeId] = useState(params.get('badge') ?? '');
  const [dev, setDev] = useState<PublicDevice | null>(null);
  const [badge, setBadge] = useState<PublicBadge | null>(null);
  const a1 = useAction();
  const a2 = useAction();
  const checkPlate = (v: string) => void a1.run(() => api<PublicDevice>(`/v1/publicite/public/devices/${encodeURIComponent(v.trim())}`), setDev);
  useEffect(() => { if (params.get('plaque')) checkPlate(params.get('plaque')!); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page">
      <PageHead eyebrow="KIN PUB CONTROL · vérification publique" title="Vérifier un support ou un contrôleur"
        lead="Scannez la plaque QR d’un panneau ou saisissez le code du badge d’un contrôleur. Un support sans plaque valide est présumé non enregistré ; un contrôleur ne perçoit jamais d’argent." />
      <div className="pk-grid pk-grid-even">
        <section className="panel">
          <header className="panel-head"><h2 className="panel-title"><Icon name="qr" size={18} /> Plaque d’un support</h2></header>
          <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); checkPlate(plate); }}>
            <label className="field"><span className="label">Code de la plaque</span><div className="input-row"><input value={plate} onChange={(e) => setPlate(e.target.value)} required /><button type="submit" className="btn btn-primary" disabled={a1.busy}>Vérifier</button></div></label>
          </form>
          <ErrorLine error={a1.error} />
          {dev && (
            <div className={`pk-light pk-light-${dev.authorized ? 'VERT' : 'ROUGE'}`} role="status" style={{ marginTop: 12 }}>
              <div className="pk-light-icon"><Icon name={dev.authorized ? 'check' : 'x'} size={40} /></div>
              <p className="pk-light-title">{DEVICE_STATUS[dev.status].label}</p>
              <p className="small">{dev.reference} · {AD_TYPE[dev.type] ?? dev.type} · {dev.surfaceM2.replace('.', ',')} m² × {dev.faces} · {dev.commune}</p>
              {dev.validUntil && <p className="small">Autorisation valable jusqu’au {dev.validUntil}</p>}
              {dev.validUntil && <ValidityCountdown from={dev.validFrom} until={dev.validUntil} blocked={dev.status === 'RETIRE' ? DEVICE_STATUS.RETIRE.label : null} label="Autorisation" />}
              <p className="small muted">{dev.notice}</p>
            </div>
          )}
          {dev && <ValidityLegend />}
        </section>
        <section className="panel">
          <header className="panel-head"><h2 className="panel-title"><Icon name="shieldCheck" size={18} /> Badge d’un contrôleur</h2></header>
          <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); void a2.run(() => api<PublicBadge>(`/v1/publicite/public/badges/${encodeURIComponent(badgeId.trim())}`), setBadge); }}>
            <label className="field"><span className="label">Code du badge</span><div className="input-row"><input value={badgeId} onChange={(e) => setBadgeId(e.target.value)} placeholder="ex. pb-inspecteur" required /><button type="submit" className="btn btn-primary" disabled={a2.busy}>Vérifier</button></div></label>
          </form>
          <ErrorLine error={a2.error} />
          {badge && (
            <div className={`pk-light pk-light-${badge.accredited ? 'VERT' : 'ROUGE'}`} role="status" style={{ marginTop: 12 }}>
              <div className="pk-light-icon"><Icon name={badge.accredited ? 'check' : 'x'} size={40} /></div>
              <p className="pk-light-title">{badge.accredited ? 'Contrôleur accrédité' : 'Aucune accréditation valide'}</p>
              {badge.name && <p className="small">{badge.name}</p>}
              {badge.accredited && <p className="small">Périmètre : {badge.communes.join(', ')} · jusqu’au {badge.validUntil}</p>}
              {badge.validUntil && <ValidityCountdown from={badge.validFrom} until={badge.validUntil} blocked={badge.status === 'REVOQUEE' ? 'Accréditation révoquée' : null} label="Accréditation" />}
              {!badge.accredited && <p className="small">Ne remettez aucun document ni aucune somme ; signalez la situation à la régie.</p>}
            </div>
          )}
          {badge && <ValidityLegend />}
        </section>
      </div>
    </div>
  );
}
