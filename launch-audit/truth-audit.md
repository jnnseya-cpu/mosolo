# Audit de vérité — promesses publiques et état réel (24/10/2026)

REAL : fonctionne de bout en bout (prouvé par test ou parcours) · PARTIAL : fonctionne, mais dépend d'un élément
externe absent · STUBBED : simulé · ABSENT : texte seulement · BROKEN : cassé.
Sources : page d'accueil, blog (`frontend/src/pages/blog/articles.ts`, relu contre l'annexe I le 22/10), courriel et
présentation au cabinet du Gouverneur (hors dépôt, fournis le 02/10).

| Promesse | Où | État | Preuve / commentaire |
|---|---|---|---|
| « 0 espèce » : aucun agent ne reçoit d'argent | Accueil, blog | REAL | Serveur : `CASH_NOT_ALLOWED_FOR_AGENT` / `ESPECES_INTERDITES_AGENT` (tests) |
| « 100 % compte public » | Accueil | PARTIAL | Règlement vers des alias du coffre prouvé ; aucun compte bancaire réel raccordé (H-03) |
| « 1 QR » vérifiable par tous | Accueil, blog | REAL | `/verifier` : vraie quittance « Paiement confirmé », code inventé « Aucune quittance ne correspond » |
| Paiement Orange Money, M-Pesa, Airtel, Africell, carte, QR | Blog, courriel | STUBBED (démonstration) | Page de paiement simulée, webhook signé par la route réelle ; aucun paiement réel (H-01) |
| Quittance provisoire puis définitive au relevé | Blog | PARTIAL | Prouvé en tests avec relevés de démonstration ; pas de relevé réel (H-03) |
| Centre de commandement : situation par commune | Courriel, blog | REAL (données fictives) | Données réelles du grand livre en démonstration ; le tableau de synthèse du Gouverneur montrait aussi des chiffres d'exemple en production → corrigé (D-06) |
| Agents IA de recettes | Blog | REAL (règles internes) / PARTIAL (fournisseurs externes) | Règles internes testées ; Claude / OpenAI / Gemini facultatifs, non évalués (E-29) |
| « Où va votre argent » | Accueil, blog | REAL | Page publique ; fuite par devise corrigée (D-04) |
| Application Android et iOS | Blog, page `/application` | PARTIAL | Application web installable (PWA) réelle ; applications de magasin non publiées (H-13) — le blog le dit |
| USSD, SMS, serveur vocal, WhatsApp | Blog | STUBBED | Simulateurs ; contrats absents (H-12) — le blog le dit |
| 17 lignes / 16 secteurs dans un seul grand livre | Blog, présentation | PARTIAL | 16 secteurs raccordés au moteur commun ; plusieurs « acte requis », sans facturation (H-02) |
| Fourrières, centres agréés, pénalités de recouvrement | Écrans | PARTIAL | API complète, écrans partiels (D-18) |
| « En service complet le 30 octobre 2026 » | **Courriel et présentation au cabinet** | **ABSENT — promesse à corriger** | Verdict NO-GO pour la production réelle : paiements réels, actes, compte public, hébergement de production manquent (`human-actions.md`). Recommandation : remplacer par « démonstration disponible ; mise en service après signature, actes et raccordements » |
| « Près de 5 000 emplois directs » | Courriel, présentation | Hors produit | Estimation interne de Groupe Nseya (option 2, 4 760) ; à présenter comme estimation |
| « Fin des faux reçus » | Blog, courriel | REAL | Vérification publique de chaque code ; signature Ed25519 |

**Action demandée :** corriger la date du 30 octobre 2026 dans le courriel et la présentation avant tout envoi (la
plateforme n'est pas prête pour un service réel à cette date).
