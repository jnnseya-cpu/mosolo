/**
 * Pénalités impayées depuis plus de 30 jours, rendues visibles à tout agent contrôleur après un contrôle,
 * quel que soit le module d'origine, AVEC le montant fixé par la décision (décision du maître d'ouvrage) :
 * le montant ne se négocie pas ; l'agent invite l'usager à payer par les canaux officiels, il n'encaisse rien.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { Icon } from './Icon';
import { MoneyText } from './MoneyText';

export interface OverduePenaltyLine {
  module: string; moduleLabel: string; reference: string; nature: string; decidedAt: string; overdueDays: number; amount?: MoneyJSON | null;
}
export interface OverduePenaltiesData {
  count: number; thresholdDays: number; guidance: string; lines: OverduePenaltyLine[];
}

function kinshasaDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('fr-FR', { timeZone: 'Africa/Kinshasa', day: '2-digit', month: 'long', year: 'numeric' });
}

export function OverduePenalties({ data }: { data: OverduePenaltiesData | null | undefined }) {
  if (!data || !data.count || data.lines.length === 0) return null;
  const days = data.thresholdDays || 30;
  return (
    <section className="callout callout-warn overdue-pen" role="region" aria-label="Pénalités impayées">
      <Icon name="alert" size={20} />
      <div className="min0 overdue-pen-body">
        <p className="overdue-pen-title"><strong>Pénalités impayées depuis plus de {days} jours</strong> <span className="overdue-pen-count">({data.count})</span></p>
        <ul className="overdue-pen-list">
          {data.lines.map((l) => (
            <li key={`${l.module}-${l.reference}`}>
              <span className="overdue-pen-mod">{l.moduleLabel}</span>
              <span className="mono">{l.reference}</span>
              <span>{l.nature}</span>
              {l.amount && <strong className="overdue-pen-amount"><MoneyText money={l.amount} /></strong>}
              <span className="muted">décidée le {kinshasaDate(l.decidedAt)}</span>
              <span className="overdue-pen-days">impayée depuis {l.overdueDays} jours</span>
            </li>
          ))}
        </ul>
        {data.guidance && <p className="overdue-pen-guidance">{data.guidance}</p>}
        {!data.guidance && <p className="overdue-pen-note">Montant fixé par la décision : il ne se négocie pas. N’encaissez rien ; aucune mesure sur place.</p>}
      </div>
    </section>
  );
}
