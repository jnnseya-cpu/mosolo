/** Alertes de sécurité et de fraude (§ 25) : journalisées, notifiées à l'anti-fraude et à la sécurité. */
import type { AuditActor, AuditLog } from '../../core/audit.js';
import type { UserDirectory } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { IdGenerator, InMemoryAppendOnlyRepository } from '../../core/repository.js';
import type { CommunicationService } from '../communications/service.js';
import { userRecipient } from '../identity/recipients.js';

export type AlertSeverity = 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SecurityAlert {
  id: string;
  at: string;
  type: string;
  severity: AlertSeverity;
  source: string;
  detail: string;
  context: Record<string, unknown>;
}

export class AlertService {
  readonly alerts = new InMemoryAppendOnlyRepository<SecurityAlert>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly users: UserDirectory,
  ) {}

  raise(input: { type: string; severity: AlertSeverity; source: string; detail: string; context?: Record<string, unknown>; actor?: AuditActor }): SecurityAlert {
    const alert = this.alerts.append({
      id: this.ids.next('ALR'),
      at: this.clock.now().toISOString(),
      type: input.type,
      severity: input.severity,
      source: input.source,
      detail: input.detail,
      context: input.context ?? {},
    });
    this.audit.append({
      actor: input.actor ?? { kind: 'system', id: 'mosolo' },
      action: 'security.alert.raised',
      resourceType: 'alert',
      resourceId: alert.id,
      outcome: 'DENIED',
      details: { type: alert.type, severity: alert.severity, source: alert.source, detail: alert.detail },
    });
    const recipients = [...this.users.withRole('R24'), ...this.users.withRole('R28')].map(userRecipient);
    this.comms.publish('fraud.alert.raised', recipients, { reference: alert.id }, { entity: 'AUDIT' });
    return alert;
  }

  list(): SecurityAlert[] {
    return this.alerts.all().reverse();
  }
}
