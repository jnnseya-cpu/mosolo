# Parcours de l'usager novice (24/10/2026)

Méthode prévue : Android de milieu de gamme, 360 px, réseau 3G lent, français puis autres langues, chronométrage du
temps jusqu'à la première valeur (payer une échéance et montrer la preuve). **Statut : NOT TESTED dans ce cycle** —
pas d'appareil réel ni de bridage réseau dans cet environnement ; seules les observations ci-dessous sont établies.

## Observé (parcours automatisé à 360 px, 5 rôles, 205 écrans)

| Observation | Effet sur le novice | Statut |
|---|---|---|
| 67 écrans débordaient horizontalement (écran de refus d'accès, « Mon espace », page hors ligne) | Page qui « glisse » sur le côté, bouton « Mes preuves » coupé | CORRIGÉ (D-11) |
| Trois liens envoyés par le serveur menaient à « page introuvable », dont « Mon compte unique » / « À faire » (demande de NIF, rôle déclaré) | Impasse dès le premier écran utile | CORRIGÉ (D-09) |
| En production, le sélecteur « Utilisateur (démo) » et des chiffres d'exemple seraient apparus | Confusion, perte de confiance | CORRIGÉ (D-06, D-07) |
| 30 saisies par `window.prompt` (fenêtre du navigateur, sans validation) | Fenêtre inhabituelle sur mobile, saisie perdue au moindre écart | OUVERT (D-19) |
| Décisions refusées en silence si le motif fait moins de 5 caractères (stationnement, opérateurs RakaPay) | Le bouton « ne fait rien » | OUVERT (D-19) |

## À tester avec de vrais usagers (avant toute ouverture publique)

1. Inscription avec un courriel mal saisi ; code non reçu ; retour le lendemain.
2. Numéros au format local (+243, 0…, 08…), noms avec accents et apostrophes, montants avec espaces ou virgules.
3. Paiement : passer à l'application de monnaie mobile puis revenir ; retour arrière après paiement ; perte de réseau
   pendant l'envoi ; ouverture du lien de retour sur un autre appareil.
4. Premier écran après inscription : l'action « À faire » est-elle évidente sans explication ?
5. Mêmes parcours en lingala, swahili, kikongo, tshiluba (traduction automatique non validée par des locuteurs).
