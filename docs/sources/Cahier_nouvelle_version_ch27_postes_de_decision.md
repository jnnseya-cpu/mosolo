# Cahier — nouvelle version : chapitre 27 « Postes de décision des autorités et postes de travail des opérateurs »

Texte reçu du maître d'ouvrage le 27/09/2026 (collé dans la session). Il remplace l'ancien intitulé « Tableaux de bord » de la
nouvelle numérotation ; l'ancien contenu (§ 27.1 tableau du Gouverneur, § 27.2 autres tableaux) reste construit et conservé
(règle n° 1). Tableaux : cellules séparées par « | ».

## 27. Postes de décision des autorités et postes de travail des opérateurs

Les chapitres précédents décrivent ce que la plateforme sait. Celui-ci décrit ce qu'elle montre, à qui, dans quel ordre, et surtout ce qu'elle ne montre pas. La distinction est essentielle : le Gouverneur, son Directeur de cabinet, le Secrétaire exécutif du Gouvernement provincial et les ministres provinciaux ne sont pas des utilisateurs d'outil décisionnel. Ce sont des autorités qui disposent de quelques minutes, souvent sur un téléphone, entre deux audiences, et dont la valeur ajoutée tient à des décisions, non à de l'exploration de données.

La plateforme distingue donc deux familles d'interfaces, qui ne se conçoivent pas de la même manière :

Famille | Pour qui | Question à laquelle l'écran répond | Forme
--- | --- | --- | ---
Poste de décision | Gouverneur, Directeur de cabinet, Secrétaire exécutif, ministres provinciaux, autorités habilitées | « Qu'attend-on de moi, maintenant ? » | Corbeille de décisions, quelques chiffres, exceptions ; consultation par exception
Poste de travail | Directeurs de régie, chefs de centre, trésorerie, juristes, contrôleurs, auditeurs, agents | « Que dois-je traiter aujourd'hui ? » | Files de travail, dossiers, listes, outils de saisie ; consultation continue

Ce chapitre ne modifie aucune habilitation. Les droits d'accès, les périmètres et les règles de séparation des fonctions sont ceux définis au chapitre consacré aux rôles et à la matrice d'habilitations, et ils sont déjà intégrés à la plateforme. Le présent chapitre ne change ni qui a le droit de voir, ni qui a le droit d'agir : il définit uniquement ce qui est présenté en premier, sous quelle forme et dans quel volume. Une autorité conserve exactement les mêmes droits ; elle n'a simplement plus à les exercer en parcourant des écrans conçus pour d'autres métiers.

### 27.1 Le principe : un poste de décision, pas un tableau de bord

Un tableau de bord classique présente tout ce qui est mesurable et laisse l'utilisateur chercher ce qui compte. C'est une interface d'analyste. Appliquée à une autorité, elle produit invariablement le même résultat : l'écran est ouvert une fois, jugé impressionnant, puis abandonné, et la décision continue de se prendre sur la base d'une note papier apportée par un collaborateur.

Le poste de décision inverse la logique. Il s'ouvre sur ce qui attend un arbitrage, présente chaque dossier prêt à être tranché, et relègue toute la donnée au second plan, accessible mais jamais imposée. Quatre règles le gouvernent :

1. Un écran répond à une seule question. S'il en pose deux, il en manque un.
2. Rien n'est affiché qui n'appelle ni une décision, ni une vérification, ni une comparaison utile.
3. Toute information affichée porte sa date, sa source et son état ; un chiffre nu n'a pas sa place devant une autorité.
4. La consultation se fait par exception : on ne montre pas ce qui va bien, on montre ce qui appelle une action.

### 27.2 Budget d'attention et règle des trois écrans

La conception part d'une contrainte assumée et vérifiée auprès des cabinets : le temps réellement disponible. Les durées ci-dessous ne sont pas des souhaits, ce sont des contraintes de conception. Tout ce qui n'entre pas dans ce budget doit être supprimé de la vue d'entrée.

Autorité | Temps réel disponible par consultation | Fréquence attendue | Support dominant
--- | --- | --- | ---
Gouverneur | 60 à 90 secondes | Quotidienne, souvent en déplacement | Téléphone
Directeur de cabinet | 5 à 10 minutes | Plusieurs fois par jour | Téléphone et ordinateur
Secrétaire exécutif du Gouvernement provincial | 10 à 15 minutes | Quotidienne | Ordinateur
Ministre provincial | 3 à 5 minutes | Quotidienne | Téléphone
Autre autorité habilitée | 3 à 5 minutes | Hebdomadaire ou par exception | Téléphone

