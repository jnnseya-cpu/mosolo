/**
 * « Autour de moi » — agents des modules liés aux biens et aux activités physiques (propriété, locatif, entreprises,
 * marchés, chantiers, sites, publicité). Une fois sur place, dans son secteur, avec une position GPS précise, l'agent
 * voit les biens et commerces proches : VERT (à jour), AMBRE (paiement partiel, échéance proche, revue), ROUGE (en
 * retard) — plus gris (non encore liquidé) et bleu (en litige). Aucun montant, aucun nom : la couleur oriente la
 * visite, elle ne vaut ni constat ni sanction. La liste se met à jour quand l'agent se déplace.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapStatusColor } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { ErrorState, ExampleNotice } from '../../components/States';
import { PreciseLocation } from '../../components/PreciseLocation';
import { GeoMapLazy } from '../../components/GeoMapLazy';
import { api, describeError } from '../../lib/api';
import { circleRing, metersBetween, type PreciseFix } from '../../lib/geo';
import { MAP_STATUS } from '../../lib/status';
import './autour.css';

interface Item {
  id: string; reference: string; label: string; categoryLabel: string; vertical: string | null; commune: string; quartier: string; avenue: string | null;
  lat: number; lon: number; distanceM: number; color: MapStatusColor; colorLabel: string; reason: string; plate: string | null; validated: boolean; demo: boolean;
}
interface Nearby {
  at: string; radiusM: number; maxRadiusM: number; commune: string; inArea: boolean; territory: string[] | null;
  counts: Record<MapStatusColor, number>; items: Item[]; legend: { color: MapStatusColor; label: string }[]; notice: string;
}

const ringBounds = (ring: [number, number][]): [[number, number], [number, number]] =>
  [[Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1]))], [Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))]];
const COLOR_NAME: Record<MapStatusColor, string> = { green: 'Vert', amber: 'Ambre', red: 'Rouge', grey: 'Gris', blue: 'Bleu' };
const ORDER: MapStatusColor[] = ['red', 'amber', 'green', 'grey', 'blue'];
const RADII = [100, 200, 300, 500, 1000];
/** L'agent doit être localisé par le GPS, à 100 m près au plus (même limite que le serveur). */
const MAX_ACC = 100;
/** Déplacement qui déclenche une mise à jour de la liste. */
const MOVE_REFRESH_M = 40;

