/**
 * Catalogue des titres par module (§ 19A.4 ; § H.11.4) — types amorcés au statut ACTE_REQUIS : visibles au catalogue
 * public, NON ACTIVABLES (aucune vente, aucun montant) tant que l'acte fondant la recette n'est pas enregistré et qu'une
 * règle de tarif ACTIVE n'existe pas au registre. Aucun tarif n'est porté ici.
 *
 * Les seuils d'ambre sont les valeurs INDICATIVES du tableau § 19A.4 (fixées par la fiche de configuration de chaque
 * module, § 10A.4) ; l'affichage suit la règle 50 % / 1 % décidée par le maître d'ouvrage (§ H.11).
 * Les types wewa et bus restent déclarés par RakaPay.
 */
import type { CredentialType, ValidityPolicy } from './model.js';
import type { TitresService } from './service.js';

const DAY_MIN = 1440;
const base = (v: Partial<ValidityPolicy> & Pick<ValidityPolicy, 'model' | 'amberMinutes'>): ValidityPolicy =>
  ({ toleranceMinutes: 0, startMode: 'PAIEMENT', extendable: false, refundable: false, ...v });
const act = (ref: string, note: string): CredentialType['legalAct'] => ({ ref, status: 'ACTE_REQUIS', note });

type Def = Omit<CredentialType, 'id' | 'version' | 'createdAt' | 'createdBy'>;

