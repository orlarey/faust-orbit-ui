# Data model of the Faust Orbit UI component

## Scope

This document describes the **set** of live data at a given instant in an instance of the *Faust Orbit UI* component — not just what it persists. It serves as a shared reference for reasoning about its conceptual boundary, its scope of responsibility, and the contracts it establishes with its host.

This is a **conceptual and mathematical model**: the relations described are neither an implementation schema nor a storage prescription. The component may adopt nested structures, caches, observables — it does not matter: what is codified here is the **normal form** of the information being manipulated.

## Conceptual boundary

Orbit UI is a **remote control** that knows of the Faust DSP only its **parameter signature** (the list of exposed widgets: address, type, range, default value). It does **not** know:

- The Faust source code.
- The audio runtime (`AudioWorkletNode`, compilation, routing).
- The concrete persistence (IDB, files, cloud).
- Instance identity (who decides that an orbit-ui exists — that is the host).

Anything that depends on the Faust code or the audio runtime is **out of scope** by construction. The host provides what is necessary via well-defined entry points (UI signature at construction, initial state, mutation callbacks, setters for cross-instance sync).

## Notation

Identical to `DAWDATAMODELSPEC.md`:

```
RelationName = (**primary key**, attribute : type, attribute → OtherRelation, …)
```

with:

- **`**…**`** — primary key (composite if multiple columns separated by commas)
- **`→ Table`** — foreign key to the PK of `Table`
- **`?`** — optional
- **`{a, b, c}`** — enumerated type
- **`[1]`** or **`[0..1]`** — cardinality of the table

## Lifetime

| Marker | Meaning |
|---|---|
| 🛰 | External input (provided by the host) |
| 📚 | Lateral persistence (delegated to the host via initial state + events) |
| ⚡ | Component runtime in-memory, reconstituted on reload |
| 🎯 | In-flight gesture |

**Structuring rule**: anything that is ⚡ must be reconstitutable from the 🛰 inputs + the 📚 lateral persistences.

## A. Input: UI signature 🛰

The host provides the signature of the Faust effect to orbit-ui at creation.

```
ParamSpec      = (**address : string**,
                  type : {hslider, vslider, nentry, button, checkbox, …},
                  min : float, max : float, default : float, step : float,
                  label : string,
                  menu : MenuEntry[]?)

MenuEntry      = (**label : string, value : float**)
```

The **identifier `uiHash`** is derived from the `ParamSpec` set (SHA-256 of a normalization: sort by address, serialization of identity fields). Orbit-ui computes it internally at boot and exposes it via `orbit.uiHash`. This is the **identity of the signature**: anything that shares the same UI signature shares the same `uiHash`. The host does not implement it — it **reads** it from the component.

The component does not know instance identity (session, slot, …). From the component's point of view, there is **only one** instance — its own — and a single current trajectory. It is the host that manages the external storage identifiers, without exposing them to the component.

## B. Preset library 📚

The library catalogs the visited configurations. Each entry is a **place** in the parameter space; the `name?` field distinguishes the **named** ones (pinned by the user, permanent) from the **anonymous** ones (visited places, subject to eviction).

The host is responsible for persistence; orbit-ui maintains a synchronous local cache of it, updates via setters, and emits `onLibraryChange`.

```
Preset             = (**ui_hash : string, config_hash : string**,
                      name : string?, last_seen_at : int)

PresetConfigEntry  = (**ui_hash, config_hash → Preset, address : string**,
                      value : float)
```

- **`ui_hash`** = identity of the parameter signature; **`config_hash`** = identity of the configuration. No reference to the Faust code.
- **`name`** absent → **anonymous** preset, subject to FIFO eviction. Present → **named** preset, permanent (never evicted).
- **`last_seen_at`** is used (a) for computing the weight in the weighted PCA projection and (b) for the centre-step navigation order. Updated each time an instance commits this configuration.
- The library is **shared** by all orbit-ui instances that expose the same `uiHash`; cross-instance synchronization goes through the host via `setLibrary`.

### Eviction policy

When the number of presets for a given `uiHash` exceeds a threshold (500 by default), the oldest **anonymous** ones (by ascending `last_seen_at`) are evicted until falling back below the threshold. **Named** ones are never evicted. Presets referenced by the multi-selection are protected (cf. §F).

