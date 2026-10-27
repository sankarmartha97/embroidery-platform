// Drawing tools (S3-05 rectangle/ellipse/polygon, S3-06 pen): pure geometry and document edits.
// Coordinates are mm on the canvas (origin top-left, y down), rounded to 0.1 mm, and kept inside
// the canvas so every new object passes the server-side document validator.

const DEFAULT_THREAD = { id: 't1', hex: '#CC3344' };
export const MIN_SHAPE_MM = 1;

export const round = (v) => Math.round(v * 10) / 10;
const fmt = (v) => String(round(v) + 0); // + 0 avoids "-0"

/** Snaps to 0.1 mm and clamps into the canvas. */
export function clampPoint([x, y], canvas) {
  return [
    round(Math.min(canvas.width, Math.max(0, x))),
    round(Math.min(canvas.height, Math.max(0, y))),
  ];
}

/** Corner-to-corner box; with `square`, the shorter side follows the longer one. */
export function dragBox([x0, y0], [x1, y1], { square = false } = {}) {
  let w = x1 - x0;
  let h = y1 - y0;
  if (square) {
    const side = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * side;
    h = Math.sign(h || 1) * side;
  }
  return {
    x: round(Math.min(x0, x0 + w)),
    y: round(Math.min(y0, y0 + h)),
    w: round(Math.abs(w)),
    h: round(Math.abs(h)),
  };
}

/** Keeps a box inside the canvas (after a Shift-square may have pushed it out). */
export function clampBox(box, canvas) {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  return {
    x,
    y,
    w: round(Math.min(box.w - (x - box.x), canvas.width - x)),
    h: round(Math.min(box.h - (y - box.y), canvas.height - y)),
  };
}

// Rectangles and polygons use only M/L/Z, so their nodes can be edited like pen paths.
export function rectPath({ x, y, w, h }) {
  return `M${fmt(x)} ${fmt(y)} L${fmt(x + w)} ${fmt(y)} L${fmt(x + w)} ${fmt(y + h)} L${fmt(x)} ${fmt(y + h)} Z`;
}

export function ellipsePath({ x, y, w, h }) {
  const rx = w / 2;
  const ry = h / 2;
  const cy = y + ry;
  return `M${fmt(x)} ${fmt(cy)} A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(x + w)} ${fmt(cy)} A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(x)} ${fmt(cy)} Z`;
}

export function polygonPath(points) {
  return `${points.map(([px, py], i) => `${i ? 'L' : 'M'}${fmt(px)} ${fmt(py)}`).join(' ')} Z`;
}

// ---- Pen paths ----
// A node is { x, y, in?: [x, y], out?: [x, y] } with absolute handle positions. A segment between
// two nodes is a straight line when neither side has a handle, otherwise a cubic Bézier.

/** Path data for pen nodes; closed paths get the closing segment and Z. */
export function penPath(nodes, closed) {
  if (nodes.length === 0) return '';
  const parts = [`M${fmt(nodes[0].x)} ${fmt(nodes[0].y)}`];
  const segment = (a, b) => {
    if (!a.out && !b.in) return `L${fmt(b.x)} ${fmt(b.y)}`;
    const [c1x, c1y] = a.out ?? [a.x, a.y];
    const [c2x, c2y] = b.in ?? [b.x, b.y];
    return `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(b.x)} ${fmt(b.y)}`;
  };
  for (let i = 1; i < nodes.length; i++) parts.push(segment(nodes[i - 1], nodes[i]));
  if (closed && nodes.length > 2) {
    const last = nodes.at(-1);
    if (last.out || nodes[0].in) parts.push(segment(last, nodes[0]));
    parts.push('Z');
  }
  return parts.join(' ');
}

/** A smooth node: dragging out from (x, y) sets `out`; `in` mirrors it. */
export function smoothNode([x, y], [dx, dy]) {
  return {
    x: round(x),
    y: round(y),
    out: [round(dx), round(dy)],
    in: [round(2 * x - dx), round(2 * y - dy)],
  };
}

/**
 * Reads pen nodes back from path data made of absolute M/L/C/Z with one subpath (what the
 * rectangle, polygon and pen tools write). Anything else returns null: not node-editable.
 * @returns {{ nodes: object[], closed: boolean } | null}
 */
