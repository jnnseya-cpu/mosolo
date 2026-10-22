/**
 * KIN PUB CONTROL — « Autour de moi » de l'inspecteur, comme pour les biens : sur place, dans son secteur, avec une
 * position GPS précise, il voit les supports proches en VERT (autorisé, à jour), AMBRE (demande en cours, échéance
 * proche, barème non publié) ou ROUGE (affiché sans autorisation, autorisation expirée, droits impayés), ainsi que les
 * commerces enregistrés sans enseigne déclarée (à vérifier). La publicité MOBILE (véhicules) se contrôle par la plaque.
 * Droits impayés : paiement numérique assisté sur place — jamais d'espèces à l'agent.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapStatusColor } from '@mosolo/shared';
import { Icon } from '../../components/Icon';
import { PreciseLocation } from '../../components/PreciseLocation';
import { GeoMapLazy } from '../../components/GeoMapLazy';
import { AssistedPay } from '../../components/AssistedPay';
import { PlateScanner } from '../../components/PlateScanner';
import { api, describeError } from '../../lib/api';
import { circleRing, metersBetween, type PreciseFix } from '../../lib/geo';
import { MAP_STATUS } from '../../lib/status';
import { AD_TYPE, VEHICLE_KIND } from './types';
import '../fiscal/autour.css';

export interface AdItem {
  id: string; reference: string; type: string; placement: string; placementLabel: string; businessName: string | null; businessObjectId: string | null;
  vehiclePlate: string | null; vehicleKind: string | null; surfaceM2: string; faces: number; commune: string; quartier: string; address: string;
  lat: number; lon: number; distanceM: number | null; status: string; rights: string; expiringSoon: boolean; validUntil: string | null;
  openCase: { reference: string } | null; ownerIdentified: boolean; objectId: string | null; color: MapStatusColor; reason: string; payable: boolean;
}
interface Business { objectId: string; label: string; reference: string; commune: string; quartier: string; avenue: string | null; lat: number; lon: number; distanceM: number; reason: string }
interface Nearby { radiusM: number; commune: string; inArea: boolean; territory: string[] | null; counts: Record<MapStatusColor, number>; items: AdItem[]; businessesToCheck: Business[]; notice: string }
interface VehicleCheck { plate: string; items: AdItem[]; notice: string }

/** Pré-remplissage d'un constat « non déclaré » depuis le terrain (commerce à vérifier, véhicule). */
export interface ConstatPreset { placement: string; type: string; businessName?: string; businessObjectId?: string; vehiclePlate?: string; vehicleKind?: string; quartier?: string; address?: string; commune?: string }

const COLOR_NAME: Record<MapStatusColor, string> = { green: 'Vert', amber: 'Ambre', red: 'Rouge', grey: 'Gris', blue: 'Bleu' };
const ORDER: MapStatusColor[] = ['red', 'amber', 'green'];
const RADII = [100, 200, 300, 500, 1000];
const BUSINESS_COLOR = '#6d4bc2';

function DeviceRow({ i, fix, paying, setPaying, sel, onSel }: { i: AdItem; fix: PreciseFix | null; paying: string | null; setPaying: (id: string | null) => void; sel?: boolean; onSel?: () => void }) {
  return (
    <li id={`adp-${i.id}`} className={`adm-item${sel ? ' is-sel' : ''}`}>
      <button type="button" className="adm-item-btn" onClick={onSel}>
        <span className={`adm-badge adm-${i.color}`}><Icon name={MAP_STATUS[i.color].icon as never} size={14} /> {COLOR_NAME[i.color]}</span>
        <span className="adm-main">
          <strong>{AD_TYPE[i.type] ?? i.type}{i.businessName ? ` — ${i.businessName}` : ''}</strong>
          <span className="small">{i.placementLabel}{i.vehiclePlate ? ` · plaque ${i.vehiclePlate}${i.vehicleKind ? ` (${VEHICLE_KIND[i.vehicleKind] ?? i.vehicleKind})` : ''}` : ''} · {i.surfaceM2} m² × {i.faces}</span>
          <span className="small mono">{i.reference}{i.validUntil ? ` · autorisé jusqu’au ${i.validUntil}` : ''}{i.ownerIdentified ? '' : ' · exploitant non identifié'}</span>
          <span className="small muted">{i.reason}</span>
        </span>
        {i.distanceM !== null && <span className="adm-dist">{i.distanceM} m</span>}
      </button>
      {i.payable && i.objectId && paying !== i.id && <button type="button" className="btn btn-secondary btn-sm adm-pay" onClick={() => setPaying(i.id)}><Icon name="phone" size={14} /> Faire payer (numérique)</button>}
      {paying === i.id && i.objectId && <AssistedPay objectId={i.objectId} {...(fix ? { position: fix } : {})} onClose={() => setPaying(null)} />}
    </li>
  );
}

