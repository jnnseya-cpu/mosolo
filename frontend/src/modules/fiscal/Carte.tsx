/**
 * Carte à deux couches (§ 16.6) : « situation fiscale » et « vérification / couverture du recensement ».
 * Carte schématique des 24 communes (tuiles) + semis de points des objets visibles pour la commune choisie.
 * Grand public : agrégats seulement, masqués sous 20 objets ; contribuable : ses biens ; agent : son périmètre.
 */
import { useMemo, useState } from 'react';
import type { MapStatusColor } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { MAP_STATUS } from '../../lib/status';
import { ColorChip, DemoNote, FiscalTabs } from './common';
import type { MapResponse } from './types';
import { CouchesCadastre } from './Couches';
import './fiscal.css';
import { CarteVisuels } from './visuels';
import { LienEcran } from '../../components/LienEcran';

/** Disposition schématique (non géographique) des communes : [ligne, colonne]. */
const TILE_POS: Record<string, [number, number]> = {
  Ngaliema: [0, 0], Kintambo: [0, 1], Gombe: [0, 2], Barumbu: [0, 3], Limete: [0, 4], Nsele: [0, 5],
  Bandalungwa: [1, 1], Lingwala: [1, 2], Kinshasa: [1, 3], Matete: [1, 4], Masina: [1, 5],
  Selembao: [2, 0], Makala: [2, 1], 'Kasa-Vubu': [2, 2], Kalamu: [2, 3], Lemba: [2, 4], Ndjili: [2, 5],
  'Mont-Ngafula': [3, 0], Bumbu: [3, 1], 'Ngiri-Ngiri': [3, 2], Ngaba: [3, 3], Kisenso: [3, 4], Kimbanseke: [3, 5],
  Maluku: [4, 5],
};
const ORDER: MapStatusColor[] = ['green', 'amber', 'red', 'blue', 'grey'];