export function parsePenPath(d) {
  const tokens = d.match(/[MLCZmlcz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  if (!tokens || tokens[0] !== 'M' || /[^MLCZ0-9.\s,eE+-]/.test(d) || /[mlcz]/.test(d)) return null;
  const nodes = [];
  let closed = false;
  let i = 0;
  const num = () => {
    const v = Number(tokens[i++]);
    if (!Number.isFinite(v)) throw new Error('bad number');
    return v;
  };
  try {
    while (i < tokens.length) {
      const cmd = tokens[i++];
      if (closed) return null; // a second subpath
      if (cmd === 'M') {
        if (nodes.length) return null;
        nodes.push({ x: num(), y: num() });
      } else if (cmd === 'L') {
        nodes.push({ x: num(), y: num() });
      } else if (cmd === 'C') {
        const c1 = [num(), num()];
        const c2 = [num(), num()];
        const end = { x: num(), y: num() };
        nodes.at(-1).out = c1;
        end.in = c2;
        nodes.push(end);
      } else if (cmd === 'Z') {
        closed = true;
      } else return null;
    }
  } catch {
    return null;
  }
  // A handle sitting on its own node is no handle (a curve meeting a corner writes it that way).
  for (const n of nodes) {
    if (n.in && n.in[0] === n.x && n.in[1] === n.y) delete n.in;
    if (n.out && n.out[0] === n.x && n.out[1] === n.y) delete n.out;
  }
  // A closing segment written explicitly ends on the first node: fold it back into node 0.
  if (closed && nodes.length > 2) {
    const first = nodes[0];
    const last = nodes.at(-1);
    if (last.x === first.x && last.y === first.y) {
      nodes.pop();
      if (last.in) first.in = last.in;
    }
  }
  return { nodes, closed };
}

/** Moves a node, carrying its handles along. */
export function moveNode(nodes, index, [x, y]) {
  return nodes.map((n, i) => {
    if (i !== index) return n;
    const dx = round(x - n.x);
    const dy = round(y - n.y);
    const shift = (h) => h && [round(h[0] + dx), round(h[1] + dy)];
    return { ...n, x: round(x), y: round(y), in: shift(n.in), out: shift(n.out) };
  });
}

/** Moves one handle; the opposite handle mirrors it so the node stays smooth. */
export function moveHandle(nodes, index, which, [x, y]) {
  return nodes.map((n, i) => {
    if (i !== index) return n;
    const other = which === 'in' ? 'out' : 'in';
    const moved = { ...n, [which]: [round(x), round(y)] };
    if (n[other]) moved[other] = [round(2 * n.x - x), round(2 * n.y - y)];
    return moved;
  });
}

// ---- Adding objects to the document ----

const ID = /^(?:obj)-(\d+)$/;

/** Next free object id (obj-1, obj-2, …) matching the schema's localId pattern. */
export function nextObjectId(document) {
  let max = 0;
  for (const o of document.objects) {
    const m = ID.exec(o.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `obj-${max + 1}`;
}

const LABEL = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', pen: 'Path' };

/**
 * Appends a drawn shape as the last object in the stitch order. Closed shapes get a fill stitch,
 * open paths a running stitch (FS-7.x import rule, used for drawing too). A document without
 * threads gets a default one.
 * @returns {{ document: object, id: string }}
 */
export function addShape(document, { kind, d, closed, threadId }) {
  const threads = document.threads.length ? document.threads : [DEFAULT_THREAD];
  const thread = threads.find((t) => t.id === threadId) ?? threads[0];
  const id = nextObjectId(document);
  const sameKind = document.objects.filter((o) => o.name?.startsWith(LABEL[kind])).length;
  const sequence = document.objects.reduce((m, o) => Math.max(m, o.sequence), 0) + 1;
  const object = {
    id,
    type: 'embroidery-path',
    name: `${LABEL[kind]} ${sameKind + 1}`,
    geometry: { kind: 'path', d, closed },
    stitch: closed
      ? { type: 'fill', threadId: thread.id }
      : { type: 'running', threadId: thread.id },
    sequence,
  };
  return { document: { ...document, threads, objects: [...document.objects, object] }, id };
}

/** Replaces an object's path data (node editing). */
export function setPath(document, id, d, closed) {
  return {
    ...document,
    objects: document.objects.map((o) =>
      o.id === id
        ? { ...o, geometry: { ...o.geometry, d, closed: closed ?? o.geometry.closed } }
        : o,
    ),
  };
}