De cette contrainte découle la règle des trois écrans : toute autorité doit pouvoir accomplir l'essentiel de son usage sans dépasser trois niveaux de profondeur.

Niveau | Contenu | Rôle
--- | --- | ---
Écran 1 — Décider | Corbeille des décisions qui attendent cette autorité, classées par échéance et par enjeu | C'est l'écran d'accueil ; il s'ouvre là, toujours
Écran 2 — Situer | Quatre à six chiffres seulement, avec leur écart à l'objectif et leur tendance | Donner le contexte nécessaire pour décider, pas davantage
Écran 3 — Comprendre | Le détail d'un point précis : une commune, une recette, une alerte, un dossier | Atteint par un clic depuis l'écran 1 ou 2, jamais par le menu

Test d'acceptation de l'interface exécutive. Une autorité qui ouvre la plateforme pour la première fois, sans formation et sans accompagnement, doit pouvoir dire en moins de quatre-vingt-dix secondes ce qu'on attend d'elle et ce qui ne va pas dans sa ville. Si elle doit d'abord choisir un filtre, une période ou une commune, l'écran est à refaire. Ce test figure parmi les critères d'acceptation du présent document.

### 27.3 La corbeille de décisions : anatomie d'une fiche

La corbeille est le cœur du poste de décision. Chaque élément y est un dossier instruit, présenté sous une forme identique quelle que soit sa nature, afin que l'autorité n'ait jamais à apprendre une nouvelle lecture. Une fiche tient sur un écran de téléphone.

Bloc de la fiche | Contenu | Raison d'être
--- | --- | ---
Objet | Une phrase : ce qui est demandé | L'autorité doit comprendre sans lire le dossier
Demandeur et service instructeur | Qui propose, qui a instruit, qui a validé en amont | Établit la responsabilité de la proposition
Enjeu | Montant concerné, nombre de contribuables ou d'objets, commune | Permet de hiérarchiser sans ouvrir le détail
Échéance | Date limite et conséquence du silence | Distingue l'urgent du reste ; le silence n'est jamais neutre
Fondement | Référence légale ou réglementaire applicable | Aucune décision sans base légale affichée
Position du service | Recommandation motivée en deux lignes, avec les réserves éventuelles | L'autorité arbitre une proposition, elle ne rédige pas
Ce qui se passe si rien n'est décidé | Effet concret de l'absence de décision à l'échéance | Rend visible le coût de l'inaction
Pièces | Dossier complet, accessible mais replié par défaut | Disponible pour qui veut vérifier, invisible pour qui ne le veut pas
Actions | Approuver · Refuser · Déléguer · Demander un complément | Quatre issues, toutes motivées et journalisées

Exemple de fiche telle qu'elle se présente au Gouverneur

Champ | Contenu affiché
--- | ---
Objet | Suspension de l'habilitation d'un centre de contrôle technique agréé
Demandeur | Direction générale de la RFCK — instruit par le service de contrôle interne
Enjeu | 1 centre, 3 412 procès-verbaux sur 90 jours, taux de réussite de 99,4 % contre 78 % pour la moyenne des centres
Échéance | Décision attendue sous 5 jours ; au-delà, les procès-verbaux litigieux continuent de produire des effets
Fondement | Arrêté ministériel du 12 novembre 2025 ; décision d'habilitation du centre
Position du service | Suspension recommandée pour 30 jours, le temps d'un contrôle sur place. Réserve : 2 des 4 signaux peuvent s'expliquer par la clientèle du centre.
Si rien n'est décidé | Le centre continue d'émettre ; les vignettes déjà délivrées resteront contestables a posteriori
Actions | Approuver la suspension · Refuser · Déléguer au ministre des Transports · Demander un complément d'enquête

### 27.4 Ce qui remonte à une autorité, et ce qui ne remonte jamais

Une corbeille n'a de valeur que si elle est courte. Le filtrage est donc une règle de conception, pas une préférence d'utilisateur : seules les catégories ci-dessous atteignent un poste de décision, et uniquement au-delà des seuils fixés par l'autorité compétente.

