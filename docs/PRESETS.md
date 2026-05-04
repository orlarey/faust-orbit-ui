# FX presets specification

## Scope

This document fixes the vocabulary and invariants of **trajectories** and **presets** of Faust DSP effects. It precedes any implementation choice. The goal is that each term has a unique meaning and that one can talk about production, navigation, memoisation and recall without ambiguity.

## Mathematical definitions

### Parameter

A Faust DSP exposes a **finite** set of parameters:

$$P = \{p_1, p_2, \dots, p_n\}$$

Each parameter $p_i$ carries:

- a unique **address** (string, e.g. `"/reverb/wet"`)
- a **domain** $D(p_i)$ of allowed values (continuous interval discretised by a step, set of categories, boolean)
- an **initialisation value** $d(p_i) \in D(p_i)$ provided by the DSP

### Configuration

A **configuration** for a given DSP is a total mapping:

$$c : P \to \bigcup_i D(p_i) \quad \text{such that} \quad c(p_i) \in D(p_i) \ \forall p_i \in P$$

### Parameter space

The set of possible configurations:

$$E(\text{dsp}) = \prod_i D(p_i)$$

### Default configuration

For each DSP, a unique configuration:

$$c_{\text{default}}(p_i) = d(p_i) \quad \forall p_i$$

It exists without any user action.

### Trajectory (mathematical view)

For an effect instance, interaction produces a piecewise constant function:

$$T : \mathbb{R}_{\geq 0} \to E(\text{dsp})$$

with $T(0) = c_{\text{default}}$, discontinuous at the instants of gesture commits.

## Operational representation

### Trajectory log

The trajectory is persisted as an **append-only log**:

$$L = [e_0, e_1, \dots, e_h] \qquad e_i = (t_i, c_i)$$

where $t_i$ is the timestamp of the commit and $c_i \in E$ the committed configuration. The log is chronologically ordered. An event can only be removed by FIFO eviction when the maximum capacity is reached.

### HEAD

**HEAD** is the index of the last event of the log ($h$). It designates the "real" configuration applied by default to the instance.

### Cursor

