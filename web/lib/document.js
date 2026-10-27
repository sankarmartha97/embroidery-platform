// Document helpers for the editor. Geometry is read with the same parser the API validator and
// the workers use, so what the canvas draws is what the server checks.
import { applyTransform, parsePath } from '../../src/lib/document/svg-path.js';

// Parameter ranges from the document schema (05-digitizing-engine/document-schema.md).
export const STITCH_PARAMS = Object.freeze({
  running: [
    {
      key: 'stitchLengthMm',
      label: 'Stitch length',
      unit: 'mm',
      min: 1,
      max: 7,
      step: 0.1,
      default: 2.5,
    },
  ],
  satin: [
    { key: 'densityMm', label: 'Density', unit: 'mm', min: 0.25, max: 1, step: 0.05, default: 0.4 },
    {
      key: 'pullCompensationMm',
      label: 'Pull compensation',
      unit: 'mm',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.2,
    },
  ],
  fill: [
    { key: 'densityMm', label: 'Density', unit: 'mm', min: 0.25, max: 1, step: 0.05, default: 0.4 },
    {
      key: 'stitchLengthMm',
      label: 'Stitch length',
      unit: 'mm',
      min: 2,
      max: 7,
      step: 0.1,
      default: 4,
    },
    { key: 'angleDegrees', label: 'Angle', unit: '°', min: 0, max: 179, step: 1, default: 45 },
  ],
});

/** The hoop to draw: the document's machine profile, else the canvas size. */
export function hoopOf(document) {
  const p = document.machineProfile;
  return p
    ? { w: p.hoopWidthMm, h: p.hoopHeightMm }
    : { w: document.canvas.width, h: document.canvas.height };
}

/** Bounding box in mm (after the transform), or null if the path does not parse. */
export function objectBounds(object) {
  let parsed;
  try {
    parsed = parsePath(object.geometry.d);
  } catch {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { points } of parsed.subpaths) {
    for (const p of points) {
      const [x, y] = applyTransform(p, object.transform);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Objects in stitch order (sequence, then array position). */
export function inSequence(document) {
  return document.objects
    .map((o, index) => ({ o, index }))
    .sort((a, b) => a.o.sequence - b.o.sequence || a.index - b.index)
    .map(({ o }) => o);
}

export const threadHex = (document, threadId) =>
  document.threads.find((t) => t.id === threadId)?.hex ?? '#888888';

// ---- Edit commands: pure, return a new document (unchanged objects are shared) ----

export function updateObject(document, id, patch) {
  return {
    ...document,
    objects: document.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
  };
}

export function updateStitch(document, id, patch) {
  return {
    ...document,
    objects: document.objects.map((o) =>
      o.id === id && o.stitch ? { ...o, stitch: { ...o.stitch, ...patch } } : o,
    ),
  };
}

/** Changes the stitch type, keeping the thread and dropping parameters the new type lacks. */
export function setStitchType(document, id, type) {
  return {
    ...document,
    objects: document.objects.map((o) => {
      if (o.id !== id || !o.stitch) return o;
      return { ...o, stitch: { type, threadId: o.stitch.threadId } };
    }),
  };
}

/** Moves an object one place earlier (-1) or later (+1) in stitch order; renumbers 1..n. */
export function moveInSequence(document, id, delta) {
  const ordered = inSequence(document);
  const from = ordered.findIndex((o) => o.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ordered.length) return document;
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  const sequenceOf = new Map(ordered.map((o, i) => [o.id, i + 1]));
  return {
    ...document,
    objects: document.objects.map((o) =>
      o.sequence === sequenceOf.get(o.id) ? o : { ...o, sequence: sequenceOf.get(o.id) },
    ),
  };
}

/** Nudges an object by (dx, dy) mm through its transform (arrow keys: 0.1 mm, Shift: 1 mm). */
export function nudge(document, id, dx, dy) {
  return {
    ...document,
    objects: document.objects.map((o) => {
      if (o.id !== id || o.locked) return o;
      const [a, b, c, d, e, f] = o.transform ?? [1, 0, 0, 1, 0, 0];
      const round = (v) => Math.round(v * 1000) / 1000;
      return { ...o, transform: [a, b, c, d, round(e + dx), round(f + dy)] };
    }),
  };
}
