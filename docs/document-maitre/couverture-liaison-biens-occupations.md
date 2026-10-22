# Matrice de couverture — « Liaison des biens et occupations » (spécification v1.0 du 28/09/2026)

Source : `docs/sources/Specification_Liaison_Biens_Occupations_v1.0.md` (texte intégral, reçu du maître d'ouvrage).
Construite SUR le module 7 (relations contribuable–objet, `backend/src/plugins/fiscal/relations.ts`) et les objets
fiscaux existants (parcelle → bâtiment → unité) : aucun système parallèle, rien n'est retiré.

Abréviations : `be:` = `backend/test/liaison-biens-occupations.test.ts` ; `cu:` = `backend/test/compte-unique.test.ts` ;
`fe:` = `frontend/test/compte-unique.test.tsx` ; `bo` = `backend/src/plugins/fiscal/biens-occupations.ts` ;
`br` = `backend/src/plugins/fiscal/biens-routes.ts` ; `bc` = `backend/src/plugins/fiscal/biens-config.ts`.

## Critères d'acceptation (§ 9)

| CA | Critère | Implémentation | Test | Statut |
|---|---|---|---|---|
| CA-1 | Deux personnes inscrites séparément revendiquent la même unité canonique dans les deux ordres, sans doublon de compte ni vérification automatique | `bo.submit`, `bo.findCandidates`, `bo.selectCandidate` ; anti-doublon des comptes (identité) | be:« CA-1 — propriétaire et locataire… » | CONSTRUIT |
| CA-2 | Unité provisoire du locataire reliée à l'unité canonique du propriétaire seulement après revue auditée ; identifiants, pièces, revendications traçables | `bo.queueDuplicateReview`, `bo.decideMerge` (cible explicite, alias, `originalTargetId`, `originalObjectId`) | be:« CA-2 — une unité provisoire… » | CONSTRUIT |
| CA-3 | Un compte possède une unité et en loue une autre ; copropriété et plusieurs occupants | relations multiples par compte et par objet ; quotes-parts (module 7) ; colocation | be:« CA-3 — un même compte possède… » | CONSTRUIT |
| CA-4 | Aucune réponse à un revendicateur non vérifié ne révèle nom, téléphone, compte ou pièces de l'autre partie | `bo.claimantView`, `bo.candidatesOf`, `bo.respond` ; vue propriétaire refusée avant vérification | be:« CA-4 — aucune réponse… » | CONSTRUIT |
| CA-5 | Jetons invalides / expirés / réutilisés refusés ; refus sans vérification ni révélation d'un compte | `bo.createInvitation` (empreinte du jeton seulement, usage unique, expiration), `bo.respond` ; statut « SANS_SUITE » indiscernable | be:« CA-5 — jetons invalides… » | CONSTRUIT |
| CA-6 | Un déménagement conserve les dates ; requête datée correcte | `bo.end`, `RelationService.effectiveAt`, `GET /v1/relations-biens/effectives` | be:« CA-6 — un déménagement… » | CONSTRUIT |
| CA-7 | Locations exclusives vérifiées qui se chevauchent ⇒ dossier de revue, rien retiré | `bo.flagExclusiveOverlap` | be:« CA-7 — deux locations exclusives… » | CONSTRUIT |
| CA-8 | Conflit d'identifiants officiels vérifiés ⇒ fusion bloquée ; clé d'idempotence rejouée ⇒ aucun travail dupliqué | `bo.decideMerge` (409 `MERGE_BLOCKED_OFFICIAL_REF_CONFLICT`, dossier ESCALADE) ; `br.mutate` (IdempotencyStore) | be:« CA-8 — un conflit d’identifiants… » | CONSTRUIT |
| CA-9 | Vérification, rejet, contestation, fin, fusion : acteur, horodatage, motif, références avant / après | `bo.event` (empreintes SHA-256 avant / après, références d'état) ; journal d'audit chaîné | be:« CA-9 — vérification, rejet… », CA-2 (fusion) | CONSTRUIT |

## Sections de la spécification

| § | Exigence | Implémentation | Test | Statut |
|---|---|---|---|---|
| 1 | Une personne, un compte, plusieurs rôles sur plusieurs biens ; ordre d'inscription indifférent ; un rapprochement n'établit rien | compte unique (ch. 9) + `bo` | be:CA-1, CA-3 ; cu:« bout en bout » | CONSTRUIT |
| 2 | Identifiants : compte, bien/unité, relation ; jamais une adresse libre ni un téléphone comme clé | objets fiscaux (id), `PropertyClaim.id`, relation module 7 | be:« § 5 — un téléphone ou un nom seuls… » | CONSTRUIT |
| 2 | Réponse à l'inscription = DRAFT ou SUBMITTED, jamais VERIFIED | crochet `registered` → `bo.draftFromIntention` ; profils d'enrôlement → brouillon | be:CA-1 (brouillon d'inscription) | CONSTRUIT |
| 2 | Hiérarchie parcelle → bâtiment → unité ; unité « MAIN » | `bo.createProvisionalHierarchy`, `bo.declareProperty` | be:« § 8 et § 10 — … » (unité MAIN) | CONSTRUIT |
| 2 | Trois circuits distincts : doublons de comptes, doublons de biens, vérification | module accès (fusion de comptes) ; `FUSION_BIENS` ; `VERIFICATION` | be:CA-2, CA-8 ; cu:anti-doublon | CONSTRUIT |
| 2 | Invitation / consentement = association, jamais preuve de titre, de bail ou d'assujettissement | preuve d'appui `INVITATION_ACCEPTEE` non acceptée seule (`bc.preuvesAccepteesParRole`) | be:« § 8 — … » (`EVIDENCE_INSUFFICIENT`), CA-5 | CONSTRUIT |
| 3 | Modèle : statut d'enregistrement PROVISIONAL / CANONICAL / ARCHIVED_ALIAS, provenance SELF_REPORTED, identifiant officiel (émetteur, espace de noms), adresse saisie conservée, libellés bâtiment / unité, usage | `modules/objects/service.ts` (`recordStatus`, `recordProvenance`, `officialRef`, `addressEntered`, `buildingLabel`, `unitLabel`, `useType`, `createSelfReported`) | be:CA-2 | CONSTRUIT |
| 3 | property_claims (rôle, cible, état, dates, version) | `PropertyClaim` + relation module 7 (`claimId`) | be:CA-1 à CA-9 | CONSTRUIT |
| 3 | claim_evidence (empreinte, jamais écrasée, aucune adresse publique) | `ClaimEvidence` (dépôt en ajout seul, `objectKey` interne) ; `EVIDENCE_EXISTS` | be:CA-2 (pièce conservée) | CONSTRUIT |
| 3 | invitations (usage unique, expiration, empreinte du jeton) | `PropertyInvitation.tokenHash` | be:CA-5 | CONSTRUIT |
| 3 | match_candidates internes | `MatchCandidate` (signaux et score jamais servis) | be:« § 5 — … » | CONSTRUIT |
| 3 | review_cases | `ReviewCase` (VERIFICATION, CONTESTATION, BIEN_ERRONE_SIGNALE, CHEVAUCHEMENT_LOCATION_EXCLUSIVE, FUSION_BIENS, APPEL) | be:CA-2, CA-7, CA-8 | CONSTRUIT |
| 3 | audit_events en ajout seul avec empreintes avant / après | `bo.event` → journal d'audit HMAC chaîné | be:CA-9 | CONSTRUIT |
| 3 | Pas de propriétaire / locataire unique sur une unité (plusieurs à plusieurs) | relations multiples | be:CA-3 | CONSTRUIT |
| 3 | Index SQL (commune, quartier, avenue, numéro, référence officielle, géométrie…) | stockage en mémoire / persistance par instantané (socle) ; recherche linéaire | — | À RACCORDER (base relationnelle) |
| 4 | Parcours d'inscription : rôles multiples, adresse, référence facultative, unité, date, usage ; rien sur l'autre partie | `pages/Registration.tsx` (rôles), `BiensRelations.tsx` (formulaire) | fe:« revendications, états… » | CONSTRUIT |
| 4.1–4.3 | Brouillon ; provisoire si non résolu ; candidats neutres ; « Mon adresse n'y figure pas » ; choix ≠ vérification | `bo.submit`, `bo.candidatesOf`, `bo.selectCandidate` | be:CA-1, CA-2 ; fe:« revendications… » | CONSTRUIT |
| 4.4 | Pièces selon la politique ; invitation opaque et expirante ; réponse : accepter, refuser, mauvais bien | `bo.addEvidence`, `bo.invite`, `bo.respond` | be:CA-5 | CONSTRUIT |
| 4.5 | VERIFIED seulement par un réviseur habilité (ou intégration autorisée) | `bo.decide` (`bc.verificateurs`, administrateurs exclus) | be:« § 8 — … » (R26 ⇒ 403) | CONSTRUIT |
| 4.6 | Chevauchement de locations exclusives ⇒ revue ; colocation et occupants admis | `bo.flagExclusiveOverlap` | be:CA-3, CA-7 | CONSTRUIT |
| 4 (scénarios) | Propriétaire d'abord ; locataire d'abord ; orthographes différentes ; autre motif d'inscription ; déménagement ; cession | `bo.declareProperty`, `bo.submit`, normalisation `normAddr`, compte unique, `bo.end` | be:CA-1, CA-2, CA-6 ; cu:« bout en bout » (revendication depuis l'espace) | CONSTRUIT |
| 5 | Priorité : référence officielle (espace de noms) → adresse normalisée + bâtiment / unité → GPS + composantes | `bo.findCandidates` | be:CA-1, « § 5 » | CONSTRUIT |
| 5 | GPS seul, nom, téléphone, IP, patronyme : jamais une vérification ni un candidat ; aucun score ne vérifie | `indicesIgnores`, GPS exigeant des composantes | be:« § 5 — … » | CONSTRUIT |
| 5 | Revue de fusion : deux arbres, identifiants, position, revendications, conflits ; cible explicite, motif, réviseur, audit ; transactionnelle ; alias ; bloquée si références vérifiées divergentes ; versions optimistes | `bo.caseDetail` (`tree`), `bo.decideMerge` ; `RevueBiens.tsx` | be:CA-2, CA-8 ; fe:« file de revue… » | CONSTRUIT |
| 6 | États DRAFT … ENDED et transitions ; réversion par réviseur avec motif ; rejet ⇒ appel par nouveau dossier ; états du bien séparés | `TRANSITIONS`, `bo.transition`, `bo.appeal` ; correspondance avec les états du module 7 conservés | be:CA-9, « § 6 et § 7 » | CONSTRUIT |
| 7 | Routes (françaises canoniques + alias anglais), Idempotency-Key, 409 / 422 / 403, compte déduit de la session, jamais le compte de l'autre partie | `br` (alias par `core/alias.ts`) | be:« § 6 et § 7 — … » | CONSTRUIT |
| 8 | Propriétaire : ni identité, ni foyer, ni revenus, ni pièces des occupants ; locataire : ni titre ni autres locataires ; agents de terrain : territoire et durée ; réviseurs : preuve minimale ; administrateurs : aucune décision ; lectures sensibles journalisées | `bo.ownerView`, `bo.claimantView`, `bo.listCases`, `bo.caseDetail`, `bo.isReviewer` | be:« § 8 — propriétaire… », CA-4 | CONSTRUIT |
| 8 | Vue datée en aval (VERIFIED, date, rôle) ; non vérifié ⇒ aucune liquidation définitive ; provenance du bien distincte de l'état de la relation | `RelationService.effectiveAt`, `bo.effective`, garde de liquidation `SELF_REPORTED_NOT_QUALIFIED` ; écrans (badge du bien séparé) | be:CA-6, « § 8 et § 10 » | CONSTRUIT |
| 10 | Paramètres soumis à approbation (preuves par rôle, espace de noms, vérificateurs, fondement fiscal, conservation, recours, mandat terrain, divulgation) | `bc.CONFIG_BIENS` (statut PAR_DEFAUT_A_CONFIRMER) ; `GET /v1/biens-relations/configuration` ; mention « non validée juridiquement » | be:« § 8 et § 10 — … » | CONSTRUIT (valeurs par défaut — à confirmer) |

## Harmonisation avec l'existant (rien n'est retiré)

- **Module 7** : les rôles PROPRIETAIRE, COPROPRIETAIRE, USUFRUITIER, HERITIER_PRESUME, GESTIONNAIRE et les états
  PROPOSEE / VALIDEE / CONTESTEE / REJETEE / CLOSE restent ; LOCATAIRE, SOUS_LOCATAIRE, OCCUPANT et EXPLOITANT s'ajoutent ;
  chaque revendication porte une relation du module 7 dont l'état est synchronisé (DRAFT…NEEDS_EVIDENCE ⇒ PROPOSEE,
  VERIFIED ⇒ VALIDEE, DISPUTED/UNDER_REVIEW ⇒ CONTESTEE, REJECTED/SUPERSEDED ⇒ REJETEE, ENDED ⇒ CLOSE). La route
  `POST /v1/fiscal/relationships` (preuve obligatoire, M07-C1) reste inchangée ; une revendication sans pièce n'est
  jamais VÉRIFIÉE (même contrôle, porté au moment de la vérification).
- **Validation des objets** : `POST /v1/fiscal/objects/:id/validate` (personne distincte, IGF) fait passer un bien
  auto-déclaré au statut CANONICAL.
- **Fusion** : les comptes passent par la fusion contrôlée du module accès ; les biens par le dossier FUSION_BIENS.

## Contradictions signalées au maître d'ouvrage

1. Consigne du 28/09 (« vérification par invitation acceptée ») et spécification v1.0 (« une invitation n'est qu'une
   preuve d'appui ») : la spécification, postérieure et détaillée, est appliquée ; paramètre à confirmer.
2. « Vérification par un agent de terrain habilité » (consigne) et « VERIFIED seulement par un réviseur » (spécification) :
   le constat de terrain est une preuve acceptée ; la décision reste au réviseur (`agentTerrainPeutVerifier` = non, par
   défaut — à confirmer).
3. Module 7 existant (M07-C1 : preuve dès la déclaration) et revendication sans pièce à l'inscription (spécification) :
   harmonisé comme indiqué ci-dessus.
4. Bail déclaré par le locataire désignant le compte du bailleur (`POST /v1/leases`, existant) : conservé ; à aligner
   sur la règle de non-divulgation.
