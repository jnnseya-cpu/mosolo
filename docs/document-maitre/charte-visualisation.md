# Charte de visualisation — trousse de graphiques partagée

*KINSHASA MOSOLO · document maître, annexe I (ajout du 27/09/2026). Référence obligatoire pour tout graphique de la
plateforme, du poste du Gouverneur au dernier écran de module.*

La plateforme doit être très visuelle, du Gouverneur à chaque écran. Pour que tous les graphiques se lisent comme **un
seul système**, ils sont construits avec la trousse partagée `frontend/src/components/viz/` (point d'entrée unique
`components/viz/index.ts`) et les agrégations pures `frontend/src/lib/aggregate.ts`. Aucun module ne dessine ses propres
couleurs : il choisit une **forme**, fournit des **données réelles**, et la trousse applique la charte.

Rien de l'existant n'est retiré : `lib/palette.ts`, `components/charts.tsx` (`useChartColors`, `ChartTooltip`),
`components/ChartCard.tsx` et tous les graphiques déjà en place restent disponibles ; la trousse les **étend**
(`ChartCard` a reçu des propriétés facultatives sans effet sur les usages existants).

Galerie vivante : **`/visualisation/galerie`** (rôles internes lecteurs du pilotage : R01–R08, R17, R18, R22–R24).

---

## 1. Règles (non négociables)

1. **La forme d'abord, la couleur ensuite.** Un chiffre seul = `KpiTile`, pas un graphique à une barre. Une part d'un tout
   = `StackedBarViz` ou `DonutViz` (≤ 5 parts). Une tendance = `LineAreaViz`. Un ordre (les six états) = `LadderFunnel`.
2. **Données réelles uniquement.** Un graphique lit une API existante (au besoin agrégée côté écran avec
   `lib/aggregate.ts`). Faute de données réelles : jeu d'exemple **marqué `[EXEMPLE]`** (`example` → ruban
   « EXEMPLE — non opposable »). Aucun chiffre, taux, seuil ni cible inventé : une cible vient d'un acte ou du libellé servi
   par le serveur (« ≥ 95 % ») ; sinon l'état reste « Suivi (sans cible) ».
3. **Jamais un chiffre nu, jamais un zéro trompeur.** Une valeur absente est **« non mesuré » avec son motif** (hachures
   45°, libellé, motif) ; jamais dessinée à 0. Les états « chargement », « vide » (« Aucune donnée pour cette période »),
   « erreur » et « non mesuré » sont intégrés à chaque composant.
4. **Devises jamais mélangées.** Les montants restent en `MoneyJSON` et s'additionnent exactement, devise par devise
   (`sumMoney`, `sumBy`). Deux devises = deux séries (ou deux graphiques). Une contre-valeur CDF n'apparaît qu'avec **le
   taux affiché** (date, source) : `convertTotalsToCdf` + `rateLabel`, ou la contre-valeur indicative déjà servie par le
   pilotage. Les nombres (`plotValue`) ne servent qu'à la géométrie.
5. **Un seul axe des valeurs.** Jamais de double axe : deux mesures d'échelles différentes = deux graphiques.
6. **Couleur par fonction.** Catégorielle = identité (ordre fixe, jamais recyclée, jamais une 9ᵉ teinte : repli
   « Autres ») ; séquentielle = grandeur (une teinte, clair → foncé) ; ordinale = rang (six états) ; **état** = bon /
   attention / sérieux / critique, **toujours avec icône et libellé**, jamais pour une simple série. La couleur suit
   l'entité (ordre déclaré des séries), jamais son rang : un filtre ne repeint pas les survivants.
7. **Mode sombre sélectionné, pas inversé.** Chaque mode a ses pas validés contre sa propre surface (§ 2).
8. **Marques fines.** Barres ≤ 24 px, bout arrondi 4 px côté donnée (carré côté ligne de base), courbes 2 px, points ≥ 8 px
   cerclés de 2 px de surface, aplats à 10 %, 2 px de surface entre segments empilés et barres groupées, quadrillage
   filet plein 1 px. Le texte porte les encres du texte, jamais la couleur de la série.
