/**
 * Quittance électronique en PDF (§ 18A.4 « Quittance électronique (PDF) — contenu complet du § 19, signature
 * électronique »). Mentions du § 19 : référence du contribuable, référence de paiement, nature de la recette, montant,
 * devise, date, statut de règlement, administration bénéficiaire, identifiant de transaction, QR sécurisé, signature
 * électronique, statut de la quittance, mécanisme de vérification. La page web imprimable reste disponible.
 */
import { buildPdf, sealPdf, type SealedPdf } from './pdf.js';
import type { Receipt, ReceiptService } from './service.js';

const SETTLEMENT: Record<string, string> = {
  CONFIRME: 'Confirmé par le prestataire — règlement au compte public en cours',
  REGLE: 'Réglé au compte public',
  RAPPROCHE: 'Réglé et rapproché au compte public',
};

export function receiptPdf(r: Receipt, receipts: ReceiptService, opts: { paymentStatus?: string; generatedAt: string; duplicate?: boolean }): SealedPdf & { fileName: string } {
  const f = (label: string, value: string) => ({ text: `${label} : ${value}` });
  const pdf = buildPdf({
    title: `Quittance ${r.number}`,
    subject: 'Quittance électronique KINSHASA MOSOLO',
    qr: r.qrPayload,
    blocks: [
      { text: 'KINSHASA MOSOLO — Ville-Province de Kinshasa', size: 9 },
      { text: 'Quittance électronique', size: 18, bold: true, gap: 6 },
      { text: r.mention, size: 11, bold: true, gap: 4 },
      ...(opts.duplicate ? [{ text: 'DUPLICATA — même numéro, même signature', bold: true }] : []),
      { text: `N° ${r.number}`, size: 12, bold: true, gap: 10 },
      f('Code de vérification', r.code),
      f('Statut de la quittance', r.status),
      { text: 'Paiement', size: 12, bold: true, gap: 12 },
      f('Référence du contribuable', r.taxpayerRef),
      f('Référence de paiement', r.paymentReference),
      f('Nature de la recette', r.revenueCategory),
      f('Montant', `${r.amount.amount} ${r.amount.currency}`),
      f('Devise', r.amount.currency),
      ...(r.indicativeAmount ? [f('Contre-valeur indicative', `${r.indicativeAmount.amount.amount} ${r.indicativeAmount.amount.currency} (taux ${r.indicativeAmount.rate} du ${r.indicativeAmount.rateDate}, ${r.indicativeAmount.source})`)] : []),
      f('Date du paiement', r.paidAt),
      f('Statut de règlement', SETTLEMENT[opts.paymentStatus ?? ''] ?? (r.status === 'DEFINITIVE' ? 'Réglé et rapproché au compte public' : 'En attente de règlement')),
      f('Administration bénéficiaire', r.administration),
      f('Canal et prestataire', `${r.channel} — ${r.provider}`),
      f('Identifiant de transaction', r.providerTxnId),
      f('Émise le', r.issuedAt),
      ...(r.finalizedAt ? [f('Définitive le', r.finalizedAt)] : []),
      ...(r.replaces ? [f('Remplace la quittance', r.replaces)] : []),
      { text: 'Signature électronique', size: 12, bold: true, gap: 12 },
      f('Algorithme', `${r.signatureAlgorithm}${r.keyId ? ` — clé ${r.keyId}` : ''}`),
      { text: `Signature de la quittance : ${r.signature}`, size: 8 },
      { text: 'Vérification', size: 12, bold: true, gap: 12 },
      { text: `Scannez le QR code ou saisissez le code ${r.code} sur la page publique de vérification (${r.verificationPath}), par SMS au numéro court, par USSD ou au serveur vocal. La vérification publique indique seulement : valide, en attente, annulée, contrepassée, remplacée ou signalée.` },
      { text: 'Ce document porte un cachet électronique avancé (Ed25519) sur l’ensemble du fichier : toute modification est détectée par la vérification de la plateforme. Une quittance n’expire jamais ; son statut fait foi sur la vérification publique.', size: 8, gap: 10 },
      { text: `Document généré le ${opts.generatedAt}.`, size: 8 },
    ],
  });
  return { ...sealPdf(pdf, receipts), fileName: `quittance-${r.number}${opts.duplicate ? '-duplicata' : ''}.pdf` };
}
