# Modèle de données du composant Faust Orbit UI

## Cadrage

Ce document décrit l'**ensemble** des données vivantes à un instant donné dans une instance du composant *Faust Orbit UI* — pas seulement ce qu'il sauvegarde. Il sert de référence partagée pour raisonner sur sa frontière conceptuelle, son périmètre de responsabilité, et les contrats qu'il établit avec son hôte.

Il s'agit d'un **modèle conceptuel et mathématique** : les relations décrites ne sont ni un schéma d'implémentation, ni une prescription de stockage. Le composant peut adopter des structures imbriquées, des caches, des observables — peu importe : ce qui est codifié ici est la **forme normale** de l'information manipulée.

## Frontière conceptuelle

Orbit UI est une **télécommande** qui ne connaît du DSP Faust que sa **signature paramètres** (la liste des widgets exposés : adresse, type, plage, valeur par défaut). Il ne connaît **pas** :

- Le code Faust source.
- Le runtime audio (`AudioWorkletNode`, compilation, routage).
- La persistance concrète (IDB, fichiers, cloud).
- L'identité d'instance (qui décide qu'un orbit-ui existe — c'est l'hôte).

Tout ce qui dépend du code Faust ou du runtime audio est **hors-scope** par construction. L'hôte fournit ce qui est nécessaire via des points d'entrée bien définis (signature UI au constructeur, état initial, callbacks de mutation, setters pour la sync cross-instance).

## Notation

Identique à `DAWDATAMODELSPEC.md` :

```
NomRelation = (**clef primaire**, attribut : type, attribut → AutreRelation, …)
```

avec :

- **`**…**`** — clef primaire (composite si plusieurs colonnes séparées par virgules)
- **`→ Table`** — clef étrangère vers la PK de `Table`
- **`?`** — optionnel
- **`{a, b, c}`** — type énuméré
- **`[1]`** ou **`[0..1]`** — cardinalité de la table

## Durée de vie

| Marqueur | Sens |
|---|---|
| 🛰 | Entrée externe (fournie par l'hôte) |
| 📚 | Persistance latérale (déléguée à l'hôte via état initial + events) |
| ⚡ | Runtime in-memory du composant, reconstitué au reload |
| 🎯 | Geste in-flight |

**Règle structurante** : tout ce qui est ⚡ doit pouvoir se reconstituer à partir des entrées 🛰 + des persistances latérales 📚.

## A. Entrée : signature UI 🛰

L'hôte fournit la signature de l'effet Faust à orbit-ui à la création.

```
ParamSpec      = (**address : string**,
                  type : {hslider, vslider, nentry, button, checkbox, …},
                  min : float, max : float, default : float, step : float,
                  label : string,
                  menu : MenuEntry[]?)

MenuEntry      = (**label : string, value : float**)
```

L'**identifiant `uiHash`** est dérivé de l'ensemble `ParamSpec` (SHA-256 d'une normalisation : tri par address, sérialisation des champs identité). Orbit-ui le calcule en interne au boot et l'expose via `orbit.uiHash`. C'est l'**identité de la signature** : tout ce qui partage la même signature UI partage le même `uiHash`. L'hôte ne l'implémente pas — il le **lit** sur le composant.

Le composant ne connaît pas l'identité d'instance (session, slot, …). Du point de vue du composant, il y a **une seule** instance — la sienne — et une seule trajectoire courante. C'est l'hôte qui gère les identifiants de stockage externes, sans les exposer au composant.

## B. Bibliothèque de presets 📚

La library catalogue les configurations visitées. Chaque entrée est un **lieu** dans l'espace des paramètres ; le champ `name?` distingue les **nommés** (épinglés par l'utilisateur, permanents) des **anonymes** (lieux visités, soumis à l'éviction).

L'hôte est responsable de la persistance ; orbit-ui en gère un cache local synchrone, met à jour via setters et émet `onLibraryChange`.

```
Preset             = (**ui_hash : string, config_hash : string**,
                      name : string?, last_seen_at : int)

PresetConfigEntry  = (**ui_hash, config_hash → Preset, address : string**,
                      value : float)
```

- **`ui_hash`** = identité de la signature paramètres ; **`config_hash`** = identité de la configuration. Pas de référence au code Faust.
- **`name`** absent → preset **anonyme**, soumis à l'éviction FIFO. Présent → preset **nommé**, permanent (jamais évincé).
- **`last_seen_at`** sert (a) au calcul du poids dans la projection PCA pondérée et (b) à l'ordre de la navigation centre-step. Mis à jour à chaque fois qu'une instance commit cette configuration.
- La library est **partagée** par toutes les instances orbit-ui qui exposent le même `uiHash` ; la synchronisation cross-instance passe par l'hôte via `setLibrary`.

### Politique d'éviction

Quand le nombre de presets pour un `uiHash` donné dépasse un seuil (par défaut 500), les **anonymes** les plus anciens (par `last_seen_at` ascendant) sont évincés jusqu'à revenir sous le seuil. Les **nommés** ne sont jamais évincés. Les presets référencés par la sélection multi sont protégés (cf. §F).

### Trash et auto-recréation

Le trash supprime **vraiment** les presets sélectionnés du catalogue. La trajectoire ne casse pas (chaque event embed sa propre configuration — cf. §C). Si l'utilisateur revisite plus tard une configuration supprimée et y reste assez longtemps (dwell timer), un preset anonyme est **auto-recréé** — sans mémoire de la suppression passée.

## C. Trajectoire 📚

Le composant maintient **une** trajectoire courante (singleton) — un log append-only des configurations committées par geste pendant la durée de vie de l'instance. **Pas de `code_hash`** : l'invariance par rapport aux édits de code non-UI est portée par `ui_hash` (consistance avec la library). L'hôte sait sous quelle clef externe stocker cette trajectoire (par exemple `(session_id, instance_id)`) mais le composant ne le voit pas.

```
TrajectoryRecord[1]    = (ui_hash : string,
                          head_index : int, cursor_index : int,
                          updated_at : int)

TrajectoryEvent        = (**event_index : int**,
                          timestamp_ms : int,
                          transition_time_ms : int?,
                          transition_level : int?,
                          loop_context : string?)

TrajectoryEventConfig  = (**event_index → TrajectoryEvent, address : string**,
                          value : float)
```

- **`head_index`** = dernier event committé (`-1` si vide). **`cursor_index`** = position du curseur de navigation (`-1` si détaché).
- **`ui_hash`** stocké sur le record permet au composant de valider qu'un `setTrajectory(record)` correspond bien à sa signature courante (sinon le record est rejeté).
- **`transition_level ∈ {0, 1}`** = niveau de transition dynamique (PRESETSPEC).
- Cardinalité bornée : FIFO eviction au-delà d'un seuil (par exemple 500 events).
- **Configuration embedded** : `TrajectoryEventConfig` porte la configuration directement dans l'event, **pas** une référence vers `Preset`. Conséquence : la suppression d'un preset (via trash) ne casse pas la trajectoire — chaque event reste rejouable indépendamment. C'est un compromis assumé : faible duplication de stockage contre robustesse à la suppression du catalogue.

## D. Instance runtime ⚡

L'état vivant de l'instance courante.

```
Instance[1]   = (ui_hash : string, signature_revision : int)

ParamValue    = (**address → ParamSpec**, value : float)
```

- `ParamValue` reflète la **valeur courante** des paramètres dans la télécommande. Les writes (drag, recall) la mettent à jour, les reads la consomment (e.g. pour calculer un `config_hash` ou apparenter un commit de geste).
- L'hôte est notifié des changements via les callbacks (`onParamChange`, `onPresetActivated`, `onTrajectoryChange`, `onCommit` — cf. [API.md](API.md)).

## E. Calque (overlay niveau-1) ⚡

Le calque est l'interface qui projette la library dans le plan via une PCA pondérée et permet la navigation Shepard.

```
Overlay[1]            = (visible : bool,
                         drag_mode : {centre, rect, none},
                         active_preset_ui_hash : string?,
                         active_preset_config_hash : string?,
                         centre_x : float?, centre_y : float?,
                         selection_start_x : float?, selection_start_y : float?,
                         selection_end_x : float?, selection_end_y : float?,
                         transition_active : bool,
                         projection_id → Projection?)

OverlayPresetOrder    = (**position : int**,
                         preset_ui_hash, preset_config_hash → Preset)

Projection            = (**id : int**, ui_hash : string,
                         kind : {empty, single, oneD, full})

ProjectionVector      = (**projection_id → Projection,
                          vector_kind : {centroid, u1, u2}, dimension_index : int**,
                         value : float)
```

- **`OverlayPresetOrder`** matérialise l'ordre Shepard (selon distance projetée).
- **`Projection`** est un cache reproductible depuis la library + les param specs.
- La **sélection multi** est modélisée séparément (cf. §F) car elle persiste entre ouvertures du calque.

## F. Sélection multi 📚

Sous-ensemble ordonné de presets sur lequel l'utilisateur opère explicitement (batch-delete via trash, mode boucle). Persiste par instance — survit aux ouvertures / fermetures du calque, et au reload comme la trajectoire.

```
SelectionEntry = (**position : int**,
                  preset_ui_hash, preset_config_hash → Preset)
```

- Singleton liste ordonnée par `position` (ordre d'insertion).
- Modifiée par Shift+click (toggle) et par marquee Shift+drag (additif).
- **Protège de l'éviction** : un preset référencé par la sélection n'est jamais évincé par la politique FIFO, même s'il est anonyme.
- L'éviction par trash supprime le preset **et** son entrée dans la sélection.

## G. Mode boucle 📚 ⚡

Lecture cyclique de la sélection avec interpolation. Les paramètres (tempo, transition) persistent par instance ; l'état d'exécution (active, position courante) est runtime.

```
LoopSettings[1]  = (bpm : float,
                    transition_time_ms : float,
                    transition_level : {0, 1})

LoopState[0..1]  = (active : bool,
                    current_step : int)
```

- **`LoopSettings`** : tempo de cycle ($T_L = 60{,}000 \cdot 4 / \text{BPM}$ ms pour la convention 1 cycle = 1 mesure 4/4), durée de transition $T_p$, niveau d'interpolation. Persiste par instance (📚).
- **`LoopState`** : état runtime du loop — runtime (⚡), perdu au reload. Au reload le loop n'est pas auto-rejoué ; l'utilisateur le redémarre s'il le souhaite.
- L'**édition à chaud** de la sélection pendant la boucle est supportée : le pas suivant lit la sélection courante (cf. PRESETSPEC).

## H. Auto-promotion (preset tracking) ⚡

Mécanisme stateful qui détecte les configurations stables et les promeut dans la library.

```
PromotionTracker[1]  = (last_committed_config_hash : string?,
                        last_committed_at_ms : int,
                        dwell_threshold_ms : int)

InGesture[1]         = (active : bool)

OverlayActive[1]     = (active : bool)
```

- **`PromotionTracker`** : si la config courante reste stable plus de `dwell_threshold_ms` milliseconds, on promeut.
- **`InGesture`** : suspend la promotion pendant un drag.
- **`OverlayActive`** : suspend la promotion quand le calque est ouvert (l'utilisateur gère manuellement).

## I. Undo scopes ⚡

Orbit-ui possède **deux** scopes d'undo, conformément à UNDOREDOSPEC :

### I.1. Library scope (niveau 3b)

Par `ui_hash` ; partagé entre toutes les instances orbit-ui de même signature.

```
LibraryUndoOp        = (**ui_hash : string, stack : {past, future}, position : int**,
                        kind : {add, rename, delete, delete_batch})

LibraryAddOp         = (**ui_hash, stack, position → LibraryUndoOp**,
                        record_snapshot_id → PresetRecordSnapshot)

LibraryDeleteOp      = (**ui_hash, stack, position → LibraryUndoOp**,
                        record_snapshot_id → PresetRecordSnapshot)

LibraryRenameOp      = (**ui_hash, stack, position → LibraryUndoOp**,
                        target_ui_hash : string, target_config_hash : string,
                        prev_name : string?, next_name : string?)

LibraryDeleteBatchOp = (**ui_hash, stack, position → LibraryUndoOp**)

LibraryDeleteBatchItem = (**ui_hash, stack, position → LibraryDeleteBatchOp,
                           item_index : int**,
                          record_snapshot_id → PresetRecordSnapshot)

PresetRecordSnapshot = (**snapshot_id : int**,
                        ui_hash : string, config_hash : string, name : string?,
                        last_seen_at : int)

PresetRecordSnapshotConfig = (**snapshot_id → PresetRecordSnapshot, address : string**,
                              value : float)
```

### I.2. Param scope (niveau 2)

Par instance ; ops parameters before/after sur un commit de geste.

```
ParamUndoOp        = (**stack : {past, future}, position : int**,
                      kind : {params})

ParamSnapshot      = (**stack, position → ParamUndoOp,
                       when : {before, after}, address : string**,
                      value : float)
```

(Cardinalité par instance : il n'y a qu'une pile par orbit-ui ; clef = `(stack, position)`.)

Notes :
- **Snapshots embarqués** : les ops library qui doivent survivre à la suppression de leur cible portent des copies indépendantes (`PresetRecordSnapshot`) — pas des FK vers `Preset`.
- Le **scope niveau 1 (chain)** et le **niveau 0 (project)** sont **hors-scope** d'orbit-ui : ils concernent l'arrangement des effets dans une chaîne, pas l'effet lui-même.

## J. Recall menu (niveau-0) 🎯

Menu transient pour sélectionner rapidement un preset par nom.

```
RecallMenu[0..1] = (anchor_x : int, anchor_y : int,
                    filter_query : string?,
                    selected_preset_index : int)
```

## Diagramme des relations

```
                       INPUT EXTERNE 🛰
                       ────────────────
   ParamSpec (host-fed)
       │
       └─► (ui_hash dérivé)

                       LIBRARY 📚 (host-stored)
                       ───────────────────────
              Preset ── PresetConfigEntry
                  │
                  │ ui_hash
   ┌──────────────┘
   │ (projection)
   ▼
   Overlay ── OverlayPresetOrder ──► Preset
        │
        └── Projection ── ProjectionVector

   SelectionEntry ──► Preset            (cf. §F)
   LoopSettings · LoopState              (cf. §G)

                       INSTANCE RUNTIME ⚡
                       ──────────────────
   Instance ── ParamValue
       │
       │ (commits)
       ▼
                       TRAJECTORY 📚 (host-stored)
                       ────────────────────────────
   TrajectoryRecord ── TrajectoryEvent ── TrajectoryEventConfig
   (singleton, host keys it externally for storage)

                       UNDO ⚡
                       ──────
   LibraryUndoOp ── { Add, Rename, Delete, DeleteBatch }
                              ↓
                   PresetRecordSnapshot ── PresetRecordSnapshotConfig

   ParamUndoOp ── ParamSnapshot

                       AUTO-PROMOTION ⚡
                       ────────────────
   PromotionTracker · InGesture · OverlayActive

                       NIVEAU 0 🎯
                       ──────────
   RecallMenu
```

## Propriétés du modèle

1. **Pureté de la frontière** : aucun champ ne référence le code Faust. Le `ui_hash` est dérivé de la signature. Le `config_hash` est dérivé d'une configuration. Les deux sont calculables depuis ce qu'orbit-ui voit déjà.

2. **Cohérence avec la library** : la trajectoire est aussi indexée par `ui_hash` (pas par `code_hash`). Conséquence : un édit de code qui ne change pas l'UI préserve la library **et** la trajectoire — c'est le bon comportement, conforme à PRESETSPEC.

3. **Hash-liaisons** : library et trajectoire sont reliés au monde extérieur (signatures UI, instances, sessions) **par hash**, jamais par FK directes. Conséquence : la disparition d'une instance ne casse rien dans la library ni dans une trajectoire d'une autre instance partageant la même signature.

4. **Reproductibilité du runtime** : tout ce qui est ⚡ peut se reconstituer à partir des entrées 🛰 + des persistances 📚. Aucune donnée vivante ne disparaît avec un reload pourvu que l'hôte fournisse l'état initial correctement.

5. **Persistance déléguée à l'hôte** : le composant ne sait rien de IDB, du serveur, du fichier. Il maintient son état en mémoire, accepte un état initial à la construction, et émet des events à chaque mutation. C'est l'hôte qui choisit comment et où persister.

6. **Cross-instance orchestrée par l'hôte** : plusieurs orbit-ui partageant le même `ui_hash` doivent voir les mêmes données library. Le composant expose des setters (`setLibrary`) que l'hôte appelle quand une autre instance a muté ; le canal de communication (BroadcastChannel, etc.) est l'affaire de l'hôte.

## Ce que ce modèle ne couvre pas (responsabilité hôte)

- **Code Faust** et son hash : externe.
- **Runtime audio** (`AudioWorkletNode`, compilation, chain audio) : externe.
- **Identification d'instance** : `session_id`, `instance_id` sont gérés par l'hôte (qui keye son store). Orbit-ui ne les voit même pas dans son API.
- **Persistance concrète** : non gérée par le composant. L'hôte fournit l'état initial via options et écoute les events de mutation pour persister.
- **Niveau 1 (chain)** et **niveau 0 (project)** d'undo : hors-scope (ce sont des structures supérieures qui contiennent l'orbit-ui, pas qu'il contient).
- **Routage Cmd+Z global** : l'hôte route ; orbit-ui expose `undoLibrary()` / `redoLibrary()` / `undoParams()` / `redoParams()` que l'hôte appelle quand le focus convient.

## Hors-scope de la spec

- **Algorithme de projection** (PCA pondérée, distances, Shepard) — couvert par PRESETSPEC.
- **Schéma de stockage concret** (forme IDB, mongo, fichier) — choix de l'hôte.
- **Mécanisme de synchronisation cross-instance** — choix de l'hôte (BroadcastChannel, polling, WebSocket).
- **Politique d'éviction du log de trajectoire** — paramétrable par l'hôte.
- **Forme exacte de l'API publique d'orbit-ui** (méthodes, events, options) — voir [API.md](API.md).
