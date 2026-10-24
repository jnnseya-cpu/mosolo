/**
 * Gestion documentaire (module 38) — catégories de pièces, mots-clés de classification (règles explicables), nature
 * « preuve d'audit » (jamais purgée) et durées de conservation par catégorie (registre des seuils : 0 = non fixée).
 */
import type { ParamDefinition } from '../integrite/gouvernance/parametres.js';

/** Catégories de pièces, mots-clés de classification (explicables) et nature « preuve d'audit » (jamais purgée). */
export const DOCUMENT_CATEGORIES = {
  PIECE_IDENTITE: { label: 'Pièce d’identité', auditProof: false, keywords: ['carte d’électeur', "carte d'electeur", 'passeport', 'carte d’identité', "carte d'identite", 'né le', 'ne le', 'nationalité', 'nationalite'] },
  TITRE_PROPRIETE: { label: 'Titre de propriété ou certificat d’enregistrement', auditProof: false, keywords: ['certificat d’enregistrement', "certificat d'enregistrement", 'titre foncier', 'parcelle', 'conservateur des titres', 'volume', 'folio'] },
  BAIL: { label: 'Contrat de bail', auditProof: false, keywords: ['bail', 'bailleur', 'preneur', 'loyer', 'locataire'] },
  CONTRAT: { label: 'Contrat ou convention', auditProof: false, keywords: ['convention', 'contrat', 'les parties', 'article 1er', 'signataires'] },
  QUITTANCE_JUSTIFICATIF: { label: 'Quittance ou justificatif de paiement', auditProof: true, keywords: ['quittance', 'reçu', 'recu', 'référence de paiement', 'reference de paiement', 'montant payé', 'montant paye'] },
  RELEVE_BANCAIRE: { label: 'Relevé bancaire ou d’opérateur', auditProof: true, keywords: ['relevé', 'releve', 'solde', 'crédit', 'credit', 'débit', 'debit', 'date de valeur'] },
  PROCES_VERBAL: { label: 'Procès-verbal ou constat', auditProof: true, keywords: ['procès-verbal', 'proces-verbal', 'constat', 'constatons', 'agent verbalisant'] },
  PIECE_ENQUETE: { label: 'Pièce d’enquête', auditProof: true, keywords: ['enquête', 'enquete', 'signalement', 'audition'] },
  PHOTO_PREUVE: { label: 'Photographie de preuve', auditProof: false, keywords: [] as string[] },
  CORRESPONDANCE: { label: 'Correspondance', auditProof: false, keywords: ['objet :', 'monsieur', 'madame', 'veuillez agréer', 'veuillez agreer'] },
  AUTRE: { label: 'Autre pièce', auditProof: false, keywords: [] as string[] },
} as const;
export type DocumentCategory = keyof typeof DOCUMENT_CATEGORIES;
export const DOCUMENT_CATEGORY_CODES = Object.keys(DOCUMENT_CATEGORIES) as DocumentCategory[];

/** Durées de conservation par catégorie (registre des seuils) : 0 = non fixée ⇒ aucune purge (à fixer par acte). */
export const retentionParamId = (c: DocumentCategory) => `conservation.documents.${c.toLowerCase()}_jours`;
export const PARAMETRES_DOCUMENTS: ParamDefinition[] = DOCUMENT_CATEGORY_CODES.map((c) => ({
  id: retentionParamId(c), label: `Conservation des documents « ${DOCUMENT_CATEGORIES[c].label} » (0 = non fixée : aucune purge)`, category: 'Conservation des données (§ 32)',
  value: 0, unit: 'jours', owner: 'REGISTRE' as const, source: { file: 'backend/src/plugins/documents/model.ts', constant: 'PARAMETRES_DOCUMENTS', exported: true }, min: 0, max: 36_500,
  description: DOCUMENT_CATEGORIES[c].auditProof ? 'Preuve d’audit : jamais purgée, quelle que soit la durée.' : 'Durée à fixer par acte (archives publiques, prescription) ; purge après aperçu et approbation à deux personnes.',
}));

