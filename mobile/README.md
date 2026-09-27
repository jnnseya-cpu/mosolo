# Application citoyenne KINSHASA MOSOLO — Android et iOS (module 4)

L'application installée est la PWA MOSOLO (`frontend/`) enveloppée par Capacitor : mêmes écrans, mêmes routes, même
circuit de paiement vers le compte public. Ce dossier ne fait pas partie des espaces de travail npm du dépôt : il
s'installe à la demande sur un poste disposant des SDK (Android Studio / JDK 17 ; Xcode 15 sur macOS pour iOS).
Les binaires (`.aab`, `.ipa`) ne sont pas produits dans l'intégration continue faute de SDK.

## Fonctions propres à l'application (testées au niveau web)

| Fonction (Spécification, module 4) | Implémentation |
|---|---|
| Titres chiffrés pour consultation hors connexion | `frontend/src/lib/mobile.ts` : AES-GCM 256, clé dérivée du code (PBKDF2-SHA-256, 210 000 itérations) |
| QR dynamique régénéré toutes les 30 s (§ 19A.5) | `DynamicQr` (heure serveur, `GET /v1/titres/{id}/qr`) |
| Code d'accès et verrouillage automatique (appareil partagé) | `definirCode`, `verifierCode`, `verrouillageAuto` (2 min, 5 essais — par défaut, à confirmer) |
| Détection d'appareil modifié (fonctions sensibles) | module natif `MosoloIntegrite` (`native/android`, `native/ios`) ; refus côté serveur (`APPAREIL_MODIFIE`) |
| Aucune validité sur l'horloge du téléphone | état et heure SERVEUR conservés dans le portefeuille ; en-tête `x-mosolo-server-time` |
| Installations actives, transactions mobiles, taux d'échec, note | `GET /v1/citoyen/application/indicateurs` |

Écran : `/application` (menu public « Application mobile (Android et iOS) »).

## Commandes

```bash
cd mobile
npm install                      # Capacitor 6 (core, android, ios, cli)
npm run verifier                 # contrôle de la configuration (sans SDK)
npm run ajouter:android          # génère android/ et installe le module natif d'intégrité
npm run ajouter:ios              # génère ios/ (macOS) et copie le module natif (à ajouter à la cible App dans Xcode)
npm run synchroniser             # construit frontend/dist puis `cap sync`
npm run construire:android       # bundle de publication (android/app/build/outputs/bundle/release)
npm run construire:ios           # archive Xcode (build/MOSOLO.xcarchive)
npm run ouvrir:android           # ouvre Android Studio
npm run ouvrir:ios               # ouvre Xcode
```

Variables de construction du frontend : `VITE_API_URL` (URL HTTPS de l'API). Signature : keystore Android et profil
de distribution Apple fournis par le maître d'ouvrage (hors dépôt). Publication sur les magasins : comptes développeur
de la Ville **[À RACCORDER — convention requise]**.