The **cursor** is an internal index in the log, used exclusively by
the detached-cursor commit mechanism (cf. §"Gesture commit from detached
cursor" below). It is **not exposed in the current level-1 UI**:
no marker represents it on the calque, no key
moves it. It remains at HEAD in practice, unless a future extension
reintroduces consultation of prior events.

Properties (inherited from the initial model, kept for future extensions):

- Modifies neither the log nor HEAD
- Determines the configuration applied to audio as long as it is detached
- Returns to HEAD after any new gesture commit

## Storage

| Property | Trajectory | Preset library |
| --- | --- | --- |
| **Identification key** | $(\text{sessionId}, \text{effectInstanceId})$ | $(\text{uiHash}, c)$ by content |
| **GC attribution** | $(\text{sessionId}, \text{effectInstanceId})$ | $(\text{sessionId}, \text{uiHash})$ |
| **Visibility** | Local to the session and to the instance | Workspace-wide |
| **Dedup** | None — chronological log | By content |
| **Lifetime** | As long as the instance exists in the session (current state OR undo-reachable) | As long as at least one live session references it |
| **Capacity** | Bounded to $N$ events (≈ 500), FIFO eviction | Unlimited until GC |

## Operations

### Gesture commit (cursor aligned on HEAD)

When the user finishes a gesture from HEAD producing $c_{\text{new}}$:

1. The log is extended: $L' = [e_0, \dots, e_h, e_{\text{new}}]$ with $e_{\text{new}} = (t_{\text{now}}, c_{\text{new}})$
2. HEAD advances to the new event
3. Cursor aligns on HEAD

### Navigation (library cycle)

The **←** and **→** keys move the level-1 center from one preset to
another, **in the library** ordered by ascending `lastSeenAt`. Navigation
is cyclic: after the last preset, one returns to the first
and conversely. The glide is continuous (cf. §"Dynamic transitions",
portamento $T_p$) — the arrows are not an instantaneous jump.

The cycle traverses **each library entry only once**
(dedup by content). Revisits recorded in the trajectory
do not appear as distinct steps.

Historical note: an earlier design had the arrows navigate
in the trajectory log with possible duplicates. This behavior was
replaced by the library cycle because it better matches the
mental model "one preset = one unique point on the map".

### Gesture commit from detached cursor

Let cursor be at index $k < h$ at the moment when the user produces a modification $c_{\text{new}}$.

**The return path to HEAD is appended**, followed by the modification:

$$L' = [e_0, \dots, e_h, e_{h-1}, e_{h-2}, \dots, e_k, e_{\text{new}}]$$

where the appended events carry the current timestamp (these are **new events**, even if they reuse the historical configurations).

After which:

- HEAD becomes the new index (the index of $e_{\text{new}}$)
- Cursor aligns on HEAD
- No data is lost; the trajectory records the actual detour

### Memoisation (trajectory → library promotion)

A trajectory event is **promoted** into the workspace library if simultaneously:

1. $\geq X$ seconds have elapsed since its commit without a new gesture
2. Audio playback is active during this dwell
3. The effect is not bypassed

Promotion creates or updates a preset in the library.

If a preset with the same $(\text{uiHash}, c)$ already exists:

- `firstSeenAt` remains unchanged
- `lastSeenAt` is updated to the moment of promotion
- The entry moves up in the chronological order by `lastSeenAt`

### Preset recall

Recalling a preset $(h, c^*)$ from the library applies $c^*$ as a standard modification:

- Equivalent to a gesture commit toward $c^*$
- If cursor was detached, the return path is appended before the recall (modification-from-detached-cursor rule)
- The recall does not add an entry to the library (unless dwell > $X$ after the recall)

## Level-0 visualisation: parameter orbit-ui

Level 0 is the existing orbit-ui UI: each parameter $p_i$ of the DSP is represented by a point in a 2D canvas. The point's position encodes the current value $v_i$ via the distance to the center. The user drives the values by moving the center (all parameters evolve) or by moving a parameter individually (a single value changes).

### Source-of-truth invariant

The **parameter values** $v_i$ are the canonical state. The **positions** $\text{pos}_i$ in the canvas are a derived visual encoding, kept consistent with the values at all times.

Formally, at any instant:

$$v_i = \Phi\bigl(|C - \text{pos}_i|,\ \min_i,\ \max_i,\ r_{\text{inner}},\ r_{\text{outer}}\bigr)$$

where $\Phi$ encodes distance into value:

- distance $\leq r_{\text{inner}}$ → $\max_i$ (saturated high)
- distance $\geq r_{\text{outer}}$ → $\min_i$ (saturated low)
- otherwise → linear interpolation between $\min_i$ and $\max_i$ over $[r_{\text{inner}}, r_{\text{outer}}]$

### Minimal-movement rule

When a value $v_i$ changes from an external source (detail panel slider, level-1 Shepard write), the position $\text{pos}_i$ is updated **only if it no longer encodes the value within the step tolerance** ($\text{step}_i / 2$). If the current position already produces the new value via $\Phi$ — typical case in the high or low saturated zone — no movement.

This avoids visual jitter in zones where small variations of value are not resolvable by a position change.

### Angle preservation

When a position must move to encode a new value, it **slides along the radius** passing through the center and the current position. Only the radial distance changes; the angle relative to the center is preserved.

Each parameter thus keeps a **stable directional identity** in the canvas across evolutions.

### User actions at level 0

| Action | Effect |
| --- | --- |
| Drag of the center $C$ | Recomputation of all values $v_i$ via $\Phi$ with the new $C$ and current positions. Positions follow with the minimum necessary (minimal-movement rule). |
| Drag of a position $\text{pos}_i$ | Recomputation of $v_i$ via $\Phi$ at the new distance. |
| Drag of an external slider | New $v_i$ set directly. $\text{pos}_i$ slides along the radius if its current position no longer encodes the value. |
| External write (e.g. level-1 Shepard) | New $v_i$ written. Positions readjusted to the minimum via the rule. |
| Click on the preset counter badge | Opens the **level-0 recall menu** (cf. below). |

### Level-0 recall menu

Affordance complementary to the calque: a dropdown anchored under the preset counter badge in the effect header, which surfaces only the **user-named presets**. Clicking on an item recalls that preset as a gesture commit (equivalent to `ψ(\pi(c^*))` exactly on the preset). Auto-promoted presets without a name do not appear — they remain accessible via the calque.

- **Sort**: alphabetical by name (case- and accent-insensitive). Stable from one opening to the next.
- **Current state**: the item whose `configHash` matches exactly the current audible configuration receives a check (`✓`). At the slightest parameter change, no item is marked anymore.
- **Empty state**: if the library contains no named preset, the menu displays "No named presets". The badge remains clickable to signal the cohabitation of the two types (auto-promoted and named).
- **Closure**: click elsewhere, Escape, scroll. Click on an item closes the menu and triggers the recall.

## Level-1 visualisation: preset orbit-ui (calque)

Level 1 is a **semi-transparent calque overlaid on level 0**. It adds a second orbit-ui that operates on the library presets, no longer on individual parameters.

### Cohabitation of the two levels

When the calque is active:

- The level-0 elements (parameters + center $C$) remain **visible by transparency** to preserve the visual context.
- The level-0 elements are **no longer interactive**: drag of the level-0 center and drag of parameter positions are disabled.
- The level-0 center remains **frozen at the canvas center position** (it has no active semantic role during the overlay).
- The level-1 calque (presets, trajectory, HEAD, cursor, level-1 center) is drawn on top with full opacity.
- The parameter values are written by $\psi(\text{center}_1)$ — cf. level-0 source-of-truth invariant.

### Jumpless toggle

On toggle-off of the calque, the configuration $(\text{parameter values})$ remains the one Shepard was writing at the last instant. The level-0 positions are already consistent with these values (continuously maintained by the minimal-movement rule). The level-0 center is at the canvas center.

**Consequence**: no audible nor visual jump at the moment of the toggle. The next drag of the level-0 center applies $\Phi$ from this consistent state, producing new values continuously from where Shepard left them.

### Projection $\pi : E \to \mathbb{R}^2$

$\pi$ is built by **weighted PCA** on the set of memoised presets for a given $\text{uiHash}$:

- Input: presets $\{c_1, \dots, c_k\} \subset E$ with weights $w_i$ decreasing with the age of `lastSeenAt`
- Output: two directional vectors $u_1, u_2 \in E$ + weighted centroid $\bar{c}$
- 2D position of preset $c_i$: $p_i = \bigl(\langle c_i - \bar{c}, u_1 \rangle, \langle c_i - \bar{c}, u_2 \rangle\bigr)$

The projection evolves when the dataset changes: adding a preset can reorient the axes. This is a **learning aspect**: the more the library grows, the more the projection reflects the choices actually explored.

### Inverse $\psi : \mathbb{R}^2 \to E$ by unbounded Shepard

For a center position $(x, y)$ in the canvas, the corresponding configuration is computed by inverse-distance weighted (Shepard) interpolation over **all** presets:

Let $d_i = \|(x, y) - p_i\|$ for each preset, and let $w_i = d_i^{-p}$ be the raw weight (with $p = 2$ by default).

$$\psi(x, y) = \sum_i \tilde{w}_i \cdot c_i, \qquad \tilde{w}_i = \frac{w_i}{\sum_j w_j}$$

The normalised contributions $\tilde{w}_i \in [0, 1]$ sum to 1 and represent the share of each preset in the current configuration.

- **Continuity**: no threshold, no "out-of-influence" zone. $\psi$ is continuous everywhere on $\mathbb{R}^2$ — when the cross approaches a preset, its $\tilde{w}_i$ continuously grows toward 1, the others decrease toward 0.
- **Edge case** $d_i = 0$: $w_i \to \infty$. Numerically we short-circuit to the exact snap $\psi(x, y) = c_i$ to avoid $\infty/\infty$.

Design choice (vs historical bounded reach): $r_{\text{inner}}, r_{\text{outer}}$ have been removed. The bounded version introduced visible jumps at the $r_{\text{outer}}$ boundary when a preset entered/exited the active set; unbounded Shepard removes these breaks and the "out-of-reach default zone" at the cost of a computation over all presets at each frame, negligible for the expected library sizes.

### Visual elements

The canvas simultaneously contains:

- **The presets** as **uniform pink discs** each carrying their
  number (1-based) in the `lastSeenAt` order — the color does not encode
  the preset's identity, the number suffices. Color reserved for
  future extensions.
- **Amber ring** around each **selected** preset (cf. §Multi-selection).
- **Level-1 center** as a manipulable cross whose position determines
  $\psi(\text{center})$ applied in real time.
- **White arc** on the ring of each preset, whose length encodes the
  normalised Shepard contribution $\tilde{w}_i$ — the user sees live
  how the cross is interpolated.
- **Visual spread**: when several presets project to the same
  PCA position (clusters of very close configurations), their discs
  are spread on a small circle around the cluster centroid to
  remain individually visible. The spread is **purely visual**;
  the Shepard distances remain computed in the original projection
  space, so the audio behavior reflects the true distances.

The trajectory (HEAD, cursor, polyline of events) **is not
represented** in the current UI; it is kept as internal data
(cf. §Cursor, §Commit from detached cursor).

### Multi-selection

An ordered subset of presets, populated on demand, serves as a target
for two operations: **bulk deletion** and **loop mode**. The
selection is an ordered set (insertion order preserved) that survives
overlay toggles. Editing:

- **Shift+click on a preset**: toggles its membership in the selection.
- **Shift+drag in the empty space**: traces a rectangle; on release, all
  presets visible in the rectangle are **added** (additive —
  never removed, so as not to lose a slowly built selection).
- **Trash** in the effect header: deletes all selected presets
  from the library (does not touch the trajectory).

### Canvas interactions

| UI action | Semantics |
| --- | --- |
| Drag of the center | Continuous navigation in $E$ via current $\pi$; applies $\psi(\text{center})$ in real time |
| ←/→ | Portamento glide of the center toward the previous / next preset in `lastSeenAt` order, cycle |
| Shift+click on a preset | Toggles its presence in the multi-selection |
| Shift+drag in the empty space | Selection rectangle; additive add on release |
| Right-click on the cross → "Add preset" | Memoises the current configuration $\psi(\text{center})$ as a new preset, anchored to the visual position of the cross |
| Right-click on a preset → "Rename…" | Opens the inline editor to rename the preset |
| Right-click on a preset → "Delete" | Deletes the preset (confirmation if named) |
| Double-click on a preset | Shortcut equivalent to "Rename…" |
| ▶ / ■ (bottom bar) | Starts / stops loop mode on the current selection |

### Recency weighting

The weights $w_i$ follow an exponential decay:

$$w_i = \exp\bigl(-\lambda \cdot (t_{\text{now}} - t_{\text{lastSeen}, i})\bigr)$$

$\lambda$ is a "memory" parameter to be calibrated. MVP target: a one-week-old preset weighs half as much as a fresh preset ($\lambda = \ln 2 / (7 \text{ days})$).

### Degenerate cases

| Number of presets | Behavior |
| --- | --- |
| $k = 0$ | Empty preset canvas. Preset-ui mode is disabled; the user remains in parameter orbit-ui. |
| $k = 1$ | A single point. The canvas has a single useful position; systematic snap. |
| $k = 2$ | PCA degenerates to a single direction. Axis between the two points; second dimension arbitrary. |
| $k \geq 3$ | Full PCA. |

## Dynamic transitions

Until now, every movement in $E$ is instantaneous (gesture commit, preset recall). **Dynamic transitions** add a continuous temporal dimension: one can progressively glide from one configuration to another over a given time, and chain these glides in a loop.

### Two user parameters

- **Portamento time $T_p$**: duration of a continuous transition between the current configuration and the target configuration. Notion familiar from synthesisers.
- **Cycle duration $T_L$**: total duration of **a complete traversal** of the selection in loop mode (and not of an individual step). Exposed to the user in **BPM** under the assumption "1 cycle = 1 measure 4/4", i.e. $T_L = 60{,}000 \cdot 4 / \text{BPM}$ ms. This mapping makes the loop tempo stable in the face of hot edits of the selection (cf. below).

### Two modes

**Follow mode (one-shot).** A unique transition from the current configuration to a target $c^*$ in $T_p$ seconds. The configuration then remains at $c^*$.

**Loop mode.** The current **multi-selection** (cf. §Multi-selection)
serves as a list: its presets $[p_1, p_2, \dots, p_m]$, in insertion
order, are continuously traversed. The cycle duration $T_L$ is
distributed equally among the $m$ presets, each therefore receives a step
$T_S = T_L / m$ structured as:

$$T_S = \underbrace{T_p}_{\text{glide}} + \underbrace{\max(0,\ T_S - T_p)}_{\text{hold at the preset}}$$

If $T_p = T_S$, continuous movement without pause on the preset. If $T_p = 0$, instantaneous jumps and full hold on each preset ($T_S$ per preset). In between, glide + hold mix emerging from the differential.

Important consequence of this model: **the cycle duration remains fixed regardless of the size of the selection**. Adding or removing presets during the loop modifies the *density* of content without moving the tempo, like filling a measure of a sequencer with more or fewer notes.

Classic modes subsumed by the loop:

- Elastic (A ↔ B, one round trip) = selection `{A, B}` executed for one iteration
- Oscillating (A ↔ B continuously) = selection `{A, B}` continuously

**Hot editing.** The selection is modifiable during the loop (via
shift+click or rectangle). The next step reads the current selection:
adding a preset inserts it at the tail, removing a preset skips it. The
rhythmic structure changes immediately.

### Path geometry

The intermediate configuration during a transition is computed according to the chosen level:

- **Level 0 (raw parameters)**: component-by-component linear interpolation.
  $$c(t) = (1 - \alpha(t)) \cdot c_{\text{start}} + \alpha(t) \cdot c_{\text{target}}$$
  with $\alpha : [0, T_p] \to [0, 1]$ linear by default ($\alpha(t) = t / T_p$).
- **Level 1 (preset-ui canvas)**: the center glides in a straight line in the 2D canvas from $\pi(c_{\text{start}})$ toward $\pi(c_{\text{target}})$. The intermediate configuration is $\psi(\text{center}(t))$. The path in $E$ can then be non-linear, passing through the influence zones of intermediate presets via Shepard.

### Interruption

If a new transition is requested while one is in progress, the new one **starts from the current interpolated configuration** (replacement, not queue).

### Constraint

In loop mode: $T_p \leq T_S = T_L / m$, i.e. $m \cdot T_p \leq T_L$ (the transition must finish before the next trigger). The execution engine applies a floor: if the current value of $T_p$ exceeds $T_L / m$, the effective step is stretched to $T_p$ and the audible cycle becomes longer than what the tempo slider displays. The UI does not actively clamp the sliders; it is up to the user to adjust Tp or reduce the selection if they want to exactly respect the displayed BPM.

### Known limitation: timer throttling in background tabs

The driving of the cross glide and of the hold in loop mode relies on `requestAnimationFrame` on the main thread side. Now browsers (Chrome notably) **throttle rAF and `setTimeout` to about 1 Hz for non-foreground tabs** in order to save CPU and battery. Practical consequence: when the DAW tab goes to the background while a loop is running, one only gets ~1 audio update per second, the intermediate Shepard glide is no longer computed, and the audible loop reduces to **discrete jumps from preset to preset**. The global cycle timing remains roughly correct (`performance.now()` is not throttled) but the $\psi$ continuity is lost.

The Web Audio engine itself runs on a non-throttled real-time thread: the sound itself does not cut off, it is only the JS chain driving `apply(config)` that suffers. **Detaching the tab into a standalone window** (or using a standalone PWA) suffices to take it out of the "background tab" category and restores nominal behavior.

Clean future solution: move the loop's reference clock to `audioContext.currentTime` (scheduling via `setValueAtTime` / `linearRampToValueAtTime`), or install a minimal `AudioWorkletNode` that posts a tick to the main thread every ~33 ms — these postMessages are not throttled as long as audio is active.

### Trace in the trajectory log

A transition produces **a single trajectory event** at the target, with metadata:

- `transitionTime` = $T_p$
- `transitionLevel` = `0` (parameter level) or `1` (canvas level)
- `loopContext` = identifier of the loop if applicable

The log remains discrete. The audible continuity is a transient phenomenon, not historically traced. If the user interrupts a transition before it ends and starts a new one, the old target is never logged.

## Invariants

### Totality

A configuration is a **total** mapping over $P$. No partial preset.

### Legitimacy

$c(p_i) \in D(p_i)$ for every parameter. No value out of domain.

### Consistency with the parameter signature

A preset is bound to a precise $\text{uiHash}$ — the signature of the DSP's parameter interface ($\{(path, type, min, max, step)\}$). As long as the signature is unchanged, the preset remains valid even if the DSP source has evolved (refactor, bug fix, comment, etc.). If the signature changes (parameter added, removed, range modified), the preset is attached to another $\text{uiHash}$ and is no longer visible from the new code. No implicit migration. The $\text{codeHash}$ — hash of the source — remains used separately by the trajectory to signal that a recompilation invalidates the current trajectory.

### Default uniqueness

A unique default configuration per $\text{uiHash}$, derived from the descriptors. Not stored as an ordinary preset.

### Trajectory linearity

The log is a linear sequence. No branching, no tree.

### Non-destructiveness

Neither navigation (cursor) nor modification from a detached cursor deletes events. The only cause of loss is FIFO eviction beyond capacity.

### Library monotonic growth

As long as a session $S$ lives, the library viewed from $S$ never loses an entry; it can only gain. The workspace is the union of the libraries of the live sessions.

### Recall determinism

Recalling the same preset twice applies the same configuration twice.

### Snap idempotence

When the center of the 2D canvas is exactly at the position $p_i$ of a
preset (zero distance), then $\psi(\text{center}) = c_i$ exactly. No
approximation by interpolation at the preset points. This invariant
is guaranteed numerically by the Shepard short-circuit at $d = 0$; there
is no longer an $r_{\text{inner}}$ zone — the transition is continuous everywhere
else.

### Single source of truth

The **parameter values** are the source of truth for the entire UI. Levels 0 (parameter orbit-ui) and 1 (preset orbit-ui) both read and write into this shared source. The visual positions of both levels (parameters for level 0, center $C$ for both levels) are derived quantities kept consistent. Direct corollary: toggling a calque introduces no discontinuity, because it does not move the source of truth.

### Full derivation of the level-1 layout

The layout of the level-1 calque — 2D positions of the presets, projection axes — is **entirely derived** from the current library via the weighted PCA. No manual adjustment, no hidden state, no separate persistence. When the library evolves (new presets, `lastSeenAt` updated), the layout recomputes.

Consequence: the map always reflects the current state of the data, and two users (or the same one at two moments) having the same library have the same map.

## Three concerns : MVP summary

| Concern | MVP choice |
|---|---|
| **Production** (trajectory) | Append to the log at each gesture commit |
| **Production** (library) | Automatic promotion after $X$ seconds of dwell during active playback, effect not bypassed. Suspended as long as the level-1 calque is open (the user then manages the library by hand). |
| **Manual production** | Right-click on the cross → "Add preset" → save of $\psi(\text{center})$ as a preset, anchored to the visual position of the cross (or bump of `lastSeenAt` if the same content already exists). A **session-local** anchor override guarantees that the new disc appears exactly under the cross, independently of what the PCA would have projected for that config. |
| **Naming** | Optional and controlled by the user: right-click on a preset → "Rename…", or double-click. A preset without a name has no label; a named preset appears with a golden disc and its name is displayed under the cross when it is exactly on it. Several presets can share the same name (collision admitted). Emptying the name deletes it. |
| **Level-1 navigation** | ←/→ glide the center toward the previous / next preset in `lastSeenAt` order, cyclic. The trajectory log cursor remains internal (used only by the detour appended on detached commit). |
| **Multi-selection** | Set ordered by insertion. Shift+click toggles; shift+drag rectangle adds additively |
| **Deletion** | Trash in the effect header: deletes all selected presets. Active only when calque open + selection non-empty |
| **Recall** | Two complementary paths: (a) level-1 center + unbounded Shepard — the calque exposes the entire library; (b) level-0 recall menu in the effect header — dropdown of named presets only, stable alphabetical sort, current item marked `✓`. |
| **Library dedup** | By content. Revisit of an existing preset updates `lastSeenAt` |
| **Trajectory capacity** | ≈ 500 events per instance, FIFO eviction |
| **Dwell threshold $X$** | 3 seconds as a first approximation, tunable |
| **2D projection** (preset level) | PCA weighted by recency ($\lambda = \ln 2 / 7\text{d}$), entirely derived from the library. No manual adjustment. Visual cluster spread for superposed presets. |
| **Interpolation** (preset level) | Unbounded Shepard $p = 2$: all presets always contribute, normalised contributions summing to 1, exact snap at the edge case $d = 0$ |
| **Follow mode** | Glide with $T_p$ seconds of portamento. $T_p = 0$ = instantaneous jump. Triggered by ←/→. |
| **Loop mode** | On the multi-selection (insertion order). Cycle duration $T_L$ exposed in BPM (1 cycle = 1 measure 4/4). Effective step $T_S = T_L / m$, constraint $T_p \leq T_S$, hot editing (the selection can change during the loop, the tempo remains fixed). ▶/■ button in the calque's bottom bar. |
| **Ease-in/out** | Linear by default ($\alpha(t) = t / T_p$). Refined curves in post-MVP |
| **Interruption** | Replacement: the new transition starts from the current interpolated position |

## Out of scope of this spec

- **Refined UI / feedback**: visual indicator of the active preset during
  the cycle, highlighting of the current target preset in loop mode,
  alternative keyboard shortcuts.
- **Pinning and hierarchical organisation**: marking certain presets as favorites, organising them into folders or collections. User renaming, however, is implemented (cf. §Canvas interactions and the Three concerns table).
- **Deletion of trajectory events**: deletion of presets from the library is implemented (trash on the multi-selection). Manual deletion of individual events from the trajectory log remains out of scope.
- **Inter-code compatibility**: detection of "near presets" for a modified code, application with controlled degradation.
- **Meta-level 2 (preset collections)**: recognised as a coherent extension of level 1 but explicitly postponed. We first gain experience with levels 0 (parameters) and 1 (presets) before adding it.
- **Refined ease curves**: ease-in/out, exponential, custom envelopes. Linear by default in the MVP.
- **Tempo synchronisation**: locking $T_L$ to the project BPM.
- **Multiple simultaneous loops**: several loops on the same instance or on different instances playing in concert.
- **External center driving** (MIDI / OSC / Web MIDI): position $(x, y)$ of the center of each canvas as an observable and drivable variable from the outside (physical controllers, inter-instance feedback, streaming recording/replay). Conceptual heritage from Interactors (Orlarey, 1980s), which exposed every command in MIDI input and output.
- **Procedural trajectory sources**: DSL allowing the generation of paths in the canvas by description (modern equivalent of the Logo turtle integrated into Interactors by Stéphane Letz). The trajectory becomes a program; it can trigger transitions, compose with preset loops, or generate geometric patterns in the parameter space.
- **Implementation**: IndexedDB schema, integration with project autosave and undo, serialisation of trajectories in session archives.

These points will be treated separately once the vocabulary is fixed.
