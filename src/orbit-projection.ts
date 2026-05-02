/**
 * Pure-math module that computes the niveau-1 2D projection of a preset
 * library via weighted PCA, and projects individual configurations into the
 * resulting plane. Mirrors the « Projection π » section of PRESETSPEC.md.
 *
 * Build normalized vectors in parameter space (each coordinate rescaled to
 * [0, 1] via paramSpecs.min/max so disparate ranges don't dominate the
 * covariance), weight each preset by `exp(-λ·age)` with a 7-day half-life,
 * compute the weighted covariance, then extract the top two eigenvectors by
 * power iteration + deflation. Stateless and deterministic.
 */
import type { Preset } from './orbit-types.js';

export type ParamSpec = {
  readonly address: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
};

export type ProjectionKind = 'empty' | 'single' | 'oneD' | 'full';

export type Projection = {
  readonly kind: ProjectionKind;
  readonly centroid: ReadonlyArray<number>;
  readonly u1: ReadonlyArray<number>;
  readonly u2: ReadonlyArray<number>;
  readonly paramSpecs: ReadonlyArray<ParamSpec>;
};

const HALF_LIFE_MS = 7 * 24 * 3600 * 1000;
const LAMBDA = Math.LN2 / HALF_LIFE_MS;

const FAUST_INPUT_WIDGET_TYPES = new Set([
  'hslider', 'vslider', 'nentry', 'button', 'checkbox',
]);
const FAUST_GROUP_TYPES = new Set(['vgroup', 'hgroup', 'tgroup']);

/**
 * Walk the raw Faust UI descriptor and produce one ParamSpec per active
 * input widget. Mirrors the walk done in `orbit-hash.ts` but additionally
 * captures `init` for the projection's default-fill behaviour.
 */
export function extractParamSpecs(rawUI: unknown): ParamSpec[] {
  const out: ParamSpec[] = [];
  if (Array.isArray(rawUI)) {
    for (const node of rawUI) walkParamSpecs(node, out);
  }
  out.sort((a, b) => a.address.localeCompare(b.address));
  return out;
}

