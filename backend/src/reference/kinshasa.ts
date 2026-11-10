/** Référentiels territoriaux et institutionnels de la Ville-Province de Kinshasa. */

/** Les 24 communes de Kinshasa. */
export const COMMUNES = [
  'Bandalungwa', 'Barumbu', 'Bumbu', 'Gombe', 'Kalamu', 'Kasa-Vubu', 'Kimbanseke', 'Kinshasa',
  'Kintambo', 'Kisenso', 'Lemba', 'Limete', 'Lingwala', 'Makala', 'Maluku', 'Masina',
  'Matete', 'Mont-Ngafula', 'Ndjili', 'Ngaba', 'Ngaliema', 'Ngiri-Ngiri', 'Nsele', 'Selembao',
] as const;
export type Commune = (typeof COMMUNES)[number];

export function isCommune(v: string): v is Commune {
  return (COMMUNES as readonly string[]).includes(v);
}

export interface InstitutionalEntity {
  code: string;
  name: string;
  shortName: string;
  role: string;
  address: string;
  contact: string;
  /** Couleur d'accent propre à l'entité (bloc d'identification dans les courriels). */
  accent: string;
}

/**
 * Entités émettrices. Coordonnées de DÉMONSTRATION — à remplacer par les coordonnées officielles.
 */
export const ENTITIES: Record<string, InstitutionalEntity> = {
  GOUVERNORAT: {
    code: 'GOUVERNORAT', name: 'Gouvernorat de la Ville-Province de Kinshasa', shortName: 'Gouvernorat',
    role: 'Exécutif provincial', address: 'Hôtel de Ville, Gombe, Kinshasa [coordonnées de démonstration]',
    contact: 'contact@kinshasa.cd [démo]', accent: '#232C6B',
  },
  MINFIN: {
    code: 'MINFIN', name: 'Ministère provincial des Finances', shortName: 'Min. Finances',
    role: 'Tutelle des régies financières', address: 'Gombe, Kinshasa [coordonnées de démonstration]',
    contact: 'finances@kinshasa.cd [démo]', accent: '#1E9BD7',
  },
  DGIPK: {
    code: 'DGIPK', name: 'Direction générale des impôts provinciaux de Kinshasa', shortName: 'DGIPK',
    role: 'Régie des impôts provinciaux', address: 'Gombe, Kinshasa [coordonnées de démonstration]',
    contact: 'contact@dgipk.cd [démo]', accent: '#1E9BD7',
  },
  DGTK: {
    code: 'DGTK', name: 'Direction générale des droits, taxes et redevances de Kinshasa', shortName: 'DGTK',
    role: 'Régie des droits, taxes et redevances (successeur de la DGRK)', address: 'Kinshasa [coordonnées de démonstration]',
    contact: 'contact@dgtk.cd [démo]', accent: '#1E9BD7',
  },
  TRESOR: {
    code: 'TRESOR', name: 'Trésor provincial — Comptable public', shortName: 'Trésor',
    role: 'Prise en charge, règlement, rapprochement', address: 'Kinshasa [coordonnées de démonstration]',
    contact: 'tresor@kinshasa.cd [démo]', accent: '#232C6B',
  },
  AUDIT: {
    code: 'AUDIT', name: 'Inspection et audit interne provincial', shortName: 'Audit',
    role: 'Audit interne', address: 'Kinshasa [coordonnées de démonstration]', contact: 'audit@kinshasa.cd [démo]', accent: '#232C6B',
  },
  PLATEFORME: {
    code: 'PLATEFORME', name: 'Exploitation technique de la plateforme KINSHASA MOSOLO', shortName: 'Plateforme',
    role: 'Exploitation technique (aucun pouvoir financier)', address: 'Kinshasa', contact: 'support@mosolo.cd [démo]', accent: '#232C6B',
  },
  CONTENTIEUX: {
    code: 'CONTENTIEUX', name: 'Service du contentieux fiscal provincial', shortName: 'Contentieux',
    role: 'Réclamations et recours', address: 'Kinshasa [coordonnées de démonstration]', contact: 'recours@kinshasa.cd [démo]', accent: '#232C6B',
  },
  PUBLIC: {
    code: 'PUBLIC', name: 'Contribuables et usagers', shortName: 'Usagers', role: 'Usagers', address: '', contact: '', accent: '#232C6B',
  },
};

export function getEntity(code: string): InstitutionalEntity | undefined {
  return ENTITIES[code];
}
