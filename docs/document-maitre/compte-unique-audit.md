# Audit du compte unique — « un utilisateur, un compte » appliqué à toute la plateforme

*KINSHASA MOSOLO · document maître, ch. 9 et annexe I (ajout du 28/09/2026). Demande du maître d'ouvrage : « s'assurer que
le compte unique s'applique et qu'une inscription partage l'information dans toute la plateforme ». Rien n'est retiré :
chaque correction s'ajoute à l'existant (règle n° 1).*

## Méthode

Recherche systématique, dans chaque module du socle (`backend/src/modules/*`), chaque module d'extension
(`backend/src/plugins/*`) et chaque écran (`frontend/src`), de tout enregistrement qui crée ou conserve SA PROPRE fiche
« personne » (nom, téléphone, NIF, pièce d'identité, adresse) ou qui redemande une donnée d'identité déjà détenue :
schémas d'entrée (zod) comportant `fullName`, `displayName`, `ownerLabel`, `phone`, `telephone`, `nif`, `rccm`,
`raisonSociale`, `nomDeclare`, `address` ; modèles comportant `name`, `phone`, `holderName` ; recherches de compte par
téléphone (`taxpayers.findOne(t => t.phone …)`). Chaque résultat a été lu et classé.

Légende du statut : **RATTACHÉ** = l'enregistrement porte déjà le lien vers le compte unique (`taxpayerId` ou
organisation) et ne redemande rien ; **CORRIGÉ** = corrigé dans ce lot (reprise des données du compte, rattachement,
garde anti-doublon) ; **FICHE MÉTIER** = fiche de métier (pas un second compte) désormais rattachée ou signalée ;
**HORS PÉRIMÈTRE** = compte de travail d'un agent, d'un sous-traitant ou d'un partenaire (circuit d'invitation, § 12A),
jamais un compte contribuable ; **À DÉCIDER** = point soumis au maître d'ouvrage.

## Tableau d'audit

