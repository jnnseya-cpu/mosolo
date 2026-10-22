# Kinshasa Mosolo — Payment, Revenue Allocation, Commission & Settlement Engine — Developer Specification v1.0

Reçue du maître d'ouvrage le 29/09/2026 ; complète et précise la v1 (`Specification_Moteur_Paiement_Reglement_Repartition_v1.md`).
Contenu fidèle, sections conservées (extraits de code condensés).

Préambule : Groupe Nseya reçoit un accès et une visibilité complets à l'échelle de la plateforme, aux côtés des rôles
exécutifs autorisés du Gouvernorat. L'architecture distingue la visibilité/accès complets de la capacité de modifier
l'historique financier réglé : **personne ne peut supprimer ni réécrire l'historique du grand livre**.

1. **Objectif** — un moteur financier central pour tout paiement et encaissement, quels que soient module, type de
   recette, ministère/département, commune, agent, sous-traitant, prestataire, devise, moyen de paiement, électronique
   ou espèces. Aucun module ne tient de grand livre ni de calcul de répartition propre. Flux : Revenue Obligation →
   Payment Initiated → Payment Confirmed → Central Payment Ledger → Reconciliation → Revenue Attribution → Allocation
   Rule Engine → Beneficiary Entitlements → Settlement / Payable → Reconciliation → Reporting + Audit.
2. **Règle financière** — répartition par défaut : Gouvernorat 0,70 ; Groupe Nseya 0,10 ; ministère ou département
   0,10 ; opérations de terrain 0,10 (total 1,00). Jamais codée en dur dans les services de traitement : chargée depuis
   une `AllocationRuleVersion` active et versionnée.
3. **Pool des opérations de terrain** — agent DIRECT_GOVERNMENT / DIRECT_MINISTRY / DIRECT_DEPARTMENT : agent 0,10,
   sous-traitant 0,00. Agent SUBCONTRACTOR : agent 0,07, sous-traitant 0,03 (points de la recette éligible). 100 $
   collectés par un agent de sous-traitant : 70 / 10 / 10 / 7 / 3. Invariant : Gouvernorat + Groupe Nseya +
   ministère/département + agent + sous-traitant = recette éligible.
4. **Accès de Groupe Nseya** — rôle dédié `GROUPE_NSEYA_SUPER_ADMIN` : visibilité sur toute la plateforme (tous
   modules, ministères, départements, communes, recettes, transactions, paiements, agents, sous-traitants, règles,
   droits, règlements, rapprochements, tableaux financiers, journaux d'audit, rapports, coûts technologiques,
   exceptions, litiges), export des données, descente jusqu'à la transaction. Accès complet ≠ suppression : restent
   immuables les écritures passées, transactions réglées, règles historiques, événements d'audit, quittances émises,
   rapprochements achevés, approbations historiques. Correction = CONTREPASSATION → ÉCRITURE CORRIGÉE, jamais
   SUPPRESSION → RECRÉATION.
5. **Accès exécutif** — visibilité financière complète : GOVERNOR, GOVERNOR_CHIEF_OF_STAFF, EXECUTIVE_SECRETARY,
   MINISTER_OF_FINANCE, GROUPE_NSEYA_SUPER_ADMIN (100 % des recettes, tous ministères, départements, modules, agents,
   sous-traitants, paiements, répartitions, commissions, restants, règlements, espèces, électronique, exceptions,
   coûts, historique).
6. **Accès restreint** — ministère : ses modules, ses recettes, sa part de 10 %, agents rattachés à ses opérations,
   encaissements de ses modules, état des paiements, historique des règlements, descente à la transaction.
   Département : même principe, périmètre départemental. Sous-traitant : son droit, ses agents, recette par agent,
   commissions agents et sous-traitant, réglé, restant, contesté, contrepassé, descente. Agent : ses transactions,
   encaissements, droit, payé, restant, en attente, contrepassé, performance, historique des règlements.
