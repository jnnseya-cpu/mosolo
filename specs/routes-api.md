# Catalogue des routes de l'API KINSHASA MOSOLO

Généré depuis le code source (`tools/gen_routes.py`) : **1598 routes** dans 50 modules. Chaque route applique le point de décision des politiques (RBAC + ABAC) ; les erreurs suivent la RFC 9457. Le contrat détaillé des routes du socle figure dans `specs/openapi.yaml` et `specs/contrat-api.md` ; les règles d'accès de chaque module d'extension sont déclarées dans son fichier `policy.ts`.

| Module | Routes |
|---|---|
| extension acces | 89 |
| extension apprentissage | 17 |
| extension canaux | 46 |
| extension catalogue-api | 20 |
| extension chaine | 3 |
| extension citoyen | 60 |
| extension communication | 13 |
| extension decision | 30 |
| extension documents | 17 |
| extension equipements | 12 |
| extension fiscal | 110 |
| extension ia | 40 |
| extension integrite | 86 |
| extension juridique | 11 |
| extension opportunites | 32 |
| extension parking | 74 |
| extension pilotage | 132 |
| extension plateforme | 23 |
| extension postes | 29 |
| extension preuves | 15 |
| extension publicite | 52 |
| extension rakapay | 53 |
| extension recouvrement | 75 |
| extension referentiel | 12 |
| extension sanctions | 12 |
| extension socle | 24 |
| extension terrain | 64 |
| extension titres | 22 |
| extension tresor | 43 |
| extension vehicules-controle | 84 |
| extension verticales | 194 |
| module ai | 3 |
| module alerts | 1 |
| module appeals | 12 |
| module assessment | 6 |
| module audit | 2 |
| module communications | 4 |
| module dashboards | 1 |
| module drafts | 3 |
| module field | 1 |
| module fx | 1 |
| module identity | 6 |
| module integrations | 7 |
| module objects | 2 |
| module payments | 12 |
| module receipts | 2 |
| module rules | 26 |
| module system | 3 |
| module treasury | 8 |
| module vault | 4 |

## Extension acces

| Méthode | Chemin |
|---|---|
| POST | `/v1/acces/abac/explication` |
| GET | `/v1/acces/accounts` |
| POST | `/v1/acces/accounts/:id/revoke` |
| POST | `/v1/acces/accounts/me/secrets` |
| GET | `/v1/acces/arbitrations` |
| GET | `/v1/acces/arbitrations/:id` |
| POST | `/v1/acces/arbitrations/:id/decision` |
| POST | `/v1/acces/arbitrations/:id/opinion` |
| POST | `/v1/acces/assisted-enrolments` |
| GET | `/v1/acces/catalogue-modules` |
| GET | `/v1/acces/claims` |
| POST | `/v1/acces/claims` |
| POST | `/v1/acces/claims/liquidations` |
| GET | `/v1/acces/consultations` |
| POST | `/v1/acces/consultations` |
| GET | `/v1/acces/consultations/:id/dossier` |
| POST | `/v1/acces/consultations/:id/review` |
| GET | `/v1/acces/contrats-partenaires` |
| POST | `/v1/acces/contrats-partenaires` |
| POST | `/v1/acces/contrats-partenaires/:id/decision` |
| GET | `/v1/acces/delegations` |
| POST | `/v1/acces/delegations` |
| POST | `/v1/acces/delegations/:id/decision` |
| POST | `/v1/acces/delegations/:id/fin` |
| GET | `/v1/acces/departements` |
| GET | `/v1/acces/departements/:id` |
| POST | `/v1/acces/departements/:id/modules` |
| POST | `/v1/acces/departements/:id/modules/:code/detachement` |
| GET | `/v1/acces/departements/liens` |
| POST | `/v1/acces/departements/liens/:id/decision` |
| GET | `/v1/acces/duplicates` |
| POST | `/v1/acces/echeancier` |
| GET | `/v1/acces/elevations` |
| POST | `/v1/acces/elevations` |
| POST | `/v1/acces/elevations/:id/decision` |
| POST | `/v1/acces/elevations/:id/end` |
| GET | `/v1/acces/elevations/:id/session` |
| GET | `/v1/acces/entities` |
| POST | `/v1/acces/entities` |
| POST | `/v1/acces/entities/:id/suspend` |
| GET | `/v1/acces/grants` |
| POST | `/v1/acces/grants` |
| POST | `/v1/acces/grants/:id/revoke` |
| GET | `/v1/acces/identity-proofs` |
| POST | `/v1/acces/identity-proofs/:id/review` |
| GET | `/v1/acces/identity/:id` |
| POST | `/v1/acces/identity/:id/otp` |
| POST | `/v1/acces/identity/:id/otp/verify` |
| POST | `/v1/acces/identity/:id/proofs` |
| GET | `/v1/acces/indicateurs` |
| GET | `/v1/acces/invitations` |
| POST | `/v1/acces/invitations` |
| POST | `/v1/acces/invitations/:id/assisted` |
| POST | `/v1/acces/invitations/:id/revoke` |
| POST | `/v1/acces/invitations/accept` |
| GET | `/v1/acces/invitations/lookup` |
| GET | `/v1/acces/journal` |
| GET | `/v1/acces/levels` |
| POST | `/v1/acces/mandataires/inscriptions` |
| POST | `/v1/acces/mandataires/inscriptions/:id/verification` |
| GET | `/v1/acces/mandates` |
| POST | `/v1/acces/mandates` |
| POST | `/v1/acces/mandates/:id/revoke` |
| GET | `/v1/acces/mandates/check` |
| GET | `/v1/acces/me` |
| GET | `/v1/acces/menu-rattachements` |
| POST | `/v1/acces/merges` |
| POST | `/v1/acces/merges/:id/approve` |
| POST | `/v1/acces/merges/:id/close` |
| POST | `/v1/acces/merges/:id/verify` |
| POST | `/v1/acces/mfa/challenge` |
| POST | `/v1/acces/mfa/verify` |
| GET | `/v1/acces/modules` |
| POST | `/v1/acces/modules` |
| GET | `/v1/acces/modules/:id` |
| POST | `/v1/acces/modules/:id/activate` |
| POST | `/v1/acces/modules/:id/reattachments` |
| POST | `/v1/acces/modules/:id/reattachments/decision` |
| POST | `/v1/acces/modules/:id/recette` |
| POST | `/v1/acces/modules/:id/status` |
| POST | `/v1/acces/modules/:id/submit` |
| POST | `/v1/acces/modules/:id/visa-juridique` |
| POST | `/v1/acces/modules/:id/visa-programme` |
| POST | `/v1/acces/organisations` |
| GET | `/v1/acces/sandbox/outbox` |
| GET | `/v1/acces/types-de-comptes` |
| GET | `/v1/acces/validations` |
| POST | `/v1/acces/validations/:id/decision` |
| GET | `/v1/acces/validations/mine` |

## Extension apprentissage

| Méthode | Chemin |
|---|---|
| GET | `/v1/apprentissage/aide/:cle` |
| GET | `/v1/apprentissage/certifications` |
| GET | `/v1/apprentissage/certifications/:userId` |
| POST | `/v1/apprentissage/certificats` |
| POST | `/v1/apprentissage/certificats/:id/retrait` |
| GET | `/v1/apprentissage/contenus` |
| POST | `/v1/apprentissage/contenus` |
| POST | `/v1/apprentissage/contenus/:id/publication/decision` |
| POST | `/v1/apprentissage/contenus/:id/publication/propose` |
| POST | `/v1/apprentissage/contenus/:id/versions` |
| GET | `/v1/apprentissage/echantillon/:userId` |
| GET | `/v1/apprentissage/espace` |
| POST | `/v1/apprentissage/evaluations` |
| GET | `/v1/apprentissage/indicateurs` |
| GET | `/v1/apprentissage/mes-certificats` |
| POST | `/v1/apprentissage/modules/:id/epreuve` |
| GET | `/v1/apprentissage/procedures` |

## Extension canaux

| Méthode | Chemin |
|---|---|
| GET | `/v1/agents/assist/payables` |
| POST | `/v1/agents/assist/payment-orders` |
| GET | `/v1/agents/assist/payment-orders/:reference` |
| GET | `/v1/assisted-enrolments` |
| GET | `/v1/assisted-enrolments/:id` |
| POST | `/v1/assisted-enrolments/:id/review` |
| POST | `/v1/assisted-enrolments/batches` |
| POST | `/v1/canaux/contestations-assistees` |
| GET | `/v1/channel-sessions` |
| GET | `/v1/channels/indicators` |
| POST | `/v1/ivr/sessions` |
| POST | `/v1/ivr/sessions/:id/input` |
| GET | `/v1/mosolo-cards/:number` |
| POST | `/v1/mosolo-cards/:number/block` |
| POST | `/v1/mosolo-cards/:number/pin` |
| POST | `/v1/mosolo-cards/:number/reissue-requests` |
| GET | `/v1/mosolo-cards/reissue-requests` |
| POST | `/v1/mosolo-cards/reissue-requests/:id/approve` |
| POST | `/v1/payment-point-proposals/:id/dismiss` |
| POST | `/v1/payment-point-proposals/:id/dismissal-request` |
| POST | `/v1/payment-point-proposals/:id/dismissal-request/decision` |
| GET | `/v1/payment-points` |
| POST | `/v1/payment-points` |
| POST | `/v1/payment-points/:id/activate` |
| POST | `/v1/payment-points/:id/card-references` |
| GET | `/v1/payment-points/:id/cards/:number` |
| GET | `/v1/payment-points/:id/cash-days/:day` |
| POST | `/v1/payment-points/:id/cash-days/:day/bank-match` |
| POST | `/v1/payment-points/:id/cash-days/:day/bank-match/approve` |
| POST | `/v1/payment-points/:id/cash-days/:day/close` |
| POST | `/v1/payment-points/:id/cash-days/:day/deposit` |
| POST | `/v1/payment-points/:id/collections` |
| POST | `/v1/payment-points/:id/collections/:cid/print` |
| GET | `/v1/payment-points/:id/references/:reference` |
| POST | `/v1/payment-points/:id/reinstate` |
| POST | `/v1/payment-points/:id/reinstatement-request` |
| POST | `/v1/payment-points/:id/reinstatement-request/decision` |
| POST | `/v1/payment-points/:id/suspend` |
| GET | `/v1/payment-points/mine` |
| GET | `/v1/pictogram-notices/:taxpayerId` |
| GET | `/v1/public/mosolo-cards/verify` |
| GET | `/v1/public/payment-points` |
| GET | `/v1/public/pictograms` |
| GET | `/v1/public/short-codes/:code` |
| POST | `/v1/ussd/sessions` |
| POST | `/v1/ussd/sessions/:id/input` |

## Extension catalogue-api

| Méthode | Chemin |
|---|---|
| POST | `/v1/affectations/scenarios` |
| GET | `/v1/alertes-fraude` |
| POST | `/v1/baux` |
| GET | `/v1/catalogue-api` |
| POST | `/v1/comptes` |
| POST | `/v1/constats` |
| POST | `/v1/identites/verification` |
| POST | `/v1/liquidations/simulation` |
| POST | `/v1/missions/synchronisation` |
| POST | `/v1/objets` |
| GET | `/v1/objets/:id/obligations` |
| POST | `/v1/paiements/callback` |
| POST | `/v1/paiements/ordres` |
| GET | `/v1/previsions` |
| GET | `/v1/quittances/:ref/verification` |
| GET | `/v1/rapprochements/exceptions` |
| POST | `/v1/recours` |
| POST | `/v1/reglements/import` |
| POST | `/v1/regles` |
| POST | `/v1/regles/:id/publication` |

## Extension chaine

| Méthode | Chemin |
|---|---|
| GET | `/v1/integrite/chaine/ruptures` |
| GET | `/v1/objects/:id/sept-questions` |
| GET | `/v1/obligations/:id/chaine` |

## Extension citoyen

