# BitriPay — présentation transmise par le maître d'ouvrage (30/09/2026)

Résumé fidèle des textes « About BitriPay » (15/09/2026) et « How BitriPay works ». Complète
`BitriPay_OpenAPI_2026-09-01_resume.md` ; référence du connecteur `connectors/bitripay.ts`.

- **Mission** : paiement électronique utilisable par tous (marchés, moto-taxis wewa, petits commerces, agents, diaspora).
- **Moyens** : QR code, @tag, numéro de téléphone, monnaie mobile, virement bancaire, **carte**, agents d'espèces, API
  partenaire. Opérateurs : **M-Pesa, Orange Money, Airtel Money, Africell Money**, et la carte.
- **Monnaie mobile sans API d'opérateur** : le client envoie au numéro de collecte BitriPay avec la référence ; le SMS de
  confirmation de l'opérateur est reçu sur un téléphone de collecte enrôlé, signé et apparié à la référence attendue ;
  correspondances incertaines examinées à quatre yeux ; rien n'est crédité sur une preuve douteuse.
- **Garde des fonds** : jamais de garde non autorisée ; soldes de monnaie électronique cantonnés 1:1 ; sur les marchés
  d'agrégation, fonds détenus et réglés par des institutions agréées via le commutateur national ; BitriPay initie,
  orchestre, normalise et rend compte. Hors autorisation : mode bac à sable annoncé.
- **Contrôles** : grand livre en partie double (soldes dérivés, jamais saisis), journal chaîné par empreintes, quatre
  yeux (crédits administratifs, émission, gros retraits, vérifications manuelles), filtrage des sanctions, plafonds par
  niveau de connaissance du client (niveau 1 : 50 $ par opération… niveau 4 : entreprise, sur dossier).
- **Frais publiés** (grille BitriPay) : paiement marchand 0,8 % ; lien de paiement 0,7 % ; entrée par monnaie mobile 0,7 % ;
  paiement de factures 0,5 % ; etc. **Qui supporte ces frais pour les recettes de la Ville relève de la convention — à
  confirmer par le maître d'ouvrage** (MOSOLO n'ajoute rien au montant de l'obligation).

## Conséquences dans MOSOLO (30/09/2026)

- Passerelle BitriPay proposée pour **Monnaie mobile, Code QR et Carte** (rail carte : identifiant `card` à confirmer).
- Plusieurs comptes publics de règlement admis (un par régie : `BITRIPAY_SETTLEMENT_ACCOUNT_ALIASES`), toujours celui de
  l'obligation.
