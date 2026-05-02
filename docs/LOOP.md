# Spécification du mode boucle

Le **mode boucle** permet de visiter cycliquement une sélection de presets en passant continûment de l'un au suivant : à chaque pas, le son glisse sur une trajectoire interpolée entre deux presets, puis stationne brièvement sur le suivant, avant de repartir vers le preset d'après. La boucle reboucle à l'infini.

## Cadrage

Ce document décrit le **mode boucle** de l'overlay niveau-1 (calque) du composant *Faust Orbit UI* : la lecture cyclique d'une sélection de presets avec des transitions interpolées via Shepard. C'est un sous-système du calque, dont les concepts plus larges sont définis par [PRESETS.md](PRESETS.md), [DATAMODEL.md](DATAMODEL.md) et [API.md](API.md).

Le présent document **formalise précisément l'état du système de boucle à un instant T**, les transitions entre phases, et le comportement attendu lors de modifications dynamiques de la sélection. Il sert de référence pour l'implémentation et pour le raisonnement sur les cas limites.

## Notation

| Symbole | Sens |
|---|---|
| `P` | l'ensemble des presets connus (la library) |
| `S = [s_0, s_1, …, s_{n−1}]` | la sélection : liste ordonnée de presets distincts, `s_i ∈ P`, `\|S\| = n` |
| `S[j]` | accesseur cyclique : `S[j] = S[j mod n]` (défini pour tout `j ≥ 0` quand `n > 0`) |
| `pos(p)` | position visuelle (en coordonnées de projection) du preset `p` |
| `c` | position courante du curseur central (en coordonnées de projection) |
| `ψ(c)` | configuration audible interpolée par Shepard à la position `c` |

## Paramètres réglables

Trois entrées continues que l'utilisateur ajuste en direct via la barre du bas. Le système les **lit en direct** à chaque tick — il n'en prend jamais de cliché.

| Symbole | Sens | Source |
|---|---|---|
| `T_L` | durée totale d'un cycle (ms = une mesure 4/4 au tempo) | slider BPM |
| `v` | durée d'un déplacement entre deux presets (ms) | slider Tp (portamento) |
| `r` | durée de stationnement sur un preset (ms) | dérivée |

`r` est dérivé en direct : `r(n) = max(T_L / n − v, 0)`. Cela donne une sémantique « tempo, pas densité » : ajouter ou retirer des presets de `S` change la densité (combien de presets visités par cycle), pas le tempo.

## Hypothèses

- Pendant la boucle, **tout fonctionne à `n > 0`**. Si `n = 0` la boucle s'arrête (cf. § *Stopping*).
- Pendant un déplacement, le curseur progresse linéairement de la position de départ vers la position cible. La progression normalisée est notée `g ∈ [0, 1]`. À `g = 0` on est à la position de départ ; à `g = 1` on est à la cible.
- Le son émis à tout instant est `ψ(c)` où `c` est la position courante du curseur.

## A. État à l'instant T

L'état de la boucle est l'une de trois valeurs :

```
LoopState =
  | Inactive
  | Motion { from : Pos, to : configHash, startedAt : ms }
  | Hold   { on   : configHash, startedAt : ms }
```

avec

- `Inactive` : la boucle ne tourne pas.
- `Motion` : on est en train de se déplacer **vers** le preset `to`. `from` est la position du curseur au début du déplacement (peut être `pos(prev)` d'un preset précédent ou n'importe quelle position dans le plan). `startedAt` est l'horodatage de l'amorce du déplacement.
- `Hold` : on est stationné **sur** le preset `on`. `startedAt` est l'horodatage de l'amorce du stationnement.

`Motion.from` est volontairement une `Pos` (et non un `configHash`) : après un swap (cf. §C), un déplacement peut être amorcé depuis n'importe quel point continu — pas nécessairement la position d'un preset.

## B. Dérivations à l'instant `now`

L'état porte les ancres temporelles ; tout le reste est calculé à la volée à chaque trame d'animation.

Pendant **Motion** (avec `target_pos = pos(to)`) :

```
g = clamp((now − startedAt) / v, 0, 1)
c = lerp(from, target_pos, g)
```

Pendant **Hold** (avec `target_pos = pos(on)`) :

```
c        = target_pos
elapsed  = now − startedAt
r_now    = max(T_L / n − v, 0)
remain   = max(r_now − elapsed, 0)
```

Le son est en permanence `ψ(c)`.

## C. Transitions entre phases

Trois transitions (toutes lues à chaque tick) :

### C.1. `Motion → Hold`

Quand `g` atteint 1 :

```
state := Hold { on: state.to, startedAt: now }
```

### C.2. `Hold → Motion`

Quand `elapsed ≥ r_now` :

```
nextHash := chooseNext(state.on, S)        # cf. §E
state    := Motion {
  from:      pos(state.on),
  to:        nextHash,
  startedAt: now,
}
```

### C.3. `Active → Inactive`

Stop explicite (bouton ■, Esc, hide, setLibrary externe, etc. — cf. §F) :

```
state := Inactive
```

### C.4. `Inactive → Active`

Démarrage explicite (bouton ▶) avec `n > 0` :

```
nextHash := S[0]
state    := Motion {
  from:      <position courante du curseur>,
  to:        nextHash,
  startedAt: now,
}
```

## D. `swap(S')` : changement dynamique de sélection

Le contrat d'un swap : remplacer la sélection `S` (avec `\|S\| = n > 0`) par `S'` (avec `\|S'\| = m > 0`) **en créant le minimum de discontinuités**.