Catégorie de décision | Niveau habituel | Pourquoi elle remonte
--- | --- | ---
Publication d'une règle de recette ou d'un nouveau taux | Ministre ou Gouverneur selon le texte | Engage la légalité de toutes les liquidations qui suivront
Changement d'un compte public bénéficiaire | Gouverneur, après double validation technique | Point de bascule le plus sensible de tout le circuit financier
Exonération, annulation ou dégrèvement au-delà d'un seuil | Ministre provincial des Finances | Perte de recette discrétionnaire ; exige une traçabilité au plus haut niveau
Suspension d'un partenaire, d'un centre agréé ou d'un prestataire | Ministre de tutelle, information du Gouverneur | Effet économique immédiat sur un tiers
Mesure irréversible sur un bien | Autorité légalement compétente | Touche au droit de propriété
Ouverture d'une enquête interne | Gouverneur ou ministre concerné | Met en cause des agents publics
Arbitrage des assignations et objectifs | Gouverneur sur proposition des régies | Détermine la pression de collecte de l'exercice
Déclenchement ou levée d'une phase de contrainte | Gouverneur | Décision de politique publique visible par toute la ville
Scénario d'affectation de fonds disponibles | Gouverneur et autorités budgétaires | Engage l'emploi de la recette
Alerte de déperdition au-delà d'un seuil | Gouverneur, en information immédiate | Toute minute compte pour préserver la preuve

Ce qui ne remonte jamais

- le dossier fiscal d'un contribuable nommément désigné, sauf finalité déclarée, enregistrée et journalisée ;
- les tâches de production : liquidations courantes, notifications, relances, rapprochements ordinaires ;
- les anomalies techniques, les incidents d'exploitation et les indicateurs de disponibilité ;
- les variations quotidiennes sans signification, qui appellent un suivi et non une décision ;
- tout élément qu'un service peut trancher lui-même dans son propre périmètre.

Le filtre est la fonction, pas un réglage. Une corbeille qui dépasse une dizaine d'éléments cesse d'être lue et l'outil retourne au statut de curiosité. Le nombre d'éléments présentés à chaque autorité est donc un indicateur suivi au même titre que les recettes : s'il augmente durablement, ce sont les seuils de délégation qui doivent être revus, pas l'écran.

### 27.5 Poste du Gouverneur

Écran d'accueil unique, conçu pour le téléphone, sans filtre à choisir et sans période à saisir. L'exercice en cours est la période par défaut, avec le delta du jour.

Zone de l'écran | Contenu | Interaction
--- | --- | ---
En-tête | Décisions en attente (nombre), dont urgentes (nombre) | Ouvre la corbeille
Bloc 1 — Décider | Les trois décisions les plus engageantes, en fiches complètes | Approuver, refuser, déléguer, demander un complément
Bloc 2 — La Ville aujourd'hui | Encaissé · Réglé en compte public · Rapproché · Écart à l'assignation. Quatre chiffres, en francs congolais et en dollars, au taux budgétaire affiché | Chaque chiffre ouvre son détail
Bloc 3 — Ce qui ne va pas | Trois alertes au maximum, classées par enjeu financier, chacune avec sa cause en une phrase | Ouvre l'alerte ou saisit l'audit
Pied d'écran | Carte des communes, en une vignette, couleur selon l'écart à l'objectif | Ouvre la vue par commune

Menu du Gouverneur

Entrée | Ce qu'elle ouvre | Pourquoi elle existe
--- | --- | ---
Décisions | La corbeille complète, avec l'historique de ses propres décisions | C'est la raison d'être de l'accès
Recettes | Potentiel, constaté, encaissé, réglé, rapproché, disponible — par commune et par catégorie | Répondre à la question du niveau de ressources
Alertes | Déperditions, fraudes en cours d'instruction, délais dépassés | Savoir où l'on perd
Communes | Carte et classement, écart à l'assignation, couverture du recensement | Interpeller un responsable nommément
Rechercher | Accès direct à une commune, une recette, un dossier, une décision | Remplace toute arborescence supplémentaire

Cinq entrées, pas davantage. Tout le reste de la plateforme demeure accessible au Gouverneur au titre de ses habilitations, mais par la recherche ou par un lien depuis un écran, jamais par un menu qu'il faudrait parcourir.

La note du lundi. Une page unique, produite automatiquement chaque semaine et consultable hors connexion : les décisions prises et leurs effets, les recettes de la semaine dans les six états, les trois communes en avance et les trois en retard, les alertes ouvertes et leur ancienneté, et les décisions attendues dans les sept jours. C'est le document que le Gouverneur emporte en réunion ; il porte la date de production et la source de chaque chiffre.

