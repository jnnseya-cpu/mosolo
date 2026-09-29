import type { ReactNode } from 'react';
import { useApp } from '../context';
import { ApiError, describeError } from '../lib/api';
import { Icon } from './Icon';
import { DemoRoleSwitch } from './DemoRoleSwitch';

export function EmptyState({ title, children, icon = 'file' }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="state state-empty">
      <Icon name={icon} size={28} />
      <p className="state-title">{title}</p>
      {children && <div className="state-body">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, children }: { error: unknown; onRetry?: () => void; children?: ReactNode }) {
  const { tr } = useApp();
  const d = describeError(error);
  // Refus d'accès (cloisonnement par rôle, entité ou territoire) : information neutre, pas une panne.
  const denied = error instanceof ApiError && error.status === 403;
  if (denied) {
    return (
      <div className="state state-empty" role="status">
        <Icon name="lock" size={28} />
        <p className="state-title">Accès réservé</p>
        <p className="state-body">Cet espace est réservé aux personnes habilitées de l’entité compétente (principe du moindre privilège). Chaque refus est journalisé.</p>
        {d.code && d.code !== 'FORBIDDEN' && <p className="state-body small muted">Motif : {d.code}</p>}
        <DemoRoleSwitch />
        {children}
      </div>
    );
  }
  return (
    <div className="state state-error" role="alert">
      <Icon name={d.network ? 'offline' : 'alert'} size={28} />
      <p className="state-title">{d.network ? tr('error.unreachable') : tr('common.error')}</p>
      <p className="state-body">{d.network ? tr('error.unreachableHint') : d.message}{d.code ? ` (${d.code})` : ''}</p>
      {children}
      {onRetry && <button type="button" className="btn btn-secondary" onClick={onRetry}><Icon name="refresh" size={18} /> {tr('common.retry')}</button>}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { tr } = useApp();
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? tr('common.loading')}</span>
    </div>
  );
}

export function ExampleNotice({ text }: { text?: string }) {
  const { tr } = useApp();
  return <p className="example-notice"><Icon name="info" size={16} /> <span>{text ?? tr('common.example')}</span></p>;
}
