# Public API of the Faust Orbit UI component

## Scope

This document describes the **public API** that the *Faust Orbit UI* component exposes to its host. It is derived directly from [DATAMODEL.md](DATAMODEL.md) and strictly applies the conceptual boundary defined there: the only thing the component knows about the Faust DSP is its parameter signature.

The API is deliberately minimal and **synchronous**. The component has no notion of persistence: it always starts with an empty state, exposes its internally computed `uiHash`, accepts **setters** to push state in (initial state after reading from the store, or later for cross-instance sync), emits **events** when its state changes, and lets the host decide what to do with them (persist, broadcast, ignore).

The pattern is therefore: **empty construction + setters to push state + outgoing events + setters for incoming sync**. No adapter, no Promises, no subscribe / unsubscribe, no exposed hash utility.

## Constructor

```typescript
new OrbitUI(container: HTMLElement, options: OrbitUIOptions): OrbitUI;
```

`container` is the DOM element that hosts the component. Since v0.4.0, the component **attaches a shadow root** to `container` and renders all of its DOM inside it (canvas, header, detail panel, calque, dropdowns). This isolation guarantees that the host's stylesheets do not affect the component's rendering, and vice versa.

The host can still interact with `container` from the outside:
- the `.orbit-ui-root` class is added to the `container` at construction,
- the `.orbit-ui-overlay-active` class is mirror-toggled on `container` when the calque opens / closes (so a Cmd+Z router can detect the state via `container.classList.contains('orbit-ui-overlay-active')` without having to penetrate the shadow).

