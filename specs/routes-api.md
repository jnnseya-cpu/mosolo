# Catalogue des routes de l'API KINSHASA MOSOLO

Généré depuis le code source (`tools/gen_routes.py`) : **638 routes** dans 35 modules. Chaque route applique le point de décision des politiques (RBAC + ABAC) ; les erreurs suivent la RFC 9457. Le contrat détaillé des routes du socle figure dans `specs/openapi.yaml` et `specs/contrat-api.md` ; les règles d'accès de chaque module d'extension sont déclarées dans son fichier `policy.ts`.

| Module | Routes |
|---|---|
| extension acces | 63 |
| extension canaux | 45 |
| extension fiscal | 44 |
| extension ia | 28 |
| extension integrite | 58 |
| extension parking | 36 |
| extension pilotage | 24 |
| extension preuves | 14 |
| extension publicite | 34 |
| extension rakapay | 23 |
| extension recouvrement | 37 |
| extension sanctions | 8 |
| extension socle | 14 |
| extension terrain | 47 |
| extension titres | 20 |
| extension tresor | 27 |
| extension verticales | 43 |
| module ai | 3 |
| module alerts | 1 |
| module appeals | 9 |
| module assessment | 6 |
| module audit | 2 |
| module communications | 4 |
| module dashboards | 1 |
| module drafts | 3 |
| module field | 1 |
| module fx | 1 |
| module identity | 2 |
| module objects | 2 |
| module payments | 8 |
| module receipts | 2 |
| module rules | 15 |
| module system | 3 |
| module treasury | 6 |
| module vault | 4 |

## Extension acces

| Méthode | Chemin |
|---|---|
| GET | `/v1/acces/accounts` |
| POST | `/v1/acces/accounts/:id/revoke` |
| POST | `/v1/acces/accounts/me/secrets` |
| GET | `/v1/acces/arbitrations` |
| GET | `/v1/acces/arbitrations/:id` |
| POST | `/v1/acces/arbitrations/:id/decision` |
| POST | `/v1/acces/arbitrations/:id/opinion` |
| POST | `/v1/acces/assisted-enrolments` |
| GET | `/v1/acces/claims` |
| POST | `/v1/acces/claims` |
| POST | `/v1/acces/claims/liquidations` |
| GET | `/v1/acces/consultations` |
| POST | `/v1/acces/consultations` |
| GET | `/v1/acces/consultations/:id/dossier` |
| POST | `/v1/acces/consultations/:id/review` |
| GET | `/v1/acces/duplicates` |
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
| GET | `/v1/acces/invitations` |
| POST | `/v1/acces/invitations` |
| POST | `/v1/acces/invitations/:id/assisted` |
| POST | `/v1/acces/invitations/:id/revoke` |
| POST | `/v1/acces/invitations/accept` |
| GET | `/v1/acces/invitations/lookup` |
| GET | `/v1/acces/journal` |
| GET | `/v1/acces/levels` |
| GET | `/v1/acces/mandates` |
| POST | `/v1/acces/mandates` |
| POST | `/v1/acces/mandates/:id/revoke` |
| GET | `/v1/acces/mandates/check` |
| GET | `/v1/acces/me` |
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
| GET | `/v1/acces/validations` |
| POST | `/v1/acces/validations/:id/decision` |
| GET | `/v1/acces/validations/mine` |

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

## Extension fiscal

