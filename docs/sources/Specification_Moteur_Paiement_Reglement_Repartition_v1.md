# Kinshasa Mosolo — Payment, Settlement & Revenue Allocation Engine

Spécification reçue du maître d'ouvrage le 29/09/2026 (texte fidèle, sections et valeurs conservées).

Principe préalable (texte du maître d'ouvrage) : concevoir un **moteur central de paiement, de règlement et de
répartition des recettes** plutôt que des virements codés en dur dans les modules. Tout paiement — électronique,
banque, monnaie mobile, carte, assisté par un agent ou espèces — entre dans le même grand livre, est attribué à la bonne
source de recette, puis réparti selon une règle de répartition autorisée. Contrôle important : s'agissant de recettes
publiques, le système ne doit **jamais détourner ou rediriger en secret** des fonds publics ; toute répartition au
profit de Groupe Nseya, des ministères/départements, des agents ou des sous-traitants doit être explicitement
configurée, légalement autorisée, visible dans la piste d'audit et approuvée selon la gouvernance financière du
Gouvernorat.

## 1. Une seule architecture de paiement

Chaque paiement crée un **enregistrement de transaction de paiement** ; aucun module ne crée sa propre logique de
paiement. Champs minimaux : Transaction ID, Payment Reference, Taxpayer/Payer Account ID, Revenue Object ID, Module ID,
Revenue Type ID, Ministry/Department ID, Field Agent ID (le cas échéant), Subcontractor ID (le cas échéant), Amount Due,
Amount Paid, Currency, Payment Method, Payment Provider, Payment Date/Time, Collection Channel, GPS/Collection Location
le cas échéant, Settlement Account, Allocation Rule Version, Allocation Breakdown, Reconciliation Status, Receipt ID,
Audit Events.

Chaîne : PAYMENT → PAYMENT LEDGER → RECONCILIATION → REVENUE SOURCE IDENTIFICATION → ALLOCATION RULE ENGINE →
ENTITLEMENT LEDGER → SETTLEMENT / PAYABLE → RECONCILIATION → REPORTING + AUDIT.

## 2. Compte de règlement principal du Gouvernement

Le compte désigné par le Gouverneur est le compte de règlement principal, objet de configuration contrôlé :
account_id, account_name, financial_institution, account_reference, currency, effective_from, effective_to, status,
authorised_by, approval_reference, created_by, verified_by. Tout changement exige une approbation renforcée et crée un
événement d'audit immuable. Aucun administrateur ordinaire — y compris le super-administrateur — ne peut remplacer
silencieusement ce compte.

## 3. Modèle de répartition (configuration actuellement proposée)

| Bénéficiaire | Répartition |
|---|---:|
| Gouvernorat de Kinshasa | 70 % |
| Groupe Nseya | 10 % |
| Ministère / département responsable | 10 % |
| Pool des opérations de terrain | 10 % |
| **Total** | **100 %** |

Pourcentages **jamais codés en dur** : matrice de répartition versionnée (ex. règle KIN-REV-001). Le
super-administrateur peut saisir des pourcentages proposés ; l'activation exige le circuit d'approbation financière du
Gouvernement. Activation refusée sauf si la somme des parts = 100,000 %.

## 4. Droit (entitlement) ≠ mouvement d'argent

Sur un paiement électronique de 100 $ : Gouvernorat 70 $, Groupe Nseya 10 $, ministère/département 10 $, opérations de
terrain 10 $ — quatre positions au grand livre, pas nécessairement quatre virements immédiats. Modes de règlement au
choix du Gouvernorat : REAL-TIME SPLIT, T+1, WEEKLY, MONTHLY, INVOICED, ACCRUED BUT NOT YET PAYABLE (important pour les
espèces).

## 5. Paiements électroniques

Paiement électronique → structure de collecte/règlement désignée par le Gouverneur → paiement confirmé → moteur de
répartition → 70/10/10/10. Si le prestataire permet le règlement fractionné, les répartitions autorisées peuvent être
exécutées automatiquement ; sinon, MOSOLO crée des **dettes / instructions de règlement**. Jamais d'instruction
invisible du type « si paiement électronique alors rediriger 10 % en secret » ; mais : si la transaction est éligible
ET la règle KIN-REV-001 active ET l'approbation juridique/financière valide ALORS droit Groupe Nseya = 10 % ET
règlement selon la méthode approuvée.

## 6. Paiements en espèces

Même logique de répartition (ex. 10 000 $ : 7 000 / 1 000 / 1 000 / 1 000), mais le système ne prétend pas que les
1 000 $ de Groupe Nseya ont été versés : droit 1 000 $, réglé 0 $, restant 1 000 $, statut PAYABLE ; Groupe Nseya émet
une demande de règlement au Gouvernorat. Circuit : Cash Collection → Cash Declaration → Deposit Verification →
Reconciliation → Allocation → Groupe Nseya Payable → Settlement Request → Government Approval → Payment → Settlement
Reconciliation.

## 7. Attribution au ministère / département

Chaque module générateur de recettes a un ministère ou département propriétaire (module_id, module_name,
responsible_entity_id, revenue_allocation_rule, effective_date). La part de 10 % suit la **propriété officielle du
module / de la source de recette**, jamais l'identité du collecteur.

## 8. Agent de terrain et sous-traitant

Pool des opérations de terrain = 10 %. Agent rattaché directement au Gouvernement / à un ministère / département :
agent 10 %, sous-traitant 0 %. Agent sous l'ombrelle d'un sous-traitant agréé : agent 7 %, sous-traitant 3 % (7 points
de la transaction d'origine ; si l'intention est « 7 % des 10 % », le calcul doit changer). Exemple 100 $ :
Gouvernorat 70, Groupe Nseya 10, ministère 10, agent 7, sous-traitant 3.

## 9. Hiérarchie agent – sous-traitant

Relation explicite ; fiche agent : agent_id, agent_name, agent_type (DIRECT_GOVERNMENT, DIRECT_MINISTRY,
DIRECT_DEPARTMENT, SUBCONTRACTOR_AGENT), parent_ministry_id, parent_department_id, subcontractor_id, commission_rule_id,
territory, module_permissions, status, effective_from, effective_to.

## 10. Tableau de bord du sous-traitant

Ses gains et la performance des agents sous son ombrelle (ex. recette générée 580 000 $ ; agents 7 % 40 600 $ ;
sous-traitant 3 % 17 400 $ ; payé 12 000 $ ; en attente 5 400 $), détail par agent (transactions, recette, 7 %, 3 %),
puis agent → type de recette → module → commune → lieu → jour → transaction → paiement → quittance → répartition →
règlement, sous réserve de la confidentialité et des contrôles d'accès.

## 11. Tableaux de bord par entité

Chaque entité a un compte « Recettes et droits ». Ministère : recettes de ses modules, sa part de 10 %, constaté,
approuvé, réglé, restant, par module / commune / agent / canal / période, contrepassations, remboursements, litiges,
exceptions de rapprochement — sans voir les données financières d'un autre ministère. Agent : recette générée,
transactions, taux, droit brut, validé, en attente, payé, restant, rejeté/contrepassé, performance par module et par
jour, historique des règlements. Groupe Nseya : recette éligible, droit contractuel de 10 %, électronique, espèces,
réglé, restant, demandes de règlement espèces, approuvé, contesté, en retard, par module / ministère / canal / période.

## 12. Visibilité des autorités

| Rôle | Visibilité financière d'ensemble |
|---|---|
| Gouverneur | Complète |
| Directeur de cabinet | Complète |
| Secrétaire exécutif du Gouvernement | Complète |
| Ministre provincial des Finances | Complète |
| Ministère | Son périmètre |
| Département | Son périmètre |
| Groupe Nseya | Complète |
| Sous-traitant | Son ombrelle |
| Agent de terrain | Sa propre activité |
| Super-administrateur | Configuration / technique ; aucune modification financière |

Tableau exécutif : total collecté, Gouvernorat 70 %, Groupe Nseya 10 %, ministères/départements 10 %, opérations de
terrain 10 % — chaque chiffre cliquable.

## 13. « Expliquer ce chiffre »

Obligatoire dans toute l'interface financière : recette éligible, pourcentage, droit calculé, électronique / espèces,
réglé / approuvé / en attente / contesté, puis « Voir les transactions ». Aucun chiffre financier inexpliqué.

## 14. Coûts d'IA, d'API, d'hébergement et d'infrastructure

Traitement configurable des coûts d'exploitation sur la part du Gouvernorat, distinct de la répartition initiale
(ex. part brute 700 000 $ moins IA, hébergement, SMS, API de paiement, cartes/SIG, autres = position nette). Ou, si
Groupe Nseya finance/gère ces services : coût technologique tiers + pourcentage de gestion approuvé = montant dû, ce
pourcentage étant configurable séparément et **jamais confondu** avec les 10 % de Groupe Nseya.

## 15. Règles de répartition versionnées

Jamais de réécriture de l'historique (V1 10 % jusqu'au 31/03/2027, V2 8 % ensuite ; une transaction du 15 décembre reste
calculée en V1). Chaque règle : Rule ID, Version, Beneficiary, Percentage, Revenue scope, Module scope, Payment-method
scope, Effective from, Effective until, Legal/contractual basis, Approval document, Created by, Reviewed by, Approved
by, Activated by, Timestamp.

