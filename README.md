# faust-orbit-ui

Orbit-style UI renderer for Faust-like UI JSON.

## CSS

The package exposes a stylesheet for Orbit layout and controls:

- `faust-orbit-ui/faust-orbit-ui.css`

In browser demos without bundler, you can include:

```html
<link rel="stylesheet" href="../dist/faust-orbit-ui.css" />
```

## Development

Build package:

```bash
npm --prefix packages/faust-orbit-ui run build
```

Run demo server (package root) on `http://localhost:4173`:

```bash
npm --prefix packages/faust-orbit-ui run demo:serve
```

Then open:

- `http://localhost:4173/demo/index.html`

## Demo layout convention

- `demo/`: browser demo app (`index.html`, `main.js`, sample `ui.json`)
- `src/`: package source
- `dist/`: built output

This keeps examples close to the package while keeping production code in `src/`.
