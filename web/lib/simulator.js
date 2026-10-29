// Stitch simulator model (FS-8.2, FS-8.3; S6-08). Turns engine-neutral stitch data
// (05-digitizing-engine/stitch-data-format.md: absolute 0.1 mm, centred on the canvas) into flat
// arrays the renderer and the controls index by step.

const MACHINE_SPM = 700; // stitches per minute, for the "sewing time" estimate

/**
 * @param {object} data stitch data
 * @param {{ width: number, height: number }} canvas document canvas in mm (the origin is its centre)
 * @returns {{
 *   count: number, x: Float32Array, y: Float32Array, kind: Uint8Array, colour: Uint16Array,
 *   object: Int32Array, objectIds: string[], threads: string[], blocks: object[], stats: object
 * }} kind per step: 0 stitch, 1 jump, 2 trim, 3 colour change; object: index into objectIds or -1
 */
export function buildPlayback(data, canvas) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const commands = data.commands.filter((c) => c[0] !== 'end');
  const n = commands.length;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const kind = new Uint8Array(n);
  const colour = new Uint16Array(n);
  const object = new Int32Array(n).fill(-1);
  const KIND = { stitch: 0, jump: 1, trim: 2, color_change: 3 };

  const objectIds = [];
  for (const { objectId, fromCommand, toCommand } of data.objectMap ?? []) {
    const index = objectIds.push(objectId) - 1;
    for (let i = fromCommand; i <= Math.min(toCommand, n - 1); i++) object[i] = index;
  }

  let thread = 0;
  let px = cx;
  let py = cy;
  for (let i = 0; i < n; i++) {
    const [type, a, b] = commands[i];
    kind[i] = KIND[type] ?? 0;
    if (type === 'color_change') thread = a;
    if (type === 'stitch' || type === 'jump') {
      px = a / 10 + cx;
      py = b / 10 + cy;
    }
    // Trims and colour changes stay where the needle is.
    x[i] = px;
    y[i] = py;
    colour[i] = thread;
  }

  const threads = (data.threads ?? []).map((t) => t.hex);
  const blocks = [];
  for (let i = 0; i < n; i++) {
    const last = blocks[blocks.length - 1];
    if (!last || last.colour !== colour[i]) blocks.push({ colour: colour[i], from: i, to: i });
    else last.to = i;
  }
  let stitches = 0;
  let jumps = 0;
  let trims = 0;
  for (let i = 0; i < n; i++) {
    if (kind[i] === 0) stitches++;
    else if (kind[i] === 1) jumps++;
    else if (kind[i] === 2) trims++;
  }
  return {
    count: n,
    x,
    y,
    kind,
    colour,
    object,
    objectIds,
    threads,
    blocks,
    stats: { stitches, jumps, trims, colorChanges: Math.max(0, blocks.length - 1) },
  };
}

/** The next (dir 1) or previous (dir -1) step where `key` changes: an object or a colour. */
export function boundary(playback, at, dir, key) {
  const values = key === 'colour' ? playback.colour : playback.object;
  const last = playback.count - 1;
  if (dir > 0) {
    for (let i = at + 1; i <= last; i++) if (values[i] !== values[at]) return i;
    return last;
  }
  // Back: to the start of the current run, or of the previous run if already at its start.
  let i = Math.max(0, at);
  if (i > 0 && values[i - 1] !== values[i]) i--;
  while (i > 0 && values[i - 1] === values[i]) i--;
  return i;
}

/** Steps to advance in `ms` at `perSecond`, keeping the fraction for the next frame. */
export function advance(carry, ms, perSecond) {
  const total = carry + (ms / 1000) * perSecond;
  const steps = Math.floor(total);
  return { steps, carry: total - steps };
}

/** Logarithmic speed slider: position 0..1 → 1..1000 stitches per second (FS-8.2). */
export const speedAt = (position) => Math.round(10 ** (Math.min(1, Math.max(0, position)) * 3));
export const positionOf = (speed) => Math.log10(Math.min(1000, Math.max(1, speed))) / 3;

/** Stitches sewn up to step `at` (inclusive), and the sewing time in seconds at MACHINE_SPM. */
export function progressAt(playback, at) {
  let sewn = 0;
  for (let i = 0; i <= at && i < playback.count; i++) if (playback.kind[i] === 0) sewn++;
  return { sewn, seconds: Math.round((sewn / MACHINE_SPM) * 60) };
}

/**
 * The object of the stitch nearest to (x, y) mm among steps 0..upTo, within `radius` mm, or null
 * (FS-8.4 click a stitch to select its object).
 */
export function objectNear(playback, [x, y], radius, upTo = playback.count - 1) {
  let best = null;
  let bestDist = radius * radius;
  for (let i = 0; i <= upTo && i < playback.count; i++) {
    if (playback.kind[i] !== 0 || playback.object[i] < 0) continue;
    const d = (playback.x[i] - x) ** 2 + (playback.y[i] - y) ** 2;
    if (d <= bestDist) {
      bestDist = d;
      best = playback.objectIds[playback.object[i]];
    }
  }
  return best;
}

/** "m:ss" for the counter. */
export const clock = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