/** Types amorcés (code stable ; module du catalogue § 11 ; préfixe visuel propre au service). */
export const ACTE_REQUIS_TYPES: Def[] = [
  { code: 'VIG-ANNUELLE', module: '11', moduleLabel: 'Véhicules et circulation', label: 'Vignette automobile (impôt sur les véhicules automoteurs)', prefix: 'VIG', entity: 'DGIPK',
    validity: base({ model: 'ANNUEL_EXERCICE', amberMinutes: 30 * DAY_MIN }), transferable: false, plateBound: true, supports: ['AUTOCOLLANT', 'QR_STATIQUE', 'PLAQUE', 'SMS'],
    legalAct: act('J3', 'Barèmes véhicules à certifier ; vignette autocollante à QR et contrôle par plaque (§ 19A.4).'), demo: false },
  { code: 'TSC-ANNUELLE', module: '11', moduleLabel: 'Véhicules et circulation', label: 'Taxe spéciale de circulation routière', prefix: 'TSC', entity: 'DGIPK',
    validity: base({ model: 'ANNUEL_EXERCICE', amberMinutes: 30 * DAY_MIN }), transferable: false, plateBound: true, supports: ['AUTOCOLLANT', 'QR_STATIQUE', 'PLAQUE', 'SMS'],
    legalAct: act('J1', 'Taxe d’intérêt commun : clé et barème à certifier ; même objet véhicule et même scan que la vignette.'), demo: false },
  { code: 'LIC-TAXI', module: '12', moduleLabel: 'Autorisations de transport', label: 'Licence de transport — taxi', prefix: 'LIC', entity: 'DGTK',
    validity: base({ model: 'ANNUEL_EXERCICE', amberMinutes: 7 * DAY_MIN }), transferable: false, plateBound: true, supports: ['AUTOCOLLANT', 'CARTE', 'PLAQUE'],
    legalAct: act('J1', 'Licence au mois ou à l’année selon l’acte ; autocollant QR sur le véhicule et carte du conducteur.'), demo: false },
  { code: 'LIC-BUS', module: '12', moduleLabel: 'Autorisations de transport', label: 'Licence de transport — bus et minibus', prefix: 'LIC', entity: 'DGTK',
    validity: base({ model: 'ANNUEL_EXERCICE', amberMinutes: 7 * DAY_MIN }), transferable: false, plateBound: true, supports: ['AUTOCOLLANT', 'CARTE', 'PLAQUE'],
    legalAct: act('J1', 'Licence au mois ou à l’année selon l’acte ; contrôle par plaque.'), demo: false },
  { code: 'LIC-MOTO', module: '12', moduleLabel: 'Autorisations de transport', label: 'Licence de transport — moto-taxi', prefix: 'LIC', entity: 'DGTK',
    validity: base({ model: 'ANNUEL_EXERCICE', amberMinutes: 7 * DAY_MIN }), transferable: false, plateBound: true, supports: ['AUTOCOLLANT', 'CARTE', 'PLAQUE'],
    legalAct: act('J28', 'Articulation avec le pass wewa (RakaPay) à arrêter par l’acte.'), demo: false },
  { code: 'PAT-ANNUELLE', module: '10', moduleLabel: 'Registre des activités et patentes', label: 'Patente — certificat d’exploitation', prefix: 'PAT', entity: 'DGTK',
    validity: base({ model: 'ANNUEL_EXERCICE', amberMinutes: 30 * DAY_MIN }), transferable: false, plateBound: false, supports: ['QR_STATIQUE', 'CODE_COURT'],
    legalAct: act('J1', 'Taxe d’intérêt commun : QR apposé sur la devanture, contrôle par identifiant de l’établissement.'), demo: false },
  { code: 'PEA-PASSAGE', module: '25', moduleLabel: 'Péage provincial', label: 'Péage — passage (usage unique)', prefix: 'PEA', entity: 'DGTK',
    validity: base({ model: 'USAGE_UNIQUE', periodDays: 1, amberMinutes: 0 }), transferable: false, plateBound: true, supports: ['PLAQUE', 'QR_STATIQUE', 'SMS'],
    legalAct: act('J1', 'Péage provincial : acte requis ; reçu électronique lié à la plaque.'), demo: false },
  { code: 'PEA-CARNET', module: '25', moduleLabel: 'Péage provincial', label: 'Péage — carnet de passages', prefix: 'PEA', entity: 'DGTK',
    validity: base({ model: 'CARNET_USAGES', amberMinutes: 0 }), transferable: false, plateBound: true, supports: ['PLAQUE', 'QR_STATIQUE', 'SMS'],
    legalAct: act('J1', 'Nombre de passages et durée du carnet fixés par l’acte (non paramétrés).'), demo: false },
  { code: 'PEA-ABONNEMENT', module: '25', moduleLabel: 'Péage provincial', label: 'Péage — abonnement', prefix: 'PEA', entity: 'DGTK',
    validity: base({ model: 'ABONNEMENT', amberMinutes: 0 }), transferable: false, plateBound: true, supports: ['PLAQUE', 'QR_STATIQUE', 'SMS'],
    legalAct: act('J1', 'Durée de l’abonnement fixée par l’acte (non paramétrée).'), demo: false },
  { code: 'CAR-BON', module: '22', moduleLabel: 'Carrières et recettes minières', label: 'Bon de sortie de carrière (par camion)', prefix: 'CAR', entity: 'DGTK',
    validity: base({ model: 'USAGE_UNIQUE', periodDays: 1, amberMinutes: 0 }), transferable: false, plateBound: true, supports: ['QR_STATIQUE', 'CODE_COURT', 'PLAQUE'],
    legalAct: act('J1', 'Base légale des carrières à certifier ; QR à usage unique lié au camion et au chargement.'), demo: false },
  { code: 'EMB-CARTE', module: '13', moduleLabel: 'Embarquement et débarquement', label: 'Carte d’embarquement', prefix: 'EMB', entity: 'DGTK',
    validity: base({ model: 'USAGE_UNIQUE', periodDays: 1, amberMinutes: 0 }), transferable: false, plateBound: false, supports: ['QR_STATIQUE', 'CODE_COURT', 'SMS'],
    legalAct: act('J30', 'Cadrage sectoriel préalable ; QR à usage unique consommé au scan, code court par SMS.'), demo: false },
  { code: 'ACC-ACCOSTAGE', module: '24', moduleLabel: 'Ports, embarcations et accostage', label: 'Titre d’accostage (embarcation)', prefix: 'ACC', entity: 'DGTK',
    validity: base({ model: 'JOURNALIER', dayMode: 'CALENDAIRE', amberMinutes: 0 }), transferable: false, plateBound: false, supports: ['QR_STATIQUE', 'CODE_COURT'],
    legalAct: act('J30', 'Accostage en ports privés : reçu électronique lié à l’embarcation, après cadrage.'), demo: false },
];

/** Amorce les types « acte requis » (idempotent : un type déjà déclaré n'est pas redéfini). */
export function defineActeRequisTypes(svc: TitresService): void {
  for (const t of ACTE_REQUIS_TYPES) if (!svc.types.findOne((x) => x.code === t.code)) svc.defineType(t, 'catalogue-19A4');
}
