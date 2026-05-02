# Algorithmes du composant Faust Orbit UI

## Cadrage

Ce document décrit les algorithmes mathématiques sur lesquels repose le composant *Faust Orbit UI* : projection PCA pondérée, interpolation Shepard, transitions dynamiques. C'est l'extrait du modèle conceptuel des **presets** pertinent pour le composant — la frontière conceptuelle plus large (notion de « lieu », commit de geste, navigation) vit dans le projet hôte.

Le modèle de **données** que ces algorithmes manipulent est défini dans [DATAMODEL.md](DATAMODEL.md). Le contrat **API** que le composant expose à son hôte est dans [API.md](API.md). Le **mode boucle** qui tisse plusieurs de ces concepts ensemble est formalisé dans [LOOP.md](LOOP.md).

## Notation

- `P` : ensemble des paramètres (adresses) de la signature UI Faust.
- `E ≅ ℝ^|P|` : espace des configurations — pour chaque adresse, une valeur réelle dans `[min, max]`.
- `c, c'` : configurations dans `E`.
- `pos(p)` : position visuelle (en coordonnées de projection) d'un preset `p`.
- `ψ` : fonction d'interpolation Shepard (cf. §Inverse).
- `π` : projection PCA pondérée (cf. §Projection).

## A. Projection PCA pondérée — π : E → ℝ²

`π` est construite par **PCA pondérée** sur l'ensemble des presets mémorisés pour un `uiHash` donné :

- Entrée : presets `{c_1, …, c_k} ⊂ E` avec poids `w_i` décroissant avec l'ancienneté de `lastSeenAt`.
- Sortie : deux vecteurs directionnels `u_1, u_2 ∈ E` + centroïde pondéré `c̄`.
- Position 2D du preset `c_i` : `p_i = (⟨c_i − c̄, u_1⟩, ⟨c_i − c̄, u_2⟩)`.

La projection évolue quand le dataset change : ajouter un preset peut réorienter les axes. C'est un **aspect d'apprentissage** : plus la bibliothèque grandit, plus la projection reflète les choix réellement explorés.

### Pondération par récence

Les poids `w_i` suivent une décroissance exponentielle :

```
w_i = exp(−λ · (now − lastSeenAt_i))
```

Avec `λ = ln 2 / (7 jours)` par défaut : un preset vieux d'une semaine pèse moitié moins qu'un preset frais.

### Cas dégénérés

| Nombre de presets | Comportement |
|---|---|
| `k = 0` | Projection vide. Le calque montre un état « Library is empty ». |
| `k = 1` | Centroïde uniquement, pas d'axes — un seul disque, snap systématique. |
| `k = 2` | PCA dégénère à une seule direction. Axe entre les deux points ; seconde dimension fixée à 0. |
| `k ≥ 3` | PCA pleine : deux axes via power iteration + déflation. |

### Frozen-PCA pendant la session

Quand le calque est ouvert, la projection **reste figée** : les ajouts (auto-promotion, double-clic) sont projetés à travers le basis courant sans le recomputer. Au prochain `show()` la projection est recalculée à partir de la library complète. Cette stratégie évite que les disques se réorganisent sous les mains de l'utilisateur pendant une session de navigation.

## B. Inverse Shepard — ψ : ℝ² → E

Pour une position de centre `(x, y)` dans le canvas, la configuration correspondante est calculée par interpolation pondérée inverse-distance (Shepard) sur **tous** les presets :

```
d_i = ‖(x, y) − p_i‖
w_i = d_i^(−p)              avec p = 2 par défaut
ψ(x, y) = Σ_i (w_i / Σ_j w_j) · c_i
```

Les contributions normalisées `w_i / Σ_j w_j ∈ [0, 1]` somment à 1 et représentent la part de chaque preset dans la configuration courante.

### Continuité

Pas de seuil, pas de zone « hors influence ». `ψ` est continue partout sur `ℝ²` — quand la croix se rapproche d'un preset, sa contribution croît continûment vers 1, les autres décroissent vers 0.

### Cas-limite `d_i = 0`

Le poids brut `w_i` diverge. Numériquement on court-circuite au snap exact `ψ(x, y) = c_i` pour éviter `∞ / ∞`. Conséquence pratique : poser la croix exactement sur un preset reproduit sa configuration bit-pour-bit.

### Cluster spread

Quand plusieurs presets se projettent à la même position PCA (cluster de configurations très proches), leurs disques sont écartés sur un petit cercle autour du centroïde du cluster pour rester individuellement cliquables. Le spread est **purement visuel** — les distances Shepard restent calculées sur les positions visuelles écartées (cohérence drawn / hit-test / audio).

