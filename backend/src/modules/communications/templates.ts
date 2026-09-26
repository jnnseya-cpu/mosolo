/**
 * Rendu des modèles de messages. Courriel : charte de la Ville de Kinshasa (marque principale),
 * bloc d'identification de l'entité émettrice, mention d'avis obligatoire, pied de page plateforme.
 */
import { formatMoney, t, type CommunicationEvent, type LanguageCode } from '@mosolo/shared';
import type { InstitutionalEntity } from '../../reference/kinshasa.js';

export const BRAND = {
  logoUrl: '/logo-ville-de-kinshasa.png',
  logoAlt: 'Ville de Kinshasa',
  navy: '#232C6B',
  flagBlue: '#1E9BD7',
  flagYellow: '#F7D618',
  flagRed: '#D7141A',
  ink: '#111111',
  surface: '#F5F7FB',
  partnerLogoUrl: '/logo-groupe-nseya.png',
  partnerMention: 'Plateforme KINSHASA MOSOLO — réalisée par Groupe Nseya',
} as const;

export const MANDATORY_NOTICE =
  'Avis obligatoire : ce message produit un effet de droit ou protège vos droits. Il vous est adressé même si vous vous êtes désinscrit des communications facultatives. Il n’est jamais envoyé par WhatsApp.';
export const FRENCH_AUTHORITATIVE = 'La version française fait foi.';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Corps texte court (SMS, push, USSD) : jamais de lien de paiement (§ 11.4.4). */
export function renderText(event: CommunicationEvent, vars: Record<string, string>): string {
  const parts = [event.objet];
  if (vars.reference) parts.push(`Réf. ${vars.reference}`);
  if (vars.amount) parts.push(vars.amount);
  parts.push('Détail : espace MOSOLO ou code USSD officiel.');
  return parts.join(' — ');
}

export interface EmailPreview {
  subject: string;
  html: string;
}

/** Aperçu de courriel avec données fictives (§ 11.4.6). */
export function renderEmailPreview(event: CommunicationEvent, entity: InstitutionalEntity, lang: LanguageCode): EmailPreview {
  const subject = event.objet;
  const sampleAmount = formatMoney({ amount: '150.00', currency: 'USD' }, { locale: lang === 'en' ? 'en' : 'fr' });
  const sampleIndicative = formatMoney({ amount: '427500.00', currency: 'CDF' }, { locale: lang === 'en' ? 'en' : 'fr' });
  const notFrench = lang !== 'fr';
  const html = `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.surface};color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${BRAND.surface};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:6px;overflow:hidden;">
  <tr><td style="background:${BRAND.navy};padding:18px 24px;color:#FFFFFF;">
    <table role="presentation" cellspacing="0" cellpadding="0"><tr>
      <td style="padding-right:14px;vertical-align:middle;"><img src="${BRAND.logoUrl}" alt="${BRAND.logoAlt}" height="56" style="display:block;height:56px;width:auto;border:0;"></td>
      <td style="vertical-align:middle;color:#FFFFFF;">
        <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.85;">Ville-Province de Kinshasa</div>
        <div style="font-size:20px;font-weight:bold;">${esc(t(lang, 'app.name'))}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:0;line-height:0;font-size:0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td height="4" style="background:${BRAND.flagBlue};height:4px;width:34%;"></td>
      <td height="4" style="background:${BRAND.flagYellow};height:4px;width:33%;"></td>
      <td height="4" style="background:${BRAND.flagRed};height:4px;width:33%;"></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:16px 24px 0 24px;">
    <div data-entity="${esc(entity.code)}" style="border-left:4px solid ${entity.accent};background:${BRAND.surface};padding:10px 14px;">
      <div style="font-weight:bold;color:${BRAND.navy};">${esc(entity.name)}</div>
      <div style="font-size:12px;">${esc(entity.role)}</div>
      <div style="font-size:12px;">${esc(entity.address)}${entity.contact ? ' · ' + esc(entity.contact) : ''}</div>
    </div>
  </td></tr>
  ${notFrench ? `<tr><td style="padding:12px 24px 0 24px;"><div style="font-size:12px;background:#FFF8D6;border:1px solid ${BRAND.flagYellow};padding:8px 12px;">Traduction en cours de validation. ${FRENCH_AUTHORITATIVE}</div></td></tr>` : ''}
  <tr><td style="padding:20px 24px 8px 24px;">
    <h1 style="margin:0 0 12px 0;font-size:20px;color:${BRAND.navy};">${esc(subject)}</h1>
    <p style="margin:0 0 10px 0;font-size:14px;line-height:1.5;">Bonjour Contribuable Exemple,</p>
    <p style="margin:0 0 10px 0;font-size:14px;line-height:1.5;">${esc(event.libelle)}.</p>
    <table role="presentation" cellspacing="0" cellpadding="6" style="font-size:14px;border-collapse:collapse;background:${BRAND.surface};width:100%;">
      <tr><td style="color:#555;">Référence</td><td style="font-weight:bold;">PR-EXEM-PLE0</td></tr>
      <tr><td style="color:#555;">Montant</td><td style="font-weight:bold;">${esc(sampleAmount)}</td></tr>
      <tr><td style="color:#555;">Contre-valeur indicative</td><td>${esc(sampleIndicative)} (taux BCC démo)</td></tr>
    </table>
    <p style="margin:12px 0 0 0;font-size:13px;line-height:1.5;">Consultez le détail dans votre espace MOSOLO. Pour payer, composez le code USSD officiel ou utilisez un canal agréé : un agent MOSOLO ne vous demandera jamais d’espèces ni de code OTP.</p>
  </td></tr>
  ${event.obligatoire ? `<tr><td style="padding:12px 24px 0 24px;"><div role="note" data-mandatory="true" style="font-size:12px;border:1px solid ${BRAND.navy};color:${BRAND.navy};padding:8px 12px;">${esc(MANDATORY_NOTICE)}</div></td></tr>` : ''}
  <tr><td style="padding:16px 24px;font-size:11px;color:#555;">
    <div>${esc(t(lang, 'common.example'))} — aperçu avec données fictives.</div>
    ${notFrench ? `<div style="margin-top:4px;font-weight:bold;">${FRENCH_AUTHORITATIVE}</div>` : ''}
  </td></tr>
  <tr><td style="border-top:1px solid #E3E7F0;padding:12px 24px;font-size:11px;color:#555;">
    <table role="presentation" cellspacing="0" cellpadding="0"><tr>
      <td style="padding-right:8px;vertical-align:middle;"><img src="${BRAND.partnerLogoUrl}" alt="Groupe Nseya" height="18" style="display:block;height:18px;width:auto;border:0;"></td>
      <td style="vertical-align:middle;">${esc(BRAND.partnerMention)}</td>
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject, html };
}