| Méthode | Chemin |
|---|---|
| GET | `/v1/citoyen/activites` |
| GET | `/v1/citoyen/activites/:id/obligations` |
| POST | `/v1/citoyen/activites/detection` |
| POST | `/v1/citoyen/activites/recoupements` |
| GET | `/v1/citoyen/activites/signaux` |
| POST | `/v1/citoyen/activites/signaux` |
| POST | `/v1/citoyen/activites/signaux/:id/decision` |
| POST | `/v1/citoyen/activites/signaux/:id/mission` |
| GET | `/v1/citoyen/application/indicateurs` |
| GET | `/v1/citoyen/cadastre/cas` |
| POST | `/v1/citoyen/cadastre/cas` |
| POST | `/v1/citoyen/cadastre/cas/:id/decision` |
| GET | `/v1/citoyen/cadastre/chaleur` |
| GET | `/v1/citoyen/cadastre/couches` |
| GET | `/v1/citoyen/cadastre/couverture` |
| GET | `/v1/citoyen/cadastre/indicateurs` |
| POST | `/v1/citoyen/cadastre/objets/:id/geometries` |
| GET | `/v1/citoyen/cadastre/objets/:id/hierarchie` |
| GET | `/v1/citoyen/cadastre/objets/:id/historique` |
| GET | `/v1/citoyen/cadastre/superpositions` |
| POST | `/v1/citoyen/cadastre/superpositions/:id/decision` |
| POST | `/v1/citoyen/enrolement/pieces` |
| POST | `/v1/citoyen/enrolement/pieces/:id/decision` |
| GET | `/v1/citoyen/enrolement/pieces/revues` |
| GET | `/v1/citoyen/indicateurs` |
| GET | `/v1/citoyen/locatif/calcul` |
| GET | `/v1/citoyen/locatif/couverture` |
| GET | `/v1/citoyen/locatif/indicateurs` |
| GET | `/v1/citoyen/relations/indicateurs` |
| GET | `/v1/citoyen/relations/revues` |
| POST | `/v1/citoyen/relations/revues/:id/decision` |
| POST | `/v1/citoyen/situation/attestations` |
| GET | `/v1/citoyen/transport/autorisations` |
| POST | `/v1/citoyen/transport/autorisations` |
| POST | `/v1/citoyen/transport/autorisations/:id/activation` |
| POST | `/v1/citoyen/transport/autorisations/:id/cartes` |
| POST | `/v1/citoyen/transport/autorisations/:id/renouvellement` |
| POST | `/v1/citoyen/transport/autorisations/:id/suspension` |
| POST | `/v1/citoyen/transport/autorisations/:id/suspension/decision` |
| POST | `/v1/citoyen/transport/controles` |
| GET | `/v1/citoyen/transport/indicateurs` |
| POST | `/v1/citoyen/transport/rappels` |
| GET | `/v1/citoyen/vehicules` |
| GET | `/v1/citoyen/vehicules/:plaque/controle` |
| POST | `/v1/citoyen/vehicules/:plaque/mutation-verification` |
| GET | `/v1/citoyen/vehicules/immatriculations` |
| POST | `/v1/citoyen/vehicules/immatriculations` |
| POST | `/v1/citoyen/vehicules/immatriculations/:id/ecarts` |
| POST | `/v1/citoyen/vehicules/liquidations` |
| POST | `/v1/public/application/installations` |
| POST | `/v1/public/application/installations/:id/avis` |
| POST | `/v1/public/application/installations/:id/integrite` |
| GET | `/v1/public/attestations-situation/:id` |
| GET | `/v1/public/cadastre/couches` |
| GET | `/v1/public/defi` |
| GET | `/v1/public/informations` |
| GET | `/v1/public/simulateurs` |
| POST | `/v1/public/simulations` |
| GET | `/v1/public/transport/cartes/:id` |
| POST | `/v1/public/visites` |

## Extension communication

| Méthode | Chemin |
|---|---|
| POST | `/v1/communication/accuses` |
| GET | `/v1/communication/avis-plaque` |
| POST | `/v1/communication/avis-plaque` |
| POST | `/v1/communication/avis-plaque/:id/apposition` |
| GET | `/v1/communication/envois/:id/preuve` |
| GET | `/v1/communication/indicateurs` |
| POST | `/v1/communication/messages/:id/lecture` |
| GET | `/v1/communication/modeles` |
| POST | `/v1/communication/modeles` |
| POST | `/v1/communication/modeles/:id/decision` |
| GET | `/v1/communication/preferences/:id` |
| PUT | `/v1/communication/preferences/:id` |
| GET | `/v1/public/avis-plaque/:code` |

## Extension decision

| Méthode | Chemin |
|---|---|
| GET | `/v1/decision/audit/corrections/:ref` |
| GET | `/v1/decision/audit/missions` |
| POST | `/v1/decision/audit/missions` |
| POST | `/v1/decision/audit/missions/:id/cloture` |
| POST | `/v1/decision/audit/missions/:id/constats` |
| POST | `/v1/decision/audit/missions/:id/constats/:findingId/recommandations` |
| POST | `/v1/decision/audit/missions/:id/echantillons` |
| POST | `/v1/decision/audit/missions/:id/scelle` |
| POST | `/v1/decision/audit/recommandations/:id/suivi` |
| GET | `/v1/decision/audit/scelles` |
| GET | `/v1/decision/audit/scelles/:id` |
| POST | `/v1/decision/audit/scelles/:id/remise` |
| GET | `/v1/decision/commandement` |
| POST | `/v1/decision/commandement/decisions` |
| GET | `/v1/decision/commandement/rapport` |
| GET | `/v1/decision/ministere` |
| POST | `/v1/decision/ministere/versements` |
| POST | `/v1/decision/ministere/versements/:id/decision` |
| GET | `/v1/decision/ministeres` |
| GET | `/v1/decision/previsions` |
| POST | `/v1/decision/previsions` |
| GET | `/v1/decision/previsions/:id` |
| GET | `/v1/decision/previsions/:id/ecart` |
| GET | `/v1/decision/regie-fiscale` |
| GET | `/v1/decision/regie-taxes` |
| GET | `/v1/decision/salle-controle` |
| POST | `/v1/decision/salle-controle/escalades` |
| POST | `/v1/decision/salle-controle/escalades/:id/prise-en-charge` |
| GET | `/v1/decision/transparence` |
| GET | `/v1/public/transparence/repartition/:period` |

## Extension documents

| Méthode | Chemin |
|---|---|
| GET | `/v1/documents` |
| POST | `/v1/documents` |
| GET | `/v1/documents/:id` |
| POST | `/v1/documents/:id/classification` |
| GET | `/v1/documents/:id/contenu` |
| POST | `/v1/documents/:id/exports` |
| POST | `/v1/documents/:id/gel-juridique` |
| POST | `/v1/documents/:id/versions` |
| GET | `/v1/documents/categories` |
| GET | `/v1/documents/exports/:token` |
| POST | `/v1/documents/filigranes/verification` |
| GET | `/v1/documents/indicateurs` |
| POST | `/v1/documents/integrite/verification` |
| GET | `/v1/documents/purges` |
| POST | `/v1/documents/purges` |
| POST | `/v1/documents/purges/:id/decision` |
| GET | `/v1/documents/purges/apercu` |

## Extension equipements

| Méthode | Chemin |
|---|---|
| GET | `/v1/equipements` |
| POST | `/v1/equipements/echeancier` |
| POST | `/v1/equipements/politiques` |
| POST | `/v1/equipements/terminaux` |
| POST | `/v1/equipements/terminaux/:id/attestation` |
| POST | `/v1/equipements/terminaux/:id/attestation/defi` |
| POST | `/v1/equipements/terminaux/:id/charte` |
| POST | `/v1/equipements/terminaux/:id/effacement` |
| POST | `/v1/equipements/terminaux/:id/levee-quarantaine` |
| POST | `/v1/equipements/terminaux/:id/perte` |
| POST | `/v1/equipements/terminaux/:id/revocation` |
| POST | `/v1/equipements/terminaux/:id/signalement` |

## Extension fiscal

| Méthode | Chemin |
|---|---|
| GET | `/v1/biens-candidats` |
| POST | `/v1/biens-declares` |
| GET | `/v1/biens-relations/configuration` |
| GET | `/v1/biens/:id/vue-proprietaire` |
| GET | `/v1/dossiers-revue` |
| GET | `/v1/dossiers-revue/:id` |
| POST | `/v1/dossiers-revue/:id/affectation` |
| POST | `/v1/dossiers-revue/:id/constat-terrain` |
| POST | `/v1/dossiers-revue/:id/decision` |
| GET | `/v1/enrolement/espaces` |
| POST | `/v1/enrolement/nif/:id` |
| GET | `/v1/enrolement/recuperations` |
| POST | `/v1/enrolement/recuperations/:id/decision` |
| POST | `/v1/enrolement/recuperations/:id/verification` |
| GET | `/v1/enrolement/roles` |
| POST | `/v1/enrolement/roles` |
| POST | `/v1/enrolement/roles/:id/instruction` |
| GET | `/v1/fiscal/anomalies` |
| POST | `/v1/fiscal/anomalies/:id/review` |
| GET | `/v1/fiscal/anomalies/catalogue` |
| POST | `/v1/fiscal/anomalies/detection` |
| GET | `/v1/fiscal/assiette-2026` |
| GET | `/v1/fiscal/assiette-2026/declarations` |
| POST | `/v1/fiscal/assiette-2026/declarations` |
| GET | `/v1/fiscal/census/coverage` |
| GET | `/v1/fiscal/census/stages` |
| GET | `/v1/fiscal/clearances` |
| POST | `/v1/fiscal/clearances` |
| POST | `/v1/fiscal/clearances/:id/revoke` |
| GET | `/v1/fiscal/clearances/eligibility` |
| GET | `/v1/fiscal/clearances/review` |
| GET | `/v1/fiscal/clearances/verify/:code` |
| GET | `/v1/fiscal/couches` |
| GET | `/v1/fiscal/couverture-locative` |
| GET | `/v1/fiscal/data-protocols` |
| POST | `/v1/fiscal/data-protocols` |
| POST | `/v1/fiscal/data-protocols/:id/decision` |
| GET | `/v1/fiscal/declarations` |
| POST | `/v1/fiscal/declarations` |
| GET | `/v1/fiscal/declarations/:id` |
| POST | `/v1/fiscal/declarations/:id/corrections` |
| POST | `/v1/fiscal/declarations/:id/instruction` |
| GET | `/v1/fiscal/declarations/prefill` |
| GET | `/v1/fiscal/dependencies` |
| POST | `/v1/fiscal/dependencies/:code/change` |
| POST | `/v1/fiscal/dependencies/:code/change/decision` |
| POST | `/v1/fiscal/dependencies/check` |
| POST | `/v1/fiscal/disputes/:id/resolve` |
| GET | `/v1/fiscal/exemptions` |
| POST | `/v1/fiscal/exemptions` |
| GET | `/v1/fiscal/exemptions/:id` |
| POST | `/v1/fiscal/exemptions/:id/decision` |
| POST | `/v1/fiscal/exemptions/:id/instruction` |
| POST | `/v1/fiscal/exemptions/:id/legal-visa` |
| POST | `/v1/fiscal/exemptions/:id/revoke` |
| POST | `/v1/fiscal/exemptions/rappels` |
| GET | `/v1/fiscal/exemptions/registre` |
| GET | `/v1/fiscal/geo-units` |
| GET | `/v1/fiscal/igf/:code` |
| GET | `/v1/fiscal/imports` |
| POST | `/v1/fiscal/imports` |
| GET | `/v1/fiscal/imports/:id` |
| POST | `/v1/fiscal/imports/:id/commit` |
| POST | `/v1/fiscal/imports/:id/duplicates/:line/decision` |
| GET | `/v1/fiscal/imports/format` |
| GET | `/v1/fiscal/leases` |
| POST | `/v1/fiscal/leases/:id/attestations` |
| POST | `/v1/fiscal/leases/:id/resiliation` |
| GET | `/v1/fiscal/map` |
| GET | `/v1/fiscal/nearby` |
| GET | `/v1/fiscal/object-closures` |
| POST | `/v1/fiscal/object-closures/:id/decision` |
| GET | `/v1/fiscal/object-corrections` |
| POST | `/v1/fiscal/object-corrections/:id/decision` |
| GET | `/v1/fiscal/objects` |
| GET | `/v1/fiscal/objects/:id` |
| POST | `/v1/fiscal/objects/:id/census-stage` |
| POST | `/v1/fiscal/objects/:id/closure` |
| GET | `/v1/fiscal/objects/:id/corrections` |
| POST | `/v1/fiscal/objects/:id/corrections` |
| POST | `/v1/fiscal/objects/:id/plate/pose` |
| POST | `/v1/fiscal/objects/:id/plate/replace` |
| POST | `/v1/fiscal/objects/:id/provenance` |
| POST | `/v1/fiscal/objects/:id/reactivation` |
| POST | `/v1/fiscal/objects/:id/suspension` |
| POST | `/v1/fiscal/objects/:id/validate` |
| POST | `/v1/fiscal/partner-data/:source/lots` |
| GET | `/v1/fiscal/plates/:code/scan` |
| GET | `/v1/fiscal/reference` |
| POST | `/v1/fiscal/relationships` |
| POST | `/v1/fiscal/relationships/:id/close` |
| POST | `/v1/fiscal/relationships/:id/contest` |
| POST | `/v1/fiscal/relationships/:id/validate` |
| GET | `/v1/fiscal/relationships/queue` |
| POST | `/v1/invitations-biens/:jeton/reponse` |
| GET | `/v1/moi/relations-biens` |
| GET | `/v1/public/enrolement/profils` |
| POST | `/v1/public/enrolement/recuperations` |
| GET | `/v1/public/fiscal/clearances/:code` |
| GET | `/v1/public/fiscal/dependances` |
| GET | `/v1/public/fiscal/lease-attestations/:code` |
| GET | `/v1/public/fiscal/plates/:code` |
| GET | `/v1/relations-biens/effectives` |
| POST | `/v1/revendications-biens` |
| POST | `/v1/revendications-biens/:id/appel` |
| POST | `/v1/revendications-biens/:id/choix-candidat` |
| POST | `/v1/revendications-biens/:id/contestations` |
| POST | `/v1/revendications-biens/:id/fin` |
| POST | `/v1/revendications-biens/:id/invitations` |
| POST | `/v1/revendications-biens/:id/preuves` |

