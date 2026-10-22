import { formatMoney, type MoneyJSON, type CurrencyCode } from '@mosolo/shared';
import { useApp } from '../context';
import { convertIndicative } from '../lib/money';

interface Props {
  /** Montant ; `null` (montant masqué au profil, p. ex. agent de terrain — minimisation des données) : « — ». */
  money: MoneyJSON | null | undefined;
  /** Contre-valeur fournie par le backend (prioritaire sur le calcul local). */
  indicative?: MoneyJSON;
  /** Afficher la contre-valeur indicative en CDF si la devise légale n'est pas le CDF (défaut : oui). */
  showIndicative?: boolean;
  /** Afficher aussi la contre-valeur dans la devise d'affichage choisie. */
  showDisplay?: boolean;
  className?: string;
}

/**
 * Montant : drapeau + code ISO + montant (formatMoney partagé).
 * L'obligation garde sa devise légale ; la contre-valeur CDF n'est qu'indicative (§ 11.6.1).
 */
export function MoneyText({ money, indicative, showIndicative = true, showDisplay = false, className }: Props) {
  const { lang, currency, rates, tr } = useApp();
  const locale = lang === 'en' ? 'en' : 'fr';
  if (!money) return <span className={`money muted ${className ?? ''}`} title="Montant non communiqué à ce profil">—</span>;
  const cdf = money.currency !== 'CDF' && showIndicative ? indicative?.currency === 'CDF' ? indicative : convertIndicative(money, 'CDF', rates) : null;
  const disp = showDisplay && currency !== money.currency && currency !== 'CDF' ? convertIndicative(money, currency as CurrencyCode, rates) : null;
  return (
    <span className={`money ${className ?? ''}`}>
      <span className="money-main">{formatMoney(money, { locale })}</span>
      {cdf && (
        <span className="money-indicative">
          {tr('money.indicative', { value: formatMoney(cdf, { locale }) })}
        </span>
      )}
      {disp && <span className="money-indicative">≈ {formatMoney(disp, { locale })}</span>}
    </span>
  );
}
