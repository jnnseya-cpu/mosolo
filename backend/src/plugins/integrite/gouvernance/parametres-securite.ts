/**
 * Paramètres du registre des seuils propres aux contrôles de sécurité, d'accès et d'audit (lot « sécurité ») :
 * élévation juste-à-temps, extraction massive à trois visas, prévention des fuites (DLP), appareils et plausibilité
 * GPS, données de mission hors ligne, plafonds de références de paiement par canal et par agent, clés d'accès FIDO2,
 * scellement du journal. TOUTES les valeurs sont PAR_DEFAUT — à confirmer par le maître d'ouvrage (acte à enregistrer
 * par le circuit à deux personnes du registre). « 0 » signifie « non fixé » : contrôle bloquant inactif, jamais une
 * valeur inventée.
 *
 * Fichier sans dépendance d'exécution (import de type seulement) : lisible par tous les modules sans cycle d'import.
 */
import type { ParamDefinition, ParamValue } from './parametres.js';
import { paramForEntity } from './parametres-entites.js';

const FILE = 'backend/src/plugins/integrite/gouvernance/parametres-securite.ts';
const R = (id: string, label: string, category: string, value: ParamValue, unit: string, bounds: { min?: number; max?: number } = {}, description?: string): ParamDefinition => ({
  id, label, category, value, unit, owner: 'REGISTRE', source: { file: FILE, constant: 'PARAMETRES_SECURITE', exported: true }, ...bounds, ...(description ? { description } : {}),
});

/** Canaux de génération des références de paiement (repris de modules/payments/service.ts PAYMENT_CHANNELS). */
export const REFERENCE_CHANNELS = ['MOBILE_MONEY', 'BANK', 'CARD', 'AGENT_POINT', 'USSD', 'QR', 'TRANSFER'] as const;

const NOT_SET = '0 = non fixé (aucun blocage) : à fixer par le maître d’ouvrage.';

