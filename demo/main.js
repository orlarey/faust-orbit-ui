import { OrbitUI, computeConfigHashSync } from '../dist/index.js';

async function main() {
  const root = document.getElementById('orbit-root');
  const eventsLog = document.getElementById('events-log');
  if (!root || !eventsLog) throw new Error('demo: missing DOM hooks');

  const ui = await fetch('./ui.json').then((r) => {
    if (!r.ok) throw new Error(`Failed to load ui.json (${r.status})`);
    return r.json();
  });

  const log = (tag, text) => {
    const div = document.createElement('div');
    div.className = 'event';
    const tagSpan = document.createElement('span');
    tagSpan.className = `tag tag-${tag}`;
    tagSpan.textContent = tag;
    div.appendChild(tagSpan);
    div.appendChild(document.createTextNode(text));
    eventsLog.prepend(div);
    // Keep the log bounded so it doesn't grow forever.
    while (eventsLog.childElementCount > 200) {
      eventsLog.lastElementChild?.remove();
    }
  };

  // Throttle param-change logs so dragging doesn't drown the log.
  let paramThrottle = 0;
  const orbit = new OrbitUI(root, {
    uiDescriptor: ui,
    onParamChange: (path, value) => {
      const now = performance.now();
      if (now - paramThrottle < 80) return;
      paramThrottle = now;
      log('param', `${path} = ${value.toFixed(3)}`);
    },
    onLibraryChange: (records) => {
      log('library', `count=${records.length} (${records.filter((r) => r.name).length} named)`);
    },
    onSelectionChange: (entries) => {
      log('selection', `count=${entries.length}`);
    },
    onCommit: (cfg) => {
      const summary = Object.entries(cfg)
        .map(([k, v]) => `${k.split('/').pop()}=${v.toFixed(2)}`)
        .join(' ');
      log('commit', summary);
    },
    onTrajectoryChange: (record) => {
      log('trajectory', `events=${record.events.length} head=${record.headIndex}`);
    },
  });

  log('library', `uiHash=${orbit.uiHash.slice(0, 12)}…`);

  // Seed a small library so the calque shows something interactive on first
  // open. lastSeenAt is staggered by 1 day per entry so the projection has
  // a non-uniform weighting.
  const dayMs = 24 * 3600 * 1000;
  const now = Date.now();
  const seeds = [
    { configuration: { '/synth/frequency': 220, '/synth/pressure': 0.30, '/synth/brightness': 0.20 }, name: 'low warm', age: 0 },
    { configuration: { '/synth/frequency': 440, '/synth/pressure': 0.50, '/synth/brightness': 0.50 }, age: 1 },
    { configuration: { '/synth/frequency': 660, '/synth/pressure': 0.65, '/synth/brightness': 0.70 }, name: 'bright', age: 2 },
    { configuration: { '/synth/frequency': 880, '/synth/pressure': 0.80, '/synth/brightness': 0.85 }, age: 3 },
    { configuration: { '/synth/frequency': 110, '/synth/pressure': 0.20, '/synth/brightness': 0.10 }, age: 5 },
    { configuration: { '/synth/frequency': 1320, '/synth/pressure': 0.40, '/synth/brightness': 0.95 }, age: 7 },
    { configuration: { '/synth/frequency': 330, '/synth/pressure': 0.70, '/synth/brightness': 0.40 }, age: 4 },
  ];
  const presets = seeds.map((s) => ({
    uiHash: orbit.uiHash,
    configHash: computeConfigHashSync(s.configuration),
    configuration: s.configuration,
    lastSeenAt: now - s.age * dayMs,
    ...(s.name ? { name: s.name } : {}),
  }));
  orbit.setLibrary(presets);
  log('library', `seeded ${presets.length} presets`);

  // Wire global Cmd+Z routing so the host-side undo contract works in the
  // demo too. Per ORBITUIAPISPEC.md: focused .orbit-ui-overlay-active →
  // library scope; focused .orbit-ui-root → param scope.
  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() !== 'z') return;
    if (event.repeat) return;
    const isRedo = event.shiftKey;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    if (!focused.closest('.orbit-ui-root')) return;
    // Route on calque visibility, not focus. The user might click a
    // toolbar control (trash, recall menu, …) which moves focus away
    // from the overlay; we still want library-undo while the calque
    // is open. The `.orbit-ui-overlay-active` class is the spec's
    // intended signal — present iff the calque is open.
    const calqueOpen = !!root.querySelector('.orbit-ui-overlay-active');
    event.preventDefault();
    if (calqueOpen) {
      const consumed = isRedo ? orbit.redoLibrary() : orbit.undoLibrary();
      log('library', isRedo ? `redo: ${consumed}` : `undo: ${consumed}`);
    } else {
      const consumed = isRedo ? orbit.redoParams() : orbit.undoParams();
      log('param', isRedo ? `redo: ${consumed}` : `undo: ${consumed}`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  const log = document.getElementById('events-log');
  if (log) {
    const div = document.createElement('div');
    div.className = 'event';
    div.style.color = '#ff8a8a';
    div.textContent = `ERROR: ${error?.message ?? String(error)}\n${error?.stack ?? ''}`;
    log.prepend(div);
  }
});

// Catch top-level errors (e.g., import resolution failures) too.
window.addEventListener('error', (e) => {
  const log = document.getElementById('events-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'event';
  div.style.color = '#ff8a8a';
  div.textContent = `WINDOW ERROR: ${e.message} at ${e.filename}:${e.lineno}`;
  log.prepend(div);
});
