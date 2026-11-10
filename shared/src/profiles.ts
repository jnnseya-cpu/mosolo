/**
 * Parcours d'enrôlement par profil (§ 9.3, doc 09 § 9.4) : chaque profil ne demande que ce qui sert à ses obligations.
 * La déclaration d'un rôle n'établit à elle seule ni la propriété ni la dette : elle OUVRE UNE INSTRUCTION.
 * Les obligations citées sont indicatives ; seules les règles ACTIVES du registre produisent une obligation.
 */

export type ProfileFieldType = 'texte' | 'nombre' | 'date' | 'commune' | 'oui_non' | 'plaque' | 'identifiant_objet';

export interface ProfileField {
  name: string;
  label: string;
  type: ProfileFieldType;
  required: boolean;
  hint?: string;
}

export interface EnrolmentProfile {
  code: string;
  label: string;
  /** Obligations potentiellement concernées (information ; jamais une dette). */
  obligations: string[];
  /** Personne morale attendue (organisation) ou indifférent. */
  kind: 'PERSONNE_PHYSIQUE' | 'PERSONNE_MORALE' | 'INDIFFERENT';
  /** NIF attendu pour ces obligations : sans NIF, un identifiant provisoire et un parcours de régularisation sont ouverts. */
  nifExpected: boolean;
  /** Catégorie d'objet proposée à l'instruction (objet provisoire recensé ensuite par un agent), le cas échéant. */
  objectCategory?: 'PARCELLE' | 'BATIMENT' | 'UNITE_LOCATIVE' | 'ACTIVITE' | 'VEHICULE' | 'PANNEAU' | 'AUTRE';
  /** Verticale de rattachement (espace de démarches). */
  vertical?: string;
  fields: ProfileField[];
}

const commune: ProfileField = { name: 'commune', label: 'Commune', type: 'commune', required: true };
const quartier: ProfileField = { name: 'quartier', label: 'Quartier', type: 'texte', required: false };
const igf: ProfileField = { name: 'objet', label: 'Identifiant du bien (IGF ou plaque NFIU), si connu', type: 'identifiant_objet', required: false };
const nif: ProfileField = { name: 'nif', label: 'NIF (si vous en avez un)', type: 'texte', required: false, hint: 'Sans NIF : un identifiant provisoire est attribué et la demande de NIF est suivie pour vous.' };
const rccm: ProfileField = { name: 'rccm', label: 'RCCM (si société)', type: 'texte', required: false };
const activite: ProfileField = { name: 'activite', label: 'Nature de l’activité', type: 'texte', required: true };

