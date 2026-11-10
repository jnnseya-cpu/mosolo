/**
 * Données de démonstration des postes de décision : fiches, file d'instruction, actes à produire et chiffres
 * illustratifs des maquettes du maître d'ouvrage (27/09/2026). TOUT est marqué [EXEMPLE] — non contractuel : ces
 * éléments ne passent jamais pour des chiffres réels ; les chiffres calculés sur les données du socle sont montrés à
 * part. Aucun nom de personne réelle. Données conservées (décision du 27/09/2026) ; jamais chargées hors démonstration.
 */
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { ajouterJours, chiffre, EXEMPLE, type Chiffre, type ProfilPoste } from './model.js';
import type { PostesService } from './service.js';

export const POSTES_DEMO = {
  users: { autorite: 'postes-u-autorite-habilitee' },
  centreCt: 'CENTRE-CT-EX-01',
  rfckDg: 'vc-u-direction-rfck',
  ministreTransports: 'vc-u-ministre-transports',
} as const;

export function seedPostes(ctx: AppContext, svc: PostesService): void {
  if (svc.dossiers.count() > 0) return;
  const u = (id: string): User | undefined => ctx.users.get(id);
  const today = svc.today();
  const at = svc.now();
  const d = (n: number) => ajouterJours(today, n);
  if (!u(POSTES_DEMO.users.autorite)) {
    ctx.users.add({ id: POSTES_DEMO.users.autorite, name: 'Autorité habilitée — instance de contrôle (démo)', roles: ['R36'], entity: 'INSTANCE-CONTROLE-DEMO' });
  }
  const X = (s: string) => `${s} ${EXEMPLE}`;

  // ——— Fiches du Gouverneur (maquette 1) ———
  const rfck = u(POSTES_DEMO.rfckDg);
  if (rfck && ctx.ext['vehicules-controle']) {
    svc.soumettreDossier(rfck, {
      categorie: 'SUSPENSION_TIERS', destinataireRole: 'R01', objet: 'Suspendre l’habilitation d’un centre de contrôle technique agréé',
      demandeurLibelle: 'Direction générale de la RFCK', serviceInstructeur: 'Service de contrôle interne de la RFCK', validationAmont: 'Instruit par le service de contrôle interne',
      enjeu: {
        texte: X('1 centre, 3 412 procès-verbaux sur 90 jours, taux de réussite de 99,4 % contre 78 % pour la moyenne des centres'), etat: 'COMPTAGE', nombre: '1 centre', commune: 'Limete',
        figures: [{ libelle: 'Procès-verbaux en 90 jours', valeur: '3 412', unite: 'PV' }, { libelle: 'Taux de réussite du centre', valeur: '99,4', unite: '%' }, { libelle: 'Moyenne des centres', valeur: '78', unite: '%' }],
      },
      echeance: d(5), consequenceSilence: 'Décision attendue sous 5 jours ; au-delà, les procès-verbaux litigieux continuent de produire des effets',
      fondement: ['Arrêté ministériel du 12 novembre 2025', 'Décision d’habilitation du centre'],
      position: { recommandation: 'Suspension recommandée pour 30 jours, le temps d’un contrôle sur place.', reserves: ['2 des 4 signaux peuvent s’expliquer par la clientèle du centre.'] },
      siRien: 'Le centre continue d’émettre ; les vignettes déjà délivrées resteront contestables a posteriori',
      pieces: [{ libelle: X('Rapport du contrôle interne (analytique de conformité des centres)'), reference: 'RFCK-CI-EX-01' }, { libelle: X('Décision d’habilitation du centre'), reference: 'AGR-CENTRE-CT-EX-01' }],
      libellesActions: { APPROUVER: 'Approuver la suspension', REFUSER: 'Refuser', DELEGUER: 'Déléguer au ministre des Transports', COMPLEMENT: 'Demander un complément d’enquête' },
      delegationSuggeree: { userId: POSTES_DEMO.ministreTransports, libelle: 'Ministre provincial des Transports' },
      execution: {
        acte: 'DECISION', libelle: 'Décision motivée de suspension de l’habilitation du centre (route POST /v1/centres-agrees/:id/suspension, direction générale de la RFCK)',
        responsable: { entity: 'RFCK', role: 'R06', libelle: 'Direction générale de la RFCK' }, delaiJours: 5, lien: { type: 'CENTRE_SUSPENSION', centreId: POSTES_DEMO.centreCt },
      },
      individuel: false, entities: ['RFCK', 'MIN-TRANSPORTS'],
    }, { exemple: true, preparation: 'INSTRUIT', transmis: true });
  }
  const minfin = u('u-ministre-finances');
  if (minfin && ctx.ext.planification) {
    svc.soumettreDossier(minfin, {
      categorie: 'ARBITRAGE_ASSIGNATIONS', destinataireRole: 'R01', objet: 'Arbitrer l’assignation de recettes du deuxième trimestre',
      demandeurLibelle: 'Ministère provincial des Finances', serviceInstructeur: 'Finances', validationAmont: 'Note de 2 pages jointe',
      enjeu: { texte: X('Écart de 12 % sur le trimestre écoulé · 24 communes'), etat: 'RATIO', nombre: '24 communes', figures: [{ libelle: 'Écart sur le trimestre écoulé', valeur: '12', unite: '%' }] },
      echeance: d(11), consequenceSilence: 'Sans arbitrage, les assignations du trimestre restent celles de l’exercice précédent.',
      fondement: [X('Assignations budgétaires de l’exercice — référence d’acte fictive de démonstration')],
      position: { recommandation: X('Arbitrage proposé par le ministère des Finances sur la base de l’écart constaté.'), reserves: [] },
      siRien: 'Les assignations du trimestre restent inchangées ; l’écart continue de se creuser.',
      pieces: [{ libelle: X('Note de 2 pages du ministère des Finances') }],
      execution: { acte: 'NOTE', libelle: 'Notification des assignations arbitrées aux régies', responsable: { entity: 'MINFIN', role: 'R05', libelle: 'Ministère provincial des Finances' }, delaiJours: 7 },
      individuel: false, entities: ['MINFIN'],
    }, { exemple: true, preparation: 'INSTRUIT', transmis: true });
  }
  // ——— File d'instruction du cabinet (maquette 2) : exonération incomplète, changement de compte à instruire ———
  const dg = u('u-dg-dgipk');
  if (dg) {
    svc.soumettreDossier(dg, {
      categorie: 'EXONERATION_DEGREVEMENT', destinataireRole: 'R01', objet: 'Exonération sollicitée — société immobilière',
      demandeurLibelle: 'Direction générale de la DGIPK', serviceInstructeur: 'DGIPK — service des exonérations', validationAmont: null,
      enjeu: { texte: X('Exonération au-delà du seuil de délégation'), etat: 'CONSTATE', nombre: '1 contribuable' },
      echeance: d(15), consequenceSilence: 'L’impôt reste dû selon la règle en vigueur.', fondement: [],
      position: { recommandation: X('Instruction en cours.'), reserves: [] }, siRien: 'L’impôt reste dû.', pieces: [],
      execution: { acte: 'DECISION', libelle: 'Décision d’exonération (si approuvée)', responsable: { entity: 'DGIPK', role: 'R06', libelle: 'DGIPK' }, delaiJours: 10 },
      individuel: true, finaliteNominative: X('Instruction de la demande d’exonération par le cabinet du Gouverneur'), manque: 'Base légale non produite', entities: ['DGIPK'],
    }, { exemple: true });
  }
  const tresor = u('u-tresor');
  if (tresor) {
    svc.soumettreDossier(tresor, {
      categorie: 'CHANGEMENT_COMPTE_BENEFICIAIRE', destinataireRole: 'R01', objet: 'Changement de compte bénéficiaire — taxe antennes',
      demandeurLibelle: 'Trésor provincial', serviceInstructeur: 'Trésor — coffre des bénéficiaires', validationAmont: 'Double validation technique obtenue',
      enjeu: { texte: X('Toutes les recettes de la taxe antennes'), etat: 'COMPTAGE', nombre: '1 compte public' },
      echeance: d(10), consequenceSilence: 'Le compte en vigueur reste inchangé.', fondement: [],
      position: { recommandation: '', reserves: [] }, siRien: 'Le compte en vigueur reste inchangé.', pieces: [{ libelle: X('Double validation technique du coffre') }],
      execution: { acte: 'DECISION', libelle: 'Changement effectué au coffre par double validation technique (jamais depuis un poste de décision)', responsable: { entity: 'TRESOR', role: 'R19', libelle: 'Gestionnaires du coffre' }, delaiJours: 10 },
      individuel: false, manque: 'avis juridique manquant', entities: ['TRESOR'],
    }, { exemple: true, preparation: 'A_INSTRUIRE' });
  }
  // ——— Fiche du ministre des Finances (maquette 4) ———
  if (dg) {
    svc.soumettreDossier(dg, {
      categorie: 'EXONERATION_DEGREVEMENT', destinataireRole: 'R05', destinataireEntity: 'MINFIN', objet: 'Exonération sollicitée au titre du Code des investissements',
      demandeurLibelle: 'Direction générale de la DGIPK', serviceInstructeur: 'DGIPK — service des exonérations', validationAmont: 'Instruction du service achevée',
      enjeu: { texte: X('Au-delà du seuil de délégation · avis du Gouvernement provincial requis'), etat: 'CONSTATE', nombre: '1 contribuable' },
      echeance: d(8), consequenceSilence: 'Sans décision, la demande reste pendante et l’impôt reste dû.',
      fondement: [X('Code des investissements — article à préciser par le service')],
      position: { recommandation: 'Rejet recommandé : pièces justificatives incomplètes.', reserves: [] },
      siRien: 'La demande reste pendante ; l’impôt reste dû.', pieces: [{ libelle: X('Demande et pièces justificatives (nominatif, finalité déclarée requise)') }],
      execution: { acte: 'DECISION', libelle: 'Notification de la décision au demandeur', responsable: { entity: 'DGIPK', role: 'R06', libelle: 'DGIPK' }, delaiJours: 5 },
      individuel: true, finaliteNominative: X('Décision du ministre des Finances sur une exonération au-delà du seuil de délégation'), entities: ['DGIPK', 'MINFIN'],
    }, { exemple: true, preparation: 'INSTRUIT', transmis: true });
  }
  // Ordre du jour : la suspension du centre montée en première position par le cabinet (motif enregistré).
  const dircab = u('u-dircab');
  const ct = svc.dossiers.findOne((x) => x.categorie === 'SUSPENSION_TIERS' && !!x.exemple);
  if (dircab && ct) {
    try { svc.ordonner(dircab, { ficheId: `DOSSIER:${ct.id}`, action: 'MONTER', motif: X('Effet immédiat sur les usagers : à trancher en premier') }); } catch { /* corbeille indisponible */ }
  }

  // ——— Actes à produire (maquette 3) et décisions non encore exécutées (maquette 2) ———
  const exe = (e: { objet: string; decideLe: number; autorite: string; acte: 'ARRETE' | 'NOTE' | 'CONVENTION' | 'INSTRUCTION' | 'DESIGNATION' | 'DECISION'; libelle: string; entity: string; role?: 'R03' | 'R04' | 'R05' | 'R06' | 'R13' | 'R22'; responsable: string; echeance: number; etat: 'NON_ENGAGE' | 'EN_COURS' | 'PRODUIT' | 'NOTIFIE' | 'EXECUTE'; note?: string; blocage?: string; preuve?: { reference: string; publieLe: number } }) => {
    svc.executions.insert({
      id: svc.ids.next('EXEC'), decision: { objet: X(e.objet), date: `${d(e.decideLe)}T09:00:00.000Z`, autorite: e.autorite }, acte: e.acte, acteLibelle: X(e.libelle),
      responsable: { entity: e.entity, ...(e.role ? { role: e.role } : {}), libelle: e.responsable }, echeance: d(e.echeance), etat: e.etat, ...(e.note ? { note: e.note } : {}),
      ...(e.blocage ? { blocage: { cause: e.blocage, declareLe: `${d(-3)}T09:00:00.000Z`, declarePar: 'u-juriste-redacteur' } } : {}),
      ...(e.preuve ? { preuve: { reference: X(e.preuve.reference), publieLe: d(e.preuve.publieLe), version: '1' } } : {}),
      ...(e.etat === 'EXECUTE' ? { executeLe: `${d(e.preuve?.publieLe ?? 0)}T09:00:00.000Z` } : {}),
      historique: [{ at, by: 'seed:postes', etat: e.etat, motif: `${EXEMPLE} donnée de démonstration non contractuelle` }], relances: [], justifications: [], exemple: true,
    });
  };
  exe({ objet: 'Paiement fractionné de l’impôt foncier et de l’IRL', decideLe: -44, autorite: 'Gouverneur', acte: 'ARRETE', libelle: 'Arrêté — paiement fractionné IF et IRL', entity: 'MINFIN', role: 'R13', responsable: 'Direction juridique', echeance: -34, etat: 'EN_COURS', blocage: 'arbitrage de taux' });
  exe({ objet: 'Convention de données avec la RFCK', decideLe: -5, autorite: 'Gouverneur', acte: 'CONVENTION', libelle: 'Convention de données — RFCK', entity: 'MIN-TRANSPORTS', role: 'R04', responsable: 'Ministère des Transports', echeance: 6, etat: 'EN_COURS', note: 'projet rédigé' });
  exe({ objet: 'Zéro espèces en fourrière', decideLe: -12, autorite: 'Gouverneur', acte: 'NOTE', libelle: 'Note d’instruction — zéro espèces en fourrière', entity: 'RFCK', role: 'R06', responsable: 'Direction générale de la RFCK', echeance: 3, etat: 'NOTIFIE', note: 'produit le ' + d(-7).split('-').reverse().slice(0, 2).join('/') + ' · notifié aux 6 sites · exécution à constater', preuve: { reference: 'Note d’instruction n° EX-FRR-01', publieLe: -7 } });
  exe({ objet: 'Désignation du comité de pilotage', decideLe: -20, autorite: 'Gouverneur', acte: 'DESIGNATION', libelle: 'Désignation du comité de pilotage', entity: 'GOUVERNORAT', role: 'R03', responsable: 'Secrétariat exécutif', echeance: -12, etat: 'EXECUTE', note: 'publié', preuve: { reference: 'Arrêté n° 0214', publieLe: -15 } });
  exe({ objet: 'Protocole de données avec un distributeur d’électricité', decideLe: -9, autorite: 'Gouverneur', acte: 'CONVENTION', libelle: 'Protocole de données — distributeur d’électricité', entity: 'GOUVERNORAT', role: 'R03', responsable: 'Secrétariat exécutif', echeance: 9, etat: 'PRODUIT', note: `signé le ${d(-9).split('-').reverse().slice(0, 2).join('/')} · convention non transmise`, preuve: { reference: 'Protocole signé EX-PROT-01', publieLe: -9 } });
  exe({ objet: 'Ouverture d’enquête — centre communal de Ndjili', decideLe: -3, autorite: 'Gouverneur', acte: 'INSTRUCTION', libelle: 'Ouverture d’enquête — centre communal de Ndjili', entity: 'AUDIT', role: 'R22', responsable: 'Inspection provinciale', echeance: 2, etat: 'EN_COURS', note: `Inspection saisie · rapport attendu le ${d(7).split('-').reverse().slice(0, 2).join('/')}` });

  // ——— Habilitation de consultation d'une autre autorité (maquette 5) ———
  const autorite = u(POSTES_DEMO.users.autorite);
  if (autorite && dircab) {
    const au = '2027-12-31' > today ? '2027-12-31' : d(365);
    try {
      svc.declarerHabilitation(dircab, { userId: autorite.id, perimetre: { libelle: 'recettes provinciales agrégées', entities: [], communes: [], categories: [] }, au, motif: X('Accès en consultation d’une instance de contrôle — portée déclarée à l’ouverture des droits') });
    } catch { /* durée hors bornes : aucune habilitation de démonstration */ }
  }

  // ——— Chiffres illustratifs des maquettes (jamais présentés comme réels) ———
  const src = (chemin: string) => ({ libelle: 'Maquette du maître d’ouvrage (illustration)', chemin: ['/poste-de-decision', chemin], api: '/v1/postes/accueil' });
  const ill = (profil: ProfilPoste, bloc: string, ordre: number, c: Omit<Chiffre, 'etatLabel' | 'date' | 'exemple'> | null, texte?: { titre: string; detail: string; enjeu?: string }, ministere?: string) => {
    svc.illustrations.insert({
      id: `ILL-${profil}-${bloc}-${ordre}`, profil, bloc, ordre, ...(ministere ? { ministere } : {}),
      ...(c ? { chiffre: chiffre({ ...c, date: at, exemple: true }) } : {}), ...(texte ? { texte } : {}),
    });
  };
  const md = (code: string, libelle: string, valeur: string, etat: 'ENCAISSE' | 'REGLE' | 'RAPPROCHE', comparaison: string, chemin: string) => ({
    code, libelle, valeur, unite: 'Md FC', etat, estimation: false, comparaison: { type: 'OBJECTIF' as const, libelle: comparaison, valeur: null, ecart: null, tendance: 'INDISPONIBLE' as const }, source: src(chemin),
  });
  ill('GOUVERNEUR', 'LA_VILLE', 1, md('ENCAISSE', 'Milliards FC encaissés', '68,4', 'ENCAISSE', 'Exercice en cours', '/poste-de-decision/recettes'));
  ill('GOUVERNEUR', 'LA_VILLE', 2, md('REGLE', 'Reçus en compte public', '66,1', 'REGLE', 'Exercice en cours', '/poste-de-decision/recettes'));
  ill('GOUVERNEUR', 'LA_VILLE', 3, md('RAPPROCHE', 'Appariés et comptabilisés', '64,7', 'RAPPROCHE', 'Exercice en cours', '/poste-de-decision/recettes'));
  ill('GOUVERNEUR', 'LA_VILLE', 4, { code: 'ECART_ASSIGNATION', libelle: 'Écart à l’assignation', valeur: '−9', unite: '%', etat: 'RATIO', estimation: false, comparaison: { type: 'OBJECTIF', libelle: 'Réf. contrat de performance', valeur: null, ecart: '−9 %', tendance: 'INDISPONIBLE' }, source: src('/poste-de-decision/communes') });
  ill('GOUVERNEUR', 'CE_QUI_NE_VA_PAS', 1, null, { titre: '1,2 Md FC non rapprochés depuis 4 jours', detail: 'Rappels de paiement non signés d’un prestataire · Trésorerie saisie', enjeu: '1,2 Md FC' });
  ill('GOUVERNEUR', 'CE_QUI_NE_VA_PAS', 2, null, { titre: 'Quatre communes sous 40 % de couverture', detail: 'Recensement locatif en retard sur le calendrier de février' });
  ill('GOUVERNEUR', 'CE_QUI_NE_VA_PAS', 3, null, { titre: '17 recours hors délai légal', detail: 'Concentrés sur deux centres communaux' });
  ill('GOUVERNEUR', 'COMMUNES', 1, null, { titre: 'Gombe, Limete, Kalamu, Ngaliema, Masina, Ndjili', detail: '+ 18 autres' });
  ill('DIRECTEUR_CABINET', 'FILE_INSTRUCTION', 1, null, { titre: '11 dossiers · 3 incomplets', detail: 'Prêts pour le Gouverneur : 3.' });
  ill('SECRETAIRE_EXECUTIF', 'INDICATEUR', 1, { code: 'EXECUTION_DANS_LE_DELAI', libelle: 'Décisions exécutées dans le délai', valeur: '78', unite: '%', etat: 'RATIO', estimation: false, comparaison: { type: 'OBJECTIF', libelle: '90 derniers jours', valeur: '100', ecart: '−22', tendance: 'INDISPONIBLE' }, source: src('/poste-de-decision/execution') });
  ill('SECRETAIRE_EXECUTIF', 'INDICATEUR', 2, { code: 'ACTES_EN_RETARD', libelle: 'Actes en retard', valeur: '6', unite: 'actes', etat: 'COMPTAGE', estimation: false, comparaison: { type: 'SEUIL', libelle: 'Dont 2 au-delà de 30 jours', valeur: '2', ecart: null, tendance: 'INDISPONIBLE' }, source: src('/poste-de-decision/retards') });
  ill('MINISTRE', 'MES_RECETTES', 1, md('RECETTE_IMPOT_FONCIER', 'Impôt foncier', '41,2', 'RAPPROCHE', '71 % de l’objectif', '/poste-de-decision/mes-recettes'), undefined, 'MINFIN');
  ill('MINISTRE', 'MES_RECETTES', 2, md('RECETTE_REVENUS_LOCATIFS', 'Revenus locatifs', '17,9', 'RAPPROCHE', '38 % de l’objectif', '/poste-de-decision/mes-recettes'), undefined, 'MINFIN');
  ill('MINISTRE', 'MES_EXCEPTIONS', 1, null, { titre: 'Écart de rapprochement sur 3 jours', detail: 'Canal mobile d’un opérateur · trésorerie informée' }, 'MINFIN');
  ill('MINISTRE', 'MES_EXCEPTIONS', 2, null, { titre: 'Délais de recours tenus à 94 %', detail: 'Au-dessus de la cible du trimestre' }, 'MINFIN');
  ill('AUTORITE_HABILITEE', 'RECETTES', 1, md('ENCAISSE', 'Md FC encaissés', '68,4', 'ENCAISSE', 'Exercice en cours', '/poste-de-decision/recettes'));
  ill('AUTORITE_HABILITEE', 'RECETTES', 2, md('RAPPROCHE', 'Md FC rapprochés', '64,7', 'RAPPROCHE', 'Exercice en cours', '/poste-de-decision/recettes'));
  const part = (code: string, libelle: string, valeur: string, detail: string) => ({ code, libelle, valeur, unite: '% de l’objectif', etat: 'RATIO' as const, estimation: false, comparaison: { type: 'OBJECTIF' as const, libelle: detail || 'Part de l’objectif de l’exercice', valeur: '100', ecart: null, tendance: 'INDISPONIBLE' as const }, source: src('/poste-de-decision/recettes') });
  ill('AUTORITE_HABILITEE', 'PAR_CATEGORIE', 1, part('IMPOT_FONCIER', 'Impôt foncier', '71', ''));
  ill('AUTORITE_HABILITEE', 'PAR_CATEGORIE', 2, part('REVENUS_LOCATIFS', 'Revenus locatifs', '38', 'Recensement en cours dans les communes pilotes'));
  ill('AUTORITE_HABILITEE', 'PAR_CATEGORIE', 3, part('VEHICULES', 'Véhicules et circulation', '52', 'Campagne de contrôle technique en cours'));
  ill('AUTORITE_HABILITEE', 'PAR_CATEGORIE', 4, part('PATENTE', 'Patente et débits de boissons', '63', ''));
  ill('AUTORITE_HABILITEE', 'REALISATIONS', 1, null, { titre: 'Voirie et drainage', detail: 'Publié — détail par commune sur le tableau public de transparence' });

  ctx.audit.append({ actor: { kind: 'system', id: 'seed:postes' }, action: 'postes.demo_seeded', resourceType: 'poste', resourceId: 'EXEMPLE', details: { dossiers: svc.dossiers.count(), executions: svc.executions.count(), illustrations: svc.illustrations.count(), note: `${EXEMPLE} données de démonstration non contractuelles` } });
}
