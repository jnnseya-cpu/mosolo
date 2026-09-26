# Captures d'écran — dossier de présentation au Gouvernement provincial

Captures du socle logiciel KINSHASA MOSOLO en fonctionnement (backend en direct, données de démonstration non opposables), 26 septembre 2026.

| Dossier / fichier | Contenu |
|---|---|
| `KINSHASA_MOSOLO_Ecrans_Presentation_Gouvernement.pdf` | Dossier de 59 diapositives 16:9 : téléphone, ordinateur, services de la Ville (verticales, dont RakaPay), puis modules construits (partie 4), un texte par écran, conclusion |
| `diapositives/` | Les mêmes diapositives en PNG (1920 × 1080) |
| `telephone/` | Chaque écran sur téléphone (390 × 844, haute définition) : premier écran et page entière (`-page`) |
| `ordinateur/` | Chaque écran sur ordinateur (1440 × 900) : premier écran et page entière (`-page`) |

| N° | Écran | Rôle utilisé pour la capture |
|---|---|---|
| 01 | Accueil | Contribuable |
| 02 | Inscription | Contribuable |
| 03 | Espace contribuable | Contribuable (Mbuyi Kalala, fictif) |
| 04 | Vérification d'une quittance | Public |
| 05 | Centre de commandement | Gouverneur |
| 06 | Communications | DG DGIPK |
| 07 | Registre juridique | Juriste vérificateur |
| 08 | Trésor et rapprochement | Comptable public |
| 09 | Application terrain | Agent de terrain |
| 10 | Journal d'audit | Auditeur interne |
| 11 | Recommandations de l'analyse | Gouverneur |
| 12 | Services de la Ville (portail des 16 verticales) | Contribuable |
| 13 | RakaPay — pass wewa (moto-taxis) | Contribuable |
| 14 | RakaPay — tickets urbains | Contribuable |
| 15 | RakaPay — historique et quittances | Contribuable |
| 16 | RakaPay — référence de paiement du pass | Contribuable |
| 17–31 | Property, Rental, Business, Mobility, Parking, Advertising, Telecom, Markets & Public Domain, Environment, Ports, Events, Construction, Assets, Recovery, AVIA | Contribuable |

Les écrans 12 à 31 utilisent des données d'exemple locales, non opposables : aucun taux n'est affirmé ; les verticales marquées « Acte requis » n'exigent aucun paiement. Le tarif du pass wewa (500 FC par jour) est l'illustration du § H.27.16.1, en attente de l'acte J28.

Régénération : `tools/presentation/build-deck.mjs` (voir l'en-tête du script).

## Partie 4 — Modules construits (écrans 32 à 52)

Captures de l'application complète (socle et 14 modules d'extension) sur données de démonstration réelles du serveur, chacune avec le profil qui la voit dans son travail : centre de commandement sur données réelles, indicateurs, transparence publique, pass wewa (conducteur fictif), contrôle des titres, stationnement, publicité, biens et relations, quitus, arriérés et échéancier, recouvrement, USSD et SVI, point de paiement agréé, supervision du terrain, signalement, enquêtes, IA, entités et modules, Trésor, CALCU, connexion. Liste et textes : `tools/presentation/modules.json`.

## Partie 5 — Galerie : vérification publique, BitriPay et KODA, verticales (usagers et agents)

Dossier `galerie/` (JPEG, téléphone 390 px et ordinateur 1440 px) et PDF `KINSHASA_MOSOLO_Galerie_Verification_Prestataires_Verticales.pdf` (112 pages titrées).

- `verification-publique/` (9) : plaques de biens en situation verte, orange et rouge (badge de situation fiscale, aucune mesure automatique), plaque NFIU, étal, certificat d'événement, quittance, badge d'agent, panneau publicitaire.
- `prestataires/` (7) : le contribuable choisit BitriPay ou KODA et obtient sa référence et son intention (bac à sable local) ; au Trésor, la console des prestataires, la confirmation par webhook signé (simulation autorisée uniquement en bac à sable de démonstration) et le journal des webhooks. Un prestataire ne règle que le compte bénéficiaire de l'obligation (un ordre DGTK n'est pas accepté sur le compte DGIPK).
- `verticales-usagers/` (23) et `verticales-agents/` (17) : chaque écran capturé avec le profil qui l'utilise.

Régénération : `tools/captures/` (serveur `MOSOLO_RATE_LIMIT=off`, frontend en aperçu sur le port 4173 ; `gallery.cjs` lit au lancement les codes de plaque, qui changent à chaque démarrage).

## Partie 6 — Preuves sur tous les canaux (`galerie/preuves-canaux/`, 18 écrans)

Règle de couleur unique : **vert** tant qu'il reste au moins 50 % de validité, **ambre** de 1 % à moins de 50 %, **rouge** sous 1 % (encore valable), puis **EXPIRÉ**. L'heure de référence est celle du serveur.

Écrans et documents :
- **Vérifier une preuve** : comment lire la couleur ; ticket de stationnement vert ; autorisation publicitaire rouge ; certificat pas encore actif.
- **Preuves imprimées** : A6, ticket 80 mm et ticket 58 mm, avec le logo de la Ville, un QR, l'échéancier des couleurs et la mention démonstration. Deux PDF réellement imprimés : `05-impression-a6.pdf` et `06-impression-ticket-80mm.pdf`.
- **WhatsApp** : consentement, vérification, comment payer (sans lien de paiement).
- **SMS « V + code »** depuis un téléphone basique.
- **Version légère `/l`** : sans JavaScript, moins de 10 Ko par page.
- **Comptes à rebours** : stationnement, pass wewa et quitus.

Les pages 1 à 36 du PDF de la galerie reprennent ces écrans. Régénération : `tools/captures/preuves.cjs`. Le serveur est redémarré entre deux appareils, car le limiteur anti-énumération bloque les vérifications répétées.


Écrans 16 à 19 de `preuves-canaux/telephone/` : scanner un QR code.
- 16 : bouton « Scanner un QR code ».
- 17 : caméra en direct.
- 18 : ticket reconnu après le scan.
- 19 : secours par photo du QR.

Régénération : `tools/captures/scanqr.cjs` (caméra simulée par un fichier Y4M qui filme la preuve imprimée).
