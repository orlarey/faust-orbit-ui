/**
 * Synchronous hash utilities for Orbit UI identity.
 *
 * `uiHash` and `configHash` are exposed synchronously by the OrbitUI component
 * (the spec requires `readonly uiHash: string`). The browser's `crypto.subtle`
 * API is async, so we ship a small synchronous SHA-256 implementation here.
 *
 * The algorithms (canonicalisation + hash) match exactly the async versions
 * previously used in webdaw's `preset-storage.ts`, so existing IDB data keyed
 * by uiHash / configHash remains valid after the migration.
 */

const FAUST_INPUT_WIDGET_TYPES = new Set([
  'hslider', 'vslider', 'nentry', 'button', 'checkbox',
]);
const FAUST_GROUP_TYPES = new Set(['vgroup', 'hgroup', 'tgroup']);

type UIHashItem = {
  path: string;
  type: string;
  min: number;
  max: number;
  step: number;
};

function extractUIHashItems(node: unknown, out: UIHashItem[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : '';
  if (FAUST_INPUT_WIDGET_TYPES.has(type)) {
    const path = typeof obj.address === 'string'
      ? obj.address
      : typeof obj.path === 'string'
        ? obj.path
        : '';
    if (!path) return;
    out.push({
      path,
      type,
      min: Number.isFinite(obj.min) ? Number(obj.min) : 0,
      max: Number.isFinite(obj.max) ? Number(obj.max) : 1,
      step: Number.isFinite(obj.step) ? Number(obj.step) : 0,
    });
    return;
  }
  if (FAUST_GROUP_TYPES.has(type) && Array.isArray(obj.items)) {
    for (const child of obj.items) extractUIHashItems(child, out);
  }
}

/**
 * Canonical UI hash: SHA-256 of the sorted, JSON-encoded list of input
 * widgets `{path, type, min, max, step}`. Labels are intentionally excluded.
 */
export function computeUIHashSync(rawUI: unknown): string {
  const items: UIHashItem[] = [];
  if (Array.isArray(rawUI)) {
    for (const node of rawUI) extractUIHashItems(node, items);
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  const canonical = JSON.stringify(items);
  return sha256Hex(utf8Encode(canonical));
}

/**
 * Canonical config hash: SHA-256 of the sorted [path, value] pairs.
 */
export function computeConfigHashSync(
  configuration: Readonly<Record<string, number>>,
): string {
  const sortedEntries = Object.keys(configuration)
    .sort()
    .map((key) => [key, configuration[key]] as const);
  const canonical = JSON.stringify(sortedEntries);
  return sha256Hex(utf8Encode(canonical));
}

// ---------------------------------------------------------------------------
// Synchronous SHA-256 (FIPS-180-4)
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function sha256Hex(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = (Math.floor((bytes.length + 9 + 63) / 64)) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // 64-bit big-endian length in bits. JS bit ops are 32-bit so split.
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      W[i] = view.getUint32(chunk + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = W[i - 15]!;
      const w2 = W[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[i] = ((W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0);
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!;
    let e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + W[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    hex += H[i]!.toString(16).padStart(8, '0');
  }
  return hex;
}