## Extension ia

| Méthode | Chemin |
|---|---|
| GET | `/v1/ia/agents` |
| POST | `/v1/ia/agents/:code/run` |
| POST | `/v1/ia/agents/:code/state` |
| GET | `/v1/ia/autonomy/:entity` |
| PUT | `/v1/ia/autonomy/:entity` |
| GET | `/v1/ia/effects` |
| GET | `/v1/ia/inbox` |
| GET | `/v1/ia/jeux-donnees` |
| POST | `/v1/ia/jeux-donnees` |
| POST | `/v1/ia/jeux-donnees/:id/decision` |
| GET | `/v1/ia/journal` |
| GET | `/v1/ia/journal/:id` |
| GET | `/v1/ia/memory/entities/:entity` |
| POST | `/v1/ia/memory/entities/:entity/items` |
| POST | `/v1/ia/memory/entities/:entity/items/:id/erase` |
| GET | `/v1/ia/memory/intelligence` |
| POST | `/v1/ia/memory/intelligence/erase` |
| GET | `/v1/ia/memory/levels` |
| DELETE | `/v1/ia/memory/me` |
| GET | `/v1/ia/memory/me` |
| PUT | `/v1/ia/memory/me` |
| POST | `/v1/ia/memory/me/outputs/:id` |
| GET | `/v1/ia/memory/processes/:type/:id` |
| POST | `/v1/ia/memory/purge` |
| GET | `/v1/ia/memory/register` |
| GET | `/v1/ia/memory/users/:userId` |
| GET | `/v1/ia/modeles` |
| POST | `/v1/ia/modeles/:code/versions` |
| GET | `/v1/ia/modeles/surveillance` |
| POST | `/v1/ia/modeles/versions/:id/evaluations` |
| POST | `/v1/ia/modeles/versions/:id/mise-en-service` |
| POST | `/v1/ia/modeles/versions/:id/mise-en-service/decision` |
| POST | `/v1/ia/modeles/versions/:id/retour-arriere` |
| POST | `/v1/ia/modeles/versions/:id/tests-biais` |
| GET | `/v1/ia/prompts` |
| GET | `/v1/ia/recommendations/:id` |
| POST | `/v1/ia/recommendations/:id/actions/:actionId/undo` |
| POST | `/v1/ia/recommendations/:id/decide` |
| POST | `/v1/ia/recommendations/:id/validate` |
| POST | `/v1/ia/sweep` |

## Extension integrite

| Méthode | Chemin |
|---|---|
| GET | `/v1/integrite/access-reviews` |
| POST | `/v1/integrite/access-reviews` |
| POST | `/v1/integrite/access-reviews/:id/close` |
| POST | `/v1/integrite/access-reviews/:id/items/:itemId/decision` |
| POST | `/v1/integrite/access-reviews/privileged` |
| GET | `/v1/integrite/alerts` |
| POST | `/v1/integrite/alerts/:id/examine` |
| POST | `/v1/integrite/alerts/:id/propose-closure` |
| GET | `/v1/integrite/alerts/:id/score` |
| POST | `/v1/integrite/alerts/:id/validate-closure` |
| GET | `/v1/integrite/appareils` |
| POST | `/v1/integrite/appareils/:id/attestation` |
| GET | `/v1/integrite/cases` |
| POST | `/v1/integrite/cases` |
| GET | `/v1/integrite/cases/:id` |
| POST | `/v1/integrite/cases/:id/conclusions` |
| POST | `/v1/integrite/cases/:id/decision` |
| POST | `/v1/integrite/cases/:id/deperdition-evitee` |
| POST | `/v1/integrite/cases/:id/evidence` |
| POST | `/v1/integrite/cases/:id/links` |
| POST | `/v1/integrite/cases/:id/notes` |
| POST | `/v1/integrite/cases/:id/suspensions-conservatoires` |
| POST | `/v1/integrite/cases/:id/transmission` |
| GET | `/v1/integrite/collusion` |
| POST | `/v1/integrite/collusion/run` |
| GET | `/v1/integrite/detecteurs` |
| POST | `/v1/integrite/detecteurs/executions` |
| POST | `/v1/integrite/detection/run` |
| GET | `/v1/integrite/gps/anomalies` |
| POST | `/v1/integrite/gps/plausibilite` |
| GET | `/v1/integrite/incidents` |
| POST | `/v1/integrite/incidents` |
| POST | `/v1/integrite/incidents/:id/assign` |
| POST | `/v1/integrite/incidents/:id/close` |
| POST | `/v1/integrite/incidents/:id/notifications` |
| POST | `/v1/integrite/incidents/:id/status` |
| GET | `/v1/integrite/incidents/candidates` |
| GET | `/v1/integrite/indicators` |
| GET | `/v1/integrite/key-health` |
| GET | `/v1/integrite/mystery-checks` |
| POST | `/v1/integrite/mystery-checks` |
| POST | `/v1/integrite/mystery-checks/:id/follow-up` |
| POST | `/v1/integrite/mystery-checks/:id/result` |
| POST | `/v1/integrite/observations` |
| GET | `/v1/integrite/plafonds-references` |
| GET | `/v1/integrite/privacy/access-log` |
| GET | `/v1/integrite/privacy/registry` |
| POST | `/v1/integrite/privacy/registry` |
| GET | `/v1/integrite/privacy/registry/:id/history` |
| GET | `/v1/integrite/privacy/requests` |
| POST | `/v1/integrite/privacy/requests` |
| GET | `/v1/integrite/privacy/requests/:id/export` |
| POST | `/v1/integrite/privacy/requests/:id/respond` |
| POST | `/v1/integrite/privacy/requests/:id/take` |
| POST | `/v1/integrite/privacy/requests/:id/validation` |
| GET | `/v1/integrite/renseignement/indicateurs` |
| GET | `/v1/integrite/reports` |
| GET | `/v1/integrite/reports/:id` |
| POST | `/v1/integrite/reports/:id/assign` |
| POST | `/v1/integrite/reports/:id/close` |
| POST | `/v1/integrite/reports/:id/messages` |
| POST | `/v1/integrite/reports/:id/qualify` |
| POST | `/v1/integrite/reports/intake` |
| GET | `/v1/integrite/scellement` |
| POST | `/v1/integrite/scellement/controles` |
| POST | `/v1/integrite/scellement/copie` |
| POST | `/v1/integrite/scellement/racines` |
| GET | `/v1/integrite/scores` |
| GET | `/v1/integrite/suspensions-conservatoires` |
| POST | `/v1/integrite/suspensions-conservatoires/:id/decision` |
| POST | `/v1/integrite/suspensions-conservatoires/:id/levee` |
| GET | `/v1/integrite/thresholds` |
| POST | `/v1/integrite/thresholds/change-requests` |
| POST | `/v1/integrite/thresholds/change-requests/:id/decision` |
| GET | `/v1/integrite/transmissions` |
| POST | `/v1/integrite/transmissions/:id/accuse` |
| GET | `/v1/integrite/transmissions/:id/verification` |
| GET | `/v1/parametres/effectifs` |
| GET | `/v1/parametres/surcharges` |
| POST | `/v1/parametres/surcharges` |
| POST | `/v1/public/integrite/reports` |
| POST | `/v1/public/integrite/reports/sms` |
| POST | `/v1/public/integrite/reports/svi` |
| POST | `/v1/public/integrite/reports/track` |
| POST | `/v1/public/integrite/reports/track/complement` |
| GET | `/v1/public/integrite/summary` |

## Extension juridique

| Méthode | Chemin |
|---|---|
| GET | `/v1/juridique/donnees/classification` |
| GET | `/v1/juridique/donnees/purges` |
| POST | `/v1/juridique/donnees/purges` |
| POST | `/v1/juridique/donnees/purges/:id/decision` |
| GET | `/v1/juridique/donnees/purges/apercu` |
| GET | `/v1/juridique/points` |
| GET | `/v1/juridique/points/:code` |
| POST | `/v1/juridique/points/:code/decision` |
| POST | `/v1/juridique/points/:code/propositions` |
| GET | `/v1/public/juridique/fonctions` |
| GET | `/v1/public/juridique/fonctions/:code` |

## Extension opportunites

| Méthode | Chemin |
|---|---|
| GET | `/v1/opportunites` |
| POST | `/v1/opportunites` |
| GET | `/v1/opportunites-indicateurs` |
| GET | `/v1/opportunites-leviers` |
| GET | `/v1/opportunites-maximisation/cas-usage` |
| GET | `/v1/opportunites-maximisation/classement` |
| POST | `/v1/opportunites-maximisation/simulations` |
| GET | `/v1/opportunites/:id` |
| POST | `/v1/opportunites/:id/decision` |
| POST | `/v1/opportunites/:id/etapes/:n` |
| PUT | `/v1/opportunites/:id/grille/:field` |
| POST | `/v1/opportunites/:id/hypotheses` |
| PUT | `/v1/opportunites/:id/maximisation/:key` |
| GET | `/v1/opportunites/:id/resultats-pilote` |
| POST | `/v1/opportunites/:id/resultats-pilote` |
| GET | `/v1/opportunites/decouverte/champ` |
| GET | `/v1/opportunites/decouverte/signaux-ia` |
| GET | `/v1/opportunites/pipeline` |
| GET | `/v1/recoupement/blocages` |
| POST | `/v1/recoupement/blocages/:id/reexamen` |
| GET | `/v1/recoupement/liste-travail` |
| POST | `/v1/recoupement/liste-travail/:id/examen` |
| POST | `/v1/recoupement/liste-travail/:id/mission` |
| GET | `/v1/recoupement/parametres` |
| PUT | `/v1/recoupement/parametres` |
| GET | `/v1/recoupement/plaques/:plaque` |
| GET | `/v1/recoupement/sources` |
| POST | `/v1/recoupement/sources` |
| POST | `/v1/recoupement/sources/:id/conformite` |
| POST | `/v1/recoupement/sources/:id/lots` |
| POST | `/v1/recoupement/sources/:id/protocole` |
| POST | `/v1/recoupement/sources/:id/suspendre` |

## Extension parking

