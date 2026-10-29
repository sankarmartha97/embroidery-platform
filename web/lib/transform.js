// Transform handles (FS-7.2, S2-16): move, 8 scale handles (Shift keeps proportions, Alt scales
// from the centre) and a rotate handle (Shift snaps to 15°). Objects keep their geometry; every
// change goes into the SVG matrix [a, b, c, d, e, f] that maps local mm to canvas mm.

import { objectBounds } from './document.js';

export const IDENTITY = [1, 0, 0, 1, 0, 0];
const MIN_SCALE = 0.01;
const SNAP_DEG = 15;

/** m1 × m2: apply m2 first, then m1. */
export function multiply([a1, b1, c1, d1, e1, f1], [a2, b2, c2, d2, e2, f2]) {
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];

export function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

const translate = (x, y) => [1, 0, 0, 1, x, y];
const about = ([x, y], m) => multiply(translate(x, y), multiply(m, translate(-x, -y)));

/** Rounds the matrix: 4 decimals for the linear part, 0.001 mm for the offset. */
export function tidy(m) {
  const r = (v, p) => Math.round(v * p) / p + 0; // + 0 turns -0 into 0
  return [r(m[0], 1e4), r(m[1], 1e4), r(m[2], 1e4), r(m[3], 1e4), r(m[4], 1e3), r(m[5], 1e3)];
}

/** Bounds of the untransformed geometry, or null if it does not parse. */
export const localBounds = (object) => objectBounds({ ...object, transform: IDENTITY });

/** Handle positions in local mm: id → [x, y]. Edge handles move one axis, corners both. */
export function handlePoints({ x, y, w, h }) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    nw: [x, y],
    n: [cx, y],
    ne: [x + w, y],
    e: [x + w, cy],
    se: [x + w, y + h],
    s: [cx, y + h],
    sw: [x, y + h],
    w: [x, cy],
  };
}

const OPPOSITE = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };

/** Current rotation of a matrix in degrees. */
export const rotationOf = (m) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;

/**
 * The matrix after dragging `handle` from `from` to `to` (canvas mm).
 * @param {{ matrix: number[], bounds: object, handle: string, from: number[], to: number[],
 *   shift?: boolean, alt?: boolean }} drag  bounds: localBounds of the object
 */
export function dragTransform({ matrix, bounds, handle, from, to, shift = false, alt = false }) {
  if (handle === 'move') {
    const snap = (v) => Math.round(v * 10) / 10; // 0.1 mm
    return tidy(multiply(translate(snap(to[0] - from[0]), snap(to[1] - from[1])), matrix));
  }

  const points = handlePoints(bounds);
  const centre = [bounds.x + bounds.w / 2, bounds.y + bounds.h / 2];

  if (handle === 'rotate') {
    const c = apply(matrix, centre);
    let angle = Math.atan2(to[1] - c[1], to[0] - c[0]) - Math.atan2(from[1] - c[1], from[0] - c[0]);
    if (shift) {
      const current = rotationOf(matrix);
      const target = Math.round((current + (angle * 180) / Math.PI) / SNAP_DEG) * SNAP_DEG;
      angle = ((target - current) * Math.PI) / 180;
    }
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return tidy(multiply(about(c, [cos, sin, -sin, cos, 0, 0]), matrix));
  }

  // Scale in local space, about the opposite handle (or the centre with Alt).
  const anchor = alt ? centre : points[OPPOSITE[handle]];
  const grip = points[handle];
  const p = apply(invert(matrix), to);
  const factor = (axis) => {
    const span = grip[axis] - anchor[axis];
    if (span === 0) return 1; // an edge handle does not move this axis
    const f = (p[axis] - anchor[axis]) / span;
    return Math.sign(f || 1) * Math.max(Math.abs(f), MIN_SCALE);
  };
  let sx = handle.includes('e') || handle.includes('w') ? factor(0) : 1;
  let sy = handle.includes('n') || handle.includes('s') ? factor(1) : 1;
  if (shift) {
    // Keep proportions: the axis the handle moves sets both (corners: the larger change).
    const corner = handle.length === 2;
    const s = corner
      ? Math.max(Math.abs(sx), Math.abs(sy))
      : handle === 'n' || handle === 's'
        ? Math.abs(sy)
        : Math.abs(sx);
    sx = Math.sign(sx) * s;
    sy = Math.sign(sy) * s;
  }
  return tidy(multiply(matrix, about(anchor, [sx, 0, 0, sy, 0, 0])));
}

/**
 * Keeps a move inside the canvas: shifts the offset back by however far the object would leave
 * it. Returns null for a scale or rotation that would not fit (the caller keeps the old matrix).
 */
export function keepInCanvas(object, matrix, canvas, handle) {
  const b = objectBounds({ ...object, transform: matrix });
  if (!b) return null;
  const inside = b.x >= 0 && b.y >= 0 && b.x + b.w <= canvas.width && b.y + b.h <= canvas.height;
  if (inside) return matrix;
  if (handle !== 'move' || b.w > canvas.width || b.h > canvas.height) return null;
  const dx = b.x < 0 ? -b.x : Math.min(0, canvas.width - (b.x + b.w));
  const dy = b.y < 0 ? -b.y : Math.min(0, canvas.height - (b.y + b.h));
  return tidy(multiply(translate(dx, dy), matrix));
}