| Méthode | Chemin |
|---|---|
| GET | `/v1/fiscal/clearances` |
| POST | `/v1/fiscal/clearances` |
| POST | `/v1/fiscal/clearances/:id/revoke` |
| GET | `/v1/fiscal/clearances/eligibility` |
| GET | `/v1/fiscal/clearances/review` |
| GET | `/v1/fiscal/clearances/verify/:code` |
| GET | `/v1/fiscal/declarations` |
| POST | `/v1/fiscal/declarations` |
| GET | `/v1/fiscal/declarations/:id` |
| POST | `/v1/fiscal/declarations/:id/corrections` |
| POST | `/v1/fiscal/declarations/:id/instruction` |
| GET | `/v1/fiscal/declarations/prefill` |
| POST | `/v1/fiscal/disputes/:id/resolve` |
| GET | `/v1/fiscal/exemptions` |
| POST | `/v1/fiscal/exemptions` |
| GET | `/v1/fiscal/exemptions/:id` |
| POST | `/v1/fiscal/exemptions/:id/decision` |
| POST | `/v1/fiscal/exemptions/:id/instruction` |
| POST | `/v1/fiscal/exemptions/:id/legal-visa` |
| POST | `/v1/fiscal/exemptions/:id/revoke` |
| GET | `/v1/fiscal/geo-units` |
| GET | `/v1/fiscal/leases` |
| POST | `/v1/fiscal/leases/:id/attestations` |
| GET | `/v1/fiscal/map` |
| GET | `/v1/fiscal/nearby` |
| GET | `/v1/fiscal/object-corrections` |
| POST | `/v1/fiscal/object-corrections/:id/decision` |
| GET | `/v1/fiscal/objects` |
| GET | `/v1/fiscal/objects/:id` |
| GET | `/v1/fiscal/objects/:id/corrections` |
| POST | `/v1/fiscal/objects/:id/corrections` |
| POST | `/v1/fiscal/objects/:id/plate/pose` |
| POST | `/v1/fiscal/objects/:id/plate/replace` |
| POST | `/v1/fiscal/objects/:id/validate` |
| GET | `/v1/fiscal/plates/:code/scan` |
| GET | `/v1/fiscal/reference` |
| POST | `/v1/fiscal/relationships` |
| POST | `/v1/fiscal/relationships/:id/close` |
| POST | `/v1/fiscal/relationships/:id/contest` |
| POST | `/v1/fiscal/relationships/:id/validate` |
| GET | `/v1/fiscal/relationships/queue` |
| GET | `/v1/public/fiscal/clearances/:code` |
| GET | `/v1/public/fiscal/lease-attestations/:code` |
| GET | `/v1/public/fiscal/plates/:code` |

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
| GET | `/v1/integrite/alerts` |
| POST | `/v1/integrite/alerts/:id/examine` |
| POST | `/v1/integrite/alerts/:id/propose-closure` |
| POST | `/v1/integrite/alerts/:id/validate-closure` |
| GET | `/v1/integrite/cases` |
| POST | `/v1/integrite/cases` |
| GET | `/v1/integrite/cases/:id` |
| POST | `/v1/integrite/cases/:id/conclusions` |
| POST | `/v1/integrite/cases/:id/decision` |
| POST | `/v1/integrite/cases/:id/evidence` |
| POST | `/v1/integrite/cases/:id/links` |
| POST | `/v1/integrite/cases/:id/notes` |
| GET | `/v1/integrite/collusion` |
| POST | `/v1/integrite/collusion/run` |
| POST | `/v1/integrite/detection/run` |
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
| GET | `/v1/integrite/privacy/access-log` |
| GET | `/v1/integrite/privacy/registry` |
| POST | `/v1/integrite/privacy/registry` |
| GET | `/v1/integrite/privacy/registry/:id/history` |
| GET | `/v1/integrite/privacy/requests` |
| POST | `/v1/integrite/privacy/requests` |
| GET | `/v1/integrite/privacy/requests/:id/export` |
| POST | `/v1/integrite/privacy/requests/:id/respond` |
| POST | `/v1/integrite/privacy/requests/:id/take` |
| GET | `/v1/integrite/reports` |
| GET | `/v1/integrite/reports/:id` |
| POST | `/v1/integrite/reports/:id/assign` |
| POST | `/v1/integrite/reports/:id/close` |
| POST | `/v1/integrite/reports/:id/messages` |
| POST | `/v1/integrite/reports/:id/qualify` |
| POST | `/v1/integrite/reports/intake` |
| GET | `/v1/integrite/thresholds` |
| POST | `/v1/integrite/thresholds/change-requests` |
| POST | `/v1/integrite/thresholds/change-requests/:id/decision` |
| POST | `/v1/public/integrite/reports` |
| POST | `/v1/public/integrite/reports/sms` |
| POST | `/v1/public/integrite/reports/svi` |
| POST | `/v1/public/integrite/reports/track` |
| POST | `/v1/public/integrite/reports/track/complement` |
| GET | `/v1/public/integrite/summary` |

## Extension parking