7. **Entités minimales** — User, Role, Permission, Organisation, Ministry, Department, Module, RevenueType,
   RevenueObject, RevenueObligation, Payment, PaymentAttempt, PaymentProvider, PaymentReconciliation, AllocationRule,
   AllocationRuleVersion, AllocationLine, Beneficiary, Entitlement, SettlementAccount, SettlementInstruction,
   Settlement, CashCollection, CashDeclaration, CashDeposit, Agent, AgentAssignment, Subcontractor,
   AgentSubcontractorRelationship, TechnologyCost, Invoice, SettlementRequest, Refund, Reversal, Adjustment, Dispute,
   Receipt, Approval, AuditEvent.
8. **Schéma Payment** — id, reference, payerId, taxpayerAccountId, revenueObligationId, revenueTypeId,
   revenueObjectId?, moduleId, ministryId?, departmentId?, agentId?, subcontractorId?, grossAmount (Decimal),
   currency, paymentMethod, providerId?, collectionChannel, status, initiatedAt, confirmedAt?, reconciledAt?,
   allocationRuleVersionId?, receiptId?, createdAt, updatedAt.
9. **Moyens de paiement** — CASH, MOBILE_MONEY, BANK_TRANSFER, BANK_DEPOSIT, CARD, QR, USSD, POS, AGENT_ASSISTED,
   OTHER_ELECTRONIC ; tous entrent dans le même grand livre.
10. **Compte principal désigné par le Gouverneur** — GovernmentSettlementAccount : id, accountName, institutionName,
    accountReferenceEncrypted, currency, designatedByGovernor, approvalReference, approvalDocumentId?, effectiveFrom,
    effectiveUntil?, status (PENDING | ACTIVE | SUSPENDED | EXPIRED), createdBy, approvedBy, createdAt, approvedAt ; un
    seul compte principal actif par devise/périmètre lorsque la règle l'exige.
11. **Paiement électronique** — obligation → référence → paiement initié → confirmation du prestataire → validation
    signature/référence → CONFIRMED → rapprochement → RECONCILED → attribution → version de règle active → droits →
    écritures → instructions de règlement → quittance. Aucun droit distribuable final sur un simple clic « Payer » :
    `payment.status === "RECONCILED"` requis.
12. **Part électronique de Groupe Nseya** — droit = recette éligible × taux actif (0,10) ; GROUPE_NSEYA_ENTITLEMENT.
    Règlement fractionné autorisé par l'infrastructure de paiement approuvée : exécutable ; sinon droit → dette envers
    Groupe Nseya → instruction de règlement → paiement → rapprochement.
13. **Espèces** — jamais hors du grand livre numérique : espèces encaissées → l'agent enregistre l'encaissement →
    transaction unique → reçu numérique → déclaration d'espèces → vérification du superviseur → dépôt bancaire →
    dépôt apparié aux déclarations → rapprochement → recette constatée → répartition. Pour Groupe Nseya : CASH et
    RECONCILED ⇒ droit + créance à régler.
14. **Demande de règlement espèces de Groupe Nseya** — Groupe Nseya → Finance → Droits espèces → Restant → Créer une
    demande de règlement (ex. 01–30/09/2026, espèces rapprochées éligibles 2 000 000 $, taux 10 %, dû 200 000 $) ;
    SettlementRequest {beneficiaryId, amount, currency, periodStart, periodEnd, status} ; circuit DRAFT → SUBMITTED →
    UNDER_REVIEW → APPROVED → PAYMENT_INSTRUCTED → PAID → RECONCILED → CLOSED.
15. **Écran de configuration** — `/platform-admin/finance/allocation-rules` : Gouvernorat [70,00] %, Groupe Nseya
    [10,00] %, ministère/département [10,00] %, opérations de terrain [10,00] %, total 100,00 % ; règle secondaire :
    agent direct 10,00 / sous-traitant 0,00 ; agent de sous-traitant 7,00 / sous-traitant 3,00 ; refus si total ≠ 100.
