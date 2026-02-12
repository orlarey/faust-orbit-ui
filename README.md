# faust-orbit-ui

Orbit-based UI component for Faust-style parameter control, driven by JSON metadata and callbacks.

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Test

Current test is a build smoke test:

```bash
npm test
```

## Demo

Run demo server from repository root on `http://localhost:4173`:

```bash
npm run demo:serve
```

Then open:

- `http://localhost:4173/demo/index.html`

## CSS

The package exposes a stylesheet for Orbit layout and controls:

- `faust-orbit-ui/faust-orbit-ui.css`

In browser demos without bundler, you can include:

```html
<link rel="stylesheet" href="../dist/faust-orbit-ui.css" />
```

## Repository layout

- `src/`: package source
- `dist/`: build output
- `demo/`: browser demo app (`index.html`, `main.js`, sample `ui.json`)
