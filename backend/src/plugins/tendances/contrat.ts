/**
 * Contrat « Growth Brief v1 » (spécification Trend Intelligence v2.3, annexe A ; copie YAML dans
 * trend-intelligence/contracts/growth-brief.v1.schema.yaml). Objet FERMÉ : tout champ en plus est refusé.
 * Les règles d'exécution au-delà du schéma (validité, portée, canal, politique) sont dans le service.
 */
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const score = z.number().min(0).max(100);
const utc = z.string().datetime().regex(/Z$/);
const texteCourt = z.string().min(1).max(500);
const listeIds = z.array(id).max(64).refine((a) => new Set(a).size === a.length, 'identifiants en double');

/** Valeurs de routage réservées (§ annexe A) : seules « seo » et « organic_social » ont un circuit en v1. */
export const CANAUX = ['seo', 'organic_social', 'sales_enablement', 'owned_placement', 'lifecycle', 'paid'] as const;
export type Canal = (typeof CANAUX)[number];
export const CANAUX_V1: Canal[] = ['seo', 'organic_social'];
/**
 * Canaux servis par un circuit EXISTANT de la plateforme hôte, avec sa propre politique (MOSOLO : rappels du module
 * « Agents IA de recettes », envoyés sur décision d'une personne, préférences et consentements respectés). Le brief ne
 * fait qu'orienter le contenu ; l'envoi reste celui du circuit existant.
 */
export const CANAUX_HOTE: Canal[] = ['lifecycle'];

export const growthBriefV1 = z.object({
  schema_version: z.literal(1),
  brief_id: id,
  brief_version: z.number().int().min(1),
  tenant_id: id,
  platform_id: id,
  market: z.string().regex(/^[A-Z]{2}$/),
  locale: z.string().min(2).max(35),
  topic_id: id,
  opportunity_score: score,
  confidence: score,
  valid_from: utc,
  expires_at: utc,
  evidence_ids: listeIds.refine((a) => a.length >= 1, 'au moins une preuve'),
  audience: texteCourt,
  intent: texteCourt,
  approved_claim_ids: listeIds,
  cta_id: id,
  allowed_channels: z.array(z.enum(CANAUX)).min(1).max(6).refine((a) => new Set(a).size === a.length, 'canaux en double'),
  prohibited_claims: z.array(texteCourt).max(32).refine((a) => new Set(a).size === a.length, 'mentions en double'),
  objective: texteCourt,
  experiment_id: id,
  policy_version: z.number().int().min(1),
}).strict();
export type GrowthBrief = z.infer<typeof growthBriefV1>;

/** Types d'action de la v1 (§ 18) : deux écritures réelles sur des pages préliées, deux brouillons exportables. */
export const ACTIONS_ECRITURE = ['seo_metadata_patch', 'owned_content_patch'] as const;
export const ACTIONS_BROUILLON = ['seo_page_draft', 'organic_social_draft'] as const;
export type TypeAction = (typeof ACTIONS_ECRITURE)[number] | (typeof ACTIONS_BROUILLON)[number];

/** Champs modifiables par type d'action (liste fermée) : jamais l'adresse, les redirections, la canonique, le robots… */
export const CHAMPS_AUTORISES: Record<TypeAction, readonly string[]> = {
  seo_metadata_patch: ['titre', 'description'],
  owned_content_patch: ['accroche', 'ctaLibelle', 'bloc'],
  seo_page_draft: ['titre', 'description', 'bloc'],
  organic_social_draft: ['texte'],
};
export const LONGUEURS: Record<string, number> = { titre: 70, description: 160, accroche: 120, ctaLibelle: 40, bloc: 2000, texte: 500 };

/** Sortie attendue d'un modèle : JSON borné, clés connues seulement (une consigne cachée dans un flux ne peut rien ajouter). */
export const sortieModele = z.object({
  titre: z.string().min(1).max(LONGUEURS.titre!),
  description: z.string().min(1).max(LONGUEURS.description!),
  accroche: z.string().min(1).max(LONGUEURS.accroche!),
  ctaLibelle: z.string().min(1).max(LONGUEURS.ctaLibelle!),
  bloc: z.string().min(1).max(LONGUEURS.bloc!),
  texte: z.string().min(1).max(LONGUEURS.texte!),
}).strict();
export type SortieModele = z.infer<typeof sortieModele>;