| Méthode | Chemin |
|---|---|
| GET | `/v1/parking/affectation` |
| GET | `/v1/parking/affectation/commitments` |
| POST | `/v1/parking/affectation/commitments` |
| POST | `/v1/parking/affectation/commitments/:id/publish` |
| GET | `/v1/parking/agents/earnings` |
| GET | `/v1/parking/agents/me/earnings` |
| POST | `/v1/parking/canal-texte/passerelle/:operator` |
| POST | `/v1/parking/canal-texte/simulateur` |
| GET | `/v1/parking/canal-texte/statistiques` |
| GET | `/v1/parking/control/:plate` |
| GET | `/v1/parking/deployment` |
| POST | `/v1/parking/deployment/phases/:n/activation` |
| POST | `/v1/parking/deployment/phases/:n/zones` |
| POST | `/v1/parking/evidence-photos` |
| GET | `/v1/parking/evidence-photos/:id` |
| GET | `/v1/parking/exemptions` |
| POST | `/v1/parking/exemptions` |
| POST | `/v1/parking/exemptions/:id/decide` |
| POST | `/v1/parking/exemptions/:id/revoke` |
| GET | `/v1/parking/indicators` |
| GET | `/v1/parking/occupancy` |
| GET | `/v1/parking/overbooking` |
| POST | `/v1/parking/overbooking/activation` |
| POST | `/v1/parking/overbooking/legal-validation` |
| GET | `/v1/parking/partners` |
| POST | `/v1/parking/partners` |
| POST | `/v1/parking/partners/:id/occupancy` |
| POST | `/v1/parking/partners/:id/status` |
| GET | `/v1/parking/partners/mine` |
| GET | `/v1/parking/penalties` |
| GET | `/v1/parking/plates/:plate/active-titles` |
| GET | `/v1/parking/plates/:plate/profile` |
| POST | `/v1/parking/plates/:plate/referrals` |
| GET | `/v1/parking/plates/priorities` |
| GET | `/v1/parking/pricing-recommendations` |
| POST | `/v1/parking/pricing-recommendations/:id/decide` |
| POST | `/v1/parking/pricing-recommendations/run` |
| GET | `/v1/parking/reconfigurations` |
| POST | `/v1/parking/reconfigurations` |
| POST | `/v1/parking/reconfigurations/:id/status` |
| POST | `/v1/parking/reminders/run` |
| GET | `/v1/parking/reservations` |
| POST | `/v1/parking/reservations` |
| POST | `/v1/parking/reservations/:id/decide` |
| POST | `/v1/parking/reservations/:id/unavailability` |
| GET | `/v1/parking/reservations/mine` |
| GET | `/v1/parking/revenue-sources` |
| POST | `/v1/parking/sessions` |
| GET | `/v1/parking/sessions/:id` |
| POST | `/v1/parking/sessions/:id/end` |
| POST | `/v1/parking/sessions/:id/extend` |
| GET | `/v1/parking/sessions/mine` |
| POST | `/v1/parking/tariff-grids` |
| GET | `/v1/parking/tariff-modes` |
| POST | `/v1/parking/tariff-simulations` |
| GET | `/v1/parking/tarification-dynamique` |
| POST | `/v1/parking/tarification-dynamique/run` |
| GET | `/v1/parking/urban-data` |
| POST | `/v1/parking/vehicles` |
| GET | `/v1/parking/vehicles/mine` |
| GET | `/v1/parking/violations` |
| POST | `/v1/parking/violations` |
| GET | `/v1/parking/violations/:id` |
| POST | `/v1/parking/violations/:id/contest` |
| POST | `/v1/parking/violations/:id/decide` |
| POST | `/v1/parking/violations/:id/verify` |
| GET | `/v1/parking/violations/mine` |
| GET | `/v1/parking/zones` |
| POST | `/v1/parking/zones` |
| GET | `/v1/parking/zones/:id` |
| POST | `/v1/parking/zones/:id/premium` |
| POST | `/v1/parking/zones/:id/sensor-readings` |
| POST | `/v1/parking/zones/:id/suspension` |
| POST | `/v1/parking/zones/:id/tariff` |

## Extension pilotage

| Méthode | Chemin |
|---|---|
| GET | `/api/allocations` |
| GET | `/api/allocations/rules` |
| POST | `/api/allocations/rules` |
| POST | `/api/allocations/rules/:id/activate` |
| POST | `/api/allocations/rules/:id/version` |
| GET | `/api/audit` |
| POST | `/api/cash/collections` |
| POST | `/api/cash/declarations` |
| POST | `/api/cash/deposits` |
| POST | `/api/cash/reconcile` |
| GET | `/api/entitlements` |
| GET | `/api/entitlements/:id` |
| GET | `/api/finance/agent/:id` |
| GET | `/api/finance/executive` |
| GET | `/api/finance/explain/:metricId` |
| GET | `/api/finance/groupe-nseya` |
| GET | `/api/finance/ministry/:id` |
| GET | `/api/finance/subcontractor/:id` |
| GET | `/api/payments` |
| POST | `/api/payments` |
| GET | `/api/payments/:id` |
| POST | `/api/payments/:id/reconcile` |
| POST | `/api/refunds` |
| POST | `/api/reversals` |
| GET | `/api/settlements` |
| POST | `/api/settlements/:id/approve` |
| POST | `/api/settlements/:id/confirm-payment` |
| POST | `/api/settlements/:id/reconcile` |
| POST | `/api/settlements/request` |
| GET | `/v1/legal-shares` |
| POST | `/v1/legal-shares/calculate` |
| GET | `/v1/legal-shares/calculations/:id` |
| GET | `/v1/legal-shares/incitations` |
| POST | `/v1/legal-shares/incitations` |
| POST | `/v1/legal-shares/incitations/:id/acte` |
| GET | `/v1/legal-shares/keys` |
| POST | `/v1/legal-shares::calculate` |
| GET | `/v1/pilotage/accords-service` |
| POST | `/v1/pilotage/accords-service` |
| POST | `/v1/pilotage/accords-service/:id/demandes` |
| POST | `/v1/pilotage/accords-service/demandes/:id/cloture` |
| GET | `/v1/pilotage/assignations` |
| POST | `/v1/pilotage/assignations` |
| POST | `/v1/pilotage/assignations/:id/certification` |
| GET | `/v1/pilotage/assignations/ecarts` |
| GET | `/v1/pilotage/assignations/ecarts/export` |
| GET | `/v1/pilotage/base-reference` |
| POST | `/v1/pilotage/base-reference` |
| POST | `/v1/pilotage/base-reference/:id/certification` |
| GET | `/v1/pilotage/disponibilite` |
| POST | `/v1/pilotage/disponibilite/sondes` |
| GET | `/v1/pilotage/drill/:dimension` |
| GET | `/v1/pilotage/echelle` |
| GET | `/v1/pilotage/exports/:kind` |
| POST | `/v1/pilotage/exports/verify` |
| GET | `/v1/pilotage/feuille-de-route` |
| POST | `/v1/pilotage/feuille-de-route/actions/:code` |
| POST | `/v1/pilotage/feuille-de-route/demarrage` |
| POST | `/v1/pilotage/feuille-de-route/phases/:code/demarrage` |
| POST | `/v1/pilotage/feuille-de-route/phases/:code/porte` |
| POST | `/v1/pilotage/feuille-de-route/phases/:code/preuves` |
| POST | `/v1/pilotage/feuille-de-route/portes/:id/decision` |
| GET | `/v1/pilotage/gouvernance` |
| POST | `/v1/pilotage/gouvernance/reunions` |
| GET | `/v1/pilotage/indicateurs` |
| GET | `/v1/pilotage/indicateurs-modules/27-40` |
| GET | `/v1/pilotage/instructions` |
| POST | `/v1/pilotage/instructions` |
| POST | `/v1/pilotage/instructions/:id/accuse` |
| POST | `/v1/pilotage/instructions/:id/cloture` |
| POST | `/v1/pilotage/instructions/:id/rapport` |
| POST | `/v1/pilotage/instructions/:id/reouverture` |
| GET | `/v1/pilotage/modele-operationnel` |
| POST | `/v1/pilotage/modele-operationnel/postes` |
| POST | `/v1/pilotage/modele-operationnel/postes/:id/binome` |
| POST | `/v1/pilotage/modele-operationnel/postes/:id/jalons/:jalon` |
| GET | `/v1/pilotage/pilote` |
| POST | `/v1/pilotage/pilote/configuration` |
| POST | `/v1/pilotage/pilote/revues/:jalon` |
| GET | `/v1/pilotage/piste-audit` |
| GET | `/v1/pilotage/piste-audit/:ref` |
| GET | `/v1/pilotage/programme` |
| GET | `/v1/pilotage/programme/cent-jours` |
| POST | `/v1/pilotage/programme/cent-jours/actions/:id/etat` |
| POST | `/v1/pilotage/programme/cent-jours/actions/:id/instruction` |
| POST | `/v1/pilotage/programme/cent-jours/demarrage` |
| GET | `/v1/pilotage/programme/decisions` |
| POST | `/v1/pilotage/programme/decisions/:numero/enregistrement` |
| POST | `/v1/pilotage/programme/decisions/:numero/validation` |
| GET | `/v1/pilotage/programme/recette` |
| POST | `/v1/pilotage/programme/recette/suivis/:code` |
| GET | `/v1/pilotage/programme/risques` |
| POST | `/v1/pilotage/programme/risques/:code/proprietaire` |
| POST | `/v1/pilotage/programme/risques/:code/revues` |
| GET | `/v1/pilotage/programme/versions` |
| POST | `/v1/pilotage/programme/versions/:code/etat` |
| GET | `/v1/pilotage/projets` |
| POST | `/v1/pilotage/projets` |
| POST | `/v1/pilotage/projets/:id/avancement` |
| POST | `/v1/pilotage/projets/:id/financement` |
| POST | `/v1/pilotage/projets/enveloppes` |
| POST | `/v1/pilotage/projets/enveloppes/:id/certification` |
| POST | `/v1/pilotage/projets/recommandations` |
| POST | `/v1/pilotage/projets/scenarios/:id/decision` |
| GET | `/v1/pilotage/ranv` |
| GET | `/v1/pilotage/reductions` |
| POST | `/v1/pilotage/reductions/detection` |
| GET | `/v1/pilotage/repartition` |
| GET | `/v1/pilotage/repartition/automatisation` |
| POST | `/v1/pilotage/repartition/automatisation/executer` |
| GET | `/v1/pilotage/repartition/cle` |
| POST | `/v1/pilotage/repartition/cles/:id/acte` |
| POST | `/v1/pilotage/repartition/cles/:id/activation` |
| POST | `/v1/pilotage/repartition/cles/:id/activation/decision` |
| POST | `/v1/pilotage/repartition/cles/:id/convention` |
| GET | `/v1/pilotage/repartition/distributions` |
| POST | `/v1/pilotage/repartition/propositions` |
| GET | `/v1/pilotage/satisfaction` |
| GET | `/v1/pilotage/scenarios` |
| GET | `/v1/pilotage/scenarios/exemple-illustratif` |
| GET | `/v1/pilotage/scenarios/hypotheses` |
| POST | `/v1/pilotage/scenarios/hypotheses` |
| POST | `/v1/pilotage/scenarios/simulation` |
| GET | `/v1/pilotage/serie` |
| GET | `/v1/pilotage/tableaux` |
| GET | `/v1/pilotage/tableaux/:profil` |
| GET | `/v1/pilotage/transparence/:period` |
| POST | `/v1/pilotage/transparence/:period/publier` |
| GET | `/v1/public/transparency` |
| GET | `/v1/public/transparency/:period` |
| POST | `/v1/satisfaction` |
| GET | `/v1/tableaux/:profil` |

## Extension plateforme

| Méthode | Chemin |
|---|---|
| POST | `/v1/oauth/token` |
| GET | `/v1/partenaires/api/v1` |
| POST | `/v1/partenaires/api/v1/abonnements` |
| GET | `/v1/partenaires/api/v1/paiements/:reference` |
| GET | `/v1/partenaires/api/v1/quittances/:numero` |
| GET | `/v1/partenaires/api/v1/statistiques` |
| GET | `/v1/plateforme/administration` |
| POST | `/v1/plateforme/astreintes` |
| POST | `/v1/plateforme/changements` |
| POST | `/v1/plateforme/changements/:id/avis` |
| POST | `/v1/plateforme/changements/:id/execution` |
| POST | `/v1/plateforme/incidents` |
| POST | `/v1/plateforme/incidents/:id/etapes` |
| GET | `/v1/plateforme/metrics` |
| GET | `/v1/plateforme/partenaires` |
| POST | `/v1/plateforme/partenaires/clients` |
| POST | `/v1/plateforme/partenaires/clients/:id/revocation` |
| POST | `/v1/plateforme/partenaires/contrats` |
| POST | `/v1/plateforme/partenaires/contrats/:id/decision` |
| POST | `/v1/plateforme/partenaires/contrats/:id/suspension` |
| GET | `/v1/plateforme/supervision` |
| POST | `/v1/plateforme/supervision/alertes` |
| POST | `/v1/plateforme/supervision/phase` |

