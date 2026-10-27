// SVG path data parser (M L H V C S Q T A Z, absolute and relative). Shared by the API's
// document validator and the workers, so both read geometry the same way.

const PARAMS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const CURVE_SEGMENTS = 16;

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}

function tokenize(d) {
  const tokens = [];
  const re = /\s*(?:([MLHVCSQTAZmlhvcsqtaz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?))\s*,?/y;
  let i = 0;
  while (i < d.length) {
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m || m[0].length === 0) {
      if (/^\s*$/.test(d.slice(i))) break;
      throw new PathError(`unexpected character at offset ${i}`);
    }
    if (m[1]) tokens.push(m[1]);
    else {
      const n = Number(m[2]);
      if (!Number.isFinite(n)) throw new PathError(`number out of range at offset ${i}`);
      tokens.push(n);
    }
    i = re.lastIndex;
  }
  return tokens;
}

/**
 * Parses path data into subpaths of points in path units. Curves and arcs are flattened into
 * CURVE_SEGMENTS straight segments, so every returned point lies on the drawn path.
 * @returns {{ subpaths: { points: [number, number][], closed: boolean }[], sourcePoints: number }}
 *   sourcePoints counts the coordinate pairs written in `d` (the document point limit).
 */
export function parsePath(d) {
  const tokens = tokenize(d);
  const subpaths = [];
  let sourcePoints = 0;
  let current = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl = null; // [x, y, 'C' | 'Q'] for S/T reflection
  let i = 0;
  let command = null;

  const push = (px, py) => current.points.push([px, py]);
  const read = (n) => {
    const out = tokens.slice(i, i + n);
    if (out.length < n || out.some((t) => typeof t !== 'number')) {
      throw new PathError(`command ${command} needs ${n} numbers`);
    }
    i += n;
    return out;
  };

  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') {
      command = tokens[i++];
    } else if (command === null) {
      throw new PathError('path must start with a command');
    } else if (command === 'M') command = 'L';
    else if (command === 'm') command = 'l';
    else if (command === 'Z' || command === 'z') throw new PathError('numbers after Z');

    const upper = command.toUpperCase();
    const rel = command !== upper;
    if (current === null && upper !== 'M') throw new PathError('path must start with M');

    if (upper === 'Z') {
      current.closed = true;
      x = startX;
      y = startY;
      lastControl = null;
      current = { points: [[x, y]], closed: false, implicit: true };
      subpaths.push(current);
      continue;
    }

    const args = read(PARAMS[upper]);
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;

    switch (upper) {
      case 'M': {
        x = args[0] + ox;
        y = args[1] + oy;
        startX = x;
        startY = y;
        if (current?.implicit && current.points.length === 1) subpaths.pop();
        current = { points: [[x, y]], closed: false };
        subpaths.push(current);
        sourcePoints += 1;
        lastControl = null;
        break;
      }
      case 'L':
      case 'H':
      case 'V': {
        if (upper === 'L') {
          x = args[0] + ox;
          y = args[1] + oy;
        } else if (upper === 'H') x = args[0] + ox;
        else y = args[0] + oy;
        push(x, y);
        sourcePoints += 1;
        lastControl = null;
        break;
      }
      case 'C':
      case 'S': {
        let c1;
        let rest;
        if (upper === 'C') {
          c1 = [args[0] + ox, args[1] + oy];
          rest = args.slice(2);
        } else {
          c1 = lastControl?.[2] === 'C' ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y];
          rest = args;
        }
        const c2 = [rest[0] + ox, rest[1] + oy];
        const end = [rest[2] + ox, rest[3] + oy];
        cubic([x, y], c1, c2, end, push);
        sourcePoints += upper === 'C' ? 3 : 2;
        lastControl = [c2[0], c2[1], 'C'];
        [x, y] = end;
        break;
      }
      case 'Q':
      case 'T': {
        let c;
        let end;
        if (upper === 'Q') {
          c = [args[0] + ox, args[1] + oy];
          end = [args[2] + ox, args[3] + oy];
        } else {
          c = lastControl?.[2] === 'Q' ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y];
          end = [args[0] + ox, args[1] + oy];
        }
        quadratic([x, y], c, end, push);
        sourcePoints += upper === 'Q' ? 2 : 1;
        lastControl = [c[0], c[1], 'Q'];
        [x, y] = end;
        break;
      }
      case 'A': {
        const [rx, ry, rotation, largeArc, sweep] = args;
        if ((largeArc !== 0 && largeArc !== 1) || (sweep !== 0 && sweep !== 1)) {
          throw new PathError('arc flags must be 0 or 1');
        }
        const end = [args[5] + ox, args[6] + oy];
        arc([x, y], rx, ry, rotation, largeArc, sweep, end, push);
        sourcePoints += 1;
        lastControl = null;
        [x, y] = end;
        break;
      }
    }
  }

  const result = subpaths.filter((s) => !(s.implicit && s.points.length === 1));
  if (result.length === 0) throw new PathError('path has no points');
  return {
    subpaths: result.map(({ points, closed }) => ({ points, closed })),
    sourcePoints,
  };
}

function cubic(p0, p1, p2, p3, push) {
  for (let s = 1; s <= CURVE_SEGMENTS; s++) {
    const t = s / CURVE_SEGMENTS;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    push(
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    );
  }
}

function quadratic(p0, p1, p2, push) {
  for (let s = 1; s <= CURVE_SEGMENTS; s++) {
    const t = s / CURVE_SEGMENTS;
    const u = 1 - t;
    push(
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    );
  }
}

/** SVG arc (endpoint parameterisation, SVG 1.1 appendix F.6) flattened to segments. */
function arc([x1, y1], rx, ry, rotationDeg, largeArc, sweep, [x2, y2], push) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    push(x2, y2);
    return;
  }
  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  for (let s = 1; s <= CURVE_SEGMENTS; s++) {
    if (s === CURVE_SEGMENTS) {
      push(x2, y2);
      break;
    }
    const t = theta1 + (delta * s) / CURVE_SEGMENTS;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    push(cos * ex - sin * ey + cx, sin * ex + cos * ey + cy);
  }
}

/** Applies a 2D affine matrix [a, b, c, d, e, f] (SVG order). */
export function applyTransform([px, py], transform) {
  if (!transform) return [px, py];
  const [a, b, c, d, e, f] = transform;
  return [a * px + c * py + e, b * px + d * py + f];
}
