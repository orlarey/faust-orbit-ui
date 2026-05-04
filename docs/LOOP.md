# Loop mode specification

The **loop mode** allows cyclic visiting of a selection of presets by continuously moving from one to the next: at each step, the sound glides along an interpolated trajectory between two presets, then briefly holds on the next one, before moving on toward the following preset. The loop loops indefinitely.

## Scope

This document describes the **loop mode** of the level-1 overlay (calque) of the *Faust Orbit UI* component: the cyclic playback of a preset selection with interpolated transitions via Shepard. It is a sub-system of the calque, whose broader concepts are defined by [PRESETS.md](PRESETS.md), [DATAMODEL.md](DATAMODEL.md) and [API.md](API.md).

This document **precisely formalizes the state of the loop system at an instant T**, the transitions between phases, and the expected behavior under dynamic modifications of the selection. It serves as a reference for implementation and for reasoning about edge cases.

## Notation

| Symbol | Meaning |
|---|---|
| `P` | the set of known presets (the library) |
| `S = [s_0, s_1, …, s_{n−1}]` | the selection: ordered list of distinct presets, `s_i ∈ P`, `\|S\| = n` |
| `S[j]` | cyclic accessor: `S[j] = S[j mod n]` (defined for all `j ≥ 0` when `n > 0`) |
| `pos(p)` | visual position (in projection coordinates) of preset `p` |
| `c` | current position of the central cursor (in projection coordinates) |
| `ψ(c)` | audible configuration interpolated by Shepard at position `c` |

## Adjustable parameters

Three continuous inputs that the user adjusts live via the bottom bar. The system **reads them live** at each tick — it never takes a snapshot of them.

| Symbol | Meaning | Source |
|---|---|---|
| `T_L` | total duration of one cycle (ms = one 4/4 measure at the tempo) | BPM slider |
| `v` | duration of a movement between two presets (ms) | Tp slider (portamento) |
| `r` | hold duration on a preset (ms) | derived |

`r` is derived live: `r(n) = max(T_L / n − v, 0)`. This gives a "tempo, not density" semantics: adding or removing presets from `S` changes the density (how many presets visited per cycle), not the tempo.

## Assumptions

- During the loop, **everything operates with `n > 0`**. If `n = 0` the loop stops (cf. § *Stopping*).
- During a movement, the cursor progresses linearly from the starting position toward the target position. The normalized progression is denoted `g ∈ [0, 1]`. At `g = 0` we are at the starting position; at `g = 1` we are at the target.
- The sound emitted at any instant is `ψ(c)` where `c` is the current cursor position.

## A. State at instant T

The state of the loop is one of three values:

```
LoopState =
  | Inactive
  | Motion { from : Pos, to : configHash, startedAt : ms }
  | Hold   { on   : configHash, startedAt : ms }
```

with

- `Inactive`: the loop is not running.
- `Motion`: we are moving **toward** the preset `to`. `from` is the cursor position at the start of the movement (may be `pos(prev)` of a previous preset or any position in the plane). `startedAt` is the timestamp of the start of the movement.
- `Hold`: we are held **on** the preset `on`. `startedAt` is the timestamp of the start of the hold.

`Motion.from` is intentionally a `Pos` (and not a `configHash`): after a swap (cf. §C), a movement may be initiated from any continuous point — not necessarily the position of a preset.

## B. Derivations at instant `now`

The state holds the temporal anchors; everything else is computed on the fly at each animation frame.

During **Motion** (with `target_pos = pos(to)`):

```
g = clamp((now − startedAt) / v, 0, 1)
c = lerp(from, target_pos, g)
```

During **Hold** (with `target_pos = pos(on)`):

```
c        = target_pos
elapsed  = now − startedAt
r_now    = max(T_L / n − v, 0)
remain   = max(r_now − elapsed, 0)
```

The sound is permanently `ψ(c)`.

## C. Transitions between phases

Three transitions (all read at each tick):

### C.1. `Motion → Hold`

When `g` reaches 1:

```
state := Hold { on: state.to, startedAt: now }
```

### C.2. `Hold → Motion`

When `elapsed ≥ r_now`:

```
nextHash := chooseNext(state.on, S)        # cf. §E
state    := Motion {
  from:      pos(state.on),
  to:        nextHash,
  startedAt: now,
}
```

### C.3. `Active → Inactive`

Explicit stop (■ button, Esc, hide, external setLibrary, etc. — cf. §F):

```
state := Inactive
```

### C.4. `Inactive → Active`

Explicit start (▶ button) with `n > 0`:

```
nextHash := S[0]
state    := Motion {
  from:      <current cursor position>,
  to:        nextHash,
  startedAt: now,
}
```

## D. `swap(S')`: dynamic change of selection