Une *discontinuité* est ici un saut non-continu de la position `c` du curseur (et donc, par conséquence, un saut audio via `ψ`).

La règle :

```
let target := state.to     if Motion
            state.on     if Hold

if target ∈ S':
    # Cas 1 : le preset visé fait toujours partie de la sélection.
    # On garde l'état tel quel. Aucune discontinuité.
    state inchangé
    # (Hold.elapsed reste valide ; le prochain Hold→Motion lira S'
    #  pour calculer le successeur.)

else:
    # Cas 2 : le preset visé n'est plus dans la sélection.
    # On choisit le preset de S' visuellement le plus proche du curseur,
    # et on amorce un Motion vers lui depuis la position courante c.
    target' := S'[ argmin_{j ∈ [0, m)} ‖ pos(S'[j]) − c ‖ ]
    state   := Motion {
      from:      c,            # position courante du curseur
      to:        target',
      startedAt: now,
    }
```

`c` est dans les deux cas la valeur dérivée à l'instant du swap (§B). Le déplacement amorcé en cas 2 utilise la durée `v` courante, comme tout autre déplacement.

### Conséquences notables

- **`\|S\| = 1`** : la boucle ne s'arrête pas. Une fois rejoint l'unique preset `p`, on alterne `Hold(on=p)` → `Motion(from=pos(p), to=p)` (déplacement dégénéré, `g = 1` immédiatement) → `Hold(on=p)` → … . Le curseur reste sur `p` ; la boucle continue de « tourner » en attendant un changement de sélection.

- **Suppression d'un preset de `S` mid-Motion** : si le preset cible disparaît, on dévie continûment vers le plus proche dans `S'`. Pas de jump, juste un changement d'angle.

- **Ajout d'un preset à `S` mid-cycle** : pas de changement de phase immédiate. Le nouveau preset entre simplement dans la rotation au prochain `Hold→Motion` (selon la règle `chooseNext` du §E).

## E. `chooseNext(current, S)` : règle de succession

Quand un Hold se termine, on choisit le preset suivant dans la sélection courante :

```
i := S.indexOf(current)

if i ≥ 0:
    return S[(i + 1) mod n]
else:
    # `current` n'est plus dans S (a été retiré entre le swap et la
    # transition Hold→Motion, ou jamais ajouté). On reprend au début.
    return S[0]
```

C'est la même règle que dans webdaw aujourd'hui, mais toujours appliquée sur la **sélection vivante** au moment de la transition — jamais sur un cliché.

## F. Stopping : quels gestes arrêtent la boucle

Les seuls gestes qui forcent `Active → Inactive` sont ceux qui prennent la main sur le curseur :

| Geste | Effet sur la boucle |
|---|---|
| Clic ■ (bouton stop) | **arrête** |
| Esc / fermeture du calque | **arrête** |
| `setLibrary` externe (sync hôte) | **arrête** (la base change sous nos pieds) |
| Clic simple sur un preset (recall + drag central) | **arrête** (manipulation directe) |
| Clic simple sur le vide (drag central) | **arrête** (manipulation directe) |
| Drag du curseur central | **arrête** (manipulation directe) |
| Curseur ←/→ (saut au preset suivant manuel) | **arrête** (saut manuel) |
| Trash (suppression) | **n'arrête pas** sauf si la sélection devient vide ⇒ stop |
| Shift+clic sur un preset (toggle dans `S`) | **n'arrête pas** — `S` change, swap rule en §D |
| Shift+drag (rectangle de sélection) | **n'arrête pas** — `S'` remplace `S`, swap rule en §D |
| Mouvement du slider Tp ou BPM | **n'arrête pas** — lecture en direct §B/§C |

### Sémantique du rectangle de sélection

Le rectangle de sélection (shift+drag sur le vide) **remplace** `S` par l'ensemble des presets contenus dans le rectangle. Ce n'est plus additif. Cohérent avec le swap rule (§D) : on peut redéfinir la sélection complète en cours de boucle sans arrêter la lecture.

(Le shift+clic sur un preset reste, lui, un toggle additif/soustractif — c'est l'édition fine d'une sélection existante.)

## G. Cardinalité / boundedness

Aucune borne dure côté boucle. Les bornes connues :

- `\|S\| ≥ 1` pour que la boucle puisse être active.
- `T_L > 0`, `v ≥ 0`, `r(n) ≥ 0` (clampé à 0 si `T_L / n < v`).

Quand `T_L / n < v` (le portamento est plus long que le pas naturel), `r = 0` et la boucle enchaîne les déplacements sans pause — comportement assumé.

## H. Hors-scope

- **Politique d'éviction de `S`** : la sélection ne fait pas l'objet d'une politique d'éviction propre ; cf. ORBITDATAMODELSPEC §F.
- **Synchronisation cross-instance des paramètres `T_L` et `v`** : ce sont des `LoopSettings` persistés par instance (cf. ORBITDATAMODELSPEC §G) ; le composant les expose via `setLoopSettings` / `onLoopSettingsChange` mais le canal entre instances est l'affaire de l'hôte.
- **Limitation rAF en onglet d'arrière-plan** : les navigateurs étranglent `requestAnimationFrame` à ~1 Hz quand l'onglet n'est pas visible, ce qui dégrade la boucle en sauts discrets. Pas de mitigation prévue ici ; détacher l'onglet en fenêtre restaure le comportement nominal.
- **Forme exacte de l'API** (types `LoopSettings`, événements `onLoopSettingsChange`, etc.) : voir ORBITUIAPISPEC.md.
