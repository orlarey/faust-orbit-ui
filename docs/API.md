# API publique du composant Faust Orbit UI

## Cadrage

Ce document décrit l'**API publique** que le composant *Faust Orbit UI* expose à son hôte. Il est dérivé directement de [DATAMODEL.md](DATAMODEL.md) et applique strictement la frontière conceptuelle qui y est définie : le composant ne connaît du DSP Faust que sa signature paramètres.

L'API est volontairement minimale et **synchrone**. Le composant n'a pas de notion de persistance : il démarre toujours avec un état vide, expose son `uiHash` calculé en interne, accepte des **setters** pour pousser l'état (initial après lecture du store, ou plus tard pour la sync cross-instance), émet des **events** quand son état change, et laisse l'hôte décider quoi en faire (persister, broadcaster, ignorer).

Le pattern est donc : **construction vide + setters pour pousser l'état + events sortants + setters pour sync entrante**. Pas d'adapter, pas de Promises, pas de subscribe / unsubscribe, pas d'utilitaire de hash exposé.

## Constructeur

```typescript
new OrbitUI(container: HTMLElement, options: OrbitUIOptions): OrbitUI;
```

`container` est l'élément DOM qui héberge le composant. Le composant y crée son canvas, son header, son détail panel, et son calque.

## Propriétés publiques

```typescript
class OrbitUI {
  /** Hash de la signature UI, calculé par le composant à la construction.
   *  L'hôte peut le lire pour keyer son store et pousser ensuite l'état
   *  initial via les setters. */
  readonly uiHash: string;
}
```

L'algorithme de hash est exclusivement à l'intérieur du composant : pas d'utilitaire à exporter, pas de risque de divergence. L'hôte ne calcule rien — il lit `orbit.uiHash` après la construction.

## Options de construction

```typescript
type OrbitUIOptions = {
  /** Descripteur UI Faust parsé. Source de vérité pour la signature paramètres. */
  uiDescriptor: FaustUIDescriptor;

  /** Notifié à chaque changement de paramètre déclenché par l'utilisateur
   *  (drag d'un knob, recall d'un preset, etc.). L'hôte le propage au
   *  runtime audio. */
  onParamChange: (path: string, value: number) => void;

  /** Optionnels — bracketing de gesture pour autosave / undo de l'hôte. */
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;

  /** Events sortants : le composant signale qu'il a muté son état. L'hôte
   *  décide quoi faire (persister, broadcaster aux autres instances,
   *  ignorer). Le payload contient l'état complet à jour, le composant
   *  ne s'occupe pas du diff. */
  onLibraryChange?: (records: Preset[]) => void;
  onTrajectoryChange?: (record: TrajectoryRecord) => void;
  onSelectionChange?: (entries: SelectionEntry[]) => void;
  onLoopSettingsChange?: (settings: LoopSettings) => void;

  /** Events sémantiques optionnels — utiles pour analytics, badges
   *  externes, statut. Ne se substituent pas aux `on*Change` qui restent
   *  la source canonique des mutations. */
  onCommit?: (configuration: Readonly<Record<string, number>>) => void;
  onPresetActivated?: (record: Preset) => void;
};
```

## Types des données échangées

```typescript
type Preset = {
  uiHash: string;
  configHash: string;
  /** Présent → preset nommé (épinglé, permanent). Absent → anonyme,
   *  soumis à l'éviction FIFO. */
  name?: string;
  /** Mis à jour à chaque commit de cette configuration par n'importe
   *  quelle instance. Sert au calcul du poids dans la projection PCA
   *  (decay exponentiel) et à l'ordre de la navigation centre-step. */
  lastSeenAt: number;
  configuration: Readonly<Record<string, number>>;
};

type SelectionEntry = {
  /** Position dans l'ordre d'insertion. La sélection est une liste
   *  ordonnée ; le mode boucle parcourt selon cet ordre. */
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
  /** Hash de la signature UI à laquelle ce log se rapporte. Utilisé par
   *  le composant pour valider qu'un `setTrajectory(record)` correspond
   *  bien à sa signature courante (sinon il l'ignore — la signature a
   *  changé, le log n'est plus interprétable dans le même cadre). */
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

## Méthodes publiques

```typescript
class OrbitUI {
  /** Force un état des paramètres. Utilisé par l'hôte pour synchroniser
   *  depuis le runtime Faust (e.g. après compilation et restauration des
   *  valeurs sauvegardées). Ne déclenche pas onParamChange. */
  setParams(config: Readonly<Record<string, number>>): void;

  /** Remplace la library complète. Utilisé pour la sync cross-instance :
   *  quand une autre orbit-ui de même uiHash a modifié sa library, l'hôte
   *  pousse la nouvelle version ici. Ne déclenche pas onLibraryChange. */
  setLibrary(records: Preset[]): void;

