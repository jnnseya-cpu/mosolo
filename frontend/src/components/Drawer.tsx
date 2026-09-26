import { useEffect, useRef, type ReactNode } from 'react';
import { useApp } from '../context';
import { Icon } from './Icon';

/** Panneau latéral (plein écran sur mobile) avec piège de focus simple et fermeture Échap. */
export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const { tr } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('no-scroll'); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost icon-btn" onClick={onClose} aria-label={tr('common.close')}><Icon name="close" /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
