/**
 * Référentiel des devises (module 89).
 * Devise principale : le franc congolais (CDF).
 * Chaque devise est représentée par le drapeau de son pays émetteur ;
 * pour une union monétaire, le drapeau de l'union ou un drapeau de référence configurable.
 */
export type CurrencyRole =
  | 'principale'
  | 'legale_secondaire'
  | 'paiement_diaspora'
  | 'affichage';

export interface CurrencyInfo {
  code: string;
  name: string;
  /** Drapeau (émoji) du pays ou de l'union émettrice */
  flag: string;
  /** Code pays ISO 3166-1 alpha-2 (ou EU) du drapeau affiché */
  country: string;
  decimals: number;
  role: CurrencyRole;
  /** La devise peut libeller une obligation (si la règle légale l'exige) */
  assessable: boolean;
  /** La devise peut être utilisée pour payer (via prestataire habilité, converti) */
  payable: boolean;
}

export const CURRENCIES = {
  CDF: { code: 'CDF', name: 'Franc congolais', flag: '🇨🇩', country: 'CD', decimals: 2, role: 'principale', assessable: true, payable: true },
  USD: { code: 'USD', name: 'Dollar américain', flag: '🇺🇸', country: 'US', decimals: 2, role: 'legale_secondaire', assessable: true, payable: true },
  EUR: { code: 'EUR', name: 'Euro', flag: '🇪🇺', country: 'EU', decimals: 2, role: 'paiement_diaspora', assessable: false, payable: true },
  GBP: { code: 'GBP', name: 'Livre sterling', flag: '🇬🇧', country: 'GB', decimals: 2, role: 'paiement_diaspora', assessable: false, payable: true },
  CAD: { code: 'CAD', name: 'Dollar canadien', flag: '🇨🇦', country: 'CA', decimals: 2, role: 'paiement_diaspora', assessable: false, payable: true },
  CHF: { code: 'CHF', name: 'Franc suisse', flag: '🇨🇭', country: 'CH', decimals: 2, role: 'paiement_diaspora', assessable: false, payable: true },
  ZAR: { code: 'ZAR', name: 'Rand sud-africain', flag: '🇿🇦', country: 'ZA', decimals: 2, role: 'paiement_diaspora', assessable: false, payable: true },
  XAF: { code: 'XAF', name: 'Franc CFA (CEMAC)', flag: '🇨🇬', country: 'CG', decimals: 0, role: 'affichage', assessable: false, payable: false },
  AOA: { code: 'AOA', name: 'Kwanza angolais', flag: '🇦🇴', country: 'AO', decimals: 2, role: 'affichage', assessable: false, payable: false },
  ZMW: { code: 'ZMW', name: 'Kwacha zambien', flag: '🇿🇲', country: 'ZM', decimals: 2, role: 'affichage', assessable: false, payable: false },
  RWF: { code: 'RWF', name: 'Franc rwandais', flag: '🇷🇼', country: 'RW', decimals: 0, role: 'affichage', assessable: false, payable: false },
  UGX: { code: 'UGX', name: 'Shilling ougandais', flag: '🇺🇬', country: 'UG', decimals: 0, role: 'affichage', assessable: false, payable: false },
  KES: { code: 'KES', name: 'Shilling kényan', flag: '🇰🇪', country: 'KE', decimals: 2, role: 'affichage', assessable: false, payable: false },
  TZS: { code: 'TZS', name: 'Shilling tanzanien', flag: '🇹🇿', country: 'TZ', decimals: 2, role: 'affichage', assessable: false, payable: false },
  BIF: { code: 'BIF', name: 'Franc burundais', flag: '🇧🇮', country: 'BI', decimals: 0, role: 'affichage', assessable: false, payable: false },
  CNY: { code: 'CNY', name: 'Yuan renminbi', flag: '🇨🇳', country: 'CN', decimals: 2, role: 'affichage', assessable: false, payable: false },
  AED: { code: 'AED', name: 'Dirham des Émirats', flag: '🇦🇪', country: 'AE', decimals: 2, role: 'affichage', assessable: false, payable: false },
} as const satisfies Record<string, CurrencyInfo>;

export type CurrencyCode = keyof typeof CURRENCIES;
export const PRIMARY_CURRENCY: CurrencyCode = 'CDF';
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export function isCurrencyCode(v: string): v is CurrencyCode {
  return v in CURRENCIES;
}

export function currencyFlag(code: CurrencyCode): string {
  return CURRENCIES[code].flag;
}