### Trash and auto-recreation

The trash **truly** removes the selected presets from the catalog. The trajectory does not break (each event embeds its own configuration — cf. §C). If the user later revisits a deleted configuration and stays there long enough (dwell timer), an anonymous preset is **auto-recreated** — with no memory of the past deletion.

## C. Trajectory 📚

The component maintains **one** current trajectory (singleton) — an append-only log of configurations committed per gesture during the lifetime of the instance. **No `code_hash`**: invariance with respect to non-UI code edits is carried by `ui_hash` (consistency with the library). The host knows under which external key to store this trajectory (for example `(session_id, instance_id)`) but the component does not see it.

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

- **`head_index`** = last committed event (`-1` if empty). **`cursor_index`** = position of the navigation cursor (`-1` if detached).
- **`ui_hash`** stored on the record allows the component to validate that a `setTrajectory(record)` actually corresponds to its current signature (otherwise the record is rejected).
- **`transition_level ∈ {0, 1}`** = dynamic transition level (PRESETSPEC).
- Bounded cardinality: FIFO eviction beyond a threshold (for example 500 events).
- **Embedded configuration**: `TrajectoryEventConfig` carries the configuration directly in the event, **not** a reference to `Preset`. Consequence: deletion of a preset (via trash) does not break the trajectory — each event remains independently replayable. This is an accepted trade-off: low storage duplication against robustness to catalog deletion.

## D. Runtime instance ⚡

The live state of the current instance.

```
Instance[1]   = (ui_hash : string, signature_revision : int)

ParamValue    = (**address → ParamSpec**, value : float)
```

- `ParamValue` reflects the **current value** of the parameters in the remote control. Writes (drag, recall) update it, reads consume it (e.g. to compute a `config_hash` or to relate a gesture commit).
- The host is notified of changes via callbacks (`onParamChange`, `onTrajectoryChange`, `onCommit` — cf. [API.md](API.md)).

## E. Calque (level-1 overlay) ⚡

The calque is the interface that projects the library into the plane via a weighted PCA and enables Shepard navigation.

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

- **`OverlayPresetOrder`** materializes the Shepard order (according to projected distance).
- **`Projection`** is a cache reproducible from the library + the param specs.
- The **multi-selection** is modeled separately (cf. §F) because it persists across calque openings.

## F. Multi-selection 📚

Ordered subset of presets on which the user explicitly operates (batch-delete via trash, loop mode). Persists per instance — survives openings/closings of the calque, and reload like the trajectory.

```
SelectionEntry = (**position : int**,
                  preset_ui_hash, preset_config_hash → Preset)
```

- Singleton list ordered by `position` (insertion order).
- Modified by Shift+click (toggle) and by Shift+drag marquee (additive).
- **Protects from eviction**: a preset referenced by the selection is never evicted by the FIFO policy, even if it is anonymous.
- Eviction by trash removes the preset **and** its entry in the selection.

## G. Loop mode 📚 ⚡

Cyclic playback of the selection with interpolation. The parameters (tempo, transition) persist per instance; the execution state (active, current position) is runtime.

```
LoopSettings[1]  = (bpm : float,
                    transition_time_ms : float,
                    transition_level : {0, 1})

LoopState[0..1]  = (active : bool,
                    current_step : int)
```

- **`LoopSettings`**: cycle tempo ($T_L = 60{,}000 \cdot 4 / \text{BPM}$ ms for the convention 1 cycle = 1 measure 4/4), transition duration $T_p$, interpolation level. Persists per instance (📚).
- **`LoopState`**: runtime state of the loop — runtime (⚡), lost on reload. On reload the loop is not auto-replayed; the user restarts it if they wish.
- **Hot-editing** of the selection during the loop is supported: the next step reads the current selection (cf. PRESETSPEC).

## H. Auto-promotion (preset tracking) ⚡

Stateful mechanism that detects stable configurations and promotes them into the library.

```
PromotionTracker[1]  = (last_committed_config_hash : string?,
                        last_committed_at_ms : int,
                        dwell_threshold_ms : int)

InGesture[1]         = (active : bool)

OverlayActive[1]     = (active : bool)
```

