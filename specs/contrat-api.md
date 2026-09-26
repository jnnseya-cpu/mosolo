# Contrat d'API du socle KINSHASA MOSOLO (v1)

Contrat partagé entre `backend/` et `frontend/`. Le frontend n'appelle le backend **que** par ces routes. Types de données : ceux de `@mosolo/shared` (montants `MoneyJSON = { amount: "123.45", currency: "CDF" }`, jamais de nombre flottant pour un montant).

## Conventions

- Préfixe `/v1`. JSON. Erreurs au format RFC 9457 : `{ type, title, status, detail, code }` (`code` stable, ex. `RULE_NOT_EXECUTABLE`).
- **Authentification de démonstration** : en-tête `x-demo-user: <userId>` (utilisateurs semés, voir `GET /v1/demo/users`). En production : OIDC + passkeys (ch. 31), non implémenté dans ce socle.
- Création financière : en-tête `Idempotency-Key` obligatoire.
- Langue : `Accept-Language` ou `?lang=` (`fr|ln|sw|kg|lua|en`).
- Toute action produit un événement d'audit chaîné.

## Routes

| Méthode | Route | Rôle(s) | Objet |
|---|---|---|---|
| GET | `/health` | public | Santé |
| GET | `/v1/meta` | public | Devises (avec drapeaux), langues, compteurs du catalogue |
| GET | `/v1/demo/users` | public (démo) | Utilisateurs semés `{id, name, roles[], entity}` |
| POST | `/v1/registrations` | public | Inscription `{phone, fullName, language, situation}` → `{taxpayerId, iuc, verificationLevel}` |
| GET | `/v1/taxpayers/:id` | contribuable (soi), agents habilités | Profil, objets, obligations, quittances |
| POST | `/v1/fiscal-objects` | contribuable, agent | Objet provisoire `{taxpayerId?, category, commune, quartier, localityRank, lat, lon, attributes}` |
| POST | `/v1/leases` | bailleur, locataire | Bail `{unitObjectId, lessorId?, lesseeId?, rent: MoneyJSON, periodicity, start, end?}` |
| GET | `/v1/legal-rules` | tous agents | Liste des fiches de règles |
| POST | `/v1/legal-rules` | R13 | Création d'une fiche (statut `BROUILLON`) |
| POST | `/v1/legal-rules/:id/approve` | R13/R14/R15/R16 | `{role}` ; quatre personnes distinctes ; la 4e approbation publie ; activation à la date d'effet |
| POST | `/v1/assessments/calculate` | moteur, contrôleur | `{ruleId, taxpayerId, objectId, inputs, simulate}` → trace ; si `simulate=false` et règle non exécutable → 422 `RULE_NOT_EXECUTABLE` |
| GET | `/v1/obligations?taxpayerId=` | selon droits | Obligations |
| GET | `/v1/obligations/:id` | selon droits | Obligation + explication (règle, version, base légale, formule, entrées, montant, échéance, voie de recours) |
| POST | `/v1/obligations/:id/payment-orders` | contribuable, mandataire, guichet | `Idempotency-Key` ; `{channel, displayCurrency?}` → `{paymentReference, amount, indicativeAmount, beneficiaryAlias, expiresAt, status, ussdInstructions}` |
| POST | `/v1/providers/:provider/callbacks` | prestataire | Signature `x-signature` (HMAC-SHA256 du corps brut), `x-nonce`, `x-timestamp` ; `{providerTxnId, paymentReference, amount, status, completedAt}` → quittance provisoire |
| POST | `/v1/settlements/statements` | R17 | `{statementId, lines:[{accountAlias, amount, valueDate, paymentReference}]}` → rapprochement |
| GET | `/v1/reconciliation/exceptions` | R17, R18 | Exceptions |
| GET | `/v1/ledger/entries` · `/v1/ledger/balance` | R17, R22 | Écritures ; équilibre |
| GET | `/v1/public/receipts/:code` | public | Vérification minimale `{status: VALID|PENDING|CANCELLED|REPLACED|FRAUD_SUSPECTED|UNKNOWN, ...}` |
| POST | `/v1/beneficiary-accounts/change-requests` | R17 | Proposition |
| POST | `/v1/beneficiary-accounts/change-requests/:id/approve` | R19 | `{outOfBandVerified: true}` ; 2 approbateurs distincts ; effet après 72 h |
| GET | `/v1/audit/events` · `/v1/audit/verify` | R22 | Journal ; vérification de la chaîne `{ok, length, brokenAt?}` |
| GET | `/v1/communications/overview` | agents | Synthèse, couverture par canal, dernières délivrances |
| GET | `/v1/communications/events` | agents | Catalogue |
| GET | `/v1/communications/preview/:eventCode?lang=&entity=` | agents | Courriel HTML rendu (logo + charte de l'entité) |
| POST | `/v1/communications/test` | agents | `{eventCode, entity}` → délivrances (statut `journalise` en bac à sable si pas de clé fournisseur) |
| PUT | `/v1/drafts/:key` | tout utilisateur | Autosave `{data}` → `{version, savedAt, changeSummary}` |
| GET | `/v1/drafts/:key` · `/v1/drafts/:key/versions` | propriétaire | Brouillon, versions |
| POST | `/v1/ai/insights` | agents | `{context: 'governor'|'rental'|'treasury'|'communications', subjectId?}` → `AIRecommendation` |
| GET | `/v1/ai/recommendations` | agents | Liste |
| POST | `/v1/ai/recommendations/:id/decide` | agents habilités | `{decision: 'ACCEPTEE'|'REJETEE'|'MODIFIEE', reason}` |
| GET | `/v1/dashboards/governor` | R01, R02, R05 | Tuiles, communes, catégories, échelle, tendance, scénarios, alertes, actions (données `example: true`) |
| GET | `/v1/exchange-rates/:date` | public | Taux officiels (démo, source déclarée) |
| POST | `/v1/field-sync/batches` | terminal enrôlé | Lot signé (HMAC clé d'appareil) → acceptés, conflits |
| POST | `/v1/appeals` · `/v1/appeals/:id/decide` | contribuable ; R21 (≠ instructeur) | Réclamation, décision |
