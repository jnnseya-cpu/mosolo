# Matrice de couverture — modules 27 à 40 (spécification fonctionnelle, lignes 1043–1304)

Légende : **BUILT** = existant, vérifié et testé ; **BUILT-NOW** = construit ou complété dans cette passe (avec test) ;
**ADAPTER** = connecteur externe ne pouvant être raccordé sans convention (adaptateur bac à sable + interface + tests + libellé [À RACCORDER]).
Chemins : `be/` = backend/src, `fe/` = frontend/src, `t/` = backend/test, `ft/` = frontend/test.
Écran transversal des indicateurs : `fe/modules/pilotage/IndicateursModules2740.tsx` (`/pilotage/indicateurs-modules-27-40`), API
`GET /v1/pilotage/indicateurs-modules/27-40` (`be/plugins/pilotage/indicateurs-modules-27-40.ts`), test `t/m27-40-indicateurs.test.ts`.

Partie I (principes communs) appliquée aux ajouts : audit chaîné sur chaque action (tous les services ajoutés appellent `ctx.audit.append`) ;
séparation des pouvoirs (assertDistinctPerson : lancement/généralisation de campagne, validation PV, activation de modèle, purge, suspension,
import de relevé) ; zéro espèce (visites, PV, avis sur plaque : mentions et aucun encaissement) ; IA/système propose, humain décide
(arrêt de campagne, classification documentaire, score anti-fraude) ; recours (contestation de PV, réponse motivée) ; inclusion (guichet pour
contestation et préférences, avis apposé sur la plaque) ; hors ligne (paquet d'inspection signé, PV en file locale) ; heure serveur
(échéances, expirations, numérotation) ; aucun seuil inventé (paramètres PAR_DEFAUT au registre des seuils, durées de conservation à 0 = non fixées).

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 27 | Déclarations adaptatives par objet/recette | be/plugins/fiscal/declarations.ts, assiette2026.ts ; /v1/fiscal/declarations ; fe/modules/fiscal/Declarations.tsx, Assiette2026.tsx | t/fiscal.test.ts:« pré-remplissage IRL depuis le bail… » ; « IF : règle ACTIVE ⇒ obligation opposable… » | BUILT |
| 27 | Préremplissage (données vérifiées) | declarations.ts `prefill` ; campagnes lot pré-rempli | t/fiscal.test.ts:« pré-remplissage IRL… » ; t/fiscalite-parcours-campagnes.test.ts | BUILT |
| 27 | Calcul explicable (entrées, formule, version, arrondis) | be/modules/assessment/service.ts `explanation` ; fe/pages/TaxpayerSpace.tsx (formule) | t/misc.test.ts:« AC-ASS-01 : l’explication… » | BUILT |
| 27 | Avis d’imposition numériques et imprimables | be/plugins/recouvrement/service.ts `issueAssessmentNotice` ; fe/modules/recouvrement/NoticeView.tsx (Imprimer) | t/recouvrement.test.ts:« avis d’imposition : mentions obligatoires… » ; ft/recouvrement.test.tsx | BUILT |
| 27 | Recalcul contrôlé + historique | be/modules/rules/recalculation.ts ; /v1/legal-rules/:id/impact-simulations, /v1/recalculations ; fe/pages/LegalRegister.tsx | t/recouvrement.test.ts:« simulation sans effet → décision motivée… » | BUILT |
| 27 | Produire l’obligation et son explication ; émettre avis et références | assessment/service.ts ; payments/service.ts | t/payments.test.ts:« AC-PAY-01… » | BUILT |
| 27 | Aucune logique fiscale dans l’UI/IA ; montants décimaux | be/modules/rules/formula.ts ; policy `assertAiMay` | t/legal.test.ts:« Évaluateur de formules (sans eval) » ; t/rules-hardening.test.ts ; t/ia.test.ts | BUILT |
| 27 | Indicateurs : obligations émises, erreurs corrigées, délai de liquidation | indicateurs-modules-27-40.ts (M27_*) ; écran Indicateurs 27–40 | t/m27-40-indicateurs.test.ts:« quatorze modules… » ; ft/modules-27-40.test.tsx | BUILT-NOW |
| 28 | Canaux (MM, banque, carte, USSD, QR, virement, points agréés) | shared PAYMENT_CHANNELS ; plugins/canaux ; fe/modules/canaux/* | t/canaux.test.ts ; t/payments.test.ts | BUILT |
| 28 | Référence unique idempotente, expirable, liée au montant | payments/service.ts | t/payments.test.ts:« AC-PAY-01 » ; t/money-path.test.ts:« une nouvelle référence ferme les références expirées… » | BUILT |
| 28 | 9 états (initié…contesté) | shared/domain.ts PaymentStatus/PAYMENT_TRANSITIONS | t/payments.test.ts ; t/tresor.test.ts:« contrepassation… », « remboursement… » | BUILT |
| 28 | Rappels signés anti-rejeu, serveur à serveur | payments/callback-signing.ts ; /v1/providers/:p/callbacks ; webhooks connecteurs | t/callback-hmac.test.ts ; t/payments.test.ts:« AC-PAY-02… » | BUILT |
| 28 | Quittance selon § 18.6 (provisoire → définitive) | receipts/service.ts | t/payments.test.ts:« AC-PAY-04 » | BUILT |
| 28 | Aucun compte privé ; bénéficiaires du coffre | vault/service.ts | t/treasury-vault.test.ts:« AC-BEN-01 » ; t/payments.test.ts:« bénéficiaire jamais fourni par le client » | BUILT |
| 28 | Connecteurs BitriPay, KODA, banques, opérateurs | payments/connectors/* (bac à sable + mode réel) | t/connectors.test.ts | ADAPTER |
| 28 | Indicateurs : succès, délai de confirmation, doublons évités | M28_* | t/m27-40-indicateurs.test.ts (M28 mesurés après paiement) | BUILT-NOW |
| 29 | Import des relevés banques/opérateurs (fichier + API) | be/plugins/tresor/releves.ts POST /v1/tresor/releves/depots ; treasury/routes.ts POST /v1/settlements/statements (proposition 202) ; fe/modules/tresor/ImportsReleves.tsx (page Trésor) | t/m29-releves-double-validation.test.ts:« dépôt de fichier : empreinte, totaux… » | BUILT-NOW |
| 29 | Contrôler l’intégrité (empreinte, lignes, totaux, période, rejeu) | treasury/service.ts `proposeImport` | t/m29…:« contrôle d’intégrité : observations non bloquantes… » ; « lecture du fichier… » | BUILT-NOW |
| 29 | Double validation des imports (R17/R18 distincts, négatif, idempotent) | `validateImport` ; POST …/:statementId/validation ; circuit TRESOR_IMPORT_RELEVE | t/m29…:« la proposition n’écrit rien ; le proposant ne valide pas… » ; « rejet motivé… » ; ft/modules-27-40.test.tsx:« module 29… » | BUILT-NOW |
| 29 | Imputation selon la nomenclature | plugins/tresor/service.ts (nomenclature, Comptabilisé) | t/tresor.test.ts:« imputation selon la nomenclature… » | BUILT |
| 29 | Comptes d’attente ; marquer « réglés » | tresor suspense ; applyStatement → REGLE/RAPPROCHE | t/tresor.test.ts:« Files d’exception et compte d’attente » ; t/m29… | BUILT |
| 29 | Indicateurs : délai de règlement ; fonds en attente | /v1/tresor/releves/indicateurs + /v1/tresor/suspense (ImportsReleves) ; M29_* | t/m29… ; t/m27-40-indicateurs.test.ts | BUILT-NOW |
| 30 | Appariement à trois voies | treasury/service.ts applyStatement (obligation–confirmation–relevé) | t/treasury-vault.test.ts:« lignes non appariées… » | BUILT |
| 30 | 4 files d’exception, délais par file avec escalade | plugins/tresor/service.ts listExceptions (48 h, alerte R17 `reconciliation.exception.aged`) ; fe/modules/tresor/ExceptionQueues.tsx | t/tresor.test.ts:« délai de 48 h : exception en retard signalée… » | BUILT |
| 30 | Proposer ou automatiser selon le seuil | plugins/tresor/appariement.ts | t/rapprochement-propose.test.ts | BUILT |
| 30 | Quittance définitive au rapprochement ; aucune correction silencieuse | receipts ; ledger contre-écriture | t/payments.test.ts:« AC-PAY-04 » ; t/treasury-vault.test.ts:« AC-LED-01 » | BUILT |
| 30 | Indicateurs : taux automatique, écart J+2, délai de traitement | M30_* | t/m27-40-indicateurs.test.ts | BUILT-NOW |
| 31 | Contenu, statuts, numérotation système, signature, statut dynamique | receipts/service.ts (Ed25519, compteur) | t/payments.test.ts:« AC-RCP-01 », « quittance altérée… » ; t/money-path.test.ts:« Quittances : numérotation… » | BUILT |
| 31 | Formes SMS, imprimée, PDF, vocale | preuves (SMS, /l), receipts/pdf.ts, canaux SVI menu « Mes quittances » | t/preuves.test.ts ; t/rapprochement-propose.test.ts:« Quittance PDF signée » ; t/canaux.test.ts:« SVI… » | BUILT |
| 31 | Vérification scan, code court, USSD, SVI | fe/pages/Verify.tsx ; /v1/public/short-codes ; ussd.ts | ft/tresor.test.tsx ; t/canaux.test.ts:« vérifie une quittance par USSD… », « vérification par code court… » | BUILT |
| 31 | Divulgation minimale ; duplicata marqué | receipts public view ; tresor duplicata | t/payments.test.ts:« AC-RCP-01 » ; t/tresor.test.ts:« …duplicata horodaté » | BUILT |
| 31 | Indicateurs : délai paiement→quittance, vérifications, suspectes | M31_* | t/m27-40-indicateurs.test.ts (M31_DELAI_QUITTANCE mesuré) | BUILT-NOW |
| 32 | Balance âgée par recette, commune, contribuable | recouvrement/service.ts `balance`, `arrears` ; fe/modules/recouvrement/RecoveryQueue.tsx | t/recouvrement.test.ts:« agents : segment, profil de risque… » | BUILT |
| 32 | Segmentation (ancienneté, montant, risque, recouvrabilité) | `segmentOf`, `riskOf`, `prescription` | idem | BUILT |
| 32 | Plans d’apurement si autorisés | requestPlan/decidePlan | t/recouvrement.test.ts:« aucun échéancier sans acte… » | BUILT |
| 32 | Priorité par rendement net | recouvrement/rendement.ts `priorities` ; fe Rendement.tsx | t/recouvrement-rendement.test.ts:« priorisation par rendement net estimé… » | BUILT |
| 32 | Alimenter les campagnes (module 33) | campagnes-relance.ts `segmentOf` (réutilise RecoveryService.segmentOf) | t/m33-campagnes-recouvrement.test.ts:« parcours… » | BUILT-NOW |
| 32 | Aucune pénalité hors règle | proposePenalty (règle ACTIVE) | t/recouvrement.test.ts:« pénalité : refusée hors règle… » | BUILT |
| 32 | Indicateurs : encours ; recouvrés bruts et nets | M32_* ; /v1/recouvrement/indicateurs | t/recouvrement-rendement.test.ts ; t/m27-40-indicateurs.test.ts | BUILT-NOW |
| 33 | Segments § 21.2 (7) | be/plugins/recouvrement/campagnes-relance.ts CAMPAIGN_SEGMENTS ; GET /v1/campagnes-recouvrement/referentiel ; fe/modules/recouvrement/CampagnesRecouvrement.tsx (page Campagnes) | t/m33…:« référentiel : 7 segments… » ; « parcours… » (litige exclu) | BUILT-NOW |
| 33 | Canaux SMS, appel, visite d’information | runSteps (sms+in-app, svi, visites) ; POST …/visites/:visitId ; GET …/visites-a-faire (vue minimale agent) | t/m33…:« parcours… » (APPEL + VISITE, visite rapportée) | BUILT-NOW |
| 33 | Tests (mesure avant généralisation, groupe témoin) | drawGroup, EN_TEST, measure, proposeGeneralisation/decideGeneralisation | t/m33…:« parcours… » (témoin non contacté, MEASURE_REQUIRED, généralisation distincte) | BUILT-NOW |
| 33 | Séquence J-15, J-3, J+1, J+15, J+30 | defaultSequence (RECOVERY_PROCEDURE, PAR DÉFAUT) ; pas de doublon avec le parcours standard | t/m33…:« parcours… » (J-15, J+1, J+15, J+30 orientation, idempotence) | BUILT-NOW |
| 33 | Arrêter au coût disproportionné (proposé, décidé par une personne) | measure → campaignYield (rendement.ts) → stopProposal ; POST …/arret/decision ; …/arret | t/m33…:« parcours… » ; « arrêt motivé… » ; ft/modules-27-40.test.tsx:« module 33… » | BUILT-NOW |
| 33 | Aucune contrainte en première étape | création : 422 COERCION_FORBIDDEN ; J+30 = orientation seulement après contact amiable | t/m33…:« référentiel… » (MISE_EN_DEMEURE et première étape refusées), « parcours… » (aucune proposition créée) | BUILT-NOW |
| 33 | Indicateurs : taux de régularisation ; coût par franc récupéré | GET /v1/campagnes-recouvrement/indicateurs ; M33_* | t/m33…:« parcours… » | BUILT-NOW |
| 34 | Missions : zones, listes | plugins/terrain/service.ts missions ; fe/modules/terrain/Supervision.tsx, pages/Field.tsx | t/terrain.test.ts | BUILT |
| 34 | Missions : itinéraires | inspection.ts `itinerary` ; GET /v1/terrain/missions/:id/itineraire ; paquet hors ligne ; Inspection.tsx | t/m35-inspection-constat.test.ts:« module 34 : itinéraire… » ; ft/modules-27-40.test.tsx:« module 35… » | BUILT-NOW |
| 34 | Objet provisoire GPS, photo, catégorie ; identifiant provisoire | POST /v1/terrain/findings/:id/objet-provisoire (OBJ-PROV-…, PROVISOIRE) ; Inspection.tsx « Créer la fiche provisoire » | t/m35…:« module 34 : … fiche provisoire… sans effet fiscal » | BUILT-NOW |
| 34 | Vagues (préparation → entretien) | plugins/fiscal/census.ts ; fe/modules/fiscal/Recensement.tsx | t/fiscalite-parcours-campagnes.test.ts | BUILT |
| 34 | Synchroniser et résoudre les conflits | modules/field/service.ts (lots signés, conflits) | t/field-appeals.test.ts:« deux agents divergents… » | BUILT |
| 34 | Aucun effet fiscal avant qualification | constat OBSERVE ; objet PROVISOIRE sans redevable | t/terrain.test.ts:« constat géolocalisé… aucune dette » ; t/m35…:« module 34… » | BUILT |
| 34 | Indicateurs : découverts, couverture, rejet qualité | terrain indicators ; M34_* | t/terrain.test.ts:« indicateurs de production… » ; t/m27-40-indicateurs.test.ts | BUILT-NOW |
| 35 | Dossiers d’inspection préparés avant visite | be/plugins/terrain/inspection.ts `prepare` ; POST /v1/terrain/missions/:id/dossiers-inspection ; fe/modules/terrain/Inspection.tsx | t/m35…:« dossiers préparés avant visite… » | BUILT-NOW |
| 35 | Disponibles hors ligne dans le paquet de mission | GET /v1/terrain/missions/:id/paquet-hors-ligne (signé, expirant) ; POST /v1/terrain/paquets/verification ; cache terminal (localStorage) | t/m35…:« …paquet hors ligne signé… » ; ft/modules-27-40.test.tsx:« module 35… » | BUILT-NOW |
| 35 | Constat numérique : photos, GPS, signature ou refus | constat terrain (photo, GPS) + PV (SIGNE / REFUS_DE_SIGNER / PERSONNE_ABSENTE) | t/m35…:« procès-verbal selon les pouvoirs… » | BUILT-NOW |
| 35 | PV selon les pouvoirs (modèles par pouvoir légal) | LEGAL_POWERS, PV_TEMPLATES (base légale À VÉRIFIER) ; GET /v1/terrain/inspection/modeles | t/m35…:« …POWER_NOT_HELD… » | BUILT-NOW |
| 35 | Géorepérer chaque constat | terrain submitFinding (distance, HORS_ZONE) repris dans le PV | t/terrain.test.ts:« constat géolocalisé… » ; t/m35… (gps, distanceM) | BUILT |
| 35 | Transmettre au superviseur | PV TRANSMIS + notification R09 ; POST /v1/terrain/proces-verbaux/:id/decision | t/m35…:« procès-verbal… validation distincte » | BUILT-NOW |
| 35 | Pas de modification d’un constat validé | reviewFinding (409) ; PV VALIDE figé (PV_VALIDATED_IMMUTABLE), rectification = nouvelle version avant validation | t/m35…:« constat validé jamais modifié… » ; « …figé après validation… » | BUILT-NOW |
| 35 | Contestations | POST …/contestations (accusé), …/reponse (personne distincte) ; fe/modules/terrain/MesProcesVerbaux.tsx | t/m35…:« …contestation et réponse » | BUILT-NOW |
| 35 | Indicateurs : constats, taux de validation, contestations | GET /v1/terrain/inspection/indicateurs ; M35_* | t/m35… ; t/m27-40-indicateurs.test.ts | BUILT-NOW |
| 36 | Mise en demeure — double validation | recouvrement propose (R20) / decide (R21) | t/recouvrement.test.ts:« chaque étape au-delà du rappel est proposée (R20) puis décidée (R21)… » | BUILT |
| 36 | Mesures légales suivies jusqu’à clôture | MESURE_EXECUTION, LEVEE, CLASSEMENT ; RecoveryQueue.tsx | idem ; « garde-fous… » | BUILT |
| 36 | Tracer chaque étape ; aucune mesure automatique | steps + audit ; automaticDecision:false | t/recouvrement.test.ts:« séparation des tâches… l’IA ne décide jamais » | BUILT |
| 36 | Indicateurs : dossiers ouverts, clos, délais | M36_* ; /v1/recouvrement/indicateurs | t/recouvrement.test.ts:« encours, dossiers… » ; t/m27-40-indicateurs.test.ts | BUILT-NOW |
| 37 | Contestation typée (bien non détenu, activité fermée, véhicule vendu, double imposition) | modules/appeals/procedure.ts APPEAL_TYPES | t/recouvrement.test.ts:« délais calculés, accusé horodaté… » | BUILT |
| 37 | Suivi du délai (décompte visible) ; décision motivée + voie suivante | appeals/service.ts deadlines, nextRemedy ; fe MyArrears / TaxpayerSpace | t/recouvrement.test.ts:« délai de réponse dépassé… voie de recours suivante » | BUILT |
| 37 | Horodater, accuser réception ; suspendre l’exigibilité selon la règle | acknowledgement ; suspensiveEffect (R21) | t/recouvrement.test.ts:« …effet suspensif décidé par R21 » | BUILT |
| 37 | Décideur distinct de l’auteur de la liquidation | appeals decide | t/recouvrement.test.ts:« le décideur est distinct de l’auteur… » ; t/field-appeals.test.ts | BUILT |
| 37 | Indicateurs : traités dans le délai ; erreurs confirmées | M37_* ; pilotage KPIs RECOURS_* | t/m27-40-indicateurs.test.ts | BUILT-NOW |
| 38 | Stockage chiffré, versions, empreintes | be/plugins/documents/service.ts (AES-256-GCM) ; POST /v1/documents, /:id/versions ; fe/modules/documents/Documents.tsx | t/m38-gestion-documentaire.test.ts:« dépôt chiffré et scellé… versions conservées… » | BUILT-NOW |
| 38 | OCR et classification | extractNativeText (texte, PDF), OCR du terminal (tesseract.js embarqué), classify (règles), confirmation humaine | t/m38…:« OCR du terminal pour une image… » ; ft/modules-27-40.test.tsx:« module 38… » | BUILT-NOW |
| 38 | Conservation par catégorie | PARAMETRES_DOCUMENTS (registre des seuils, 0 = non fixée) | t/m38…:« conservation par catégorie… » | BUILT-NOW |
| 38 | Sceller chaque pièce | sceau HMAC + `document.sealed` au journal chaîné | t/m38…:« dépôt chiffré et scellé… » | BUILT-NOW |
| 38 | Purger à échéance sauf preuves d’audit | purges/apercu, POST /v1/documents/purges, …/decision (deux personnes) ; gel juridique | t/m38…:« …jamais une preuve d’audit ni sous gel » | BUILT-NOW |
| 38 | Exports filigranés et expirables | POST /v1/documents/:id/exports ; GET /v1/documents/exports/:token ; vérification du filigrane | t/m38…:« export filigrané remis au seul demandeur… » | BUILT-NOW |
| 38 | Indicateurs : volume stocké ; intégrité vérifiée | GET /v1/documents/indicateurs ; POST /v1/documents/integrite/verification | t/m38…:« …intégrité vérifiée puis écart détecté » | BUILT-NOW |
| 38 | Clé de chiffrement matérielle (HSM) | DocumentKeyProvider (clé dérivée en attendant) | t/m38… (chiffrement effectif) | ADAPTER |
| 39 | Canaux SMS, courriel, application, WhatsApp autorisé, appel vocal, courrier | modules/communications (fournisseurs par canal, bac à sable) | t/communications.test.ts | ADAPTER (connecteurs réels) |
| 39 | Avis imprimé apposé sur la plaque | be/plugins/communication/service.ts createPlateNotice/postPlateNotice ; /v1/communication/avis-plaque ; /v1/public/avis-plaque/:code ; fe/modules/communication/Notifications.tsx | t/m39-notifications.test.ts:« canaux épuisés… avis imprimé à apposer sur la plaque… » | BUILT-NOW |
| 39 | Modèles versionnés par recette et par langue | proposeTemplate/decideTemplate ; resolver dans CommunicationService | t/m39…:« modèles versionnés par recette et par langue… » | BUILT-NOW |
| 39 | Préférences : canal choisi, consentements | PUT /v1/communication/preferences/:id ; journal des consentements ; fe/modules/communication/MesPreferences.tsx | t/m39…:« préférences… » | BUILT-NOW |
| 39 | Preuve de remise horodatée et conservée | journal de délivrance + accusés signés (/v1/communication/accuses), lecture (/messages/:id/lecture), /envois/:id/preuve | t/m39…:« accusés signés… » ; t/communications.test.ts:« AC-COM-01… preuve conservée » | BUILT-NOW |
| 39 | Rappels d’échéance et de phase ambre | recouvrement runSchedule ; titres `ticket.expiring` | t/recouvrement.test.ts:« planification idempotente… » ; t/titres.test.ts | BUILT |
| 39 | Notifications légales après validation | avis formels émis après décision R21 | t/recouvrement.test.ts:« chaque étape… décidée (R21) » | BUILT |
| 39 | Réessayer sur un canal de secours | FALLBACK_ORDER, fallback(), retryOnFallback() sur accusé « échoué » | t/m39…:« accusés signés… échec ⇒ canal de secours… » | BUILT-NOW |
| 39 | Messages minimaux sans lien ; mises en demeure seulement si légalement autorisées | SUSPICIOUS_LINK (422) ; LEGAL_EVENTS : acte EN_VIGUEUR exigé | t/m39…:« modèles… » (SUSPICIOUS_LINK, LEGAL_BASIS_REQUIRED, LEGAL_BASIS_NOT_IN_FORCE) | BUILT-NOW |
| 39 | Indicateurs : délivrance, délai, ouverture | GET /v1/communication/indicateurs ; M39_* ; Notifications.tsx | t/m39… ; ft/modules-27-40.test.tsx | BUILT-NOW |
| 40 | Signaux : doublons, exonérations/annulations anormales, collusion agent–objet, constats hors zone, réutilisation d’appareils, quittances manipulées | be/plugins/integrite/enquetes/service.ts `detect` (branché sur runDetection) ; collusion : detecteurs PROXIMITE_AGENT_OBJET, gouvernance/collusion.ts | t/m40-renseignement-antifraude.test.ts:« signaux complémentaires… » ; t/terrain-qualite-detecteurs.test.ts ; t/integrite-gouvernance.test.ts | BUILT-NOW |
| 40 | Dossiers d’enquête (pièces, liens, chronologie) | integrite/service.ts cases ; fe/modules/integrite/ConsoleEnquete.tsx | t/integrite.test.ts ; t/m40…:« dossier ouvert à partir d’un signal… » | BUILT |
| 40 | Scores explicables (variables, sources, confiance) | scoreOf ; GET /v1/integrite/scores, /alerts/:id/score ; fe/modules/integrite/Renseignement.tsx | t/m40…:« …scores explicables… » ; ft/modules-27-40.test.tsx | BUILT-NOW |
| 40 | Signalements citoyens (ligne protégée) | integrite reports (web, SMS, SVI) ; fe/modules/integrite/Signalement.tsx | t/integrite.test.ts:« canaux SMS et SVI simulés… » | BUILT |
| 40 | Ouvrir un dossier à partir d’un signal | openCase(alertIds) | t/m40…:« dossier ouvert à partir d’un signal… » | BUILT |
| 40 | Suspendre un accès technique à titre conservatoire | proposeSuspension (R24) → decideSuspension (R28/R26 distinct) → hold dans UserDirectory (403 ACCESS_SUSPENDED_PRECAUTIONARY) → levée / échéance | t/m40…:« …suspension conservatoire… effective, levée ; échéance » ; ft/modules-27-40.test.tsx:« module 40 : suspension… » | BUILT-NOW |
| 40 | Transmettre à l’autorité compétente | POST /v1/integrite/cases/:id/transmission (bordereau scellé), /transmissions/:id/accuse, /verification | t/m40…:« transmission à l’autorité compétente… » | BUILT-NOW |
| 40 | Clôture d’alerte par un responsable distinct | validateAlertClosure | t/integrite.test.ts | BUILT |
| 40 | Indicateurs : alertes ouvertes/résolues, délai d’instruction, déperdition évitée | GET /v1/integrite/renseignement/indicateurs ; /cases/:id/deperdition-evitee ; M40_* | t/m40…:« …déperdition évitée ; indicateurs » | BUILT-NOW |

## Comptes par module (BUILT / BUILT-NOW / ADAPTER)

| Module | BUILT | BUILT-NOW | ADAPTER |
|---|---|---|---|
| 27 | 7 | 1 | 0 |
| 28 | 6 | 1 | 1 |
| 29 | 2 | 4 | 0 |
| 30 | 4 | 1 | 0 |
| 31 | 4 | 1 | 0 |
| 32 | 5 | 2 | 0 |
| 33 | 0 | 7 | 0 |
| 34 | 4 | 3 | 0 |
| 35 | 1 | 8 | 0 |
| 36 | 3 | 1 | 0 |
| 37 | 4 | 1 | 0 |
| 38 | 0 | 7 | 1 |
| 39 | 2 | 7 | 1 |
| 40 | 4 | 5 | 0 |

## Adaptateurs restants (convention requise)

- Module 28 : connecteurs BitriPay, KODA, banques et opérateurs — bac à sable + mode réel derrière `payments/connectors/*`, testés (t/connectors.test.ts) ; raccordement réel = convention avec chaque prestataire.
- Module 38 : module matériel de sécurité (HSM/KMS) pour la clé de chiffrement au repos — interface `DocumentKeyProvider`, clé dérivée de la clé serveur en attendant ; libellé « [À RACCORDER — convention requise] » à l’écran.
- Module 39 : agrégateur SMS, SMTP, WhatsApp Business, opérateur vocal, courrier — fournisseurs bac à sable (journalisés) derrière `ChannelProvider` ; accusés de remise signés (clé par fournisseur à convenir) ; libellé [À RACCORDER] aux indicateurs.