function walkParamSpecs(node: unknown, out: ParamSpec[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : '';
  if (FAUST_INPUT_WIDGET_TYPES.has(type)) {
    const address = typeof obj.address === 'string'
      ? obj.address
      : typeof obj.path === 'string'
        ? obj.path
        : '';
    if (!address) return;
    const min = Number.isFinite(obj.min) ? Number(obj.min) : 0;
    const max = Number.isFinite(obj.max) ? Number(obj.max) : 1;
    const init = Number.isFinite(obj.init) ? Number(obj.init) : min;
    out.push({ address, min, max, default: init });
    return;
  }
  if (FAUST_GROUP_TYPES.has(type) && Array.isArray(obj.items)) {
    for (const child of obj.items) walkParamSpecs(child, out);
  }
}

/**
 * Build the weighted PCA projection for a preset library. Degenerate cases
 * short-circuit before any covariance work: k=0 → empty, k=1 → single
 * (centroid only), k=2 → oneD. For k ≥ 3 we run power iteration twice on
 * the n × n weighted covariance matrix, deflating between runs.
 */
export function computeProjection(
  presets: ReadonlyArray<Preset>,
  paramSpecs: ReadonlyArray<ParamSpec>,
  now: number = Date.now(),
): Projection {
  const n = paramSpecs.length;
  const k = presets.length;

  if (k === 0 || n === 0) {
    return { kind: 'empty', centroid: zeros(n), u1: zeros(n), u2: zeros(n), paramSpecs };
  }

  const vectors = presets.map((p) => normalize(p.configuration, paramSpecs));
  const weights = presets.map((p) => Math.exp(-LAMBDA * Math.max(0, now - p.lastSeenAt)));
  const totalW = weights.reduce((s, w) => s + w, 0) || 1;

  const centroid = zeros(n);
  for (let i = 0; i < k; i += 1) {
    const w = weights[i] ?? 0;
    const v = vectors[i] ?? [];
    for (let j = 0; j < n; j += 1) {
      centroid[j] = (centroid[j] ?? 0) + w * (v[j] ?? 0);
    }
  }
  for (let j = 0; j < n; j += 1) centroid[j] = (centroid[j] ?? 0) / totalW;

  if (k === 1) {
    return { kind: 'single', centroid, u1: zeros(n), u2: zeros(n), paramSpecs };
  }

  const cov = covariance(vectors, weights, centroid, totalW);
  const u1 = powerIteration(cov);
  deflate(cov, u1);
  const u2 = k === 2 ? zeros(n) : powerIteration(cov);
  const kind = k === 2 ? 'oneD' : 'full';
  return { kind, centroid, u1, u2, paramSpecs };
}

/**
 * Project a configuration through an existing projection. Returns [0, 0]
 * when the projection is degenerate (single or empty).
 */
export function projectConfig(
  configuration: Readonly<Record<string, number>>,
  projection: Projection,
): readonly [number, number] {
  const vec = normalize(configuration, projection.paramSpecs);
  let x = 0;
  let y = 0;
  for (let i = 0; i < projection.centroid.length; i += 1) {
    const diff = (vec[i] ?? 0) - (projection.centroid[i] ?? 0);
    x += diff * (projection.u1[i] ?? 0);
    y += diff * (projection.u2[i] ?? 0);
  }
  return [x, y];
}

/**
 * Inverse mapping ψ : ℝ² → E — given a point in the 2D plane, return the
 * configuration the audio should currently play. Pure unbounded Shepard:
 * every preset always contributes, the share of preset i is `w_i / Σ w_j`
 * with `w_i = 1/d_i^p` (default p=2). The exact-zero distance is treated
 * as a numerical snap to avoid Infinity/Infinity = NaN.
 */
export function shepardInterpolate(
  center: readonly [number, number],
  presets: ReadonlyArray<Preset>,
  presetPositions: ReadonlyArray<readonly [number, number]>,
  paramSpecs: ReadonlyArray<ParamSpec>,
  p: number = 2,
): Record<string, number> {
  const distances: number[] = new Array(presets.length);
  for (let i = 0; i < presets.length; i += 1) {
    const pos = presetPositions[i];
    if (!pos) { distances[i] = Infinity; continue; }
    distances[i] = Math.hypot(center[0] - pos[0], center[1] - pos[1]);
  }

  for (let i = 0; i < presets.length; i += 1) {
    if (distances[i] === 0) {
      const preset = presets[i];
      if (preset) return projectionCompleteConfig(preset.configuration, paramSpecs);
    }
  }

  let wSum = 0;
  const accumulator: Record<string, number> = {};
  for (const spec of paramSpecs) accumulator[spec.address] = 0;
  for (let i = 0; i < presets.length; i += 1) {
    const d = distances[i] ?? Infinity;
    const preset = presets[i];
    if (!preset || !isFinite(d)) continue;
    const w = Math.pow(d, -p);
    wSum += w;
    for (const spec of paramSpecs) {
      accumulator[spec.address] =
        (accumulator[spec.address] ?? 0) + w * (preset.configuration[spec.address] ?? spec.default);
    }
  }

  if (wSum > 0) {
    for (const spec of paramSpecs) accumulator[spec.address] = (accumulator[spec.address] ?? 0) / wSum;
    return accumulator;
  }

  const result: Record<string, number> = {};
  for (const spec of paramSpecs) result[spec.address] = spec.default;
  return result;
}

function projectionCompleteConfig(
  source: Readonly<Record<string, number>>,
  paramSpecs: ReadonlyArray<ParamSpec>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const spec of paramSpecs) {
    result[spec.address] = source[spec.address] ?? spec.default;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeros(n: number): number[] {
  return Array.from({ length: n }, () => 0);
}

function normalize(
  config: Readonly<Record<string, number>>,
  paramSpecs: ReadonlyArray<ParamSpec>,
): number[] {
  const v = zeros(paramSpecs.length);
  for (let i = 0; i < paramSpecs.length; i += 1) {
    const spec = paramSpecs[i];
    if (!spec) continue;
    const raw = config[spec.address] ?? spec.default;
    const range = spec.max - spec.min;
    v[i] = range > 0 ? (raw - spec.min) / range : 0;
  }
  return v;
}

function covariance(
  vectors: ReadonlyArray<ReadonlyArray<number>>,
  weights: ReadonlyArray<number>,
  centroid: ReadonlyArray<number>,
  totalW: number,
): number[][] {
  const n = centroid.length;
  const cov: number[][] = Array.from({ length: n }, () => zeros(n));
  for (let i = 0; i < vectors.length; i += 1) {
    const w = weights[i] ?? 0;
    const vec = vectors[i] ?? [];
    const diff = zeros(n);
    for (let j = 0; j < n; j += 1) diff[j] = (vec[j] ?? 0) - (centroid[j] ?? 0);
    for (let a = 0; a < n; a += 1) {
      const wda = w * (diff[a] ?? 0);
      const rowA = cov[a];
      if (!rowA) continue;
      for (let b = a; b < n; b += 1) {
        const v = wda * (diff[b] ?? 0);
        rowA[b] = (rowA[b] ?? 0) + v;
        if (a !== b) {
          const rowB = cov[b];
          if (rowB) rowB[a] = (rowB[a] ?? 0) + v;
        }
      }
    }
  }
  for (let a = 0; a < n; a += 1) {
    const row = cov[a];
    if (!row) continue;
    for (let b = 0; b < n; b += 1) row[b] = (row[b] ?? 0) / totalW;
  }
  return cov;
}

function powerIteration(M: ReadonlyArray<ReadonlyArray<number>>, iters: number = 60, tol: number = 1e-10): number[] {
  const n = M.length;
  if (n === 0) return [];
  let v = zeros(n).map(() => 1);
  v = unit(v);
  for (let i = 0; i < iters; i += 1) {
    const next = unit(matMulVec(M, v));
    let converged = true;
    for (let j = 0; j < n; j += 1) {
      if (Math.abs((next[j] ?? 0) - (v[j] ?? 0)) >= tol) { converged = false; break; }
    }
    if (converged) return next;
    v = next;
  }
  return v;
}

function deflate(M: number[][], v: ReadonlyArray<number>): void {
  const Mv = matMulVec(M, v);
  let lambda = 0;
  for (let i = 0; i < v.length; i += 1) lambda += (v[i] ?? 0) * (Mv[i] ?? 0);
  for (let i = 0; i < M.length; i += 1) {
    const row = M[i];
    if (!row) continue;
    for (let j = 0; j < M.length; j += 1) {
      row[j] = (row[j] ?? 0) - lambda * (v[i] ?? 0) * (v[j] ?? 0);
    }
  }
}

function matMulVec(M: ReadonlyArray<ReadonlyArray<number>>, v: ReadonlyArray<number>): number[] {
  const n = M.length;
  const out = zeros(n);
  for (let i = 0; i < n; i += 1) {
    const row = M[i];
    if (!row) continue;
    let s = 0;
    for (let j = 0; j < n; j += 1) s += (row[j] ?? 0) * (v[j] ?? 0);
    out[i] = s;
  }
  return out;
}

function unit(v: ReadonlyArray<number>): number[] {
  let s = 0;
  for (const c of v) s += c * c;
  const norm = Math.sqrt(s);
  if (norm === 0) return v.slice();
  return v.map((c) => c / norm);
}
