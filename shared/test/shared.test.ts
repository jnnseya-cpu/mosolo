import { describe, it, expect } from 'vitest';
import {
  Money, CurrencyMismatchError, formatMoney, CURRENCIES, PRIMARY_CURRENCY, EVENTS, EVENT_CATEGORIES,
  channelCoverage, resolveChannels, getEvent, isRuleExecutable, SAMPLE_RULES, t, completeness, LANGUAGE_CODES,
  canTransition, hasIncompatibility,
} from '../src/index.js';

describe('Money', () => {
  it('additionne exactement sans virgule flottante', () => {
    expect(Money.of('0.10', 'USD').add(Money.of('0.20', 'USD')).toDecimalString()).toBe('0.30');
  });
  it('refuse les opérations entre devises', () => {
    expect(() => Money.of('1', 'USD').add(Money.of('1', 'CDF'))).toThrow(CurrencyMismatchError);
  });
  it('applique un pourcentage avec arrondi', () => {
    expect(Money.of('720', 'USD').percent('22').toDecimalString()).toBe('158.40');
    expect(Money.of('0.05', 'USD').percent('50').toDecimalString()).toBe('0.03');
  });
  it('convertit au taux officiel', () => {
    expect(Money.of('150', 'USD').convert('CDF', '2267.75').toDecimalString()).toBe('340162.50');
    expect(Money.of('1000', 'CDF').convert('XAF', '0.25').toDecimalString()).toBe('250');
  });
  it('sérialise en JSON décimal', () => {
    expect(Money.of('1250000', 'CDF').toJSON()).toEqual({ amount: '1250000.00', currency: 'CDF' });
  });
});

describe('Devises', () => {
  it('CDF est la devise principale et chaque devise a un drapeau', () => {
    expect(PRIMARY_CURRENCY).toBe('CDF');
    for (const c of Object.values(CURRENCIES)) expect(c.flag.length).toBeGreaterThan(0);
    expect(CURRENCIES.CDF.flag).toBe('🇨🇩');
  });
  it('formate avec drapeau, et sans drapeau pour les SMS', () => {
    expect(formatMoney({ amount: '1250000.00', currency: 'CDF' })).toBe('🇨🇩 CDF 1 250 000,00');
    expect(formatMoney({ amount: '450.00', currency: 'USD' }, { locale: 'en' })).toBe('🇺🇸 USD 450.00');
    expect(formatMoney({ amount: '1250000.00', currency: 'CDF' }, { style: 'plain' })).toBe('CDF 1250000');
  });
});

describe('Catalogue des événements', () => {
  it('contient 255 événements uniques en 23 catégories', () => {
    expect(EVENTS.length).toBe(255);
    expect(EVENT_CATEGORIES.length).toBe(23);
    expect(new Set(EVENTS.map((e) => e.code)).size).toBe(EVENTS.length);
  });
  it('un avis obligatoire ignore la désinscription et n’utilise jamais WhatsApp', () => {
    const e = getEvent('assessment.issued')!;
    expect(e.obligatoire).toBe(true);
    const ch = resolveChannels(e, { optedOut: true, whatsappConsent: true });
    expect(ch).toContain('sms');
    expect(ch).not.toContain('whatsapp');
  });
  it('WhatsApp seulement sur consentement pour un événement éligible', () => {
    const e = getEvent('obligation.due_soon')!;
    expect(resolveChannels(e, {})).not.toContain('whatsapp');
    expect(resolveChannels(e, { whatsappConsent: true })).toContain('whatsapp');
  });
  it('calcule la couverture par canal', () => {
    expect(channelCoverage()['in-app']).toBeGreaterThan(200);
  });
});

describe('Règles', () => {
  it('les fiches modèles au statut A_VERIFIER ne sont pas exécutables', () => {
    for (const r of SAMPLE_RULES) expect(isRuleExecutable(r, new Date('2027-02-01')).ok).toBe(false);
  });
  it('une règle active exige quatre approbateurs distincts et une source certifiée', () => {
    const base = { ...SAMPLE_RULES[0]!, status: 'ACTIVE' as const, sourceVerification: 'OFFICIEL_CERTIFIE' as const };
    const same = ['REDACTEUR', 'VERIFICATEUR_JURIDIQUE', 'VALIDATEUR_FINANCIER', 'AUTORITE_PUBLICATION'].map((role) => ({ role: role as never, userId: 'u1', at: '2026-01-01' }));
    expect(isRuleExecutable({ ...base, approvals: same }, new Date('2027-01-01')).ok).toBe(false);
    const distinct = same.map((a, i) => ({ ...a, userId: `u${i}` }));
    expect(isRuleExecutable({ ...base, approvals: distinct }, new Date('2027-01-01')).ok).toBe(true);
  });
});

describe('Domaine', () => {
  it('respecte les transitions de paiement', () => {
    expect(canTransition('INITIE', 'CONFIRME')).toBe(true);
    expect(canTransition('INITIE', 'RAPPROCHE')).toBe(false);
  });
  it('détecte les rôles incompatibles', () => {
    expect(hasIncompatibility(['R26', 'R17'])).toEqual(['R26', 'R17']);
    expect(hasIncompatibility(['R01'])).toBeNull();
  });
});

describe('i18n', () => {
  it('traduit avec repli sur le français', () => {
    expect(t('fr', 'autosave.saved', { time: '09:15' })).toBe('Enregistré à 09:15');
    expect(t('kg', 'taxpayer.obligations')).toBe('Mes obligations');
    expect(completeness('fr')).toBe(100);
    expect(LANGUAGE_CODES).toEqual(['fr', 'ln', 'sw', 'kg', 'lua', 'en']);
  });
});