| Méthode | Chemin |
|---|---|
| GET | `/v1/parking/agents/earnings` |
| GET | `/v1/parking/agents/me/earnings` |
| GET | `/v1/parking/control/:plate` |
| POST | `/v1/parking/evidence-photos` |
| GET | `/v1/parking/evidence-photos/:id` |
| GET | `/v1/parking/indicators` |
| GET | `/v1/parking/partners` |
| POST | `/v1/parking/partners` |
| POST | `/v1/parking/partners/:id/occupancy` |
| POST | `/v1/parking/partners/:id/status` |
| GET | `/v1/parking/partners/mine` |
| GET | `/v1/parking/penalties` |
| POST | `/v1/parking/reminders/run` |
| GET | `/v1/parking/reservations` |
| POST | `/v1/parking/reservations` |
| POST | `/v1/parking/reservations/:id/decide` |
| GET | `/v1/parking/reservations/mine` |
| POST | `/v1/parking/sessions` |
| GET | `/v1/parking/sessions/:id` |
| POST | `/v1/parking/sessions/:id/end` |
| POST | `/v1/parking/sessions/:id/extend` |
| GET | `/v1/parking/sessions/mine` |
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
| POST | `/v1/parking/zones/:id/suspension` |
| POST | `/v1/parking/zones/:id/tariff` |

## Extension pilotage

| Méthode | Chemin |
|---|---|
| GET | `/v1/pilotage/drill/:dimension` |
| GET | `/v1/pilotage/echelle` |
| GET | `/v1/pilotage/exports/:kind` |
| POST | `/v1/pilotage/exports/verify` |
| GET | `/v1/pilotage/indicateurs` |
| GET | `/v1/pilotage/piste-audit` |
| GET | `/v1/pilotage/piste-audit/:ref` |
| GET | `/v1/pilotage/reductions` |
| POST | `/v1/pilotage/reductions/detection` |
| GET | `/v1/pilotage/repartition` |
| GET | `/v1/pilotage/repartition/cle` |
| POST | `/v1/pilotage/repartition/cles/:id/acte` |
| POST | `/v1/pilotage/repartition/cles/:id/activation` |
| POST | `/v1/pilotage/repartition/cles/:id/activation/decision` |
| GET | `/v1/pilotage/repartition/distributions` |
| POST | `/v1/pilotage/repartition/propositions` |
| GET | `/v1/pilotage/serie` |
| GET | `/v1/pilotage/tableaux` |
| GET | `/v1/pilotage/tableaux/:profil` |
| GET | `/v1/pilotage/transparence/:period` |
| POST | `/v1/pilotage/transparence/:period/publier` |
| GET | `/v1/public/transparency` |
| GET | `/v1/public/transparency/:period` |
| GET | `/v1/tableaux/:profil` |

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
| GET | `/v1/publicite/authorizations/mine` |
| GET | `/v1/publicite/cases` |
| POST | `/v1/publicite/cases/:id/contest` |
| POST | `/v1/publicite/cases/:id/decide` |
| POST | `/v1/publicite/cases/:id/verify` |
| GET | `/v1/publicite/cases/mine` |
| POST | `/v1/publicite/devices` |
| GET | `/v1/publicite/devices/:id` |
| GET | `/v1/publicite/devices/mine` |
| POST | `/v1/publicite/evidence-photos` |
| GET | `/v1/publicite/evidence-photos/:id` |
| GET | `/v1/publicite/indicators` |
| GET | `/v1/publicite/inspections` |
| POST | `/v1/publicite/inspections` |
| GET | `/v1/publicite/inventory` |
| GET | `/v1/publicite/liquidations/pending` |
| GET | `/v1/publicite/lookup` |
| GET | `/v1/publicite/map` |
| GET | `/v1/publicite/nearby` |
| GET | `/v1/publicite/obligations/mine` |
| GET | `/v1/publicite/public/badges/:userId` |
| GET | `/v1/publicite/public/devices/:token` |
| POST | `/v1/publicite/reminders/run` |
| GET | `/v1/publicite/vehicles/:plate` |

## Extension rakapay