16. **Versions** — jamais de modification d'une règle historique ; KIN-DEFAULT / V1 (effet 01/10/2026, 70/10/10/10),
    un changement crée V2 ; V1 reste attachée aux transactions historiques.
17. **Module → ministère** — ModuleOwnership {moduleId, responsibleMinistryId?, responsibleDepartmentId?,
    allocationRuleId, effectiveFrom, effectiveUntil?} ; la part ministérielle suit la propriété du module, jamais
    l'entité qui encaisse.
18. **Affectation des agents** — AgentAssignment {id, agentId, relationshipType (DIRECT_GOVERNMENT | DIRECT_MINISTRY |
    DIRECT_DEPARTMENT | SUBCONTRACTOR), ministryId?, departmentId?, subcontractorId?, moduleIds[], territoryIds[],
    validFrom, validUntil?, status} ; relation déterminée à la date de la transaction ; un changement ultérieur ne
    modifie jamais les commissions historiques.
19. **Service de répartition** — `allocateRevenue(payment)` : exige RECONCILED ; règle effective (module, date de
    rapprochement) ; propriété du module à la date ; affectation de l'agent à la date ; recette éligible ; lignes
    Gouvernorat, Groupe Nseya, département sinon ministère, puis agent 0,07 + sous-traitant 0,03 ou agent direct 0,10 ;
    contrôle somme = recette ; droits immuables. Arithmétique décimale obligatoire (jamais de flottants).
20. **Entitlement** — id, transactionId, beneficiaryId, beneficiaryType (GOVERNORAT | GROUPE_NSEYA | MINISTRY |
    DEPARTMENT | AGENT | SUBCONTRACTOR), allocationRuleVersionId, eligibleRevenue, rate, amount, currency, status
    (ACCRUED | APPROVED | PAYABLE | PARTIALLY_SETTLED | SETTLED | DISPUTED | REVERSED), settledAmount,
    outstandingAmount, createdAt.
21. **Centre de commandement financier exécutif** — `/executive/finance` ; cartes : total collecté, électronique,
    espèces, rapproché, non rapproché, droits Gouvernorat, Groupe Nseya, ministères/départements, agents,
    sous-traitants, réglé, restant, contesté, coûts technologiques ; filtres : date, ministère, département, module,
    commune, type de recette, agent, sous-traitant, moyen, prestataire, devise, état de règlement, état de rapprochement.
22. **Centre de commandement Groupe Nseya** — `/groupe-nseya/command-centre` ; deux vues : « Ma position commerciale »
    (droit total, électronique, espèces, réglé, restant, en attente d'approbation, en retard, contesté, remboursements
    technologiques, frais de gestion/service) et « Contrôle financier de la ville » (recettes de la ville, Gouvernorat,
    ministères, départements, modules, agents, sous-traitants, encaissements, règlements, coûts, exceptions,
    rapprochement).
23. **« Expliquer ce chiffre »** — chaque indicateur financier cliquable : recette éligible, taux, droit ; puis par
    moyen, ministère, département, module, commune, agent, sous-traitant, jour, mois, devise, état de règlement ; puis
    « Voir les transactions sources ». Aucun agrégat sans traçabilité.
24. **Sous-traitant** — `/subcontractor/finance` : recette générée 580 000 $, agents 40 600 $, mon droit 17 400 $,
    réglé 12 000 $, restant 5 400 $ ; détail par agent (A : 143 000 / 10 010 / 4 290 ; B : 201 000 / 14 070 / 6 030 ;
    C : 236 000 / 16 520 / 7 080) puis transactions.