9. **Accessibilité.** Titre (`h2`) et description lue (`role="img"` ou `role="group"` + `aria-label`) ; **légende dès
   2 séries** (aucune pour une série : le titre la nomme) ; **vue tableau** sur chaque graphique (bouton « Vue tableau ») ;
   infobulle au survol, au toucher **et au clavier** (les marques focalisables) — elle enrichit, ne conditionne jamais
   l'accès à une valeur ; `role="meter"` sur les jauges ; mode `forced-colors` respecté.
10. **Téléphone d'abord.** Tout composant fonctionne à 360 px sans défilement horizontal : barres horizontales pour les
    libellés longs, axe des catégories borné à 40 % de la largeur, étiquettes tronquées (libellé complet dans
    l'infobulle et le tableau), étiquettes de fin retirées quand elles se chevaucheraient.
11. **Français d'abord.** Libellés, états, mois (« sept. 26 »), nombres (« 17,8 M », « 64,2 % ») en français ; un nom de
    marque ou anglais n'apparaît qu'en second, entre parenthèses.
12. **Jours de Kinshasa.** Toute date est ramenée au jour de Kinshasa (UTC+1, sans heure d'été) avant regroupement.

---

## 2. Palette et validation

Fichier : `frontend/src/lib/palette.ts` (valeurs existantes inchangées ; ajouts marqués « trousse de visualisation »).
Validateur : `validate_palette.js` de la méthode dataviz (six contrôles ; ΔE OKLab × 100, simulation
Machado-Oliveira-Fernandes 2009).

| Rôle | Clair (surface `#FFFFFF`) | Sombre (surface `#141A33`) |
|---|---|---|
| Catégorielle (8, ordre fixe) | `#1E9BD7 #E0A526 #4453b5 #eb6834 #8a5cc2 #e87ba4 #1E8C3A #e34948` | `#1E9BD7 #b98300 #7080e6 #d65a2c #9468d6 #d05f89 #187832 #e8665a` |
| Séquentielle (7, faible → fort) | `SEQ_NAVY` `#E3EAF7 … #232C6B` | `SEQ_NAVY_DARK` `#455390 … #cadeff` |
| Ordinale « six états » | `#8a9ff0 #7386d5 #5c6eba #4757a1 #324087 #20296f` | `#44549d #596bb7 #7083d2 #879cec #a0b6ff #b8cfff` |
| État (réservé) | `good #0ca30c` · `warning #fab219` · `serious #ec835a` · `critical #d03b3b` + icône + libellé | idem |
| Retrait / « Autres » | `#A9B0C0` | `#5A6385` |
| Non mesuré | fond `#E6E9F0` hachuré | fond `#252D4D` hachuré |

### 2.1 Résultats du validateur — catégorielle, mode clair

```
$ node validate_palette.js "#1E9BD7,#E0A526,#4453b5,#eb6834,#8a5cc2,#e87ba4,#1E8C3A,#e34948" --mode light --surface "#FFFFFF"
Palette (light, surface #FFFFFF, categorical): 8 slots
  [PASS] Lightness band         all 8 inside L 0.43–0.77
  [PASS] Chroma floor           all 8 >= 0.1
  [WARN] CVD separation         worst adjacent #e34948↔#1E8C3A ΔE 7.6 (deutan) · tritan 21.0
  [PASS] Normal-vision floor    worst adjacent #e87ba4↔#8a5cc2 ΔE 20.1 (normal)
  [WARN] Contrast vs surface    below 3:1 — relief required (visible labels or table view): [["#E0A526",2.19],["#e87ba4",2.69]]

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
```

### 2.2 Résultats du validateur — catégorielle, mode sombre

```
$ node validate_palette.js "#1E9BD7,#b98300,#7080e6,#d65a2c,#9468d6,#d05f89,#187832,#e8665a" --mode dark --surface "#141A33"
Palette (dark, surface #141A33, categorical): 8 slots
  [PASS] Lightness band         all 8 inside L 0.48–0.67
  [PASS] Chroma floor           all 8 >= 0.1
  [WARN] CVD separation         worst adjacent #e8665a↔#187832 ΔE 6.7 (protan) · tritan 16.5
  [PASS] Normal-vision floor    worst adjacent #d05f89↔#9468d6 ΔE 15.6 (normal)
  [PASS] Contrast vs surface    all 8 >= 3:1

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
```

**Obligations qui découlent des avertissements** (non négociables) : la paire 7–8 (vert / rouge) est en bande CVD 6–8 →
dès qu'un graphique utilise **7 ou 8 séries**, il porte un encodage secondaire (légende + étiquettes directes + 2 px
d'air) — la trousse replie de toute façon au-delà de 4 séries (barres, courbes) ou 6 (piles) ; l'or et le rose sont
sous 3:1 en clair → vue tableau toujours présente (fournie par la trousse) et valeurs lisibles hors couleur.

### 2.3 Rampes ordinale et séquentielle (contrôles `--ordinal`)

```
$ node validate_palette.js "#8a9ff0,#7386d5,#5c6eba,#4757a1,#324087,#20296f" --ordinal --mode light --surface "#FFFFFF"
  [PASS] Lightness monotone · [PASS] Adjacent ΔL (all gaps >= 0.06) · [PASS] Light-end contrast #8a9ff0 at 2.53:1 · [PASS] Single hue (spread 1°)
  → ALL CHECKS PASS

$ node validate_palette.js "#b8cfff,#a0b6ff,#879cec,#7083d2,#596bb7,#44549d" --ordinal --mode dark --surface "#141A33"
  [PASS] Lightness monotone · [PASS] Adjacent ΔL (all gaps >= 0.06) · [PASS] Light-end contrast #44549d at 2.45:1 · [PASS] Single hue (spread 7°)
  → ALL CHECKS PASS

$ node validate_palette.js "#cadeff,#b2c5ff,#9badf1,#8496d8,#6e7fbf,#5969a7,#455390" --ordinal --mode dark --surface "#141A33"
  [PASS] Lightness monotone · [PASS] Adjacent ΔL (all gaps >= 0.06) · [PASS] Light-end contrast #455390 at 2.36:1 · [PASS] Single hue (spread 12°)
  → ALL CHECKS PASS
```

La rampe séquentielle claire existante `SEQ_NAVY` (conservée) est monotone et à pas réguliers ; son pas le plus clair
(`#E3EAF7`, 1,21:1) est volontairement proche de la surface : dans les cartes de chaleur chaque case porte son libellé
et sa valeur, et l'échelle de légende est toujours affichée (contrôle séquentiel = monotonie, conformément à la méthode).

Toute modification de palette **doit** être revalidée avec ces commandes (clair et sombre) et reportée ici.

---

## 3. Catalogue des composants

Import unique : `import { … } from '../components/viz';` (chemin relatif selon le module).
Props communes de cadre (`VizFrameProps`) : `title`, `subtitle?`, `example?`, `exampleLabel?`, `className?`, `actions?`,
`note?`, `framed?` (false = incrusté dans un bloc existant, avec son propre bouton « Tableau »), et d'état
(`VizStateProps`) : `loading?`, `error?`, `onRetry?`, `unmeasured?` (motif), `emptyText?`.

### 3.1 `KpiTile` et `KpiGrid`

```ts
KpiTile(props: {
  label: string; value: number | string | null; unit?: string; format?: (v: number) => string;
  state?: { label: string; tone?: Tone };                         // « Encaissé », « Rapproché »… (icône + libellé)
  delta?: { trend?: Trend; current?: number | null; previous?: number | null; versus: string; better?: 'HAUSSE' | 'BAISSE' | 'NEUTRE'; absolute?: boolean };
  spark?: { values: (number | null)[]; labels?: string[]; label?: string };
  target?: { value: number; label?: string; better?: Better; max?: number };
  sub?: ReactNode; href?: string; example?: boolean; loading?: boolean; error?: unknown; reason?: string; hero?: boolean;
})
KpiGrid(props: { children; max?: 2 | 3 | 4 | 5 | 6; label?: string })   // 2 colonnes au téléphone
```

```tsx
<KpiGrid max={4}>
  <KpiTile hero label="Encaissé — mois courant" value={17_837_000} unit="CDF" format={fmtCompact}
    state={{ label: 'Encaissé', tone: 'info' }} delta={{ trend: trendOfSeries(serie), versus: 'vs mois précédent' }}
    spark={{ values: serie, labels: mois }} />
  <KpiTile label="Potentiel estimé" value={null} reason="Modèle de potentiel non calibré (§ 38.2)." />
</KpiGrid>
```

### 3.2 `BarChartViz` — colonnes ou barres, 1 à 4 séries, cible facultative

```ts
BarChartViz(props: VizFrameProps & { rows: { key?: string; label: string; values: Record<string, number | null> }[];
  series: { key: string; label: string; color?: string }[]; orientation?: 'vertical' | 'horizontal';
  format?; tickFormat?; reference?: { value: number; label: string }; highlight?: string; directLabels?: boolean; height?: number })
```

```tsx
<BarChartViz title="Par commune" orientation="horizontal" format={fmtCompact}
  series={[{ key: 'assessed', label: 'Liquidé' }, { key: 'confirmed', label: 'Confirmé' }, { key: 'reconciled', label: 'Rapproché' }]}
  rows={drill.rows.map((r) => ({ label: r.key, values: { assessed: n(r.values.assessed), confirmed: n(r.values.confirmed), reconciled: n(r.values.reconciled) } }))} />
```

### 3.3 `StackedBarViz` — pile à 100 % ou absolue (2 px d'air entre segments)

```tsx
<StackedBarViz title="Part rapprochée par commune" mode="percent"
  series={[{ key: 'attente', label: 'Confirmé non rapproché' }, { key: 'rapproche', label: 'Rapproché' }]} rows={rows} />
```
Attention : ne jamais empiler deux niveaux emboîtés de l'échelle (le rapproché est inclus dans le confirmé) — empiler
des parts **disjointes** (« confirmé non rapproché » + « rapproché »).

### 3.4 `LineAreaViz` — série temporelle, réticule, aplat, cible

```tsx
<LineAreaViz title="Encaissé, mois par mois" granularity="month" area format={fmtCompact}
  series={[{ key: 'enc', label: 'Encaissé' }]} points={mois.map((m, i) => ({ date: m, values: { enc: serie[i] } }))}
  target={{ value: cibleDeLActe, label: 'Cible (acte n° …)' }} />
```
`date` accepte une clé de période (« 2026-09-27 », « 2026-S39 », « 2026-09 ») ou un instant ISO (ramené au jour de Kinshasa).

### 3.5 `DonutViz` — part d'un tout, 5 parts au plus, total au centre

```tsx
<DonutViz title="Encaissé par canal" centerLabel="CDF encaissés" format={fmtCompact}
  slices={canaux.map((r) => ({ key: r.key, label: CHANNEL_LABELS[r.key], value: n(r.values.confirmed) ?? 0 }))} />
// au-delà de 5 parts : les plus petites → « Autres » (gris de retrait), nommées sous le graphique
```

### 3.6 `GaugeMeter` / `ProgressMeter` — progression vers une cible

```tsx
<GaugeMeter title="Rapprochement à J+1" value={97.2} unit="%" target={95} targetLabel="≥ 95 %" />
<ProgressMeter label="Part des paiements numériques" value={85.3} unit="%" target={80} />
```
État : `tone`/`toneLabel` fournis par l'appelant, sinon « Cible atteinte » / « Sous la cible » (comparaison à la seule
cible déclarée ; `better="BAISSE"` pour un délai) ; `value={null}` + `reason` = non mesuré.

### 3.7 `StatusDistribution` — répartition par état (couleur d'état + icône + libellé)

```tsx
<StatusDistribution title="Avis par état" unitLabel="avis"
  items={countBy(avis, 'statut').map((r) => ({ key: r.key, ...ETATS_PAIEMENT[r.key], count: r.count }))} />
// ETATS_PAIEMENT : PAYE → « Payé » (bon), EN_ATTENTE → « En attente » (attention), IMPAYE → « Impayé » (critique)
```

### 3.8 `HeatGrid` (24 communes) et `MatrixHeat` (lignes × colonnes)

```tsx
<HeatGrid title="Rapproché par commune" measureLabel="Rapproché (contre-valeur CDF)" unit="CDF" format={fmtCompact}
  cells={drill.rows.map((r) => ({ commune: r.key, value: n(r.values.reconciled), href: `/…?commune=${r.key}` }))}
  unmeasuredReason="aucun paiement rapproché rattaché à cette commune" />
<HeatGrid compact framed={false} href="/poste-de-decision/communes" … />   // vignette (abréviations)
<MatrixHeat title="Paiements par jour et par heure" rows={jours} cols={heures} values={matrice} measureLabel="Paiements" />
```
Les 24 communes (`COMMUNES_KINSHASA`, identiques au référentiel `backend/src/reference/kinshasa.ts`) sont toujours
toutes affichées ; une commune sans donnée est « non mesurée » (hachures + motif). Disposition schématique 8 × 5
(ouest → est) dès 600 px de large, grille fluide à noms complets en dessous.

### 3.9 `LadderFunnel` — les six états de la recette

```tsx
<LadderFunnel title="Les six états de la recette" steps={sixEtatsFromLadder(echelle.levels, f.amounts)} />
```
`sixEtatsFromLadder` applique `SIX_ETATS` du paquet partagé (potentiel → *potential*, constaté → *assessed*,
encaissé → *confirmed*, réglé → *settled*, rapproché → *reconciled*, disponible → *available*) : montants par devise
en tête de ligne, barre en contre-valeur indicative, part de l'état mesuré précédent, états non mesurés hachurés et motivés.

### 3.10 `Sparkline` et `TrendBadge`

```tsx
<Sparkline values={[1, 3, null, 5]} labels={mois} label="Encaissé, 12 mois" area />
<TrendBadge current={120} previous={100} versus="vs veille" />                // « ↗ +20 % vs veille », favorable
<TrendBadge current={3} previous={4} better="BAISSE" versus="(délai)" />       // baisse favorable
```

### 3.11 `TimelineStrip` — événements dans le temps

```tsx
<TimelineStrip title="Échéances des dossiers" categories={['Urgent', 'En retard', 'À échéance']}
  events={fiches.map((f) => ({ id: f.id, at: f.echeance.date, category: …, label: f.objet }))} />
```

### 3.12 `ChartGrid` — grille de cartes

```tsx
<ChartGrid min={300}>
  <LadderFunnel className="viz-span-2" … />   {/* viz-span-2 : deux colonnes dès 900 px ; viz-span-all : pleine largeur */}
  <GaugeMeter … />
</ChartGrid>
```

---

## 4. Agrégations (`frontend/src/lib/aggregate.ts`)

Fonctions pures, testées (`frontend/test/aggregate.test.ts`), pour dériver un graphique d'une **liste existante** sans
changer le serveur :

| Fonction | Rôle |
|---|---|
| `countBy(items, champ \| fn)` | `{ key, count }[]` décroissant ; clé vide → « Non renseigné » |
| `sumMoney(montants)` | totaux exacts **par devise** (`{ CDF?, USD?, … }`) |
| `sumBy(items, champ, champMontant)` | `{ key, count, totals }[]` — une ligne par clé, un total par devise |
| `splitByCurrency(lignes)` | une série numérique par devise (CDF d'abord) — un graphique par devise |
| `convertTotalsToCdf(totaux, taux[])` + `rateLabel(taux)` | contre-valeur CDF **avec le taux affiché** ; devise sans taux → `null` + `missing` |
| `kinshasaDay / kinshasaWeek / kinshasaMonth` | jour, semaine ISO (« 2026-S39 »), mois de Kinshasa (UTC+1) |
| `groupByDay / groupByWeek / groupByMonth(items, date, { from, to })` | regroupement ; périodes vides comblées ; `undated` compté à part |
| `periodRange`, `nextPeriod`, `periodLabel` | suites de périodes et libellés français (« 27 sept. », « S39 2026 », « sept. 26 ») |
| `topN(lignes, n, valeur)` | N premiers + « Autres » (liste des repliés) |
| `share(valeurs, décimales)` | parts en % au plus fort reste (total exact 100) ; total nul → `null` |
| `trend(courant, précédent)`, `trendOfSeries`, `trendVsPrevious(items, date, valeur, du, au)` | écart, %, sens (HAUSSE / BAISSE / STABLE / INDISPONIBLE) |

Exemple — des avis de recouvrement vers deux graphiques, sans mélanger les devises :

```ts
const parEtat = countBy(avis, 'statut');                                   // → StatusDistribution
const parCommune = sumBy(avis, 'commune', 'montant');                      // totaux par devise
const { CDF = [], USD = [] } = splitByCurrency(parCommune);                // → deux BarChartViz (CDF, USD)
const jours = groupByDay(avis, (a) => a.emisLe, { from: '2026-09-01', to: '2026-09-30' });
const serie = jours.groups.map((g) => g.items.length);                     // → LineAreaViz / Sparkline
const t = trendVsPrevious(avis, (a) => a.emisLe, () => 1, '2026-09-21', '2026-09-27');   // → TrendBadge
```

---

## 5. Identité visuelle des graphiques

`frontend/src/styles.css`, section « Trousse de visualisation » : filet tricolore (bleu / jaune / rouge du drapeau) de
3 px en tête de chaque carte, tuiles sur un léger dégradé de surface avec liseré bleu drapeau, tuile héroïque en dégradé
marine du blason (liseré jaune), hachures « non mesuré », infobulles sobres. Les logos ne sont pas modifiés. Jetons :
`--viz-accent`, `--viz-card-top`, `--viz-kpi-bg`, `--viz-kpi-hero-bg`, `--viz-hatch-fg`, `--viz-hatch-bg` (clair et
sombre).

## 6. Écrans déjà équipés

- **Poste du Gouverneur** (`/poste-de-decision`, maquettes conservées) : bloc 2 « La Ville aujourd'hui » en quatre tuiles
  avec courbes miniatures (12 mois réels, `/v1/pilotage/drill/month`), fiches chiffrées complètes repliées juste dessous ;
  échelle des six états (`/v1/postes/vues/recettes`) ; vignette des communes en carte de chaleur ; vue « Recettes » ouverte
  sur l'échelle des six états.
- **Tableau du Gouverneur** (`/gouverneur`) : tuiles avec tendance vs veille et courbes, six états, jauge de
  rapprochement, carte de chaleur des communes, répartition des indicateurs par état, anneaux par catégorie et par canal,
  série mensuelle — en plus de tous les graphiques existants (conservés).
- **Galerie** (`/visualisation/galerie`) : chaque composant, données réelles sinon `[EXEMPLE]`, et ses états.

Captures (360 × 800 et 1280 × 900, clair et sombre) : `docs/captures/visualisation/`.

## 7. Liste de contrôle avant de livrer un graphique

- [ ] La forme répond à la question (sinon : tuile, tableau).
- [ ] Données réelles, ou `example` + « [EXEMPLE] » ; aucune cible ni aucun seuil inventé.
- [ ] Une devise par série ; contre-valeur avec son taux affiché.
- [ ] États chargement / vide / erreur / non mesuré (motif) vérifiés.
- [ ] Légende dès 2 séries, vue tableau, infobulle au clavier, rendu à 360 px sans défilement horizontal.
- [ ] Clair et sombre regardés à l'écran (étiquettes qui se chevauchent, texte rogné, infobulle coupée).
