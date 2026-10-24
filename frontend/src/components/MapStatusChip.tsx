import type { MapStatusColor } from '@mosolo/shared';
import { useApp } from '../context';
import { MAP_STATUS } from '../lib/status';
import { Icon } from './Icon';

export function MapStatusChip({ status }: { status?: MapStatusColor }) {
  const { tr } = useApp();
  const s = MAP_STATUS[status ?? 'grey'];
  return (
    <span className="map-chip">
      <span className="map-dot" style={{ background: s.color }} aria-hidden="true"><Icon name={s.icon} size={10} /></span>
      {tr(s.key)}
    </span>
  );
}