function Scatter({ objects, onPick, picked }: { objects: MapResponse['objects']; onPick: (id: string) => void; picked: string | null }) {
  const box = useMemo(() => {
    const lats = objects.map((o) => o.lat); const lons = objects.map((o) => o.lon);
    const pad = 0.002;
    return { minLat: Math.min(...lats) - pad, maxLat: Math.max(...lats) + pad, minLon: Math.min(...lons) - pad, maxLon: Math.max(...lons) + pad };
  }, [objects]);
  const W = 640; const H = 360;
  const x = (lon: number) => ((lon - box.minLon) / (box.maxLon - box.minLon || 1)) * (W - 32) + 16;
  const y = (lat: number) => ((box.maxLat - lat) / (box.maxLat - box.minLat || 1)) * (H - 32) + 16;
  return (
    <svg className="fs-scatter" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Semis de ${objects.length} objets`}>
      <rect x="0" y="0" width={W} height={H} className="fs-scatter-bg" />
      {[1, 2, 3].map((i) => <line key={`h${i}`} x1="0" x2={W} y1={(H / 4) * i} y2={(H / 4) * i} className="fs-scatter-grid" />)}
      {[1, 2, 3, 4, 5].map((i) => <line key={`v${i}`} y1="0" y2={H} x1={(W / 6) * i} x2={(W / 6) * i} className="fs-scatter-grid" />)}
      {objects.map((o) => (
        <g key={o.id} className="fs-pt" onClick={() => onPick(o.id)} tabIndex={0} role="button" aria-label={`${o.categoryLabel} ${o.igf ?? o.id} — ${o.label}`}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPick(o.id); }}>
          <circle cx={x(o.lon)} cy={y(o.lat)} r={picked === o.id ? 9 : 6} fill={MAP_STATUS[o.color].color} stroke="var(--surface)" strokeWidth={2} />
          <title>{`${o.igf ?? o.id} — ${o.label}`}</title>
        </g>
      ))}
    </svg>
  );
}

export default function Carte() {
  const { user } = useApp();
  const [layer, setLayer] = useState<'situation' | 'couverture'>('situation');
  const [commune, setCommune] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const q = useApi(() => api<MapResponse>(`/v1/fiscal/map?layer=${layer}`), [layer, user?.id]);
  const d = q.data;
  const selected = commune ?? (d?.objects[0]?.commune ?? null);
  const objs = (d?.objects ?? []).filter((o) => o.commune === selected);
  const tile = d?.communes.find((c) => c.commune === selected);
  const pickedObj = objs.find((o) => o.id === picked);

  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Cadastre fiscal" title="Carte à deux couches"
        lead="Couche « situation fiscale » ou couche « vérification / couverture du recensement ». Les couleurs sont calculées par le serveur ; une couleur ne déclenche jamais de mesure automatique.">
        <LienEcran masquer to="/autour-de-moi" className="btn btn-secondary btn-sm"><Icon name="gps" size={16} /> Autour de moi</LienEcran>
      </PageHead>
      <FiscalTabs />
      <DemoNote>Données de démonstration fictives (recensement simulé). Disposition des communes schématique, non géographique.</DemoNote>
      <div className="fs-map-tools">
        <div className="seg" role="group" aria-label="Couche">
          <button type="button" aria-pressed={layer === 'situation'} onClick={() => setLayer('situation')}><Icon name="chart" size={16} /> Situation fiscale</button>
          <button type="button" aria-pressed={layer === 'couverture'} onClick={() => setLayer('couverture')}><Icon name="check" size={16} /> Couverture du recensement</button>
        </div>
        {d && <span className="tag">{d.scope === 'PUBLIC' ? 'Vue publique (agrégats)' : d.scope === 'CONTRIBUABLE' ? 'Mes biens' : 'Mon périmètre'}</span>}
      </div>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {d && <CarteVisuels d={d} />}
      {d && (
        <div className="fs-map-layout">
          <section className="panel">
            <div className="panel-head"><div><p className="panel-title">Communes</p><p className="panel-sub">{d.notice}</p></div></div>
            <div className="fs-tiles" role="group" aria-label="Communes (disposition schématique)">
              {d.communes.map((c) => {
                const pos = TILE_POS[c.commune] ?? [5, 0];
                const color = MAP_STATUS[c.dominant].color;
                return (
                  <button key={c.commune} type="button" className={`fs-tile${c.masked ? ' masked' : ''}${selected === c.commune ? ' sel' : ''}${c.total ? '' : ' empty'}`}
                    style={{ gridRow: pos[0] + 1, gridColumn: pos[1] + 1, ...(c.total && !c.masked ? { background: `color-mix(in srgb, ${color} 22%, var(--surface))`, borderColor: color } : {}) }}
                    onClick={() => { setCommune(c.commune); setPicked(null); }}
                    aria-pressed={selected === c.commune}
                    aria-label={`${c.commune} : ${c.masked ? `moins de ${d.threshold} objets, masqué` : `${c.total ?? 0} objet(s)`}`}>
                    <span className="fs-tile-code">{c.code}</span>
                    <span className="fs-tile-n">{c.masked ? `<${d.threshold}` : c.total ?? 0}</span>
                  </button>
                );
              })}
            </div>
            <ul className="fs-legend" aria-label="Légende">
              {d.legend.map((l) => (
                <li key={l.color}><span className="map-dot" style={{ background: MAP_STATUS[l.color].color }} aria-hidden="true"><Icon name={MAP_STATUS[l.color].icon} size={10} /></span>{l.label}</li>
              ))}
              <li><span className="fs-hatch" aria-hidden="true" />Masqué : moins de {d.threshold} objets (aucune maille identifiante)</li>
            </ul>
          </section>

          <section className="panel">
            <div className="panel-head"><div><p className="panel-title">{selected ?? 'Choisissez une commune'}</p><p className="panel-sub">{tile && !tile.masked && tile.total ? `${tile.total} objet(s) recensé(s)` : tile?.masked ? 'Agrégat masqué' : ''}</p></div></div>
            {tile?.byColor && tile.total ? (
              <div className="fs-bar" role="img" aria-label={ORDER.map((k) => `${k} ${tile.byColor![k]}`).join(', ')}>
                {ORDER.filter((k) => tile.byColor![k] > 0).map((k) => <span key={k} style={{ width: `${(tile.byColor![k] / tile.total!) * 100}%`, background: MAP_STATUS[k].color }} title={`${tile.byColor![k]}`} />)}
              </div>
            ) : null}
            {objs.length > 0 ? (
              <>
                <Scatter objects={objs} onPick={setPicked} picked={picked} />
                {pickedObj && (
                  <div className="line-box fs-picked">
                    <p className="row-title">{pickedObj.categoryLabel} <span className="mono">{pickedObj.igf ?? pickedObj.id}</span></p>
                    <p className="small muted">{pickedObj.commune} › {pickedObj.quartier}</p>
                    <ColorChip result={{ color: pickedObj.color, label: pickedObj.label, reason: pickedObj.reason }} />
                    <p className="small">{pickedObj.reason}</p>
                  </div>
                )}
                <ul className="list-rows compact-rows fs-obj-list">
                  {objs.slice(0, 40).map((o) => (
                    <li key={o.id} className="list-row">
                      <button type="button" className="btn-link mono" onClick={() => setPicked(o.id)}>{o.igf ?? o.id}</button>
                      <ColorChip result={{ color: o.color, label: o.label, reason: o.reason }} compact />
                    </li>
                  ))}
                </ul>
              </>
            ) : <EmptyState title={d.scope === 'PUBLIC' ? 'Vue publique : aucune situation individuelle n’est affichée.' : 'Aucun objet visible dans cette commune pour votre profil.'} icon="pin" />}
          </section>
        </div>
      )}
      {user && !user.roles.some((r) => r === 'R30' || r === 'R31') && <CouchesCadastre />}
    </div>
  );
}
