import type { AutosaveState } from '../hooks/useAutosave';
import { useApp } from '../context';
import { Icon } from './Icon';

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Indicateur d'enregistrement automatique (§ 23.5.3), annoncé aux lecteurs d'écran. */
export function AutosaveStatus({ state, onHistory }: { state: AutosaveState; onHistory?: () => void }) {
  const { tr } = useApp();
  let icon = 'file'; let text = tr('autosave.idle');
  switch (state.kind) {
    case 'saving': icon = 'refresh'; text = tr('autosave.saving'); break;
    case 'saved': icon = 'check'; text = tr('autosave.saved', { time: hhmm(state.at) }); break;
    case 'offline': icon = 'download'; text = tr('autosave.offline'); break;
    case 'error': icon = 'alert'; text = tr('autosave.error'); break;
  }
  return (
    <div className={`autosave autosave-${state.kind}`}>
      <span role="status" aria-live="polite" aria-atomic="true" className="autosave-text" data-state={state.kind}>
        <Icon name={icon} size={16} /> <span>{text}</span>
      </span>
      {onHistory && (
        <button type="button" className="btn-link" onClick={onHistory}>
          <Icon name="history" size={16} /> {tr('autosave.history')}
        </button>
      )}
    </div>
  );
}