## Extension postes

| Méthode | Chemin |
|---|---|
| GET | `/v1/postes/accueil` |
| GET | `/v1/postes/accueil/export` |
| POST | `/v1/postes/cabinet/dossiers/:id/preparation` |
| POST | `/v1/postes/cabinet/ordre-du-jour` |
| GET | `/v1/postes/corbeille` |
| GET | `/v1/postes/delegations` |
| POST | `/v1/postes/delegations` |
| POST | `/v1/postes/delegations/:id/revocation` |
| GET | `/v1/postes/delegations/candidats` |
| POST | `/v1/postes/dossiers` |
| POST | `/v1/postes/dossiers/:id/reponse` |
| POST | `/v1/postes/executions/:id/etat` |
| POST | `/v1/postes/executions/:id/justification` |
| POST | `/v1/postes/executions/:id/relance` |
| GET | `/v1/postes/fiches/:id` |
| POST | `/v1/postes/fiches/:id/action` |
| POST | `/v1/postes/habilitations` |
| POST | `/v1/postes/habilitations/:id/renouvellement` |
| GET | `/v1/postes/indicateurs` |
| GET | `/v1/postes/notes` |
| GET | `/v1/postes/notes/:id` |
| GET | `/v1/postes/notes/:id/impression` |
| POST | `/v1/postes/notes/production` |
| GET | `/v1/postes/notifications` |
| POST | `/v1/postes/notifications/plafond` |
| GET | `/v1/postes/recherche` |
| GET | `/v1/postes/referentiel` |
| GET | `/v1/postes/travail` |
| GET | `/v1/postes/vues/:vue` |

## Extension preuves

| Méthode | Chemin |
|---|---|
| GET | `/l` |
| GET | `/l/imprimer` |
| GET | `/l/payer` |
| GET | `/l/points` |
| GET | `/l/signaler` |
| POST | `/l/signaler` |
| GET | `/l/v` |
| GET | `/v1/moi/preuves` |
| GET | `/v1/public/preuves` |
| GET | `/v1/public/preuves/:code` |
| GET | `/v1/public/preuves/:code/impression` |
| POST | `/v1/sms/inbound` |
| GET | `/v1/whatsapp/simulator/:msisdn` |
| GET | `/v1/whatsapp/webhook` |
| POST | `/v1/whatsapp/webhook` |

## Extension publicite

| Méthode | Chemin |
|---|---|
| POST | `/v1/public/publicite/signalements` |
| GET | `/v1/publicite/accreditations` |
| POST | `/v1/publicite/accreditations` |
| POST | `/v1/publicite/accreditations/:userId/revoke` |
| GET | `/v1/publicite/authorizations` |
| POST | `/v1/publicite/authorizations` |
| POST | `/v1/publicite/authorizations/:id/decide` |
| POST | `/v1/publicite/authorizations/:id/instruct` |
| POST | `/v1/publicite/authorizations/:id/liquidation/approve` |
| POST | `/v1/publicite/authorizations/:id/liquidation/propose` |
| POST | `/v1/publicite/authorizations/:id/pieces` |
| POST | `/v1/publicite/authorizations/:id/renewal` |
| GET | `/v1/publicite/authorizations/mine` |
| GET | `/v1/publicite/carte/couches` |
| GET | `/v1/publicite/cases` |
| POST | `/v1/publicite/cases/:id/contest` |
| POST | `/v1/publicite/cases/:id/decide` |
| POST | `/v1/publicite/cases/:id/verify` |
| GET | `/v1/publicite/cases/mine` |
| GET | `/v1/publicite/contrats` |
| POST | `/v1/publicite/contrats` |
| POST | `/v1/publicite/contrats/:id/resiliation` |
| POST | `/v1/publicite/devices` |
| GET | `/v1/publicite/devices/:id` |
| GET | `/v1/publicite/devices/mine` |
| GET | `/v1/publicite/echeances` |
| POST | `/v1/publicite/espaces` |
| POST | `/v1/publicite/espaces/:id/statut` |
| POST | `/v1/publicite/evidence-photos` |
| GET | `/v1/publicite/evidence-photos/:id` |
| POST | `/v1/publicite/ia/analyses/:photoId` |
| GET | `/v1/publicite/ia/propositions` |
| POST | `/v1/publicite/ia/propositions/:id/verification` |
| GET | `/v1/publicite/indicators` |
| GET | `/v1/publicite/inspections` |
| POST | `/v1/publicite/inspections` |
| GET | `/v1/publicite/inventory` |
| GET | `/v1/publicite/liquidations/pending` |
| GET | `/v1/publicite/lookup` |
| GET | `/v1/publicite/map` |
| GET | `/v1/publicite/nearby` |
| GET | `/v1/publicite/obligations/mine` |
| GET | `/v1/publicite/pilote` |
| POST | `/v1/publicite/pilote/:rank` |
| GET | `/v1/publicite/public/badges/:userId` |
| GET | `/v1/publicite/public/devices/:token` |
| POST | `/v1/publicite/reminders/run` |
| GET | `/v1/publicite/signalements` |
| POST | `/v1/publicite/signalements/:id/tri` |
| GET | `/v1/publicite/vehicles/:plate` |
| POST | `/v1/publicite/zones` |
| POST | `/v1/publicite/zones/:id/cloture` |

## Extension rakapay

| Méthode | Chemin |
|---|---|
| GET | `/v1/public/wewa/:code` |
| GET | `/v1/rakapay/blocages` |
| POST | `/v1/rakapay/blocages/:id/levee` |
| GET | `/v1/rakapay/catalogue` |
| GET | `/v1/rakapay/circuits` |
| GET | `/v1/rakapay/commissions/mes-commissions` |
| GET | `/v1/rakapay/cooperatives` |
| GET | `/v1/rakapay/cooperatives/:id` |
| POST | `/v1/rakapay/cooperatives/:id/decisions` |
| POST | `/v1/rakapay/cooperatives/:id/paiements-groupes` |
| GET | `/v1/rakapay/indicateurs` |
| GET | `/v1/rakapay/lignes` |
| GET | `/v1/rakapay/offres` |
| POST | `/v1/rakapay/offres/:id/decision` |
| POST | `/v1/rakapay/offres/:id/prix` |
| GET | `/v1/rakapay/operateurs` |
| POST | `/v1/rakapay/operateurs/:id/agents` |
| POST | `/v1/rakapay/operateurs/:id/agents/:userId/blocage` |
| POST | `/v1/rakapay/operateurs/:id/agents/:userId/retrait` |
| GET | `/v1/rakapay/operateurs/:id/agrement` |
| POST | `/v1/rakapay/operateurs/:id/agrement/decision` |
| POST | `/v1/rakapay/operateurs/:id/agrement/proposition` |
| GET | `/v1/rakapay/operateurs/:id/analyse-quotidienne` |
| POST | `/v1/rakapay/operateurs/:id/grille-commissions` |
| GET | `/v1/rakapay/operateurs/:id/limites` |
| POST | `/v1/rakapay/operateurs/:id/limites` |
| POST | `/v1/rakapay/operateurs/:id/offres` |
| GET | `/v1/rakapay/operateurs/:id/tableau` |
| POST | `/v1/rakapay/operateurs/candidatures` |
| GET | `/v1/rakapay/operateurs/mon-rattachement` |
| GET | `/v1/rakapay/periode-grace` |
| POST | `/v1/rakapay/periode-grace` |
| POST | `/v1/rakapay/periode-grace/:id/decision` |
| GET | `/v1/rakapay/redevance-plateforme/simulation` |
| GET | `/v1/rakapay/revues-ventes` |
| POST | `/v1/rakapay/revues-ventes/:id/decision` |
| POST | `/v1/rakapay/revues-ventes/detection` |
| GET | `/v1/rakapay/signalements` |
| POST | `/v1/rakapay/signalements` |
| POST | `/v1/rakapay/signalements/:id/traitement` |
| GET | `/v1/rakapay/stations` |
| GET | `/v1/rakapay/tickets` |
| POST | `/v1/rakapay/tickets` |
| POST | `/v1/rakapay/ventes-privees` |
| POST | `/v1/rakapay/ventes-privees/:id/annulation` |
| POST | `/v1/rakapay/wewa/conducteurs` |
| POST | `/v1/rakapay/wewa/conducteurs/:id/affectation` |
| POST | `/v1/rakapay/wewa/controles` |
| GET | `/v1/rakapay/wewa/moi` |
| POST | `/v1/rakapay/wewa/motos` |
| GET | `/v1/rakapay/wewa/motos/:id/statut` |
| POST | `/v1/rakapay/wewa/passes` |
| GET | `/v1/rakapay/wewa/registre` |

## Extension recouvrement

| Méthode | Chemin |
|---|---|
| GET | `/v1/campagnes` |
| POST | `/v1/campagnes` |
| GET | `/v1/campagnes-recouvrement` |
| POST | `/v1/campagnes-recouvrement` |
| GET | `/v1/campagnes-recouvrement/:id` |
| POST | `/v1/campagnes-recouvrement/:id/arret` |
| POST | `/v1/campagnes-recouvrement/:id/arret/decision` |
| POST | `/v1/campagnes-recouvrement/:id/execution` |
| POST | `/v1/campagnes-recouvrement/:id/generalisation` |
| POST | `/v1/campagnes-recouvrement/:id/generalisation/decision` |
| POST | `/v1/campagnes-recouvrement/:id/lancement` |
| POST | `/v1/campagnes-recouvrement/:id/lancement/decision` |
| POST | `/v1/campagnes-recouvrement/:id/mesure` |
| POST | `/v1/campagnes-recouvrement/:id/simulation` |
| POST | `/v1/campagnes-recouvrement/:id/visites/:visitId` |
| GET | `/v1/campagnes-recouvrement/indicateurs` |
| GET | `/v1/campagnes-recouvrement/referentiel` |
| GET | `/v1/campagnes-recouvrement/visites-a-faire` |
| GET | `/v1/campagnes/:id` |
| POST | `/v1/campagnes/:id/arret` |
| POST | `/v1/campagnes/:id/lancement` |
| POST | `/v1/campagnes/:id/lancement/decision` |
| POST | `/v1/campagnes/:id/pre-remplissage` |
| POST | `/v1/campagnes/:id/relances` |
| POST | `/v1/campagnes/:id/simulation` |
| GET | `/v1/campagnes/calendrier` |
| GET | `/v1/prorogations` |
| POST | `/v1/prorogations` |
| POST | `/v1/prorogations/:id/decision` |
| GET | `/v1/recouvrement/arrieres` |
| GET | `/v1/recouvrement/avis` |
| POST | `/v1/recouvrement/avis` |
| GET | `/v1/recouvrement/avis/:id` |
| POST | `/v1/recouvrement/avis/:id/lecture` |
| GET | `/v1/recouvrement/avis/:id/preuve` |
| POST | `/v1/recouvrement/avis/:id/remise` |
| GET | `/v1/recouvrement/campagnes/:id/rendement` |
| POST | `/v1/recouvrement/contribuables/:id/adresse-notification` |
| POST | `/v1/recouvrement/couts` |
| GET | `/v1/recouvrement/dossiers` |
| POST | `/v1/recouvrement/dossiers` |
| GET | `/v1/recouvrement/dossiers/:id` |
| POST | `/v1/recouvrement/dossiers/:id/observations` |
| POST | `/v1/recouvrement/dossiers/:id/propositions` |
| POST | `/v1/recouvrement/dossiers/:id/rappel` |
| GET | `/v1/recouvrement/dossiers/:id/rendement` |
| GET | `/v1/recouvrement/echeanciers` |
| POST | `/v1/recouvrement/echeanciers` |
| POST | `/v1/recouvrement/echeanciers/:id/decision` |
| POST | `/v1/recouvrement/echeanciers/:id/defaillance` |
| POST | `/v1/recouvrement/garanties` |
| POST | `/v1/recouvrement/garanties/:id/decision` |
| POST | `/v1/recouvrement/garanties/:id/mainlevee` |
| GET | `/v1/recouvrement/indicateurs` |
| GET | `/v1/recouvrement/mes-arrieres` |
| GET | `/v1/recouvrement/non-valeurs` |
| POST | `/v1/recouvrement/non-valeurs` |
| POST | `/v1/recouvrement/non-valeurs/:id/decision` |
| GET | `/v1/recouvrement/parametres` |
| GET | `/v1/recouvrement/penalites` |
| POST | `/v1/recouvrement/penalites` |
| POST | `/v1/recouvrement/penalites/:id/decision` |
| POST | `/v1/recouvrement/penalites/:id/liquidation` |
| POST | `/v1/recouvrement/planification` |
| GET | `/v1/recouvrement/priorites` |
| GET | `/v1/recouvrement/propositions` |
| POST | `/v1/recouvrement/propositions/:id/decision` |
| GET | `/v1/recouvrement/remises` |
| POST | `/v1/recouvrement/remises` |
| POST | `/v1/recouvrement/remises/:id/decision` |
| POST | `/v1/recouvrement/remises/:id/instruction` |
| GET | `/v1/recouvrement/rendement` |
| GET | `/v1/recouvrement/reprises` |
| POST | `/v1/recouvrement/reprises` |
| POST | `/v1/recouvrement/reprises/:id/validation` |

