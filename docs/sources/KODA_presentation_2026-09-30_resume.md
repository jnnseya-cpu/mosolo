# KODA — présentation transmise par le maître d'ouvrage (30/09/2026)

Résumé fidèle du texte reçu (langue d'origine : anglais). Sert de référence au connecteur `backend/src/modules/payments/connectors/koda.ts`.

- **Nature** : vérification de paiement en tant que service (« Payment Verification-as-a-Service ») — une couche de vérité
  entre « le client dit avoir payé » et « le marchand sait qu'il a été payé ». Indépendant des opérateurs et des frontières.
- **KODA n'est pas** un portefeuille, un agrégateur ni un rail de paiement ; ni séquestre ni règlement ; ne dépend
  d'aucun contrat d'opérateur. **KODA ne touche, ne détient, n'achemine ni ne règle jamais les fonds** (hors du champ des
  licences EME/PSP) ; BitriPay traite le rail en aval.
- **Principe** : une application de 6 Mo sur le téléphone du marchand (**KODA Sentinel**) lit le SMS de confirmation que
  l'opérateur envoie déjà (référence, montant, émetteur, solde), le structure et le signe.
- **Cinq portes** : console de vérification (sans code), WhatsApp, API à 3 points d'accès, USSD et SMS entrant.
- **Fonctionne avec tous les opérateurs congolais** (maître d'ouvrage) ; 235 opérateurs, 95 pays, 111 familles de gabarits.
- **Parcours en huit étapes** : (1) une obligation existe ; (2) le client paie comme d'habitude (USSD `*144#`, `*1122#`… ou
  application de l'opérateur) ; (3) l'opérateur envoie le SMS de confirmation à la SIM du marchand, Sentinel le capture et
  pousse un enregistrement signé (~2–4 s) ; (4) le code de référence parvient à KODA (saisi au paiement, déposé dans
  WhatsApp, collé dans la console) ; (5) KODA le compare à l'enregistrement de l'opérateur et refuse toute discordance ;
  (6) le moteur de fraude note la correspondance (propre → confirmer ; incertain → contester ; risqué → rejeter) ;
  (7) le verdict arrive par webhook, ✅ dans la conversation ou carte verte dans la console ; (8) côté client ~30–60 s,
  part de KODA < 10 s.
- **Anti-fraude** : un code ne sert qu'une fois, sur toutes les portes ; messages forgés, modifiés ou rejoués mis en
  quarantaine, marchand alerté.
- **Page de paiement hébergée** : dans la langue de l'appareil ; n'affiche que les réseaux réellement vérifiables pour le
  marchand (compte de réception actif, vérifié et sain).
- **« Vérifié » signifie** : le SMS de confirmation de l'opérateur est arrivé ; montant, référence et fenêtre concordent ;
  code jamais utilisé ; contrôles de fraude passés. **Ne signifie pas** : paiement irréversible, fonds détenus par KODA,
  ni preuve de règlement.
- **Trois niveaux de confirmation** portés par chaque reçu : *recoupé par l'opérateur* (le plus fort, API de l'opérateur),
  *ancré à l'appareil* (Sentinel attesté, test de chaîne des soldes), *déclaré* (SMS collé ou relayé, sans appareil).
  Bande « à examiner » recommandée pour les montants élevés ou inhabituels.

## Conséquences dans MOSOLO (30/09/2026)

- Passerelle KODA proposée pour **Monnaie mobile, Code QR et USSD** (le client paie comme d'habitude) ; opérateurs par
  défaut **Orange Money, M-Pesa, Airtel Money, Africell Money** (`KODA_OPERATORS`, codes retenus par le maître d'ouvrage le 30/09/2026).
- La vérification KODA produit une **quittance provisoire** ; elle ne devient définitive qu'au rapprochement du relevé
  (« vérifié » n'est pas une preuve de règlement). Le niveau de confirmation n'est pas requis (décision du 30/09/2026) ; les montants élevés passent par la revue humaine existante.
