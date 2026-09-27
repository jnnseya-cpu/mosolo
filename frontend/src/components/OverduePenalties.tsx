/**
 * Pénalités impayées visibles de l'agent après un contrôle, AVEC le montant fixé par la décision (décision du maître
 * d'ouvrage) : celles de SON module dès la décision ; celles des autres modules une fois impayées depuis 30 jours.
 * le montant ne se négocie pas ; l'agent invite l'usager à payer par les canaux officiels, il n'encaisse rien.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { Icon } from './Icon';
import { MoneyText } from './MoneyText';

export interface OverduePenaltyLine {
  module: string; moduleLabel: string; reference: string; nature: string; decidedAt: string; overdueDays: number; amount?: MoneyJSON | null;
  /** Pénalité du module de l'agent (visible à tout âge). */
  sameModule?: boolean;
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
  const mine = data.lines.filter((l) => l.sameModule).length;
  const title = mine === 0 ? `Pénalités impayées depuis plus de ${days} jours`
    : mine === data.lines.length ? 'Pénalités impayées de votre module' : `Pénalités impayées : votre module, et autres modules au-delà de ${days} jours`;
  return (
    <section className="callout callout-warn overdue-pen" role="region" aria-label="Pénalités impayées">
      <Icon name="alert" size={20} />
      <div className="min0 overdue-pen-body">
        <p className="overdue-pen-title"><strong>{title}</strong> <span className="overdue-pen-count">({data.count})</span></p>
        <ul className="overdue-pen-list">
          {data.lines.map((l) => (
            <li key={`${l.module}-${l.reference}`}>
              <span className="overdue-pen-mod">{l.moduleLabel}{l.sameModule && <span className="overdue-pen-mine"> · votre module</span>}</span>
              <span className="mono">{l.reference}</span>
              <span>{l.nature}</span>
              {l.amount && <strong className="overdue-pen-amount"><MoneyText money={l.amount} /></strong>}
              <span className="muted">décidée le {kinshasaDate(l.decidedAt)}</span>
              <span className="overdue-pen-days">{l.overdueDays >= 1 ? `impayée depuis ${l.overdueDays} jour${l.overdueDays > 1 ? 's' : ''}` : 'décidée aujourd’hui, impayée'}</span>
            </li>
          ))}
        </ul>
        {data.guidance && <p className="overdue-pen-guidance">{data.guidance}</p>}
        {!data.guidance && <p className="overdue-pen-note">Montant fixé par la décision : il ne se négocie pas. N’encaissez rien ; aucune mesure sur place.</p>}
      </div>
    </section>
  );
}