## Extension referentiel

| Méthode | Chemin |
|---|---|
| GET | `/v1/public/referentiel/recettes` |
| GET | `/v1/referentiel/base-de-reference` |
| GET | `/v1/referentiel/codes` |
| POST | `/v1/referentiel/codes` |
| POST | `/v1/referentiel/codes/:code/retrait` |
| GET | `/v1/referentiel/espaces` |
| GET | `/v1/referentiel/matrice-habilitations` |
| GET | `/v1/referentiel/modele-donnees` |
| GET | `/v1/referentiel/recettes` |
| GET | `/v1/referentiel/recettes-administratives` |
| GET | `/v1/referentiel/recettes/:code` |
| POST | `/v1/referentiel/recettes/:code/inventaire` |

## Extension sanctions

| Méthode | Chemin |
|---|---|
| GET | `/v1/agents/commission-validations` |
| POST | `/v1/agents/commission-validations/:id/decision` |
| GET | `/v1/agents/counter-checks` |
| POST | `/v1/agents/counter-checks/:id/record` |
| GET | `/v1/agents/earnings` |
| POST | `/v1/agents/me/commission-validations` |
| GET | `/v1/agents/me/earnings` |
| GET | `/v1/agents/me/reserve` |
| GET | `/v1/agents/monitoring` |
| GET | `/v1/agents/reserve` |
| POST | `/v1/agents/reserve/reprises` |
| POST | `/v1/agents/reserve/reprises/:id/decision` |

## Extension socle

| Méthode | Chemin |
|---|---|
| GET | `/.well-known/jwks.json` |
| GET | `/.well-known/openid-configuration` |
| GET | `/v1/auth/demo-accounts` |
| POST | `/v1/auth/login` |
| POST | `/v1/auth/logout` |
| GET | `/v1/auth/me` |
| POST | `/v1/auth/otp` |
| GET | `/v1/auth/passkeys` |
| POST | `/v1/auth/passkeys/:id/revoke` |
| POST | `/v1/auth/passkeys/authentication/options` |
| POST | `/v1/auth/passkeys/authentication/verify` |
| POST | `/v1/auth/passkeys/registration` |
| POST | `/v1/auth/passkeys/registration/verify` |
| POST | `/v1/auth/refresh` |
| GET | `/v1/auth/sessions` |
| POST | `/v1/auth/sessions/:id/revoke` |
| POST | `/v1/socle/exports` |
| GET | `/v1/socle/exports/requests` |
| POST | `/v1/socle/exports/requests` |
| POST | `/v1/socle/exports/requests/:id/committee` |
| POST | `/v1/socle/exports/requests/:id/data-owner` |
| POST | `/v1/socle/exports/requests/:id/package` |
| POST | `/v1/socle/exports/requests/:id/withdraw` |
| GET | `/v1/socle/status` |

## Extension terrain

| Méthode | Chemin |
|---|---|
| GET | `/v1/public/agent-badges/:code` |
| POST | `/v1/public/agent-badges/:code/reports` |
| GET | `/v1/public/terrain/mystery-checks/summary` |
| GET | `/v1/terrain/agents` |
| POST | `/v1/terrain/agents` |
| POST | `/v1/terrain/agents/:id/badge/reissue` |
| POST | `/v1/terrain/agents/:id/habilitation` |
| POST | `/v1/terrain/agents/:id/revoke` |
| POST | `/v1/terrain/agents/:id/suspend` |
| GET | `/v1/terrain/counter-visits` |
| POST | `/v1/terrain/counter-visits/:id/assignment` |
| POST | `/v1/terrain/counter-visits/:id/result` |
| GET | `/v1/terrain/findings` |
| POST | `/v1/terrain/findings/:id/objet-provisoire` |
| POST | `/v1/terrain/findings/:id/review` |
| GET | `/v1/terrain/indicators` |
| GET | `/v1/terrain/inspection/indicateurs` |
| GET | `/v1/terrain/inspection/modeles` |
| GET | `/v1/terrain/lots` |
| POST | `/v1/terrain/lots` |
| POST | `/v1/terrain/lots/:id/close` |
| GET | `/v1/terrain/me` |
| GET | `/v1/terrain/missions` |
| POST | `/v1/terrain/missions` |
| GET | `/v1/terrain/missions/:id` |
| POST | `/v1/terrain/missions/:id/assignment` |
| POST | `/v1/terrain/missions/:id/cancel` |
| POST | `/v1/terrain/missions/:id/complete` |
| POST | `/v1/terrain/missions/:id/dossiers-inspection` |
| POST | `/v1/terrain/missions/:id/findings` |
| GET | `/v1/terrain/missions/:id/itineraire` |
| GET | `/v1/terrain/missions/:id/paquet-hors-ligne` |
| GET | `/v1/terrain/mystery-checks` |
| POST | `/v1/terrain/mystery-checks` |
| POST | `/v1/terrain/mystery-checks/:id/result` |
| POST | `/v1/terrain/paquets/verification` |
| GET | `/v1/terrain/points-resultats` |
| GET | `/v1/terrain/proces-verbaux` |
| POST | `/v1/terrain/proces-verbaux` |
| POST | `/v1/terrain/proces-verbaux/:id/contestations` |
| POST | `/v1/terrain/proces-verbaux/:id/contestations/:cid/reponse` |
| POST | `/v1/terrain/proces-verbaux/:id/decision` |
| GET | `/v1/terrain/proces-verbaux/mes-proces-verbaux` |
| GET | `/v1/terrain/qualite` |
| GET | `/v1/terrain/quality` |
| POST | `/v1/terrain/quality/samples` |
| POST | `/v1/terrain/recuperations` |
| POST | `/v1/terrain/recuperations/:id/decision` |
| GET | `/v1/terrain/settings/gps-tolerance` |
| PUT | `/v1/terrain/settings/gps-tolerance/:commune` |
| GET | `/v1/terrain/subcontractors` |
| POST | `/v1/terrain/subcontractors` |
| GET | `/v1/terrain/subcontractors/:id` |
| POST | `/v1/terrain/subcontractors/:id/accreditation/approve` |
| POST | `/v1/terrain/subcontractors/:id/accreditation/confirm` |
| POST | `/v1/terrain/subcontractors/:id/accreditation/propose` |
| POST | `/v1/terrain/subcontractors/:id/agents` |
| PUT | `/v1/terrain/subcontractors/:id/contract` |
| POST | `/v1/terrain/subcontractors/:id/diligence` |
| POST | `/v1/terrain/subcontractors/:id/dossier` |
| POST | `/v1/terrain/subcontractors/:id/reinstate` |
| GET | `/v1/terrain/subcontractors/:id/remuneration` |
| POST | `/v1/terrain/subcontractors/:id/suspend` |
| POST | `/v1/terrain/subcontractors/:id/withdraw` |

## Extension titres

| Méthode | Chemin |
|---|---|
| GET | `/v1/titres` |
| POST | `/v1/titres` |
| GET | `/v1/titres/:id` |
| POST | `/v1/titres/:id/abonnement` |
| POST | `/v1/titres/:id/decisions` |
| POST | `/v1/titres/:id/prolongations` |
| GET | `/v1/titres/:id/qr` |
| GET | `/v1/titres/:id/statut` |
| GET | `/v1/titres/cle-publique` |
| GET | `/v1/titres/commandes` |
| POST | `/v1/titres/commandes/:id/annulation` |
| GET | `/v1/titres/constats` |
| POST | `/v1/titres/constats/:id/contestation` |
| POST | `/v1/titres/constats/:id/decision` |
| GET | `/v1/titres/constats/mine` |
| POST | `/v1/titres/controles` |
| POST | `/v1/titres/controles/lots` |
| GET | `/v1/titres/hors-ligne/paquet` |
| GET | `/v1/titres/indicateurs` |
| GET | `/v1/titres/revocations` |
| GET | `/v1/titres/types` |
| GET | `/v1/vehicules/:plaque/titres` |

## Extension tresor

| Méthode | Chemin |
|---|---|
| POST | `/v1/public/receipts/pdf-verification` |
| POST | `/v1/receipts/:ref/duplicates` |
| GET | `/v1/tresor/accounting` |
| GET | `/v1/tresor/appariements` |
| POST | `/v1/tresor/appariements/propositions` |
| POST | `/v1/tresor/appariements/propositions/:id/decision` |
| GET | `/v1/tresor/closures` |
| POST | `/v1/tresor/closures/daily` |
| POST | `/v1/tresor/closures/daily/waivers` |
| POST | `/v1/tresor/closures/daily/waivers/:id/approve` |
| POST | `/v1/tresor/closures/monthly` |
| GET | `/v1/tresor/consistency` |
| GET | `/v1/tresor/exceptions` |
| POST | `/v1/tresor/exceptions/:id/assign` |
| POST | `/v1/tresor/exceptions/:id/detail-prestataire` |
| POST | `/v1/tresor/exceptions/:id/evidence` |
| POST | `/v1/tresor/exceptions/:id/resolution` |
| POST | `/v1/tresor/exceptions/:id/resolution/approve` |
| POST | `/v1/tresor/exceptions/:id/resolution/reject` |
| POST | `/v1/tresor/exceptions/:id/start` |
| GET | `/v1/tresor/exports` |
| GET | `/v1/tresor/grand-livre/indicateurs` |
| GET | `/v1/tresor/grand-livre/verification` |
| POST | `/v1/tresor/imputations/run` |
| GET | `/v1/tresor/nomenclature` |
| GET | `/v1/tresor/operations` |
| POST | `/v1/tresor/operations` |
| POST | `/v1/tresor/operations/:id/approve` |
| POST | `/v1/tresor/operations/:id/reject` |
| GET | `/v1/tresor/overview` |
| GET | `/v1/tresor/points` |
| GET | `/v1/tresor/points/:id/commission` |
| POST | `/v1/tresor/points/:id/contrats` |
| POST | `/v1/tresor/points/contrats/:id/decision` |
| POST | `/v1/tresor/points/penalites` |
| POST | `/v1/tresor/points/penalites/:id/decision` |
| GET | `/v1/tresor/provider-receivables` |
| GET | `/v1/tresor/receipts/:ref` |
| GET | `/v1/tresor/receipts/:ref/pdf` |
| POST | `/v1/tresor/releves/depots` |
| GET | `/v1/tresor/releves/indicateurs` |
| GET | `/v1/tresor/suspense` |
| GET | `/v1/tresor/verification-journal` |

## Extension vehicules-controle