## 16. Remboursements, contrepassations, paiements échoués

Droits calculés sur la **recette éligible rapprochée**, pas sur la tentative. Contrepassation : écritures négatives
(-70/-10/-10/-10) ; si un droit a déjà été réglé : solde recouvrable, jamais suppression de l'historique.

## 17. Architecture du grand livre

Pas de champs de solde simples ; sous-grand-livre immuable en partie double. Objets : Payment, Collection,
RevenueRecognition, AllocationRule, AllocationRuleVersion, Entitlement, Beneficiary, Settlement, SettlementInstruction,
CashDeclaration, CashDeposit, Reconciliation, Refund, Reversal, Adjustment, Dispute, Invoice, SettlementRequest,
Approval, Receipt, AuditEvent. Soldes toujours calculés à partir des écritures.

## 18. Contrôles financiers non négociables

Le super-administrateur ne peut pas passer 10 % à 25 % : Maker → Checker → Approver → Activation, circuit
gouvernemental autorisé. Audit : qui, quoi, ancienne valeur, nouvelle valeur, pourquoi, référence juridique/contrat,
qui a approuvé, quand, date d'effet. Aucune transaction, répartition, règlement ou règle historique supprimable ;
corrections par contrepassation + écriture de remplacement.

## Logique finale

EligibleRevenue = ReconciledPayment − Refunds − Reversals ; droits = EligibleRevenue × taux (Gouvernorat, Groupe Nseya,
entité responsable) ; agent direct : 10 %, sous-traitant 0 ; agent de sous-traitant : 7 % et 3 %. Invariant :
Gouvernorat + Groupe Nseya + ministère/département + agent + sous-traitant = 100 % de la recette éligible. Une seule
vérité financière : payeur → obligation → paiement → compte public → module → ministère → agent/sous-traitant → droit →
règlement → rapprochement final, avec descente du total de la ville jusqu'à la transaction.