### 27.6 Poste du Directeur de cabinet

Le Directeur de cabinet ne consulte pas une version allégée de l'écran du Gouverneur : il tient la même corbeille, mais en amont. Sa fonction propre est de décider de ce qui mérite d'atteindre le Gouverneur et dans quel état.

Fonction | Écran | Action
--- | --- | ---
Préparation | File des dossiers en instruction, avec leur état : instruit, incomplet, à instruire | Renvoyer un dossier au service, réclamer une pièce, demander une reformulation
Priorisation | Ordonnancement de la corbeille du Gouverneur | Monter, descendre ou différer un dossier, avec motif enregistré
Suivi | Décisions prises et non encore exécutées, avec le responsable et l'échéance | Relancer nommément un service
Coordination | Vue transversale des services et des régies, sans accès aux dossiers individuels | Convoquer, arbitrer en amont, saisir le comité technique

Le geste de préparation est lui-même journalisé : ce qui a été écarté, par qui et pour quel motif, reste consultable. Cette trace protège le Directeur de cabinet autant qu'elle protège le Gouverneur.

### 27.7 Poste du Secrétaire exécutif du Gouvernement provincial

Son écran ne parle pas de recettes mais d'exécution. Il répond à une seule question : ce qui a été décidé est-il fait ?

Colonne | Contenu
--- | ---
Décision | Objet, date, autorité ayant décidé
Acte à produire | Arrêté, note, convention, instruction, désignation
Responsable | Service et agent nommément désigné
Échéance | Date attendue et jours restants ou jours de retard
État | Non engagé · En cours · Produit · Notifié · Exécuté
Blocage | Cause déclarée du retard, le cas échéant

Un seul indicateur domine cet écran : la proportion des décisions exécutées dans le délai prévu. Les autres vues du Secrétaire exécutif portent sur la coordination interservices et sur la documentation institutionnelle, dans le périmètre que lui reconnaît la matrice d'habilitations.

### 27.8 Poste du Ministre provincial

Chaque ministre voit son périmètre légal, et lui seul. L'écran est identique dans sa structure d'un ministère à l'autre, ce qui permet au Gouvernement provincial de comparer des situations sans avoir à comparer des présentations.

Bloc | Contenu | Limite
--- | --- | ---
Mes décisions | Corbeille filtrée sur les compétences du ministère | Aucune décision relevant d'un autre ministère
Mes recettes | Recettes dont le ministère est responsable, dans les six états, face aux objectifs | Agrégats ; aucun dossier nominatif sans finalité déclarée
Mes services | Performance des directions et services rattachés, délais de traitement, contentieux | Pas d'accès aux agents d'un autre ministère
Mes exceptions | Dossiers hors délai, écarts de rapprochement, alertes de son périmètre | Instruction par ses services, pas d'action financière directe
Mes engagements | Décisions prises par lui ou le concernant, et leur état d'exécution | Lecture, relance, justification

Le ministre provincial des Finances dispose en outre de l'arbitrage des assignations et de la vue consolidée de trésorerie, conformément à ses compétences propres.

### 27.9 Poste des autres autorités habilitées

D'autres autorités peuvent recevoir un accès en consultation : membres du Gouvernement provincial sans compétence fiscale directe, responsables institutionnels, instances de contrôle. Leur poste est volontairement réduit et sa portée est déclarée à l'ouverture des droits.

- consultation d'agrégats uniquement, dans un périmètre déclaré et daté ;
- aucune donnée fiscale individuelle, sans exception ;
- aucune action : ces postes n'ouvrent ni corbeille de décision, ni possibilité d'instruction ;
- traçabilité intégrale des consultations, comme pour tout autre profil ;
- expiration automatique de l'habilitation à une date fixée, avec renouvellement explicite.

Le tableau public de transparence, qui présente les recettes agrégées et les réalisations financées sans aucune donnée personnelle, constitue le niveau le plus ouvert de cette famille.

### 27.10 Règles communes d'affichage des chiffres

Ces règles s'appliquent à tous les postes de décision, sans dérogation possible, parce qu'elles déterminent la qualité des arbitrages qui s'appuieront dessus.