The contract of a swap: replace the selection `S` (with `\|S\| = n > 0`) by `S'` (with `\|S'\| = m > 0`) **while creating the minimum of discontinuities**.

A *discontinuity* is here a non-continuous jump in the cursor position `c` (and therefore, as a consequence, an audio jump via `ψ`).

The rule:

```
let target := state.to     if Motion
            state.on     if Hold

if target ∈ S':
    # Case 1: the targeted preset is still part of the selection.
    # We keep the state as is. No discontinuity.
    state unchanged
    # (Hold.elapsed remains valid; the next Hold→Motion will read S'
    #  to compute the successor.)

else:
    # Case 2: the targeted preset is no longer in the selection.
    # We choose the preset of S' visually closest to the cursor,
    # and initiate a Motion toward it from the current position c.
    target' := S'[ argmin_{j ∈ [0, m)} ‖ pos(S'[j]) − c ‖ ]
    state   := Motion {
      from:      c,            # current cursor position
      to:        target',
      startedAt: now,
    }
```

`c` is in both cases the value derived at the instant of the swap (§B). The movement initiated in case 2 uses the current `v` duration, like any other movement.

### Notable consequences

- **`\|S\| = 1`**: the loop does not stop. Once the unique preset `p` is reached, we alternate `Hold(on=p)` → `Motion(from=pos(p), to=p)` (degenerate movement, `g = 1` immediately) → `Hold(on=p)` → … . The cursor stays on `p`; the loop continues to "run" while waiting for a change of selection.

- **Removal of a preset from `S` mid-Motion**: if the target preset disappears, we deviate continuously toward the closest one in `S'`. No jump, just a change of angle.

- **Addition of a preset to `S` mid-cycle**: no immediate phase change. The new preset simply enters the rotation at the next `Hold→Motion` (according to the `chooseNext` rule of §E).

## E. `chooseNext(current, S)`: succession rule

When a Hold ends, the next preset in the current selection is chosen:

```
i := S.indexOf(current)

if i ≥ 0:
    return S[(i + 1) mod n]
else:
    # `current` is no longer in S (was removed between the swap and the
    # Hold→Motion transition, or never added). We restart at the beginning.
    return S[0]
```

This is the same rule as in webdaw today, but always applied to the **live selection** at the moment of the transition — never to a snapshot.

## F. Stopping: which gestures stop the loop

The only gestures that force `Active → Inactive` are those that take over the cursor:

| Gesture | Effect on the loop |
|---|---|
| Click ■ (stop button) | **stops** |
| Esc / closing the calque | **stops** |
| External `setLibrary` (host sync) | **stops** (the base changes under our feet) |
| Single click on a preset (recall + central drag) | **stops** (direct manipulation) |
| Single click on empty space (central drag) | **stops** (direct manipulation) |
| Drag of the central cursor | **stops** (direct manipulation) |
| Cursor ←/→ (manual jump to next preset) | **stops** (manual jump) |
| Trash (deletion) | **does not stop** unless the selection becomes empty ⇒ stop |
| Shift+click on a preset (toggle in `S`) | **does not stop** — `S` changes, swap rule in §D |
| Shift+drag (selection rectangle) | **does not stop** — `S'` replaces `S`, swap rule in §D |
| Movement of the Tp or BPM slider | **does not stop** — live read §B/§C |

### Selection rectangle semantics

The selection rectangle (shift+drag on empty space) **replaces** `S` with the set of presets contained in the rectangle. It is no longer additive. Consistent with the swap rule (§D): the entire selection can be redefined while the loop is running without stopping playback.

(Shift+click on a preset, on the other hand, remains an additive/subtractive toggle — that is the fine-grained editing of an existing selection.)

## G. Cardinality / boundedness

No hard bound on the loop side. The known bounds:

- `\|S\| ≥ 1` for the loop to be active.
- `T_L > 0`, `v ≥ 0`, `r(n) ≥ 0` (clamped to 0 if `T_L / n < v`).

When `T_L / n < v` (the portamento is longer than the natural step), `r = 0` and the loop chains movements without pause — assumed behavior.

## H. Out of scope

- **Eviction policy of `S`**: the selection is not subject to its own eviction policy; cf. ORBITDATAMODELSPEC §F.
- **Cross-instance synchronization of parameters `T_L` and `v`**: these are `LoopSettings` persisted per instance (cf. ORBITDATAMODELSPEC §G); the component exposes them via `setLoopSettings` / `onLoopSettingsChange` but the channel between instances is the host's concern.
- **rAF limitation in background tabs**: browsers throttle `requestAnimationFrame` to ~1 Hz when the tab is not visible, which degrades the loop into discrete jumps. No mitigation planned here; detaching the tab into a window restores nominal behavior.
- **Exact form of the API** (`LoopSettings` types, `onLoopSettingsChange` events, etc.): see ORBITUIAPISPEC.md.
