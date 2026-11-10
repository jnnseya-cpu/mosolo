/** Alertes de sécurité et de fraude (§ 25) : journalisées, notifiées à l'anti-fraude et à la sécurité. */
import type { RoleCode } from '@mosolo/shared';
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

  /**
   * Lève une alerte (examen humain, aucun effet automatique). `notifyRoles` ajoute des destinataires (ex. R22
   * auditeur interne) à l'anti-fraude (R24) et à la sécurité (R28), toujours notifiées.
   */
  raise(input: { type: string; severity: AlertSeverity; source: string; detail: string; context?: Record<string, unknown>; actor?: AuditActor; notifyRoles?: RoleCode[] }): SecurityAlert {
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
    const roles = [...new Set<RoleCode>(['R24', 'R28', ...(input.notifyRoles ?? [])])];
    const seen = new Set<string>();
    const recipients = roles.flatMap((r) => this.users.withRole(r)).filter((u) => !seen.has(u.id) && seen.add(u.id)).map(userRecipient);
    this.comms.publish('fraud.alert.raised', recipients, { reference: alert.id, score: alert.severity.toLowerCase() }, { entity: 'AUDIT' });
    return alert;
  }

  /**
   * Lève l'alerte seulement si aucune alerte portant la même empreinte (`context.fingerprint`) n'existe déjà :
   * une détection rejouée ne multiplie pas les signaux.
   */
  raiseOnce(fingerprint: string, input: Parameters<AlertService['raise']>[0]): SecurityAlert | null {
    if (this.alerts.all().some((a) => a.context.fingerprint === fingerprint)) return null;
    return this.raise({ ...input, context: { ...(input.context ?? {}), fingerprint } });
  }

  list(): SecurityAlert[] {
    return this.alerts.all().reverse();
  }
}