export function AdAround({ onConstat }: { onConstat: (p: ConstatPreset) => void }) {
  const [fix, setFix] = useState<PreciseFix | null>(null);
  const [radius, setRadius] = useState(300);
  const [data, setData] = useState<Nearby | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [only, setOnly] = useState<MapStatusColor | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const last = useRef<{ lat: number; lon: number; r: number } | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const usable = !!fix && fix.source === 'GPS' && fix.accuracy !== null && fix.accuracy <= 100;
  useEffect(() => () => inflight.current?.abort(), []);

  // Une requête par position ou rayon : la précédente est annulée, une réponse périmée est ignorée, et une erreur
  // oublie la dernière requête pour que la position suivante relance la recherche.
  useEffect(() => {
    if (!usable || !fix) return;
    const q = last.current;
    if (q && q.r === radius && metersBetween(q, fix) < 40) return;
    last.current = { lat: fix.lat, lon: fix.lon, r: radius };
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    api<Nearby>(`/v1/publicite/nearby?lat=${fix.lat.toFixed(6)}&lon=${fix.lon.toFixed(6)}&accuracyM=${Math.max(1, Math.round(fix.accuracy ?? 100))}&radiusM=${radius}`, { signal: ctl.signal })
      .then((d) => { if (inflight.current === ctl) { setData(d); setErr(null); } })
      .catch((e) => { if (inflight.current === ctl) { last.current = null; setErr(describeError(e).message); } })
      .finally(() => { if (inflight.current === ctl) inflight.current = null; });
  }, [fix?.lat, fix?.lon, fix?.accuracy, radius, usable]); // eslint-disable-line react-hooks/exhaustive-deps -- justifié : dépendances volontairement restreintes aux valeurs listées (sinon boucle de rendu ou rechargement à chaque rendu)
  useEffect(() => { if (sel) document.getElementById(`adp-${sel}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [sel]);

  const items = useMemo(() => (data?.items ?? []).filter((i) => !only || i.color === only), [data, only]);
  const ring = fix && data ? circleRing(fix.lon, fix.lat, data.radiusM, 16) : null;
  return (
    <div className="stack">
      <section className="panel">
        <PreciseLocation label="Ma position" targetM={15} compact showMap={false} onChange={setFix} />
        {fix && fix.source !== 'GPS' && <p className="small err">Position saisie à la main : la vue exige une position mesurée par le GPS.</p>}
        <div className="adm-radius" role="radiogroup" aria-label="Rayon de recherche">
          <span className="small muted">Rayon :</span>
          {RADII.map((r) => <button key={r} type="button" role="radio" aria-checked={radius === r} className={`chip${radius === r ? ' is-on' : ''}`} onClick={() => setRadius(r)}>{r < 1000 ? `${r} m` : '1 km'}</button>)}
        </div>
      </section>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {data && !data.inArea && <div className="callout callout-warn"><Icon name="alert" size={20} /><p className="small" style={{ margin: 0 }}><strong>Hors de votre secteur.</strong> {data.notice}{data.territory?.length ? ` Votre secteur : ${data.territory.join(', ')}.` : ''}</p></div>}
      {data && data.inArea && fix && (
        <>
          <div className="adm-counts" role="group" aria-label="Filtrer par couleur">
            {ORDER.map((c) => (
              <button key={c} type="button" aria-pressed={only === c} className={`adm-count adm-${c}${only === c ? ' is-on' : ''}`} onClick={() => setOnly(only === c ? null : c)}>
                <span className="adm-dot" style={{ background: MAP_STATUS[c].color }} aria-hidden="true"><Icon name={MAP_STATUS[c].icon as never} size={12} /></span>
                <strong>{data.counts[c]}</strong> <span>{COLOR_NAME[c]}</span>
              </button>
            ))}
            <span className="adm-count" style={{ cursor: 'default' }}><span className="adm-dot" style={{ background: BUSINESS_COLOR }} aria-hidden="true"><Icon name="store" size={12} /></span><strong>{data.businessesToCheck.length}</strong> <span>Commerces à vérifier</span></span>
            <span className="small muted adm-where"><Icon name="pin" size={14} /> {data.commune} · {data.items.length} support(s) à moins de {data.radiusM} m</span>
          </div>
          <GeoMapLazy center={[fix.lon, fix.lat]} height={320} ariaLabel="Carte des supports publicitaires autour de moi"
            {...(ring ? { bounds: [[Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1]))], [Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))]] as [[number, number], [number, number]] } : {})}
            polygons={fix && data ? [{ id: 'rayon', rings: [circleRing(fix.lon, fix.lat, data.radiusM)], color: '#232C6B', fillOpacity: 0.04 }] : []}
            accuracy={fix.accuracy ? { lon: fix.lon, lat: fix.lat, radiusM: fix.accuracy } : null}
            markers={[
              ...items.map((i) => ({ id: i.id, lon: i.lon, lat: i.lat, color: MAP_STATUS[i.color].color, label: sel === i.id ? i.reference : '' })),
              ...(!only ? data.businessesToCheck.map((b) => ({ id: `biz-${b.objectId}`, lon: b.lon, lat: b.lat, color: BUSINESS_COLOR, label: '' })) : []),
              { id: 'moi', lon: fix.lon, lat: fix.lat, color: '#1E9BD7', label: 'Moi' },
            ]}
            onSelect={(id) => { if (id !== 'moi' && id !== 'rayon') setSel(id); }}
            caption="Points colorés : supports publicitaires. Violet : commerce enregistré sans enseigne déclarée. © contributeurs OpenStreetMap." />
          <section className="panel">
            <header className="panel-head"><div><h2 className="panel-title"><Icon name="megaphone" size={18} /> Supports proches</h2><p className="panel-sub">Du plus proche au plus éloigné{only ? ` · filtre : ${COLOR_NAME[only]}` : ''}. Rouge : constatez (photos, position) ; droits impayés : faites payer par canal numérique.</p></div></header>
            {items.length === 0 ? <p className="muted">Aucun support {only ? `« ${COLOR_NAME[only].toLowerCase()} » ` : ''}dans ce rayon.</p> : (
              <ul className="adm-list">{items.map((i) => <DeviceRow key={i.id} i={i} fix={fix} paying={paying} setPaying={setPaying} sel={sel === i.id} onSel={() => setSel(i.id)} />)}</ul>
            )}
          </section>
          {data.businessesToCheck.length > 0 && (
            <section className="panel">
              <header className="panel-head"><div><h2 className="panel-title"><Icon name="store" size={18} /> Commerces à vérifier</h2><p className="panel-sub">Commerces enregistrés sans enseigne ni publicité déclarée. Enseigne en façade, sur la porte ou publicité devant le commerce : toutes sont assujetties. À vérifier, jamais présumé en infraction.</p></div></header>
              <ul className="adm-list">
                {data.businessesToCheck.map((b) => (
                  <li key={b.objectId} id={`adp-biz-${b.objectId}`} className={`adm-item${sel === `biz-${b.objectId}` ? ' is-sel' : ''}`}>
                    <div className="adm-item-btn" style={{ cursor: 'default' }}>
                      <span className="adm-badge" style={{ background: BUSINESS_COLOR }}><Icon name="store" size={14} /> À vérifier</span>
                      <span className="adm-main"><strong>{b.label}</strong><span className="small">{b.quartier}{b.avenue ? `, ${b.avenue}` : ''}</span><span className="small mono">{b.reference}</span><span className="small muted">{b.reason}</span></span>
                      <span className="adm-dist">{b.distanceM} m</span>
                    </div>
                    <div className="row-actions adm-pay">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onConstat({ placement: 'FACADE_COMMERCE', type: 'ENSEIGNE', businessName: b.label.replace(/^Établissement — /, ''), businessObjectId: b.objectId, commune: b.commune, quartier: b.quartier, address: b.avenue ?? b.quartier })}><Icon name="camera" size={14} /> Constater une enseigne</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onConstat({ placement: 'DEVANT_COMMERCE', type: 'CHEVALET', businessName: b.label.replace(/^Établissement — /, ''), businessObjectId: b.objectId, commune: b.commune, quartier: b.quartier, address: b.avenue ?? b.quartier })}>Publicité devant le commerce</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="callout callout-info"><Icon name="shieldCheck" size={18} /><p className="small" style={{ margin: 0 }}>{data.notice} Chaque consultation est journalisée.</p></div>
        </>
      )}
    </div>
  );
}

/** Publicité mobile : contrôle par la plaque (saisie ou lecture caméra), où que soit le véhicule. */
export function AdVehicle({ onConstat }: { onConstat: (p: ConstatPreset) => void }) {
  const [plate, setPlate] = useState('');
  const [scan, setScan] = useState(false);
  const [res, setRes] = useState<VehicleCheck | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const run = (p: string) => { setErr(null); api<VehicleCheck>(`/v1/publicite/vehicles/${encodeURIComponent(p.trim())}`).then(setRes).catch((e) => setErr(describeError(e).message)); };
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="bus" size={18} /> Publicité sur véhicule</h2><p className="panel-sub">Voitures, taxis, bus, camions, motos, tricycles, remorques : la publicité portée est assujettie. Contrôle par la plaque, où que soit le véhicule.</p></div></header>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (plate.trim()) run(plate); }}>
        <div className="input-row">
          <input className="mono" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="Plaque du véhicule (ex. KN-4521-BB)" aria-label="Plaque du véhicule" />
          <button type="button" className="btn btn-ghost" onClick={() => setScan(true)}><Icon name="camera" size={16} /> Lire</button>
          <button type="submit" className="btn btn-primary" disabled={!plate.trim()}>Vérifier</button>
        </div>
      </form>
      {scan && <PlateScanner onConfirm={(p) => { setScan(false); setPlate(p); run(p); }} onClose={() => setScan(false)} />}
      {err && <p className="notice notice-err small" role="alert">{err}</p>}
      {res && (
        <div className="stack-sm" style={{ marginTop: 10 }}>
          <p className="small">{res.notice}</p>
          {res.items.length > 0 ? <ul className="adm-list">{res.items.map((i) => <DeviceRow key={i.id} i={i} fix={null} paying={paying} setPaying={setPaying} />)}</ul> : (
            <button type="button" className="btn btn-secondary btn-sm btn-block" style={{ whiteSpace: 'normal' }} onClick={() => onConstat({ placement: 'VEHICULE', type: 'HABILLAGE_VEHICULE', vehiclePlate: res.plate, vehicleKind: 'TAXI' })}><Icon name="camera" size={14} /> Constater « non déclaré » (véhicule {res.plate})</button>
          )}
        </div>
      )}
    </section>
  );
}