| Méthode | Chemin |
|---|---|
| GET | `/v1/centres-agrees` |
| POST | `/v1/centres-agrees/:id/decision` |
| POST | `/v1/centres-agrees/:id/diligences` |
| POST | `/v1/centres-agrees/:id/dossier` |
| POST | `/v1/centres-agrees/:id/enrolements` |
| POST | `/v1/centres-agrees/:id/habilitation` |
| POST | `/v1/centres-agrees/:id/proposition` |
| POST | `/v1/centres-agrees/:id/retablissement-decision` |
| POST | `/v1/centres-agrees/:id/retablissement-demande` |
| POST | `/v1/centres-agrees/:id/suspension` |
| GET | `/v1/centres-agrees/analytique` |
| POST | `/v1/centres-agrees/analytique/alertes` |
| POST | `/v1/centres-agrees/enrolements/:id/code` |
| POST | `/v1/centres-agrees/invitations` |
| POST | `/v1/fourrieres/alertes/garde` |
| POST | `/v1/fourrieres/constats` |
| GET | `/v1/fourrieres/dossiers` |
| GET | `/v1/fourrieres/dossiers/:id` |
| POST | `/v1/fourrieres/dossiers/:id/contestation` |
| POST | `/v1/fourrieres/dossiers/:id/contestation/decision` |
| POST | `/v1/fourrieres/dossiers/:id/decision-enlevement` |
| POST | `/v1/fourrieres/dossiers/:id/destination-legale` |
| POST | `/v1/fourrieres/dossiers/:id/destination-legale/validation` |
| POST | `/v1/fourrieres/dossiers/:id/ecritures-contraires` |
| POST | `/v1/fourrieres/dossiers/:id/ecritures-contraires/:cid/decision` |
| POST | `/v1/fourrieres/dossiers/:id/encaissement` |
| POST | `/v1/fourrieres/dossiers/:id/entree` |
| POST | `/v1/fourrieres/dossiers/:id/liquidation` |
| POST | `/v1/fourrieres/dossiers/:id/mainlevee` |
| POST | `/v1/fourrieres/dossiers/:id/sortie` |
| GET | `/v1/fourrieres/indicateurs` |
| GET | `/v1/fourrieres/priorisation` |
| GET | `/v1/fourrieres/rapprochement` |
| GET | `/v1/fourrieres/sites` |
| POST | `/v1/fourrieres/sites` |
| GET | `/v1/public/centres-agrees/:code` |
| GET | `/v1/public/vehicules/domaine-officiel` |
| GET | `/v1/public/vehicules/vignettes/:numero` |
| GET | `/v1/public/vehicules/vignettes/verifier` |
| GET | `/v1/rfck/chiffres-publies` |
| POST | `/v1/rfck/chiffres-publies/:code/decision` |
| POST | `/v1/rfck/conventions` |
| POST | `/v1/rfck/conventions/:id/conformite` |
| GET | `/v1/rfck/domaine` |
| POST | `/v1/rfck/domaine/anciens` |
| GET | `/v1/rfck/domaine/exigences` |
| POST | `/v1/rfck/domaine/proposition` |
| POST | `/v1/rfck/domaine/surveillance` |
| POST | `/v1/rfck/domaine/surveillance/:id/suite` |
| POST | `/v1/rfck/domaine/validation` |
| GET | `/v1/rfck/entite` |
| POST | `/v1/rfck/entite/contacts` |
| GET | `/v1/rfck/flux` |
| POST | `/v1/rfck/flux/:flux/echanges` |
| GET | `/v1/rfck/integration` |
| POST | `/v1/rfck/integration/:etape/validation` |
| POST | `/v1/rfck/integration/fermeture-especes` |
| POST | `/v1/rfck/rapprochement-registre` |
| GET | `/v1/rfck/reprises` |
| POST | `/v1/rfck/reprises` |
| POST | `/v1/rfck/reprises/:id/controle` |
| GET | `/v1/vehicules/:plaque/controle-technique` |
| GET | `/v1/vehicules/:plaque/lignes-de-recettes` |
| GET | `/v1/vehicules/controles-techniques` |
| POST | `/v1/vehicules/controles-techniques` |
| POST | `/v1/vehicules/controles-techniques/rappels` |
| GET | `/v1/vehicules/courtoisie` |
| POST | `/v1/vehicules/courtoisie` |
| POST | `/v1/vehicules/courtoisie/:id/fin` |
| GET | `/v1/vehicules/hors-ligne/paquet` |
| GET | `/v1/vehicules/indicateurs` |
| GET | `/v1/vehicules/mes-vehicules` |
| GET | `/v1/vehicules/referentiel` |
| GET | `/v1/vehicules/rendez-vous` |
| POST | `/v1/vehicules/rendez-vous` |
| POST | `/v1/vehicules/rendez-vous/:id/confirmation` |
| POST | `/v1/vehicules/scan` |
| POST | `/v1/vehicules/scans/:id/decision` |
| GET | `/v1/vehicules/vignettes-securisees` |
| POST | `/v1/vehicules/vignettes-securisees/:numero/annulation` |
| POST | `/v1/vehicules/vignettes-securisees/:numero/attribution` |
| POST | `/v1/vehicules/vignettes-securisees/:numero/revocation` |
| POST | `/v1/vehicules/vignettes-securisees/lots` |
| GET | `/v1/vehicules/vignettes-securisees/revocations` |

## Extension verticales

| Méthode | Chemin |
|---|---|
| GET | `/v1/grands-redevables` |
| POST | `/v1/grands-redevables/:taxpayerId/conventions` |
| POST | `/v1/grands-redevables/:taxpayerId/gestionnaire` |
| POST | `/v1/grands-redevables/:taxpayerId/journal` |
| POST | `/v1/grands-redevables/conventions/:id/decision` |
| GET | `/v1/public/verticales/actifs/appels` |
| GET | `/v1/public/verticales/avia/ifa/cle-publique` |
| POST | `/v1/public/verticales/avia/ifa/verify` |
| GET | `/v1/public/verticales/certificates/:code` |
| GET | `/v1/public/verticales/plates/:code` |
| GET | `/v1/verticales` |
| GET | `/v1/verticales/:slug` |
| POST | `/v1/verticales/:slug/cases` |
| POST | `/v1/verticales/:slug/objects/:objectId/liquidate` |
| GET | `/v1/verticales/:slug/space` |
| GET | `/v1/verticales/actifs` |
| POST | `/v1/verticales/actifs/appels` |
| POST | `/v1/verticales/actifs/appels/:id/attribution` |
| POST | `/v1/verticales/actifs/appels/:id/infructueux` |
| POST | `/v1/verticales/actifs/appels/:id/ouverture` |
| POST | `/v1/verticales/actifs/inventaire` |
| POST | `/v1/verticales/actifs/inventaire/:id/evaluations` |
| GET | `/v1/verticales/actifs/revenus` |
| GET | `/v1/verticales/avia/auto` |
| GET | `/v1/verticales/avia/auto/executions` |
| GET | `/v1/verticales/avia/auto/executions/:id` |
| POST | `/v1/verticales/avia/auto/executions/:id/observations` |
| POST | `/v1/verticales/avia/auto/run` |
| GET | `/v1/verticales/avia/cadre` |
| POST | `/v1/verticales/avia/cadre/actes` |
| POST | `/v1/verticales/avia/cadre/actes/:id/validate` |
| POST | `/v1/verticales/avia/cadre/coordination/:partner` |
| POST | `/v1/verticales/avia/cadre/mesures` |
| POST | `/v1/verticales/avia/cadre/mesures/:id/decide` |
| GET | `/v1/verticales/avia/cadre/remuneration-alternative` |
| GET | `/v1/verticales/avia/declarations` |
| POST | `/v1/verticales/avia/declarations` |
| GET | `/v1/verticales/avia/declarations/:id` |
| POST | `/v1/verticales/avia/declarations/:id/billing` |
| POST | `/v1/verticales/avia/declarations/:id/gap-decision` |
| POST | `/v1/verticales/avia/declarations/:id/observations` |
| POST | `/v1/verticales/avia/declarations/:id/reconcile` |
| POST | `/v1/verticales/avia/declarations/:id/validate` |
| GET | `/v1/verticales/avia/ifa/:code` |
| POST | `/v1/verticales/avia/ifa/controls` |
| POST | `/v1/verticales/avia/operator-data` |
| GET | `/v1/verticales/avia/overview` |
| GET | `/v1/verticales/avia/rrh/agencies` |
| POST | `/v1/verticales/avia/rrh/agencies` |
| POST | `/v1/verticales/avia/rrh/agencies/:id/decision` |
| POST | `/v1/verticales/avia/rrh/agencies/:id/tickets` |
| GET | `/v1/verticales/avia/rrh/connectors` |
| POST | `/v1/verticales/avia/rrh/connectors/:code/pull` |
| POST | `/v1/verticales/avia/rrh/freight` |
| GET | `/v1/verticales/avia/rrh/overview` |
| POST | `/v1/verticales/avia/rrh/passenger-events` |
| GET | `/v1/verticales/avia/rrh/reconciliations` |
| POST | `/v1/verticales/avia/rrh/reconciliations` |
| GET | `/v1/verticales/avia/rrh/reconciliations/:id` |
| POST | `/v1/verticales/avia/rrh/reconciliations/:id/lines/:airline/submit` |
| POST | `/v1/verticales/avia/rrh/remittances` |
| POST | `/v1/verticales/avia/rrh/tickets` |
| POST | `/v1/verticales/calcu/accounts` |
| POST | `/v1/verticales/calcu/accounts/:id/validate` |
| POST | `/v1/verticales/calcu/documents` |
| POST | `/v1/verticales/calcu/fournisseurs` |
| POST | `/v1/verticales/calcu/fournisseurs/:id/radiation` |
| POST | `/v1/verticales/calcu/fournisseurs/:id/validation` |
| POST | `/v1/verticales/calcu/gateway/transactions` |
| POST | `/v1/verticales/calcu/justificatifs` |
| POST | `/v1/verticales/calcu/lignes-budgetaires` |
| POST | `/v1/verticales/calcu/lignes-budgetaires/:id/validation` |
| POST | `/v1/verticales/calcu/missions` |
| POST | `/v1/verticales/calcu/missions/:id/cloture` |
| GET | `/v1/verticales/calcu/missions/:id/preuves` |
| GET | `/v1/verticales/calcu/organe` |
| GET | `/v1/verticales/calcu/overview` |
| POST | `/v1/verticales/calcu/recommandations` |
| POST | `/v1/verticales/calcu/recommandations/:id/suivi` |
| POST | `/v1/verticales/calcu/reports/:id/close` |
| POST | `/v1/verticales/calcu/reports/:id/freeze` |
| GET | `/v1/verticales/calcu/reports/:id/pdf` |
| POST | `/v1/verticales/calcu/reports/:id/recuperations` |
| POST | `/v1/verticales/calcu/reports/:id/transmission-justice` |
| POST | `/v1/verticales/calcu/transmissions/:id/decision` |
| GET | `/v1/verticales/cases` |
| GET | `/v1/verticales/cases/:id` |
| POST | `/v1/verticales/cases/:id/decide` |
| POST | `/v1/verticales/cases/:id/documents` |
| POST | `/v1/verticales/cases/:id/propose` |
| POST | `/v1/verticales/cases/:id/request-info` |
| POST | `/v1/verticales/cases/:id/take` |
| POST | `/v1/verticales/cases/:id/visits` |
| GET | `/v1/verticales/catalogue/:slug` |
| GET | `/v1/verticales/domaine-public/emprises` |
| GET | `/v1/verticales/entreprises/etablissements/:objectId/obligations` |
| GET | `/v1/verticales/environnement/registre` |
| POST | `/v1/verticales/environnement/simulations` |
| POST | `/v1/verticales/evenements/events/:objectId/controls` |
| POST | `/v1/verticales/evenements/events/:objectId/ticketing` |
| GET | `/v1/verticales/fiches/:module/configuration` |
| POST | `/v1/verticales/fiches/:module/configuration` |
| GET | `/v1/verticales/fiches/:module/objets` |
| POST | `/v1/verticales/fiches/:module/objets` |
| GET | `/v1/verticales/fiches/:module/types-titres` |
| POST | `/v1/verticales/fiches/antennes/imports` |
| GET | `/v1/verticales/fiches/antennes/mutations` |
| POST | `/v1/verticales/fiches/antennes/mutations/:id/decision` |
| GET | `/v1/verticales/fiches/antennes/recouvrement` |
| POST | `/v1/verticales/fiches/antennes/sites/:objectId/mutations` |
| POST | `/v1/verticales/fiches/assainissement/application` |
| GET | `/v1/verticales/fiches/assainissement/portefeuille` |
| GET | `/v1/verticales/fiches/boissons/coherence` |
| POST | `/v1/verticales/fiches/boissons/livraisons` |
| GET | `/v1/verticales/fiches/boissons/points-livraison` |
| GET | `/v1/verticales/fiches/boissons/points-non-autorises` |
| POST | `/v1/verticales/fiches/boissons/redevables/:taxpayerId/relances` |
| GET | `/v1/verticales/fiches/boissons/suivi` |
| GET | `/v1/verticales/fiches/boissons/transmissions` |
| POST | `/v1/verticales/fiches/boissons/transmissions` |
| POST | `/v1/verticales/fiches/carrieres/:objectId/bons` |
| GET | `/v1/verticales/fiches/carrieres/:objectId/sorties` |
| POST | `/v1/verticales/fiches/carrieres/:objectId/sorties` |
| GET | `/v1/verticales/fiches/departs` |
| POST | `/v1/verticales/fiches/departs` |
| GET | `/v1/verticales/fiches/departs/:id/embarquements` |
| POST | `/v1/verticales/fiches/departs/:id/embarquements` |
| POST | `/v1/verticales/fiches/departs/:id/manifeste` |
| POST | `/v1/verticales/fiches/departs/:id/mouvements` |
| GET | `/v1/verticales/fiches/departs/:id/rapprochement` |
| POST | `/v1/verticales/fiches/departs/:id/titres` |
| GET | `/v1/verticales/fiches/embarcations/:ref/controle` |
| POST | `/v1/verticales/fiches/evenements/:objectId/liquidation` |
| GET | `/v1/verticales/fiches/evenements/recettes` |
| GET | `/v1/verticales/fiches/forets/declarations` |
| POST | `/v1/verticales/fiches/forets/declarations` |
| GET | `/v1/verticales/fiches/indicateurs` |
| GET | `/v1/verticales/fiches/liquidations` |
| POST | `/v1/verticales/fiches/liquidations` |
| POST | `/v1/verticales/fiches/liquidations/:id/decision` |
| GET | `/v1/verticales/fiches/liquidations/automatique` |
| POST | `/v1/verticales/fiches/liquidations/automatique` |
| GET | `/v1/verticales/fiches/marches/abonnements/mine` |
| POST | `/v1/verticales/fiches/marches/etals/:stallId/abonnement` |
| GET | `/v1/verticales/fiches/marches/rapprochement` |
| GET | `/v1/verticales/fiches/objets/:objectId/avis-unique` |
| GET | `/v1/verticales/fiches/peage/carnets/:plaque` |
| POST | `/v1/verticales/fiches/peage/passages` |
| POST | `/v1/verticales/fiches/peage/titres` |
| GET | `/v1/verticales/fiches/ports/rapprochement` |
| GET | `/v1/verticales/fiches/references` |
| POST | `/v1/verticales/fiches/references` |
| GET | `/v1/verticales/indicators` |
| GET | `/v1/verticales/marches/plan` |
| POST | `/v1/verticales/marches/stalls/:id/titles` |
| GET | `/v1/verticales/me/summary` |
| GET | `/v1/verticales/nfiu/habilitations` |
| POST | `/v1/verticales/nfiu/habilitations` |
| POST | `/v1/verticales/nfiu/habilitations/:userId/revocation` |
| GET | `/v1/verticales/nfiu/habilitations/mienne` |
| GET | `/v1/verticales/nfiu/indicateurs` |
| GET | `/v1/verticales/nfiu/plates/:code/situation` |
| GET | `/v1/verticales/nfiu/rapports` |
| POST | `/v1/verticales/nfiu/rapports` |
| GET | `/v1/verticales/nfiu/rapports/historique` |
| GET | `/v1/verticales/plastique` |
| POST | `/v1/verticales/plastique/assujettis` |
| POST | `/v1/verticales/plastique/declarations` |
| POST | `/v1/verticales/plastique/declarations/:id/reversement` |
| POST | `/v1/verticales/plastique/etude` |
| POST | `/v1/verticales/plastique/simulations` |
| POST | `/v1/verticales/plates` |
| GET | `/v1/verticales/plates-report/daily` |
| GET | `/v1/verticales/plates/:code/counter` |
| POST | `/v1/verticales/plates/:code/replace` |
| GET | `/v1/verticales/plates/:code/scan` |
| GET | `/v1/verticales/secteurs` |
| POST | `/v1/verticales/secteurs/:module/releves` |
| GET | `/v1/verticales/secteurs/antennes/liquidation-annuelle` |
| POST | `/v1/verticales/secteurs/antennes/liquidation-annuelle` |
| POST | `/v1/verticales/secteurs/antennes/liquidation-annuelle/automatique` |
| GET | `/v1/verticales/secteurs/declarations` |
| POST | `/v1/verticales/secteurs/declarations` |
| GET | `/v1/verticales/secteurs/declarations/:id` |
| POST | `/v1/verticales/secteurs/declarations/:id/decision` |
| POST | `/v1/verticales/secteurs/declarations/:id/observations` |
| POST | `/v1/verticales/secteurs/declarations/:id/rapprochement` |
| POST | `/v1/verticales/secteurs/donnees-tierces` |
| GET | `/v1/verticales/secteurs/grands-redevables` |
| POST | `/v1/verticales/secteurs/grands-redevables` |
| POST | `/v1/verticales/secteurs/grands-redevables/:taxpayerId/levee` |
| GET | `/v1/verticales/secteurs/modules/:module` |
| GET | `/v1/verticales/telecom/reconciliation` |
| GET | `/v1/verticales/vehicules/:plaque/controle` |