  /** Remplace la trajectoire complète. Rare en pratique (la trajectoire
   *  est propre à l'instance), mais utile pour restaurer après un reload
   *  ou pour des cas de migration. Ne déclenche pas onTrajectoryChange. */
  setTrajectory(record: TrajectoryRecord): void;

  /** Remplace la sélection multi complète (sync cross-instance).
   *  Ne déclenche pas onSelectionChange. */
  setSelection(entries: SelectionEntry[]): void;

  /** Remplace les paramètres de boucle (tempo, transition).
   *  Ne déclenche pas onLoopSettingsChange. */
  setLoopSettings(settings: LoopSettings): void;

  /** Tente de défaire l'opération library la plus récente.
   *  Retourne true si une op a été défaite, false si la pile était vide. */
  undoLibrary(): boolean;
  redoLibrary(): boolean;

  /** Tente de défaire le dernier commit de paramètres. */
  undoParams(): boolean;
  redoParams(): boolean;

  /** Détache le composant : retire les listeners DOM, libère les caches.
   *  À appeler avant de retirer le container du DOM. */
  destroy(): void;
}
```

### Convention de retour pour `undo*` / `redo*`

Retourne un `boolean` :
- `true` — une opération a été défaite / refaite ; l'hôte considère le keystroke consommé.
- `false` — la pile était vide.

L'hôte utilise ce retour pour décider du fall-through au scope parent.

### Convention de non-déclenchement des events sur les setters

`setParams`, `setLibrary`, `setTrajectory`, `setSelection`, `setLoopSettings` **ne déclenchent pas** les events sortants correspondants. Ces méthodes sont l'outil de synchronisation **entrante** ; émettre un event en réponse créerait des boucles de rétroaction (l'hôte écoute → persiste → notifie d'autres instances → setLibrary → si event re-émis → l'hôte persiste à nouveau, etc.).

### Effet des setters sur les piles undo / redo

Quand l'hôte appelle un setter, l'état change de manière externe au composant. Les piles undo / redo correspondantes ne représentent plus un historique cohérent et sont **vidées** :

| Setter | Pile vidée |
|---|---|
| `setParams` | pile params (undo / redo) |
| `setLibrary` | pile library (undo / redo) |

Pour les setters qui n'ont pas de pile dédiée (`setTrajectory`, `setSelection`, `setLoopSettings`), il n'y a rien à vider.

### Events émis par les undo / redo

Contrairement aux setters, les méthodes undo / redo modifient l'état **depuis l'intérieur** du composant ; les events correspondants sont donc émis pour que l'hôte persiste et synchronise aux autres instances.

| Méthode | Émet | N'émet pas |
|---|---|---|
| `undoLibrary` / `redoLibrary` | `onLibraryChange(records)` | — |
| `undoParams` / `redoParams` | `onParamChange(path, value)` pour chaque param qui change | `onCommit`, `onTrajectoryChange` |

La distinction sur `undoParams` se justifie ainsi : `onParamChange` n'identifie pas un geste utilisateur mais signale qu'un paramètre a changé et doit être propagé au DSP — sa cause (drag, recall, undo) est indifférente. À l'inverse, `onCommit` et `onTrajectoryChange` sont propres à l'enregistrement d'un commit dans l'historique ; un undo/redo ne crée pas de nouvel event historique, il restaure un état antérieur déjà committé.

## Routage Cmd+Z par l'hôte

L'hôte est responsable du routage global Cmd+Z. Quand le focus est dans la zone d'orbit-ui, il appelle les méthodes du composant.

```typescript
window.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
  if (event.repeat) return;

  const isRedo = event.shiftKey;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return;

  if (focused.closest(".orbit-ui-overlay-active")) {
    event.preventDefault();
    event.stopPropagation();
    if (isRedo) orbit.redoLibrary(); else orbit.undoLibrary();
  } else if (focused.closest(".orbit-ui-root")) {
    event.preventDefault();
    event.stopPropagation();
    if (isRedo) orbit.redoParams(); else orbit.undoParams();
  }
  // sinon → fall-through aux scopes hôte (chain, project)
});
```

Le composant garantit deux classes CSS sur ses sous-éléments :
- `.orbit-ui-root` — le container racine.
- `.orbit-ui-overlay-active` — sur le calque quand il est ouvert.

## Patterns d'usage

### Pattern 1 — sans persistance (sandbox, démo)

```typescript
const orbit = new OrbitUI(container, {
  uiDescriptor: runtime.ui,
  onParamChange: (path, value) => node.setParamValue(path, value),
});

