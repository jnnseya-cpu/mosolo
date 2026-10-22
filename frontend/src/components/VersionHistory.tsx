import { useEffect, useState } from 'react';
import type { AutosaveApi } from '../hooks/useAutosave';
import { useApp } from '../context';
import { Drawer } from './Drawer';
import { AutosaveStatus } from './AutosaveStatus';

/** Statut d'enregistrement + tiroir d'historique des versions du brouillon. */
export function AutosaveBar<T extends object>({ draft }: { draft: AutosaveApi<T> }) {
  const { tr, fmtDate } = useApp();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { loadVersions } = draft;
  useEffect(() => { if (open) loadVersions(); }, [open, loadVersions]);
  return (
    <>
      <div className="autosave-bar">
        <AutosaveStatus state={draft.status} onHistory={() => setOpen(true)} />
        {draft.restoredFrom && <span className="muted small">{tr(draft.restoredFrom === 'local' ? 'autosave.restoredLocal' : 'autosave.restoredServer')}</span>}
      </div>
      <p className="muted small">{tr('autosave.notAnAct')}</p>
      <Drawer open={open} title={tr('autosave.history')} onClose={() => setOpen(false)}>
        {draft.versionsLoading && <p>{tr('common.loading')}</p>}
        {draft.versionsError && <p className="muted">{tr('autosave.historyUnavailable')}</p>}
        {!draft.versionsLoading && !draft.versionsError && draft.versions.length === 0 && <p className="muted">{tr('autosave.noVersions')}</p>}
        {msg && <p role="status" className="notice">{msg}</p>}
        <ol className="timeline">
          {draft.versions.map((v) => (
            <li key={v.version}>
              <div className="timeline-dot" aria-hidden="true" />
              <div>
                <strong>{tr('autosave.version', { n: v.version })}</strong> · <span className="muted">{fmtDate(v.savedAt, true)}</span>
                {v.changeSummary && <p className="small">{v.changeSummary}</p>}
                {v.data !== undefined && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => { draft.restoreVersion(v); setMsg(tr('autosave.restored', { n: v.version })); }}>
                    {tr('autosave.restore')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Drawer>
    </>
  );
}