## Module ai

| Méthode | Chemin |
|---|---|
| POST | `/v1/ai/insights` |
| GET | `/v1/ai/recommendations` |
| POST | `/v1/ai/recommendations/:id/decide` |

## Module alerts

| Méthode | Chemin |
|---|---|
| GET | `/v1/security/alerts` |

## Module appeals

| Méthode | Chemin |
|---|---|
| GET | `/v1/appeals` |
| POST | `/v1/appeals` |
| GET | `/v1/appeals/:id` |
| POST | `/v1/appeals/:id/assign` |
| POST | `/v1/appeals/:id/decide` |
| POST | `/v1/appeals/:id/documents` |
| POST | `/v1/appeals/:id/instruct` |
| POST | `/v1/appeals/:id/suspensive-effect` |
| POST | `/v1/appeals/:id/suspensive-effect/decision` |
| GET | `/v1/appeals/indicateurs` |
| GET | `/v1/appeals/procedure` |
| GET | `/v1/appeals/proprietaires` |

## Module assessment

| Méthode | Chemin |
|---|---|
| GET | `/v1/assessments/base-overrides` |
| POST | `/v1/assessments/base-overrides` |
| POST | `/v1/assessments/base-overrides/:id/decision` |
| POST | `/v1/assessments/calculate` |
| GET | `/v1/obligations` |
| GET | `/v1/obligations/:id` |

## Module audit

| Méthode | Chemin |
|---|---|
| GET | `/v1/audit/events` |
| GET | `/v1/audit/verify` |

## Module communications

| Méthode | Chemin |
|---|---|
| GET | `/v1/communications/events` |
| GET | `/v1/communications/overview` |
| GET | `/v1/communications/preview/:eventCode` |
| POST | `/v1/communications/test` |

## Module dashboards

| Méthode | Chemin |
|---|---|
| GET | `/v1/dashboards/governor` |

## Module drafts

| Méthode | Chemin |
|---|---|
| GET | `/v1/drafts/:key` |
| PUT | `/v1/drafts/:key` |
| GET | `/v1/drafts/:key/versions` |

## Module field

| Méthode | Chemin |
|---|---|
| POST | `/v1/field-sync/batches` |

## Module fx

| Méthode | Chemin |
|---|---|
| GET | `/v1/exchange-rates/:date` |

## Module identity

| Méthode | Chemin |
|---|---|
| GET | `/v1/compte-unique/:taxpayerId` |
| GET | `/v1/compte-unique/fiches-metier` |
| GET | `/v1/compte-unique/me` |
| GET | `/v1/moi/a-faire` |
| POST | `/v1/registrations` |
| GET | `/v1/taxpayers/:id` |

## Module integrations

| Méthode | Chemin |
|---|---|
| POST | `/v1/integrations/:group/test` |
| GET | `/v1/integrations/keys` |
| POST | `/v1/integrations/keys/:name/proposals` |
| GET | `/v1/integrations/proposals` |
| POST | `/v1/integrations/proposals/:id/approve` |
| POST | `/v1/integrations/proposals/:id/reject` |
| GET | `/v1/integrations/webhooks` |

## Module objects

| Méthode | Chemin |
|---|---|
| POST | `/v1/fiscal-objects` |
| POST | `/v1/leases` |

## Module payments

| Méthode | Chemin |
|---|---|
| POST | `/v1/obligations/:id/payment-orders` |
| POST | `/v1/payment-orders/:reference/provider-resolution` |
| POST | `/v1/payment-orders/:reference/provider-verification-evidence` |
| GET | `/v1/payment-orders/:reference/status` |
| POST | `/v1/providers/:provider/callbacks` |
| POST | `/v1/providers/:provider/demo-operator-confirmation` |
| POST | `/v1/providers/:provider/sandbox-simulate` |
| POST | `/v1/providers/:provider/test-connection` |
| POST | `/v1/providers/bitripay/webhooks` |
| GET | `/v1/providers/connectors` |
| POST | `/v1/providers/koda/webhooks` |
| GET | `/v1/providers/readiness` |

## Module receipts

| Méthode | Chemin |
|---|---|
| GET | `/v1/public/receipts/:code` |
| GET | `/v1/public/receipts/revocations` |

## Module rules

| Méthode | Chemin |
|---|---|
| GET | `/v1/legal-instruments` |
| POST | `/v1/legal-instruments/:id/abrogate` |
| GET | `/v1/legal-instruments/completude` |
| GET | `/v1/legal-rules` |
| POST | `/v1/legal-rules` |
| GET | `/v1/legal-rules/:id` |
| POST | `/v1/legal-rules/:id/abrogate` |
| POST | `/v1/legal-rules/:id/approve` |
| POST | `/v1/legal-rules/:id/archive-requests` |
| GET | `/v1/legal-rules/:id/fiche-technique` |
| POST | `/v1/legal-rules/:id/impact-simulations` |
| POST | `/v1/legal-rules/:id/lift-suspension` |
| POST | `/v1/legal-rules/:id/sample-simulations` |
| POST | `/v1/legal-rules/:id/suspend` |
| POST | `/v1/legal-rules/:id/suspension-change/decide` |
| GET | `/v1/legal-rules/:id/test-cases` |
| POST | `/v1/legal-rules/:id/test-cases` |
| POST | `/v1/legal-rules/:id/test-cases/:caseId/validate` |
| POST | `/v1/legal-rules/:id/test-cases/run` |
| GET | `/v1/legal-rules/:id/versions` |
| POST | `/v1/legal-rules/archives/:id/decide` |
| GET | `/v1/legal-rules/attributs-techniques` |
| GET | `/v1/legal-rules/veille` |
| GET | `/v1/recalculations` |
| GET | `/v1/recalculations/:id` |
| POST | `/v1/recalculations/:id/decide` |

## Module system

| Méthode | Chemin |
|---|---|
| GET | `/health` |
| GET | `/v1/demo/users` |
| GET | `/v1/meta` |

## Module treasury

| Méthode | Chemin |
|---|---|
| GET | `/v1/ledger/balance` |
| GET | `/v1/ledger/entries` |
| POST | `/v1/ledger/entries/:id/reversals` |
| GET | `/v1/reconciliation/exceptions` |
| GET | `/v1/settlements/imports` |
| GET | `/v1/settlements/statements` |
| POST | `/v1/settlements/statements` |
| POST | `/v1/settlements/statements/:statementId/validation` |

## Module vault

| Méthode | Chemin |
|---|---|
| GET | `/v1/beneficiary-accounts` |
| POST | `/v1/beneficiary-accounts/change-requests` |
| POST | `/v1/beneficiary-accounts/change-requests/:id/approve` |
| POST | `/v1/beneficiary-accounts/change-requests/:id/veto` |