1. Aucun chiffre n'est affiché sans son état : potentiel estimé, constaté, encaissé, réglé en compte public, rapproché, ou disponible pour affectation. Un montant sans état est une source d'illusion budgétaire.
2. Aucun chiffre n'est affiché seul : il porte toujours une comparaison, à l'objectif, à la période précédente ou aux autres communes.
3. Tout chiffre porte sa date de production et son taux de conversion lorsqu'il est exprimé en devises.
4. Une estimation est visuellement distincte d'une donnée constatée, et le demeure dans tout export.
5. Tout chiffre est cliquable jusqu'à sa source, en trois niveaux au maximum.
6. Toute alerte énonce sa cause en une phrase ; une alerte qui exige une enquête pour être comprise est mal conçue.
7. Les exports reprennent ces mentions ; un chiffre sorti de la plateforme ne doit jamais perdre son état ni sa date.

### 27.11 Notifications, délégation et mobilité

Sujet | Règle
--- | ---
Volume | Nombre maximal de notifications par jour et par autorité, fixé par elle-même ; au-delà, regroupement en une synthèse unique
Déclenchement | Uniquement par seuil ou par échéance : décision urgente, alerte au-delà d'un montant, délai légal sur le point d'expirer
Canal | Application et message court ; le contenu ne comporte jamais de donnée fiscale individuelle
Délégation | Une autorité délègue une catégorie de décisions à une personne nommée, pour une durée déterminée et un périmètre déclaré ; la délégation est journalisée et expire d'elle-même
Suppléance | En cas d'absence, la corbeille reste visible du délégataire, jamais transférable à un compte partagé
Mobilité | Le poste de décision fonctionne sur téléphone, en réseau dégradé ; la note hebdomadaire et les fiches en attente restent consultables hors connexion
Sécurité | Authentification résistante à l'hameçonnage pour tous les postes de décision, appareil enregistré, session courte

### 27.12 Ce qui ne figure jamais sur un écran exécutif

- aucune donnée fiscale individuelle sur un écran d'accueil, y compris celui du Gouverneur ;
- aucune action financière directe : on approuve une orientation, on ne modifie ni une dette, ni un paiement, ni un compte bénéficiaire depuis un poste de décision ;
- aucun indicateur technique d'exploitation, qui relève du poste d'administration ;
- aucune donnée non rapprochée présentée comme une recette acquise ;
- aucun classement nominatif d'agents publics fondé sur des mesures intrusives ;
- aucune projection présentée sans ses hypothèses.

Une limite volontaire, et son motif. Il serait techniquement simple d'ouvrir depuis l'écran du Gouverneur la possibilité d'annuler une dette ou de débloquer un dossier. Cette facilité est écartée délibérément. Elle exposerait l'autorité la plus élevée de la province à des sollicitations permanentes et ferait d'elle le point de défaillance unique du système. Une autorité peut tout voir dans son périmètre, demander une enquête sur tout, arbitrer toute orientation ; elle ne manipule aucune écriture. Cette séparation protège la fonction autant que les recettes.

### 27.13 Postes de travail des opérateurs

Les autres utilisateurs disposent, à l'inverse, d'interfaces de production denses, conçues pour un usage continu et pour un métier précis. Elles obéissent à une logique de file de travail et non de corbeille de décision.

Utilisateur | Écran d'entrée | Indicateur dominant
--- | --- | ---
Directeur de régie | Assiette, recouvrement, contentieux, performance des agents et des centres | Écart à l'assignation et couverture du recensement
Chef de centre communal | Objets non enregistrés de sa zone, missions du jour, régularisations | Progression de la couverture
Trésorerie et comptabilité publique | Encaissements, règlements, files d'exception, clôture | Écart de rapprochement et ancienneté des exceptions
Juriste et tarificateur | État du référentiel, règles expirant, conflits de normes | Règles en vigueur sans référence valide
Auditeur et enquêteur | Échantillons, pistes, dossiers, extractions probantes | Délai d'instruction
Agent de terrain | Mission du jour, itinéraire, objets assignés | Constats confirmés par une quittance payée
Contribuable | Ses objets, ses obligations, ses quittances, ses recours | Situation personnelle
Administrateur de la plateforme | Disponibilité, intégrations, versions, sécurité | Incidents ouverts

Un même utilisateur peut disposer des deux familles d'interfaces : un directeur de régie tient une file de travail pour son activité quotidienne et une corbeille de décision pour ce qui relève de sa signature. Les deux restent séparées à l'écran, afin que l'urgence de production ne noie jamais la décision qui engage.