export const ENROLMENT_PROFILES: EnrolmentProfile[] = [
  { code: 'CITOYEN', label: 'Citoyen', obligations: ['Aucune par défaut : vérification de quittances, signalements, services'], kind: 'PERSONNE_PHYSIQUE', nifExpected: false, fields: [commune] },
  { code: 'PROPRIETAIRE_OCCUPANT', label: 'Propriétaire occupant', obligations: ['Impôt foncier'], kind: 'INDIFFERENT', nifExpected: false, objectCategory: 'PARCELLE', vertical: 'propriete', fields: [commune, quartier, igf, { name: 'bati', label: 'Parcelle bâtie ?', type: 'oui_non', required: true }] },
  { code: 'BAILLEUR', label: 'Bailleur', obligations: ['Impôt sur les revenus locatifs', 'Impôt foncier'], kind: 'INDIFFERENT', nifExpected: true, objectCategory: 'UNITE_LOCATIVE', vertical: 'locatif', fields: [commune, quartier, igf, { name: 'unites', label: 'Nombre d’unités louées', type: 'nombre', required: true }, nif] },
  { code: 'LOCATAIRE', label: 'Locataire', obligations: ['Retenue IRL si locataire assujetti [À VÉRIFIER]', 'Déclaration du bail'], kind: 'INDIFFERENT', nifExpected: false, vertical: 'locatif', fields: [commune, quartier, igf, { name: 'bailleur', label: 'Nom du bailleur (si connu)', type: 'texte', required: false }] },
  { code: 'OPERATEUR_INFORMEL', label: 'Opérateur informel', obligations: ['Droits de place, taxes d’activité selon règle'], kind: 'PERSONNE_PHYSIQUE', nifExpected: false, objectCategory: 'ACTIVITE', vertical: 'entreprises', fields: [commune, quartier, activite] },
  { code: 'COMMERCANT_ENTREPRISE', label: 'Commerçant et entreprise', obligations: ['Patente / taxes d’activité', 'Retenues à la source selon règle'], kind: 'INDIFFERENT', nifExpected: true, objectCategory: 'ACTIVITE', vertical: 'entreprises', fields: [commune, activite, nif, rccm] },
  { code: 'TRANSPORTEUR', label: 'Transporteur et propriétaire de véhicule', obligations: ['Vignette et taxe de circulation', 'Autorisation de transport'], kind: 'INDIFFERENT', nifExpected: false, objectCategory: 'VEHICULE', vertical: 'mobilite', fields: [{ name: 'plaque', label: 'Plaque d’immatriculation', type: 'plaque', required: true }, { name: 'usage', label: 'Usage (privé, taxi, bus, moto)', type: 'texte', required: true }] },
  { code: 'COMMERCANT_MARCHE', label: 'Commerçant de marché', obligations: ['Droits de place (étal)'], kind: 'PERSONNE_PHYSIQUE', nifExpected: false, vertical: 'marches', fields: [{ name: 'marche', label: 'Marché', type: 'texte', required: true }, { name: 'etal', label: 'Numéro d’étal (si attribué)', type: 'texte', required: false }] },
  { code: 'FABRICANT_IMPORTATEUR', label: 'Fabricant et importateur', obligations: ['Taxes sur la production ou l’importation selon règle'], kind: 'PERSONNE_MORALE', nifExpected: true, objectCategory: 'ACTIVITE', vertical: 'entreprises', fields: [commune, activite, nif, rccm] },
  { code: 'BOISSONS_TABAC', label: 'Opérateur de boissons et tabac', obligations: ['Autorisation de débit de boissons', 'Taxes sectorielles selon règle'], kind: 'INDIFFERENT', nifExpected: true, objectCategory: 'ACTIVITE', vertical: 'entreprises', fields: [commune, quartier, activite, nif] },
  { code: 'ORGANISATEUR_EVENEMENTS', label: 'Organisateur d’événements', obligations: ['Autorisation d’événement', 'Taxe sur les spectacles selon règle'], kind: 'INDIFFERENT', nifExpected: false, vertical: 'evenements', fields: [commune, { name: 'frequence', label: 'Événements par an (estimation)', type: 'nombre', required: false }] },
  { code: 'ANNONCEUR', label: 'Annonceur publicitaire', obligations: ['Autorisation et taxe d’affichage'], kind: 'INDIFFERENT', nifExpected: true, objectCategory: 'PANNEAU', vertical: 'publicite', fields: [commune, { name: 'supports', label: 'Nombre de supports', type: 'nombre', required: true }, nif] },
  { code: 'EXPLOITANT_CARRIERE', label: 'Exploitant de carrière', obligations: ['Droits d’exploitation et bons de sortie selon règle'], kind: 'INDIFFERENT', nifExpected: true, objectCategory: 'ACTIVITE', vertical: 'environnement', fields: [commune, { name: 'site', label: 'Site d’exploitation', type: 'texte', required: true }, nif] },
  { code: 'OPERATEUR_FORESTIER', label: 'Opérateur forestier', obligations: ['Taxes forestières selon règle'], kind: 'INDIFFERENT', nifExpected: true, objectCategory: 'ACTIVITE', vertical: 'environnement', fields: [{ name: 'depot', label: 'Dépôt ou point de vente', type: 'texte', required: true }, nif] },
  { code: 'BATELIER_PORTUAIRE', label: 'Batelier et opérateur portuaire', obligations: ['Droits d’embarquement et de port selon règle'], kind: 'INDIFFERENT', nifExpected: false, objectCategory: 'AUTRE', vertical: 'ports', fields: [{ name: 'port', label: 'Port d’attache', type: 'texte', required: true }, { name: 'embarcation', label: 'Nom de l’embarcation', type: 'texte', required: false }] },
  { code: 'OCCUPANT_DOMAINE_PUBLIC', label: 'Occupant du domaine public', obligations: ['Redevance d’occupation selon règle'], kind: 'INDIFFERENT', nifExpected: false, vertical: 'marches', fields: [commune, quartier, { name: 'emprise', label: 'Nature de l’occupation (terrasse, étal, emprise)', type: 'texte', required: true }] },
  { code: 'ASSOCIATION', label: 'Association', obligations: ['Exonérations éventuelles sur preuve (registre des exonérations)'], kind: 'PERSONNE_MORALE', nifExpected: false, fields: [commune, { name: 'reconnaissance', label: 'Référence de reconnaissance (si disponible)', type: 'texte', required: false }] },
  { code: 'INSTITUTION_PUBLIQUE', label: 'Institution publique', obligations: ['Retenues à la source, loyers payés, déclarations selon règle'], kind: 'PERSONNE_MORALE', nifExpected: true, fields: [{ name: 'acte', label: 'Acte de création ou de nomination du représentant', type: 'texte', required: true }, nif] },
  { code: 'MANDATAIRE', label: 'Mandataire', obligations: ['Agit pour un mandant : mandat vérifié requis'], kind: 'INDIFFERENT', nifExpected: false, fields: [{ name: 'mandant', label: 'Nom ou identifiant du mandant', type: 'texte', required: true }, { name: 'mandat', label: 'Référence du mandat', type: 'texte', required: true }] },
  { code: 'DIASPORA', label: 'Membre de la diaspora', obligations: ['Selon les biens détenus à Kinshasa'], kind: 'PERSONNE_PHYSIQUE', nifExpected: false, fields: [commune, igf, { name: 'pays', label: 'Pays de résidence', type: 'texte', required: true }] },
];

export const ENROLMENT_PROFILE_CODES = ENROLMENT_PROFILES.map((p) => p.code);

/** Rappel affiché à chaque parcours. */
export const ROLE_DECLARATION_NOTICE = 'Déclarer un rôle n’établit ni la propriété ni une dette : votre déclaration ouvre une instruction par un agent.';