export default function AutourDeMoi() {
  const [fix, setFix] = useState<PreciseFix | null>(null);
  const [radius, setRadius] = useState(300);
  const [data, setData] = useState<Nearby | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [only, setOnly] = useState<MapStatusColor | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const lastQuery = useRef<{ lat: number; lon: number; radius: number } | null>(null);

  const usable = !!fix && fix.source === 'GPS' && fix.accuracy !== null && fix.accuracy <= MAX_ACC;

  async function load(f: PreciseFix, r: number) {
    setBusy(true); setErr(null);
    try {
      const d = await api<Nearby>(`/v1/fiscal/nearby?lat=${f.lat.toFixed(6)}&lon=${f.lon.toFixed(6)}&accuracyM=${Math.max(1, Math.round(f.accuracy ?? MAX_ACC))}&radiusM=${r}`);
      setData(d); lastQuery.current = { lat: f.lat, lon: f.lon, radius: r };
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!usable || !fix) return;
    const q = lastQuery.current;
    if (!q || q.radius !== radius || metersBetween(q, fix) >= MOVE_REFRESH_M) void load(fix, radius);
  }, [fix?.lat, fix?.lon, fix?.accuracy, radius, usable]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => (data?.items ?? []).filter((i) => !only || i.color === only), [data, only]);
  useEffect(() => { if (sel) document.getElementById(`adm-${sel}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [sel]);

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Agents des biens et des activités · sur place" title="Autour de moi"
        lead="Sur place, dans votre secteur, voyez les biens et commerces proches : vert à jour, ambre à surveiller, rouge en retard. Aucun montant : la couleur oriente la visite, elle ne vaut ni constat ni sanction.">
        {usable && fix && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(fix, radius)} disabled={busy}><Icon name="refresh" size={16} /> Actualiser</button>}
      </PageHead>
      <ExampleNotice />

      <section className="panel">
        <PreciseLocation label="Ma position" targetM={15} compact showMap={false} onChange={setFix} />
        {fix && fix.source !== 'GPS' && <p className="notice notice-err small" style={{ marginTop: 8 }}>Position saisie à la main : la vue « Autour de moi » exige une position mesurée par le GPS de l’appareil.</p>}
        {fix && fix.source === 'GPS' && !usable && <p className="small" style={{ color: 'var(--warning-ink)', marginTop: 8 }}><Icon name="alert" size={14} /> Précision insuffisante (± {fix.accuracy} m) : {MAX_ACC} m au plus. Placez-vous à découvert et patientez.</p>}
        <div className="adm-radius" role="radiogroup" aria-label="Rayon de recherche">
          <span className="small muted">Rayon :</span>
          {RADII.map((r) => <button key={r} type="button" role="radio" aria-checked={radius === r} className={`chip${radius === r ? ' is-on' : ''}`} onClick={() => setRadius(r)}>{r < 1000 ? `${r} m` : '1 km'}</button>)}
        </div>
      </section>

      {!!err && <ErrorState error={err} onRetry={() => fix && void load(fix, radius)} />}
      {!fix && !err && <p className="muted">Recherche de votre position GPS… La liste apparaît dès que la position est assez précise.</p>}

      {data && !data.inArea && (
        <div className="callout callout-warn"><Icon name="alert" size={20} /><div><strong>Hors de votre secteur</strong><p className="small" style={{ margin: 0 }}>{data.notice}{data.territory?.length ? ` Votre secteur : ${data.territory.join(', ')}.` : ''}</p></div></div>
      )}

      {data && data.inArea && (
        <>
          <div className="adm-counts" role="group" aria-label="Filtrer par couleur">
            {ORDER.filter((c) => c !== 'blue' || data.counts.blue > 0).map((c) => (
              <button key={c} type="button" aria-pressed={only === c} className={`adm-count adm-${c}${only === c ? ' is-on' : ''}`} onClick={() => setOnly(only === c ? null : c)}>
                <span className="adm-dot" style={{ background: MAP_STATUS[c].color }} aria-hidden="true"><Icon name={MAP_STATUS[c].icon as never} size={12} /></span>
                <strong>{data.counts[c]}</strong> <span>{COLOR_NAME[c]}</span>
              </button>
            ))}
            <span className="small muted adm-where"><Icon name="pin" size={14} /> {data.commune} · {data.items.length} bien(s) à moins de {data.radiusM} m{busy ? ' · mise à jour…' : ''}</span>
          </div>

          {fix && (
            <GeoMapLazy center={[fix.lon, fix.lat]} height={340} ariaLabel="Carte des biens autour de moi"
              bounds={ringBounds(circleRing(fix.lon, fix.lat, data.radiusM, 16))}
              polygons={[{ id: 'rayon', rings: [circleRing(fix.lon, fix.lat, data.radiusM)], color: '#232C6B', fillOpacity: 0.04 }]}
              accuracy={fix.accuracy ? { lon: fix.lon, lat: fix.lat, radiusM: fix.accuracy } : null}
              markers={[
                ...items.map((i) => ({ id: i.id, lon: i.lon, lat: i.lat, color: MAP_STATUS[i.color].color, label: sel === i.id ? i.reference : '' })),
                { id: 'moi', lon: fix.lon, lat: fix.lat, color: '#1E9BD7', label: 'Moi' },
              ]}
              onSelect={(id) => { if (id !== 'moi' && id !== 'rayon') setSel(id); }}
              caption="Touchez un point pour le retrouver dans la liste. © contributeurs OpenStreetMap." />
          )}

          <section className="panel">
            <header className="panel-head"><div><h2 className="panel-title"><Icon name="building" size={18} /> Biens et commerces proches</h2><p className="panel-sub">Du plus proche au plus éloigné{only ? ` · filtre : ${COLOR_NAME[only]}` : ''}.</p></div></header>
            {items.length === 0 ? <p className="muted">Aucun bien {only ? `« ${COLOR_NAME[only].toLowerCase()} » ` : ''}dans ce rayon. Élargissez le rayon ou déplacez-vous.</p> : (
              <ul className="adm-list">
                {items.map((i) => (
                  <li key={i.id} id={`adm-${i.id}`} className={`adm-item${sel === i.id ? ' is-sel' : ''}`}>
                    <button type="button" className="adm-item-btn" onClick={() => setSel(i.id)} aria-label={`${i.label}, ${COLOR_NAME[i.color]}, à ${i.distanceM} mètres`}>
                      <span className={`adm-badge adm-${i.color}`}><Icon name={MAP_STATUS[i.color].icon as never} size={14} /> {COLOR_NAME[i.color]}</span>
                      <span className="adm-main">
                        <strong>{i.label}</strong>
                        <span className="small">{i.categoryLabel}{i.vertical ? ` · ${i.vertical}` : ''} · {i.quartier}{i.avenue ? `, ${i.avenue}` : ''}</span>
                        <span className="small mono">{i.reference}{i.plate ? ` · plaque ${i.plate}` : ''}{i.validated ? '' : ' · non validé'}</span>
                        <span className="small muted">{i.reason}</span>
                      </span>
                      <span className="adm-dist">{i.distanceM < 1000 ? `${i.distanceM} m` : `${(i.distanceM / 1000).toFixed(1)} km`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="callout callout-info"><Icon name="shieldCheck" size={18} /><p className="small" style={{ margin: 0 }}>{data.notice} Chaque consultation est journalisée (position, rayon, nombre de biens montrés).</p></div>
        </>
      )}
    </div>
  );
}