Visual theming now goes through **CSS custom properties** declared at the `:host` scope — see [Theming](#theming) below.

## Public properties

```typescript
class OrbitUI {
  /** Hash of the UI signature, computed by the component at construction.
   *  The host can read it to key its store and then push the initial
   *  state via the setters. */
  readonly uiHash: string;
}
```

The hash algorithm lives exclusively inside the component: no utility to export, no risk of divergence. The host computes nothing — it reads `orbit.uiHash` after construction.

## Construction options

```typescript
type OrbitUIOptions = {
  /** Parsed Faust UI descriptor. Source of truth for the parameter signature. */
  uiDescriptor: FaustUIDescriptor;

  /** Notified on every parameter change triggered by the user (knob drag,
   *  preset recall, etc.). The host propagates it to the audio runtime. */
  onParamChange: (path: string, value: number) => void;

  /** Optional — gesture bracketing for host-side autosave / undo. */
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;

  /** Outgoing events: the component signals that it has mutated its state.
   *  The host decides what to do (persist, broadcast to other instances,
   *  ignore). The payload contains the full up-to-date state; the
   *  component does not handle the diff. */
  onLibraryChange?: (records: Preset[]) => void;
  onTrajectoryChange?: (record: TrajectoryRecord) => void;
  onSelectionChange?: (entries: SelectionEntry[]) => void;
  onLoopSettingsChange?: (settings: LoopSettings) => void;

  /** Optional semantic event — useful for analytics, external badges,
   *  status. Does not replace the `on*Change` events, which remain the
   *  canonical source of mutations. */
  onCommit?: (configuration: Readonly<Record<string, number>>) => void;

  /** Forwarded to the internal FaustOrbitUI (bare renderer).
   *
   *  `tooltips` — tooltip strings injected on the toolbar buttons
   *  (Center / Random / Zoom / hints). Lets the host localize the
   *  labels without touching the component.
   *
   *  `onOrbitStateChange` — fires on every mutation of the renderer's
   *  visual state (parameter positions, zoom, center movement). Useful
   *  for hosts that persist orbital state cross-session or sync it to
   *  a remote backend. Distinct from the `on*Change` events above,
   *  which concern logical state (library, trajectory, selection,
   *  loop) rather than visual layout. */
  tooltips?: {
    centerButton?: string;
    randomButton?: string;
    randomMix?: string;
    zoomSelect?: string;
    hintSlider?: string;
    hintCenter?: string;
    hintOuter?: string;
  };
  onOrbitStateChange?: (state: OrbitState) => void;
};
```

## Types of exchanged data

```typescript
type Preset = {
  uiHash: string;
  configHash: string;
  /** Present → named preset (pinned, permanent). Absent → anonymous,
   *  subject to FIFO eviction. */
  name?: string;
  /** Updated on each commit of this configuration by any instance.
   *  Used to compute the weight in the PCA projection (exponential
   *  decay) and the order of center-step navigation. */
  lastSeenAt: number;
  configuration: Readonly<Record<string, number>>;
};

type SelectionEntry = {
  /** Position in insertion order. The selection is an ordered list;
   *  loop mode iterates according to this order. */
  position: number;
  uiHash: string;
  configHash: string;
};

type LoopSettings = {
  bpm: number;
  transitionTimeMs: number;
  transitionLevel: 0 | 1;
};

type TrajectoryRecord = {
  /** Hash of the UI signature this log refers to. Used by the
   *  component to validate that a `setTrajectory(record)` actually
   *  matches its current signature (otherwise it is ignored — the
   *  signature has changed, the log is no longer interpretable in
   *  the same frame). */
  uiHash: string;
  events: TrajectoryEvent[];
  headIndex: number;
  cursorIndex: number;
  updatedAt: number;
};

type TrajectoryEvent = {
  timestampMs: number;
  configuration: Readonly<Record<string, number>>;
  transitionTimeMs?: number;
  transitionLevel?: 0 | 1;
  loopContext?: string;
};
```

## Public methods

```typescript
class OrbitUI {
  /** Forces a parameter state. Used by the host to sync from the Faust
   *  runtime (e.g. after compilation and restoration of saved values).
   *  Does not trigger onParamChange. */
  setParams(config: Readonly<Record<string, number>>): void;

  /** Replaces the entire library. Used for cross-instance sync: when
   *  another orbit-ui with the same uiHash has modified its library,
   *  the host pushes the new version here. Does not trigger
   *  onLibraryChange. */
  setLibrary(records: Preset[]): void;

  /** Replaces the entire trajectory. Rare in practice (the trajectory
   *  is instance-specific), but useful for restoring after a reload or
   *  for migration cases. Does not trigger onTrajectoryChange. */
  setTrajectory(record: TrajectoryRecord): void;

  /** Replaces the full multi-selection (cross-instance sync).
   *  Does not trigger onSelectionChange. */
  setSelection(entries: SelectionEntry[]): void;

  /** Replaces the loop parameters (tempo, transition).
   *  Does not trigger onLoopSettingsChange. */
  setLoopSettings(settings: LoopSettings): void;

  /** Reads the current loop parameters back. The host typically uses
   *  this when persisting settings (paired with `onLoopSettingsChange`
   *  for the live stream of edits). */
  getLoopSettings(): LoopSettings;

  /** Suspends or resumes the dwell-based auto-promotion (PRESETSPEC §
   *  "Memoisation"). Hosts call this to gate promotion on external
   *  signals : audio paused, effect bypassed, the user explicitly
   *  pinned the current state. The component already gates
   *  promotion on its own signals (calque open, gesture in flight). */
  setPromotionSuspended(suspended: boolean): void;

  /** Attempts to undo the most recent library operation.
   *  Returns true if an op was undone, false if the stack was empty. */
  undoLibrary(): boolean;
  redoLibrary(): boolean;

  /** Attempts to undo the last parameter commit. */
  undoParams(): boolean;
  redoParams(): boolean;

  /** Detaches the component: removes DOM listeners, releases caches.
   *  Also empties the shadow root so that a reconstruction on the
   *  same container does not stack duplicate `<style>` elements.
   *  To be called before removing the container from the DOM. */
  destroy(): void;

  // ----- Delegators to the internal renderer (FaustOrbitUI) -----
  // Surface reserved for hosts that need to manipulate the
  // bare-renderer layer: cross-session visual-state snapshot, remote
  // sync of the orbital layout, batching of updates.

  /** Re-measures the container and redraws. The wrapper installs its
   *  own ResizeObserver — calling explicitly is useful after a layout
   *  mutation that the browser does not capture. */
  resize(): void;

  /** Current zoom level as exposed by the selector. */
  getZoom(): number;

  /** Suspends / resumes `onOrbitStateChange` emissions during a batch
   *  of mutations. Must be paired — every `beginUpdate` must be
   *  followed by an `endUpdate`. Inherited from `FaustUICore`. */
  beginUpdate(): void;
  endUpdate(): void;

  /** Builds a fresh OrbitState from a Faust UI descriptor, without
   *  applying it. Typical host use: seed-then-merge with a persisted
   *  snapshot before `setOrbitState`. */
  buildControlsFromUnknown(input: unknown): OrbitState;

  /** Full snapshot of the renderer's visual state (parameter
   *  positions, zoom, etc.). For cross-session persistence or remote
   *  sync. */
  getOrbitState(): OrbitState;
  setOrbitState(state: OrbitState): void;

  /** `<div>` element that contains the canvas in the shadow root.
   *  Hosts that need to measure its dimensions (layout recovery,
   *  diagnostics) read it via this getter. */
  readonly body: HTMLDivElement;
}
```

### Return convention for `undo*` / `redo*`

Returns a `boolean`:
- `true` — an operation was undone / redone; the host considers the keystroke consumed.
- `false` — the stack was empty.

The host uses this return value to decide whether to fall through to the parent scope.

### Convention: setters do not trigger events

`setParams`, `setLibrary`, `setTrajectory`, `setSelection`, `setLoopSettings` **do not trigger** the corresponding outgoing events. These methods are the **incoming** synchronization tool; emitting an event in response would create feedback loops (host listens → persists → notifies other instances → setLibrary → if event re-emitted → host persists again, etc.).

### Effect of setters on the undo / redo stacks

When the host calls a setter, the state changes externally to the component. The corresponding undo / redo stacks no longer represent a coherent history and are **cleared**:

| Setter | Stack cleared |
|---|---|
| `setParams` | params stack (undo / redo) |
| `setLibrary` | library stack (undo / redo) |

For setters that have no dedicated stack (`setTrajectory`, `setSelection`, `setLoopSettings`), there is nothing to clear.

### Events emitted by undo / redo

Unlike setters, the undo / redo methods modify the state **from inside** the component; the corresponding events are therefore emitted so that the host can persist and synchronize to other instances.

| Method | Emits | Does not emit |
|---|---|---|
| `undoLibrary` / `redoLibrary` | `onLibraryChange(records)` | — |
| `undoParams` / `redoParams` | `onParamChange(path, value)` for each param that changes | `onCommit`, `onTrajectoryChange` |

The distinction for `undoParams` is justified as follows: `onParamChange` does not identify a user gesture but signals that a parameter has changed and must be propagated to the DSP — its cause (drag, recall, undo) is irrelevant. Conversely, `onCommit` and `onTrajectoryChange` are specific to recording a commit in the history; an undo/redo does not create a new historical event, it restores a previously committed state.

## Theming

The wrapper renders inside a shadow root, so the host's CSS selectors (`.orbit-center-btn { … }`) **do not reach** the internal elements. Visual theming goes through **CSS custom properties** declared at the `:host` scope — they cross the shadow boundary by design.

The host overrides them on the container element it passes to `new OrbitUI(...)`:

```css
#orbit-root {
  --orbit-bg: #0a1018;
  --orbit-pill-bg: rgba(255, 255, 255, 0.06);
  --orbit-accent-bg: #5b9bd5;
}
```

| Custom property | Role |
|---|---|
| `--orbit-bg` | Canvas / main body background |
| `--orbit-toolbar-bg` | Top toolbar + bottom detail panel background |
| `--orbit-toolbar-line` | Separator lines + slider rail |
| `--orbit-pill-bg` | Pill background (Center / Random / Zoom / Library / Trash / value box) |
| `--orbit-pill-border` | Pill border |
| `--orbit-pill-hover-bg` | Pill hover background |
| `--orbit-fg` | Pill text, slider thumb, displayed values |
| `--orbit-fg-muted` | Secondary labels (BPM, ms, …) |
| `--orbit-accent-bg` | Active / pressed pill background (Library when calque is open) |
| `--orbit-accent-fg` | Active pill text |
| `--orbit-accent-border` | Active pill border |

The default values produce the dark palette visible in the demo. Hosts that want to stay close to their design system override whatever they want.

Surfaces that are not currently themable (preset disc colors on the calque, amber selection ring, etc.) remain hard-coded in the canvas — they cannot be driven via CSS. They may be added to the theming surface if the need arises.

## Cmd+Z routing (host-side)

The host is responsible for global Cmd+Z routing. When focus is in the orbit-ui zone, it calls the component's methods.

```typescript
window.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
  if (event.repeat) return;

  const isRedo = event.shiftKey;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return;

  const root = focused.closest(".orbit-ui-root");
  if (!root) return;  // outside the orbit zone — fall-through

  // The wrapper toggles `.orbit-ui-overlay-active` on the container itself
  // when the calque opens — detectable from outside the shadow.
  const calqueOpen = root.classList.contains("orbit-ui-overlay-active");
  event.preventDefault();
  event.stopPropagation();
  if (calqueOpen) {
    if (isRedo) orbit.redoLibrary(); else orbit.undoLibrary();
  } else {
    if (isRedo) orbit.redoParams(); else orbit.undoParams();
  }
});
```

The component guarantees two CSS classes on the `container` (host element):
- `.orbit-ui-root` — added at construction.
- `.orbit-ui-overlay-active` — toggled when the calque opens / closes. Detectable via `container.classList.contains(...)` (not via `querySelector` — the shadow boundary cannot be crossed).

## Usage patterns

### Pattern 1 — without persistence (sandbox, demo)

```typescript
const orbit = new OrbitUI(container, {
  uiDescriptor: runtime.ui,
  onParamChange: (path, value) => node.setParamValue(path, value),
});

orbit.setParams({ "/reverb/wet": 0.4 });
```

The component runs at full capacity: calque, auto-promotion, undo, recall menu are all functional. The library and trajectory live in memory and disappear on reload.

### Pattern 2 — with IDB persistence

```typescript
async function mountOrbitUI(container, runtime, sessionId, instanceId) {
  const orbit = new OrbitUI(container, {
    uiDescriptor: runtime.ui,
    onParamChange: (path, value) => runtime.node.setParamValue(path, value),

    onLibraryChange: async (records) => {
      await idb.saveLibrary(orbit.uiHash, records);
      libraryChannel.postMessage({ type: "library", uiHash: orbit.uiHash });
    },
    onTrajectoryChange: async (record) => {
      await idb.saveTrajectory(sessionId, instanceId, record);
    },
    onSelectionChange: async (entries) => {
      await idb.saveSelection(sessionId, instanceId, entries);
    },
    onLoopSettingsChange: async (settings) => {
      await idb.saveLoopSettings(sessionId, instanceId, settings);
    },
  });

  // The component has computed its uiHash. We read our store and push.
  const [library, trajectory, selection, loopSettings] = await Promise.all([
    idb.loadLibrary(orbit.uiHash),
    idb.loadTrajectory(sessionId, instanceId),
    idb.loadSelection(sessionId, instanceId),
    idb.loadLoopSettings(sessionId, instanceId),
  ]);
  if (library) orbit.setLibrary(library);
  if (trajectory) orbit.setTrajectory(trajectory);
  if (selection) orbit.setSelection(selection);
  if (loopSettings) orbit.setLoopSettings(loopSettings);

  // Cross-instance sync: if another instance modifies the library,
  // we reload from IDB and push to the component.
  libraryChannel.addEventListener("message", async (msg) => {
    if (msg.data.type === "library" && msg.data.uiHash === orbit.uiHash) {
      orbit.setLibrary(await idb.loadLibrary(orbit.uiHash));
    }
  });

  return orbit;
}
```

The host handles persistence, keying by `(sessionId, instanceId)`, and cross-instance sync. The component knows nothing about it — it just receives / emits opaque `TrajectoryRecord` values.

### Pattern 3 — multiple instances, same uiHash

When two distinct orbit-ui instances share the same signature, each manages its own state independently. Synchronization goes through the host (BroadcastChannel, IDB observer, etc.), which calls `setLibrary` on each instance after a mutation by another.

```typescript
const o1 = await mountOrbitUI(container1, runtime1, sessionId, "fx-1");
const o2 = await mountOrbitUI(container2, runtime1, sessionId, "fx-2"); // same runtime, hence same uiHash

// If the user saves a preset in o1, the onLibraryChange event is
// emitted. mountOrbitUI persists to IDB and broadcasts. o2 receives
// the broadcast, reloads from IDB, and calls setLibrary — its
// library is synchronized.
```

## Error conventions

The component itself is synchronous and does not throw errors on the public API. Errors on the **host** side (IDB write failure in `onLibraryChange`, etc.) are its responsibility — it can catch them in its callback and handle them however it wants (retry, UI status, log).

If the host calls a setter with an invalid state (e.g. a malformed `Preset`, a `TrajectoryRecord` whose `uiHash` does not match the current signature, etc.), the component silently filters / ignores rather than throwing, so as not to crash the app.

## Lifecycle

```
┌─ The host compiles the Faust effect → obtains runtime.ui
│
├─ new OrbitUI(container, { uiDescriptor, …, onLibraryChange })
│   • the component computes uiHash (from runtime.ui), exposed via orbit.uiHash
│   • it starts with empty library / trajectory / selection / loopSettings
│   • it renders canvas + header + detail
│
├─ The host reads its store using orbit.uiHash and pushes the state:
│   • orbit.setLibrary(records)
│   • orbit.setTrajectory(record)
│   • orbit.setSelection(entries)
│   • orbit.setLoopSettings(settings)
│   (these setters do not trigger outgoing events)
│
├─ Usage loop:
│   • drags → onParamChange → host node.setParamValue
│   • commits → onCommit, onTrajectoryChange (host persists), auto-promotion
│   • promotion → onLibraryChange (host persists + broadcasts)
│   • broadcast from another instance → host calls setLibrary(records)
│   • Cmd+Z in the calque → host calls orbit.undoLibrary() → if it
│     returns true, the event is consumed; otherwise fall-through to
│     the parent scope
│
└─ orbit.destroy()
    • removes DOM listeners
    • clears internal caches
```

## What is NOT in the API

These concepts are deliberately absent in order to respect the boundary:

- **No host-side calque control** (no `showOverlay`, `selectPreset`). The calque is fully driven by the user via the internal controls.
- **No access to internal undos** beyond the `undo*` / `redo*` methods. The host cannot inspect the stack, nor push ops onto it.
- **No library CRUD method** from the host (`addPreset`, `deletePreset`). All library mutations are internal to the component; the host sees them via `onLibraryChange`.
- **No manipulation of the UI signature** after construction. If the signature changes, the host destroys the instance and creates a new one.
- **No internal persistence**. The component does not know whether IDB exists. The host listens to events and does whatever it wants.

## Out of scope

- **Exact format of `FaustUIDescriptor`** — defined by the Faust project.
- **Algorithm for computing `uiHash` and `configHash`** — deterministic, defined internally.
- **The host's IDB storage schema** — the host's business.
- **Cross-instance synchronization mechanism** — host's choice (BroadcastChannel, polling, WebSocket, etc.).
- **PCA / Shepard / interpolation projection algorithms** — covered by PRESETSPEC.
- **Global Cmd+Z routing** — host's decision.