| Méthode | Chemin |
|---|---|
| GET | `/v1/public/wewa/:code` |
| GET | `/v1/rakapay/catalogue` |
| GET | `/v1/rakapay/cooperatives` |
| GET | `/v1/rakapay/cooperatives/:id` |
| POST | `/v1/rakapay/cooperatives/:id/decisions` |
| POST | `/v1/rakapay/cooperatives/:id/paiements-groupes` |
| GET | `/v1/rakapay/indicateurs` |
| GET | `/v1/rakapay/lignes` |
| GET | `/v1/rakapay/operateurs` |
| GET | `/v1/rakapay/signalements` |
| POST | `/v1/rakapay/signalements` |
| POST | `/v1/rakapay/signalements/:id/traitement` |
| GET | `/v1/rakapay/stations` |
| GET | `/v1/rakapay/tickets` |
| POST | `/v1/rakapay/tickets` |
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
| GET | `/v1/recouvrement/arrieres` |
| GET | `/v1/recouvrement/avis` |
| POST | `/v1/recouvrement/avis` |
| GET | `/v1/recouvrement/avis/:id` |
| POST | `/v1/recouvrement/avis/:id/lecture` |
| GET | `/v1/recouvrement/avis/:id/preuve` |
| POST | `/v1/recouvrement/contribuables/:id/adresse-notification` |
| GET | `/v1/recouvrement/dossiers` |
| POST | `/v1/recouvrement/dossiers` |
| GET | `/v1/recouvrement/dossiers/:id` |
| POST | `/v1/recouvrement/dossiers/:id/observations` |
| POST | `/v1/recouvrement/dossiers/:id/propositions` |
| POST | `/v1/recouvrement/dossiers/:id/rappel` |
| GET | `/v1/recouvrement/echeanciers` |
| POST | `/v1/recouvrement/echeanciers` |
| POST | `/v1/recouvrement/echeanciers/:id/decision` |
| POST | `/v1/recouvrement/echeanciers/:id/defaillance` |
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
| GET | `/v1/recouvrement/propositions` |
| POST | `/v1/recouvrement/propositions/:id/decision` |
| GET | `/v1/recouvrement/remises` |
| POST | `/v1/recouvrement/remises` |
| POST | `/v1/recouvrement/remises/:id/decision` |
| POST | `/v1/recouvrement/remises/:id/instruction` |
| GET | `/v1/recouvrement/reprises` |
| POST | `/v1/recouvrement/reprises` |
| POST | `/v1/recouvrement/reprises/:id/validation` |

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
| GET | `/v1/agents/monitoring` |

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
| POST | `/v1/auth/passkeys/registration` |
| POST | `/v1/auth/refresh` |
| GET | `/v1/auth/sessions` |
| POST | `/v1/auth/sessions/:id/revoke` |
| POST | `/v1/socle/exports` |
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
| POST | `/v1/terrain/findings/:id/review` |
| GET | `/v1/terrain/indicators` |
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
| POST | `/v1/terrain/missions/:id/findings` |
| GET | `/v1/terrain/mystery-checks` |
| POST | `/v1/terrain/mystery-checks` |
| POST | `/v1/terrain/mystery-checks/:id/result` |
| GET | `/v1/terrain/quality` |
| POST | `/v1/terrain/quality/samples` |
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
| POST | `/v1/titres/constats/:id/decision` |
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
| POST | `/v1/receipts/:ref/duplicates` |
| GET | `/v1/tresor/accounting` |
| GET | `/v1/tresor/closures` |
| POST | `/v1/tresor/closures/daily` |
| POST | `/v1/tresor/closures/daily/waivers` |
| POST | `/v1/tresor/closures/daily/waivers/:id/approve` |
| POST | `/v1/tresor/closures/monthly` |
| GET | `/v1/tresor/consistency` |
| GET | `/v1/tresor/exceptions` |
| POST | `/v1/tresor/exceptions/:id/assign` |
| POST | `/v1/tresor/exceptions/:id/evidence` |
| POST | `/v1/tresor/exceptions/:id/resolution` |
| POST | `/v1/tresor/exceptions/:id/resolution/approve` |
| POST | `/v1/tresor/exceptions/:id/resolution/reject` |
| POST | `/v1/tresor/exceptions/:id/start` |
| GET | `/v1/tresor/exports` |
| POST | `/v1/tresor/imputations/run` |
| GET | `/v1/tresor/nomenclature` |
| GET | `/v1/tresor/operations` |
| POST | `/v1/tresor/operations` |
| POST | `/v1/tresor/operations/:id/approve` |
| POST | `/v1/tresor/operations/:id/reject` |
| GET | `/v1/tresor/overview` |
| GET | `/v1/tresor/provider-receivables` |
| GET | `/v1/tresor/receipts/:ref` |
| GET | `/v1/tresor/suspense` |
| GET | `/v1/tresor/verification-journal` |

## Extension verticales

