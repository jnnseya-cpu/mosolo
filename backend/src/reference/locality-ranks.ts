/**
 * Référentiel CERTIFIÉ des rangs de localité (quartier → rang 1 à 4).
 *
 * Aucun barème officiel quartier → rang n'est certifié à ce jour : la table est VIDE et aucun rang n'est inventé.
 * Tant qu'un quartier n'y figure pas, le rang saisi par le déclarant est PROVISOIRE ; il n'est confirmé que par la
 * validation de l'objet par une personne distincte du déclarant. Dès qu'une entrée certifiée existe (instrument du
 * registre juridique + article), elle s'impose : à la déclaration, à la validation et à toute correction.
 *
 * Chargement : `loadCertifiedLocalityRanks` (acte provincial lu et certifié), remplacement intégral et journalisé
 * par l'appelant ; `clearCertifiedLocalityRanks` sert aux tests.
 */
import { isCommune } from './kinshasa.js';

export type LocalityRank = 1 | 2 | 3 | 4;

export interface CertifiedLocalityRank {
  commune: string;
  quartier: string;
  rank: LocalityRank;
  /** Instrument du registre juridique fixant le rang (EN VIGUEUR) et article. */
  instrumentId: string;
  article: string;
  certifiedAt: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const keyOf = (commune: string, quartier: string) => `${norm(commune)}|${norm(quartier)}`;

let table = new Map<string, CertifiedLocalityRank>();

/** Remplace la table certifiée (entrées validées : commune connue, rang 1 à 4, fondement cité). */
export function loadCertifiedLocalityRanks(entries: CertifiedLocalityRank[]): number {
  const next = new Map<string, CertifiedLocalityRank>();
  for (const e of entries) {
    if (!isCommune(e.commune)) throw new Error(`Commune inconnue dans la table des rangs : ${e.commune}`);
    if (![1, 2, 3, 4].includes(e.rank)) throw new Error(`Rang invalide pour ${e.commune}/${e.quartier} : ${e.rank}`);
    if (!e.instrumentId?.trim() || !e.article?.trim()) throw new Error(`Fondement juridique manquant pour ${e.commune}/${e.quartier}`);
    if (!e.quartier?.trim()) throw new Error('Quartier manquant dans la table des rangs.');
    next.set(keyOf(e.commune, e.quartier), { ...e, quartier: e.quartier.trim() });
  }
  table = next;
  return table.size;
}

export function clearCertifiedLocalityRanks(): void {
  table = new Map();
}

/** Rang certifié d'un quartier, s'il existe (sinon `undefined` : rang provisoire à confirmer). */
export function certifiedRankOf(commune: string, quartier: string): CertifiedLocalityRank | undefined {
  return table.get(keyOf(commune, quartier));
}

export function certifiedLocalityRanksCount(): number {
  return table.size;
}
