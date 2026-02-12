import { FaustOrbitUI } from '../dist/index.js';

async function main() {
  const root = document.getElementById('orbit-root');
  if (!root) throw new Error('Missing #orbit-root');

  const ui = await fetch('./ui.json').then((r) => {
    if (!r.ok) throw new Error(`Failed to load ui.json (${r.status})`);
    return r.json();
  });

  const orbit = new FaustOrbitUI(
    root,
    (path, value) => {
      // Demo callback (host side): receive UI changes and print them.
      console.log('[faust-orbit-ui demo] paramChangeByUI', { path, value });
    },
    {
      title: 'Orbit Demo',
      tooltips: {
        centerButton: 'Re-center controls and outer radius to defaults',
        randomButton: 'Randomize enabled controls',
        randomMix: 'Mix between current and random values',
        zoomSelect: 'Canvas zoom',
        hintSlider: 'Drag to edit value',
        hintCenter: 'Drag to move center',
        hintOuter: 'Drag to resize outer radius'
      }
    }
  );

  const initialState = orbit.buildControlsFromUnknown(ui);
  orbit.setOrbitState(initialState);
}

main().catch((error) => {
  console.error(error);
});