| Méthode | Chemin |
|---|---|
| GET | `/v1/public/verticales/certificates/:code` |
| GET | `/v1/public/verticales/plates/:code` |
| GET | `/v1/verticales` |
| GET | `/v1/verticales/:slug` |
| POST | `/v1/verticales/:slug/cases` |
| POST | `/v1/verticales/:slug/objects/:objectId/liquidate` |
| GET | `/v1/verticales/:slug/space` |
| GET | `/v1/verticales/avia/declarations` |
| POST | `/v1/verticales/avia/declarations` |
| GET | `/v1/verticales/avia/declarations/:id` |
| POST | `/v1/verticales/avia/declarations/:id/billing` |
| POST | `/v1/verticales/avia/declarations/:id/observations` |
| POST | `/v1/verticales/avia/declarations/:id/reconcile` |
| POST | `/v1/verticales/avia/declarations/:id/validate` |
| POST | `/v1/verticales/avia/operator-data` |
| GET | `/v1/verticales/avia/overview` |
| POST | `/v1/verticales/calcu/accounts` |
| POST | `/v1/verticales/calcu/accounts/:id/validate` |
| POST | `/v1/verticales/calcu/documents` |
| POST | `/v1/verticales/calcu/gateway/transactions` |
| GET | `/v1/verticales/calcu/overview` |
| POST | `/v1/verticales/calcu/reports/:id/close` |
| POST | `/v1/verticales/calcu/reports/:id/freeze` |
| GET | `/v1/verticales/cases` |
| GET | `/v1/verticales/cases/:id` |
| POST | `/v1/verticales/cases/:id/decide` |
| POST | `/v1/verticales/cases/:id/documents` |
| POST | `/v1/verticales/cases/:id/propose` |
| POST | `/v1/verticales/cases/:id/request-info` |
| POST | `/v1/verticales/cases/:id/take` |
| POST | `/v1/verticales/cases/:id/visits` |
| POST | `/v1/verticales/evenements/events/:objectId/controls` |
| POST | `/v1/verticales/evenements/events/:objectId/ticketing` |
| GET | `/v1/verticales/indicators` |
| GET | `/v1/verticales/marches/plan` |
| POST | `/v1/verticales/marches/stalls/:id/titles` |
| GET | `/v1/verticales/me/summary` |
| POST | `/v1/verticales/plates` |
| GET | `/v1/verticales/plates-report/daily` |
| GET | `/v1/verticales/plates/:code/counter` |
| POST | `/v1/verticales/plates/:code/replace` |
| GET | `/v1/verticales/plates/:code/scan` |
| GET | `/v1/verticales/telecom/reconciliation` |

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
| POST | `/v1/appeals/:id/decide` |
| POST | `/v1/appeals/:id/documents` |
| POST | `/v1/appeals/:id/instruct` |
| POST | `/v1/appeals/:id/suspensive-effect` |
| POST | `/v1/appeals/:id/suspensive-effect/decision` |
| GET | `/v1/appeals/procedure` |

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
| POST | `/v1/registrations` |
| GET | `/v1/taxpayers/:id` |

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
| POST | `/v1/providers/:provider/callbacks` |
| POST | `/v1/providers/:provider/sandbox-simulate` |
| POST | `/v1/providers/bitripay/webhooks` |
| GET | `/v1/providers/connectors` |
| POST | `/v1/providers/koda/webhooks` |

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
| GET | `/v1/legal-rules` |
| POST | `/v1/legal-rules` |
| GET | `/v1/legal-rules/:id` |
| POST | `/v1/legal-rules/:id/abrogate` |
| POST | `/v1/legal-rules/:id/approve` |
| POST | `/v1/legal-rules/:id/impact-simulations` |
| POST | `/v1/legal-rules/:id/lift-suspension` |
| POST | `/v1/legal-rules/:id/suspend` |
| POST | `/v1/legal-rules/:id/suspension-change/decide` |
| GET | `/v1/legal-rules/:id/versions` |
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
| GET | `/v1/settlements/statements` |
| POST | `/v1/settlements/statements` |

## Module vault

| Méthode | Chemin |
|---|---|
| GET | `/v1/beneficiary-accounts` |
| POST | `/v1/beneficiary-accounts/change-requests` |
| POST | `/v1/beneficiary-accounts/change-requests/:id/approve` |
| POST | `/v1/beneficiary-accounts/change-requests/:id/veto` |