export const PARAMETRES_SECURITE: ParamDefinition[] = [
  // Accès privilégié juste-à-temps (§ 12.1, § 12.5)
  R('acces.elevation_duree_max_min', 'Élévation privilégiée juste-à-temps : durée maximale', 'Accès privilégiés', 120, 'min', { min: 5, max: 720 },
    'Expiration automatique : l’élévation cesse d’elle-même à l’échéance, sans action humaine.'),
  R('acces.revue_privileges_auto', 'Revue mensuelle des accès privilégiés : ouverture automatique le 1er du mois', 'Accès privilégiés', true, 'oui/non', {}),
  // Extraction massive (§ 12.3, § 12.5, § 25.1, § 31.1)
  R('socle.export_massif_lignes', 'Export de données : au-delà de ce nombre de lignes, circuit à trois visas', 'Extraction et fuite de données', 5000, 'lignes', { min: 1, max: 100_000_000 },
    'En deçà : export signé par une personne habilitée avec motif et second facteur (circuit historique). Au-delà : demandeur motivé → responsable des données → comité des données.'),
  R('socle.export_expiration_h', 'Export massif chiffré : durée de mise à disposition', 'Extraction et fuite de données', 24, 'h', { min: 1, max: 720 }),
  R('dlp.lectures_max', 'Lecture massive (DLP) : consultations de données personnelles par une personne sur la fenêtre', 'Extraction et fuite de données', 200, 'lectures', { min: 5, max: 1_000_000 },
    'Au-delà : alerte immédiate au responsable sécurité et à l’audit ; aucune sanction automatique.'),
  R('dlp.fenetre_min', 'Lecture massive (DLP) : fenêtre glissante', 'Extraction et fuite de données', 10, 'min', { min: 1, max: 1440 }),
  // Appareils et GPS (§ 25.1, § 40)
  R('appareil.comptes_max', 'Empreinte d’appareil : nombre de comptes distincts servis avant alerte', 'Appareils et géolocalisation', 1, 'comptes', { min: 1, max: 100 },
    'Les sessions sur appareil partagé déclaré (guichet) sont exclues.'),
  R('gps.vitesse_max_kmh', 'Plausibilité GPS : vitesse maximale entre deux actions de terrain successives', 'Appareils et géolocalisation', 150, 'km/h', { min: 5, max: 2000 }),
  R('gps.distance_min_m', 'Plausibilité GPS : déplacement ignoré en deçà (imprécision)', 'Appareils et géolocalisation', 500, 'm', { min: 0, max: 100_000 }),
  // Données de mission hors ligne (§ 15.1, § 15.4, ARB-68)
  R('terrain.donnees_mission_ttl_h', 'Données de mission hors ligne : expiration automatique sur le terminal', 'Appareils et géolocalisation', 72, 'h', { min: 1, max: 720 },
    'ARB-68 : durée de vie des données de mission sur le terminal ; appliquée par l’application terrain.'),
  // Plafonds de références de paiement (§ 18.4, H.10)
  R('plafonds.agent.alerte_jour', 'Références de paiement générées par un même agent : seuil d’alerte journalier', 'Plafonds de références', 50, 'références', { min: 0, max: 100_000 }),
  R('plafonds.agent.max_jour', 'Références de paiement générées par un même agent : plafond journalier bloquant', 'Plafonds de références', 0, 'références', { min: 0, max: 100_000 }, NOT_SET),
  ...REFERENCE_CHANNELS.flatMap((c) => [
    R(`plafonds.canal.${c.toLowerCase()}.alerte_jour`, `Références de paiement — canal ${c} : seuil d’alerte journalier`, 'Plafonds de références', 0, 'références', { min: 0, max: 10_000_000 }, NOT_SET),
    R(`plafonds.canal.${c.toLowerCase()}.max_jour`, `Références de paiement — canal ${c} : plafond journalier bloquant`, 'Plafonds de références', 0, 'références', { min: 0, max: 10_000_000 }, NOT_SET),
  ]),
  // Authentification résistante au hameçonnage (§ 31)
  R('socle.cle_acces_obligatoire', 'Clé d’accès (FIDO2) exigée des rôles sensibles qui en ont enregistré une (secours TOTP motivé)', 'Authentification', true, 'oui/non', {},
    'Un rôle sensible sans clé enregistrée se connecte par mot de passe et TOTP (période d’enrôlement) ; avec une clé, le TOTP reste un secours motivé, journalisé et alerté.'),
  // Scellement du journal (§ 25.1)
  R('scellement.controle_intervalle_h', 'Contrôle d’intégrité du journal (chaîne, copie WORM, racines publiées) : intervalle', 'Scellement du journal', 1, 'h', { min: 0, max: 168 }, '0 = contrôle planifié désactivé.'),
];

/**
 * Lecture d'un paramètre : valeur en vigueur du registre (module de gouvernance chargé) ou valeur par défaut.
 * `entity` (27/09/2026, facultatif) : pour un paramètre modulable par entité, la valeur de l'entité ou de sa lignée.
 */
export function securityParam(ctx: { ext: Record<string, unknown> }, id: string, entity?: string): ParamValue {
  if (entity) return paramForEntity(ctx, id, entity, () => securityParam(ctx, id));
  const gov = ctx.ext['integrite-gouvernance'] as { value?: (id: string) => ParamValue } | undefined;
  if (gov?.value) {
    try { return gov.value(id); } catch { /* paramètre inconnu du registre chargé : défaut ci-dessous */ }
  }
  const d = PARAMETRES_SECURITE.find((p) => p.id === id);
  if (!d) throw new Error(`Paramètre de sécurité inconnu : ${id}`);
  return d.value;
}

export const securityNum = (ctx: { ext: Record<string, unknown> }, id: string, entity?: string): number => Number(securityParam(ctx, id, entity));
export const securityBool = (ctx: { ext: Record<string, unknown> }, id: string): boolean => securityParam(ctx, id) === true;