| Module | Lien au compte unique | Champs d'identité dupliqués ou redemandés (avant) | Statut et correction |
|---|---|---|---|
| Identité (socle) — inscription `POST /v1/registrations` | Crée le compte (IUC) | — ; anti-doublon par téléphone seulement | **CORRIGÉ** : NIF facultatif (clé du compte quand il existe) contrôlé par une garde anti-doublon (même NIF ⇒ 409 `NIF_ALREADY_REGISTERED` + lien de récupération) ; même téléphone ⇒ 409 avec lien de récupération ; rôles choisis (`intentions`) ⇒ revendications BROUILLON ; crochets `duplicateGuards`, `registered`, `phoneVerified` pour les modules |
| Identité — enrôlement assisté (`registerAssisted`) | Crée le compte N0-A | Nom, téléphone facultatif (légitime : première inscription) | **CORRIGÉ** : mêmes gardes anti-doublon que l'inscription |
| Accès — preuves, OTP, niveaux N0–N3, fusion, mandats, consultation | `taxpayerId` | — | **RATTACHÉ** ; ajout : portes du compte unique (mandat actif « CONSULTER », consultation motivée), identité enrichie (niveaux et droits ouverts), contributions (mandats, organisations, rôles, pièces) |
| Accès — organisations (`POST /v1/acces/organisations`) | Compte PERSONNE_MORALE | Raison sociale, NIF, RCCM, représentants (nom, téléphone) ressaisis ; doublon NIF/RCCM seulement signalé | **CORRIGÉ** : même NIF ou même RCCM qu'un compte actif ⇒ 409 + récupération ; une personne CONNECTÉE se désigne représentante (`moiCommeRepresentant` : fonction et habilitation seulement), son nom et son téléphone sont repris du compte et le représentant est rattaché à son compte (`taxpayerId`) — sans aucun accès aux données de l'organisation (l'accès passe par un mandat) |
| Accès — inscription des mandataires (R31) | Compte public de mandataire | Nom, téléphone | **HORS PÉRIMÈTRE** (compte de mandataire distinct par nature, § 13.5) ; mandats reçus affichés quand le compte de travail est lié |
| Accès — invitations et comptes de travail | Compte de travail | Nom, téléphone, pièce | **HORS PÉRIMÈTRE** (agents ; `linkedTaxpayerIds` conserve le lien au profil contribuable de la même personne, § 12A.1) |
| Fiscal — biens et relations (module 7), baux | `taxpayerId`, `lessorId`/`lesseeId` | — | **RATTACHÉ** ; ajout : liaison des biens et occupations (revendications, candidats, preuves, invitations, revue, vue datée) — voir `couverture-liaison-biens-occupations.md` |
| Fiscal — enrôlement par profil, NIF provisoire, récupération | `taxpayerId` | NIF facultatif ; profil LOCATAIRE : « nom du bailleur » (déclaration du locataire, pas une identité redemandée) | **RATTACHÉ** ; ajout : un rôle lié à un bien ouvre une revendication BROUILLON |
| Fiscal — imports e-DGRK | Rapprochement par NIF ou téléphone, sinon proposition de fusion | Nom, téléphone, NIF (reprise de données) | **RATTACHÉ** (aucune création silencieuse ; fusion proposée à double validation) |
| Titres (module 19A) | `holderTaxpayerId`, `payerTaxpayerId` | — | **RATTACHÉ** ; contribution : titres, pass, tickets |
| RakaPay — conducteurs wewa | `taxpayerId` FACULTATIF + `displayName` + `phone` | Nom et téléphone ressaisis même quand le compte est indiqué | **CORRIGÉ / FICHE MÉTIER** : compte indiqué ⇒ nom et téléphone REPRIS du compte ; téléphone exactement égal à celui d'un compte actif ⇒ rattachement ; téléphone vérifié plus tard par code ⇒ rattachement exact journalisé (`rakapay.driver.linked_to_account`) ; jamais sur le nom |
| RakaPay — motos | `ownerTaxpayerId` FACULTATIF + `ownerLabel` | Nom du propriétaire ressaisi | **CORRIGÉ** : propriétaire rattaché ⇒ désignation reprise du compte |
| RakaPay — coopératives, opérateurs | `taxpayerId` (compte de la structure) | Nom de la structure (désignation commerciale) | **RATTACHÉ** ; opérateurs sans compte (ex. TRANSCO, coopérative de Limete, démo) signalés dans `GET /v1/compte-unique/fiches-metier` |
| RakaPay — billetterie | `user.taxpayerId` | — | **RATTACHÉ** |
| Stationnement (modules 14, 75) — sessions, véhicules, réservations, constats, SMS/USSD | `payerTaxpayerId`, `taxpayerId`, `holderTaxpayerId` | — ; canal SMS/USSD : compte trouvé par téléphone sans suivre une fusion | **RATTACHÉ / CORRIGÉ** : le canal texte résout le compte conservé après fusion (`findByPhone`) |
| Stationnement — partenaires (parkings privés, marchands) | `operatorTaxpayerId` (facultatif) | Nom de l'établissement (désignation) | **RATTACHÉ** (fiche d'établissement, pas une personne) |
| Publicité — espace annonceur, dispositifs, autorisations | `ownerTaxpayerId`, `taxpayerId` | `presumedOperator` (texte libre d'un recensement) | **RATTACHÉ** ; l'exploitant présumé d'un support recensé reste une présomption jusqu'au rattachement par le circuit existant |
| Verticales (17 espaces : propriété, locatif, entreprises, mobilité, marchés, domaine public, ports, événements, construction, actifs, environnement…) | `taxpayerId` (dossiers, certificats, étals) | Démarche « contribution plastique » : raison sociale redemandée | **CORRIGÉ** : raison sociale reprise du compte si absente ; autres champs « nom » = nom de l'établissement, de l'embarcation ou de l'événement (pas une identité) |
| Verticales — AVIA (compagnies, agences, RRH) | `taxpayerId` | Nom d'agence (désignation commerciale) | **RATTACHÉ** |
| Verticales — secteurs, grands redevables | `taxpayerId` | — | **RATTACHÉ** ; contribution : déclarations sectorielles, portefeuille grands redevables |
| Chaîne véhicule RFCK (modules 82–84) — mes véhicules, contrôle technique, fourrière | `taxpayerId` | Enrôlement en centre agréé : nom redemandé même pour un compte existant | **CORRIGÉ** : le numéro retrouve le compte (fusion suivie) ; le nom n'est demandé que pour une première inscription |
| Recouvrement — mes arriérés, échéanciers, adresse de notification | `taxpayerId` | Adresse de notification vérifiée par un agent (preuve de notification, pas une identité) | **RATTACHÉ** ; contribution : dossiers et échéanciers |
| Terrain — objets provisoires → rattachement | Objet sans redevable jusqu'à une relation validée | — | **RATTACHÉ** (rattachement par le module 7) |
| Terrain — sous-traitants, agents | Compte de travail | Nom, RCCM, NIF de la structure | **HORS PÉRIMÈTRE** (§ 15A) |
| Canaux — USSD, SVI, carte MOSOLO, points agréés, enrôlement assisté | `taxpayerId` ; inscription USSD par `taxpayers.register` | USSD : compte trouvé par téléphone sans suivre une fusion | **CORRIGÉ** : `findByPhone` suit la fusion ; l'inscription passe par les gardes anti-doublon ; l'enrôlement assisté hors ligne conserve sa détection de doublons « à revoir » (jamais de fusion automatique) |
| Citoyen — contrôle des pièces (module 2) | `taxpayerId` facultatif | Nom déclaré et téléphone ressaisis par le titulaire | **CORRIGÉ** : titulaire connecté ⇒ compte, nom et téléphone repris |
| Communication — préférences et consentements | Préférences sur le compte | — | **RATTACHÉ** ; contribution : préférences, historique des consentements |
| Documents (module 38) | `taxpayerId` | — | **RATTACHÉ** ; contribution : documents du compte |
| Preuves, apprentissage, intégrité, pilotage, trésor | Comptes de travail, pas de fiche contribuable | — | **HORS PÉRIMÈTRE** |
| Coffre (comptes bénéficiaires) | `holderName` du compte PUBLIC bénéficiaire | — | **HORS PÉRIMÈTRE** (comptes publics, jamais une personne) |

## Données de démonstration

Recherche des fiches parallèles sans lien dont le téléphone ou le NIF correspond EXACTEMENT à un compte de démonstration
(outil : `GET /v1/compte-unique/fiches-metier`). Résultat : **aucune** correspondance exacte — les deux conducteurs wewa
non rattachés (gilets COND-000003 et COND-000004) n'ont ni téléphone ni NIF ; l'opérateur TRANSCO et la coopérative de
Limete n'en ont pas non plus. Aucun enregistrement de démonstration n'a donc été modifié (décision du 27/09/2026 :
données de démonstration conservées sans modification). Tout rattachement futur passe par le téléphone vérifié par code
ou par le circuit de fusion contrôlé (preuve, deux personnes, réversible) — jamais par la ressemblance d'un nom.

## Ce qui est construit (résumé)

- **Registre de contributions** (`backend/src/modules/identity/compte-unique.ts`) : chaque module déclare sa section ;
  socle (objets, baux, obligations, paiements, quittances, recours, notifications) et 13 modules d'extension.
- **Route** `GET /v1/compte-unique/me` et `GET /v1/compte-unique/:taxpayerId` (titulaire ; mandataire dans le périmètre
  d'un mandat actif « CONSULTER » ; agent habilité avec consultation motivée active ; sinon 403) et
  `GET /v1/compte-unique/fiches-metier` (guichet, audit, administration).
- **Écran** : section « Mon compte unique » de `/espace` (identité, niveaux N0–N3 et droits ouverts, synthèse, graphiques
  de la trousse, rubriques filtrables, liens vers chaque module), « Mes biens et relations » (`/espace/biens-relations`).
- **Tests** : `backend/test/compte-unique.test.ts` (parcours de bout en bout), `frontend/test/compte-unique.test.tsx`.

## Points soumis au maître d'ouvrage

1. **Rattachement exact par téléphone vérifié** d'une fiche de métier (conducteur wewa) saisie par un tiers : retenu
   (le téléphone est la clé du compte, § 9.6) ; à confirmer.
2. **Représentant d'une organisation** : le lien au compte ne donne aucun accès aux données de l'organisation (mandat
   exigé) ; faut-il un circuit de confirmation par l'organisation ? (non construit).
3. **Bail déclaré par le locataire** (`POST /v1/leases`, existant) : le locataire désigne le bailleur par son identifiant
   de compte ; conservé tel quel, alors que la nouvelle liaison des biens n'expose jamais le compte de l'autre partie —
   harmonisation à décider.
4. **Mandataire (R31)** : la revendication de biens est réservée au titulaire (compte déduit de la session) ; ouverture
   aux mandataires dans le périmètre d'un mandat « DÉCLARER » à décider.