- **`PromotionTracker`**: if the current config remains stable for more than `dwell_threshold_ms` milliseconds, we promote.
- **`InGesture`**: suspends promotion during a drag.
- **`OverlayActive`**: suspends promotion when the calque is open (the user manages manually).

## I. Undo scopes ⚡

Orbit-ui has **two** undo scopes, in accordance with UNDOREDOSPEC:

### I.1. Library scope (level 3b)

Per `ui_hash`; shared between all orbit-ui instances of the same signature.

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

### I.2. Param scope (level 2)

Per instance; before/after parameters ops on a gesture commit.

```
ParamUndoOp        = (**stack : {past, future}, position : int**,
                      kind : {params})

ParamSnapshot      = (**stack, position → ParamUndoOp,
                       when : {before, after}, address : string**,
                      value : float)
```

(Cardinality per instance: there is only one stack per orbit-ui; key = `(stack, position)`.)

Notes:
- **Embedded snapshots**: library ops that must survive deletion of their target carry independent copies (`PresetRecordSnapshot`) — not FKs to `Preset`.
- The **level 1 (chain) scope** and the **level 0 (project)** are **out of scope** of orbit-ui: they concern the arrangement of effects in a chain, not the effect itself.

## J. Recall menu (level 0) 🎯

Transient menu to quickly select a preset by name.

```
RecallMenu[0..1] = (anchor_x : int, anchor_y : int,
                    filter_query : string?,
                    selected_preset_index : int)
```

## Relationship diagram

```
                       EXTERNAL INPUT 🛰
                       ────────────────
   ParamSpec (host-fed)
       │
       └─► (ui_hash derived)

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

                       RUNTIME INSTANCE ⚡
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

                       LEVEL 0 🎯
                       ──────────
   RecallMenu
```

## Properties of the model

1. **Boundary purity**: no field references the Faust code. The `ui_hash` is derived from the signature. The `config_hash` is derived from a configuration. Both are computable from what orbit-ui already sees.

2. **Consistency with the library**: the trajectory is also indexed by `ui_hash` (not by `code_hash`). Consequence: a code edit that does not change the UI preserves the library **and** the trajectory — that is the right behavior, conforming to PRESETSPEC.

3. **Hash bindings**: library and trajectory are linked to the outside world (UI signatures, instances, sessions) **by hash**, never by direct FK. Consequence: the disappearance of an instance breaks nothing in the library nor in a trajectory of another instance sharing the same signature.

4. **Runtime reproducibility**: anything that is ⚡ can be reconstituted from the 🛰 inputs + the 📚 persistences. No live data disappears with a reload provided the host supplies the initial state correctly.

5. **Persistence delegated to the host**: the component knows nothing of IDB, the server, the file. It maintains its state in memory, accepts an initial state at construction, and emits events at every mutation. It is the host that chooses how and where to persist.

6. **Cross-instance orchestrated by the host**: multiple orbit-uis sharing the same `ui_hash` must see the same library data. The component exposes setters (`setLibrary`) that the host calls when another instance has mutated; the communication channel (BroadcastChannel, etc.) is the host's affair.

## What this model does not cover (host responsibility)

- **Faust code** and its hash: external.
- **Audio runtime** (`AudioWorkletNode`, compilation, audio chain): external.
- **Instance identification**: `session_id`, `instance_id` are managed by the host (which keys its store). Orbit-ui does not even see them in its API.
- **Concrete persistence**: not managed by the component. The host provides the initial state via options and listens to mutation events to persist.
- **Level 1 (chain)** and **level 0 (project)** undo: out of scope (these are higher-level structures that contain the orbit-ui, not that it contains).
- **Global Cmd+Z routing**: the host routes; orbit-ui exposes `undoLibrary()` / `redoLibrary()` / `undoParams()` / `redoParams()` that the host calls when focus is appropriate.

## Out of scope of the spec

- **Projection algorithm** (weighted PCA, distances, Shepard) — covered by PRESETSPEC.
- **Concrete storage schema** (IDB shape, mongo, file) — host's choice.
- **Cross-instance synchronization mechanism** — host's choice (BroadcastChannel, polling, WebSocket).
- **Trajectory log eviction policy** — parameterizable by the host.
- **Exact form of orbit-ui's public API** (methods, events, options) — see [API.md](API.md).