orbit.setParams({ "/reverb/wet": 0.4 });
```

Le composant tourne en plein régime : calque, auto-promotion, undo, recall menu sont tous fonctionnels. La library et la trajectoire vivent en mémoire et disparaissent au reload.

### Pattern 2 — avec persistance IDB

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

  // Le composant a calculé son uiHash. On lit notre store et on pousse.
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

  // Sync cross-instance : si une autre instance modifie la library, on
  // recharge depuis IDB et on pousse au composant.
  libraryChannel.addEventListener("message", async (msg) => {
    if (msg.data.type === "library" && msg.data.uiHash === orbit.uiHash) {
      orbit.setLibrary(await idb.loadLibrary(orbit.uiHash));
    }
  });

  return orbit;
}
```

L'hôte gère la persistance, le keying par `(sessionId, instanceId)`, et la sync cross-instance. Le composant n'en sait rien — il reçoit / émet juste des `TrajectoryRecord` opaques.

### Pattern 3 — plusieurs instances, même uiHash

Lorsqu'on a deux orbit-ui distincts qui partagent la même signature, chacun gère son état indépendamment. La synchronisation passe par l'hôte (BroadcastChannel, IDB observer, etc.) qui appelle `setLibrary` sur chaque instance après la mutation d'une autre.

```typescript
const o1 = await mountOrbitUI(container1, runtime1, sessionId, "fx-1");
const o2 = await mountOrbitUI(container2, runtime1, sessionId, "fx-2"); // même runtime, donc même uiHash

// Si l'utilisateur sauvegarde un preset dans o1, l'event onLibraryChange
// est émis. mountOrbitUI persiste en IDB et broadcast. o2 reçoit le
// broadcast, recharge depuis IDB, et appelle setLibrary — sa library
// est synchronisée.
```

## Convention d'erreurs

Le composant lui-même est synchrone et ne lève pas d'erreurs sur l'API publique. Les erreurs côté **hôte** (échec d'écriture IDB dans `onLibraryChange`, etc.) sont sa responsabilité — il peut les capturer dans son callback et les gérer comme il veut (retry, statut UI, log).

Si l'hôte appelle un setter avec un état invalide (par exemple un `Preset` mal formé, un `TrajectoryRecord` dont l'`uiHash` ne correspond pas à la signature courante, etc.), le composant filtre / ignore silencieusement plutôt que de jeter, pour ne pas crasher l'app.

## Cycle de vie

```
┌─ L'hôte compile l'effet Faust → obtient runtime.ui
│
├─ new OrbitUI(container, { uiDescriptor, …, onLibraryChange })
│   • le composant calcule uiHash (depuis runtime.ui), exposé via orbit.uiHash
│   • il démarre avec library / trajectoire / sélection / loopSettings vides
│   • il rend canvas + header + détail
│
├─ L'hôte lit son store en utilisant orbit.uiHash et pousse l'état :
│   • orbit.setLibrary(records)
│   • orbit.setTrajectory(record)
│   • orbit.setSelection(entries)
│   • orbit.setLoopSettings(settings)
│   (ces setters ne déclenchent pas les events sortants)
│
├─ Boucle d'usage :
│   • drags → onParamChange → host node.setParamValue
│   • commits → onCommit, onTrajectoryChange (host persists), auto-promotion
│   • promotion → onLibraryChange (host persists + broadcasts)
│   • broadcast d'une autre instance → host calls setLibrary(records)
│   • Cmd+Z dans le calque → host calls orbit.undoLibrary() → si retour
│     true, l'event est consommé ; sinon fall-through au scope parent
│
└─ orbit.destroy()
    • retire les listeners DOM
    • clear caches internes
```

## Ce qui n'est PAS dans l'API

Ces concepts sont volontairement absents pour respecter la frontière :

- **Pas de pilotage du calque** par l'hôte (pas de `showOverlay`, `selectPreset`). Le calque est entièrement piloté par l'utilisateur via les contrôles internes.
- **Pas d'accès aux undo internes** au-delà des méthodes `undo*` / `redo*`. L'hôte ne peut pas inspecter la pile, ni y pousser des ops.
- **Pas de méthode CRUD library** depuis l'hôte (`addPreset`, `deletePreset`). Toute mutation de la library est interne au composant ; l'hôte la voit via `onLibraryChange`.
- **Pas de manipulation de la signature UI** après construction. Si la signature change, l'hôte détruit l'instance et en crée une nouvelle.
- **Pas de persistance interne**. Le composant ne sait pas si IDB existe. L'hôte écoute les events et fait ce qu'il veut.

## Hors-scope de la spec

- **Format exact du `FaustUIDescriptor`** — défini par le projet Faust.
- **Algorithme de calcul de `uiHash` et `configHash`** — déterministe, défini en interne.
- **Schéma de stockage IDB de l'hôte** — l'affaire de l'hôte.
- **Mécanisme de synchronisation cross-instance** — choix de l'hôte (BroadcastChannel, polling, WebSocket, etc.).
- **Algorithmes de projection PCA / Shepard / interpolation** — couverts par PRESETSPEC.
- **Routage Cmd+Z global** — l'hôte décide.