## C. Transitions dynamiques

Tout mouvement dans `E` peut se faire instantanément (commit de geste, recall de preset) ou continûment via une **transition dynamique**.

### Paramètres utilisateur

- **Portamento `T_p`** : durée d'une transition continue entre la configuration courante et la cible. Notion familière des synthétiseurs.
- **Durée de cycle `T_L`** : durée totale d'un parcours complet de la sélection en mode boucle. Exposée à l'utilisateur en **BPM** sous l'hypothèse « 1 cycle = 1 mesure 4/4 », soit `T_L = 60 000 · 4 / BPM` ms.

### Géométrie du chemin

La configuration intermédiaire pendant une transition se calcule en **niveau 1** (canvas du calque) :

- Le centre glisse en ligne droite dans le plan 2D de `π(c_start)` vers `π(c_target)`.
- La configuration intermédiaire est `ψ(center(t))`.
- Le chemin dans `E` peut alors être non-linéaire, passant par les zones d'influence des presets intermédiaires via Shepard.

(Le niveau 0 — interpolation linéaire composante-par-composante — est défini par le projet hôte mais pas exposé par le composant aujourd'hui.)

### Interruption

Si une nouvelle transition est demandée pendant qu'une est en cours, la nouvelle **part de la configuration interpolée courante** (remplacement, pas file d'attente).

### Limitation connue : étranglement du timer en onglet d'arrière-plan

Le pilotage du glissement de la croix repose sur `requestAnimationFrame`. Or les navigateurs **étranglent rAF et `setTimeout` à environ 1 Hz pour les onglets non-foreground**. Conséquence : quand l'onglet du DAW passe en arrière-plan pendant qu'une boucle tourne, on n'obtient plus que ~1 mise à jour audio par seconde, le glissement Shepard intermédiaire n'est plus calculé, et la boucle audible se réduit à des **sauts discrets de preset à preset**.

Le moteur audio, lui, tourne sur un thread temps-réel non étranglé : le son ne se coupe pas, c'est uniquement la chaîne JS qui pilote `apply(config)` qui souffre. **Détacher l'onglet en fenêtre autonome** suffit à restaurer le comportement nominal.

## D. Auto-promotion (dwell)

Mécanisme stateful qui détecte les configurations stables et les promeut dans la library — la trajectoire (suite de gestes successifs) **mémorise** automatiquement les configurations sur lesquelles l'utilisateur s'attarde, sans demande explicite.

```
PromotionTracker = (lastCommittedAt, dwellThresholdMs)
```

Une configuration committée (gesture-end) est promue si elle est restée stable plus de `dwellThresholdMs` (3 s par défaut) ET que les gates de suspension sont fermées :

- **InGesture** : pas pendant un drag en cours.
- **OverlayActive** : pas pendant que le calque est ouvert (l'utilisateur est en mode « gestion à la main » de la library, pas création).
- **Suspended** : signal hôte (audio en pause, effet bypassé, …).

La promotion crée un preset **anonyme** (sans `name`). L'utilisateur peut nommer après coup via double-clic, clic droit > Rename, ou via l'entrée `+` du menu de rappel.

## E. Recall — clic, menu, ←/→

Trois chemins fonctionnellement équivalents pour appliquer la configuration d'un preset à l'audio :

- **Clic sur un disque** dans le calque : snap centre + applique la configuration. Sélection devient `{ce preset}`.
- **Pick dans le menu de rappel** (clic sur la pill `[label] [count|name]` du toolbar) : applique la configuration ; si le calque est ouvert, snap centre + sélection comme un clic-disc.
- **Touches ←/→** dans le calque : itère parmi les presets dans l'ordre `lastSeenAt` croissant, avec glissement portamento.

Toutes trois passent par le pipeline de gesture (`onInteractionStart` / `onInteractionEnd`), enregistrent un commit dans le journal de trajectoire, et un op `params` dans la pile undo niveau-2.

## F. Hors-scope

- **Algorithmique exacte** (power iteration, déflation, normalisation) : voir l'implémentation dans `src/orbit-projection.ts`.
- **Implementation des timers** : `src/orbit-transition.ts` (`TransitionTimer`), `src/orbit-promotion.ts` (`PresetPromotionTracker`).
- **Forme exacte des stacks undo** : voir [DATAMODEL.md](DATAMODEL.md) §I et l'implémentation dans `src/orbit-library-undo.ts` / `src/orbit-param-undo.ts`.