25. **Coûts technologiques** — hors répartition initiale : TechnologyCost {id, provider, category, period, quantity,
    unitCost, grossCost, currency, fundedBy (GOVERNORAT | GROUPE_NSEYA), managementFeeRate?, managementFeeAmount?,
    supportingInvoiceId?, status} ; catégories AI, LLM/API, Hosting, Cloud, Storage, SMS, Email, GIS/Maps, Payment API,
    Identity Verification, Cybersecurity, Monitoring, Other ; si Groupe Nseya paie : coût réel + frais de gestion
    autorisés = dette du Gouvernement, distincte des 10 %.
26. **Remboursements et contrepassations** — jamais de suppression : écritures d'origine (+100 / +70 / +10 / +10 / +7 /
    +3) et contrepassation (−100 / −70 / −10 / −10 / −7 / −3), toutes deux visibles pour toujours.
27. **Audit** — AuditEvent {id, actorUserId, actorRole, action, entityType, entityId, before?, after?, reason?,
    approvalReference?, ipAddress?, deviceId?, timestamp} ; actions critiques : règle créée, changée, activée, compte de
    règlement changé, affectation agent / sous-traitant changée, paiement rapproché, espèces vérifiées, droit créé,
    règlement demandé, approuvé, payé, remboursement, contrepassation, ajustement, litige, coût technologique saisi,
    export financier.
28. **API** — POST/GET /api/payments, /api/payments/:id/reconcile ; GET /api/allocations ; POST /api/allocations/rules,
    /rules/:id/version, /rules/:id/activate ; GET /api/entitlements(/:id) ; GET /api/settlements ; POST
    /api/settlements/request, /:id/approve, /:id/confirm-payment, /:id/reconcile ; POST /api/cash/declarations,
    /deposits, /reconcile ; GET /api/finance/executive, /groupe-nseya, /ministry/:id, /subcontractor/:id, /agent/:id,
    /explain/:metricId ; POST /api/refunds, /api/reversals ; GET /api/audit. Contrôle d'accès côté serveur pour chaque
    route ; jamais de sécurité financière par masquage côté interface.
29. **Critères d'acceptation non négociables** — référence unique immuable par paiement ; module d'origine identifié ;
    chaque module résolu vers son ministère/département ; chaque transaction rapprochée éligible = 100 % ; 100 $ agent
    direct = 70/10/10/10 ; 100 $ agent de sous-traitant = 70/10/10/7/3 ; visibilité plateforme pour Groupe Nseya,
    Gouverneur, directeur de cabinet, secrétaire exécutif, ministre des Finances ; un ministère ne voit pas un autre
    ministère sauf autorisation distincte ; un agent ne voit pas le compte privé d'un autre ; un sous-traitant descend
    vers ses agents ; Groupe Nseya descend ville → ministère → module → agent → transaction ; espèces et électronique
    par le même moteur ; pourcentages ≠ 100 % refusés ; tout changement de taux crée une version ; l'historique garde sa
    version ; remboursement = contrepassation ; aucune écriture passée supprimable ; chaque chiffre de tableau expliqué
    par les écritures ; règlement jamais supérieur au restant ; rappels prestataire en double sans recette en double ;
    références d'espèces en double sans encaissement en double ; arithmétique décimale ; chaque action financière
    privilégiée auditée.

**État final requis** — un grand livre souverain unique : PAYEUR → OBLIGATION → PAIEMENT → COMPTE DÉSIGNÉ PAR LE
GOUVERNEUR / ENCAISSEMENT → RAPPROCHEMENT → MODULE → MINISTÈRE / DÉPARTEMENT → VERSION DE RÈGLE → 70 % Gouvernorat,
10 % Groupe Nseya, 10 % ministère/département, 10 % opérations de terrain (agent direct 10 % ou agent de sous-traitant
7 % + sous-traitant 3 %) → DROIT → RÈGLEMENT → RAPPROCHEMENT → AUDIT. Groupe Nseya a un accès complet à l'échelle du
système ; l'historique financier reste immuable.
