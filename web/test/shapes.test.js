// S3-05 / S3-06 done-when: shapes create correct document objects (checked with the API's own
// validator), pen paths can be open or closed, and nodes can be edited.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePath } from '../../src/lib/document/svg-path.js';
import { validateDocument } from '../../src/lib/document/validate-document.js';
import {
  addShape,
  clampBox,
  clampPoint,
  dragBox,
  ellipsePath,
  moveHandle,
  moveNode,
  nextObjectId,
  parsePenPath,
  penPath,
  polygonPath,
  rectPath,
  smoothNode,
} from '../lib/shapes.js';

const empty = () => ({
  schemaVersion: 1,
  units: 'mm',
  canvas: { width: 100, height: 100 },
  threads: [],
  objects: [],
});

describe('drag boxes and clamping', () => {
  it('normalises a drag in any direction and snaps to 0.1 mm', () => {
    assert.deepEqual(dragBox([50.04, 40], [20.01, 70.06]), { x: 20, y: 40, w: 30, h: 30.1 });
  });
  it('makes a square with Shift, following the longer side', () => {
    assert.deepEqual(dragBox([10, 10], [40, 20], { square: true }), { x: 10, y: 10, w: 30, h: 30 });
    assert.deepEqual(dragBox([50, 50], [45, 20], { square: true }), { x: 20, y: 20, w: 30, h: 30 });
  });
  it('keeps points and boxes inside the canvas', () => {
    const canvas = { width: 100, height: 80 };
    assert.deepEqual(clampPoint([-3, 95.55], canvas), [0, 80]);
    assert.deepEqual(clampBox({ x: 90, y: -5, w: 30, h: 30 }, canvas), {
      x: 90,
      y: 0,
      w: 10,
      h: 25,
    });
  });
});

describe('shape paths', () => {
  it('writes rectangles, ellipses and polygons the shared parser reads back exactly', () => {
    const rect = parsePath(rectPath({ x: 10, y: 20, w: 30, h: 15 }));
    assert.equal(rect.subpaths[0].closed, true);
    assert.deepEqual(rect.subpaths[0].points, [
      [10, 20],
      [40, 20],
      [40, 35],
      [10, 35],
    ]);

    const ellipse = parsePath(ellipsePath({ x: 0, y: 0, w: 40, h: 20 }));
    const xs = ellipse.subpaths[0].points.map(([x]) => x);
    const ys = ellipse.subpaths[0].points.map(([, y]) => y);
    assert.ok(Math.min(...xs) >= -1e-9 && Math.max(...xs) <= 40 + 1e-9);
    assert.ok(Math.abs(Math.min(...ys)) < 1e-9 && Math.abs(Math.max(...ys) - 20) < 1e-9);

    assert.equal(
      polygonPath([
        [0, 0],
        [10, 0],
        [5, 8],
      ]),
      'M0 0 L10 0 L5 8 Z',
    );
  });

  it('writes pen paths with lines for corners and curves for smooth nodes', () => {
    const nodes = [{ x: 0, y: 0 }, smoothNode([10, 10], [15, 10]), { x: 20, y: 0 }];
    assert.equal(penPath(nodes, false), 'M0 0 C0 0 5 10 10 10 C15 10 20 0 20 0');
    assert.equal(
      penPath(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 5, y: 8 },
        ],
        true,
      ),
      'M0 0 L10 0 L5 8 Z',
    );
  });

  it('reads its own paths back as nodes, open or closed', () => {
    const nodes = [smoothNode([10, 10], [20, 5]), { x: 30, y: 30 }, { x: 5, y: 30 }];
    const closedBack = parsePenPath(penPath(nodes, true));
    assert.equal(closedBack.closed, true);
    assert.deepEqual(closedBack.nodes, nodes);
    // Open: nothing leads into the first node, so its incoming handle is not part of the path.
    const openBack = parsePenPath(penPath(nodes, false));
    assert.equal(openBack.closed, false);
    const firstWithoutIn = { ...nodes[0] };
    delete firstWithoutIn.in;
    assert.deepEqual(openBack.nodes, [firstWithoutIn, nodes[1], nodes[2]]);
    const rect = parsePenPath(rectPath({ x: 0, y: 0, w: 10, h: 10 }));
    assert.equal(rect.nodes.length, 4);
    assert.equal(rect.closed, true);
  });

  it('refuses paths it cannot edit as nodes', () => {
    for (const d of [
      ellipsePath({ x: 0, y: 0, w: 10, h: 10 }),
      'm0 0 l10 0',
      'M0 0 H10',
      'M0 0 L1 1 Z M5 5 L6 6',
    ]) {
      assert.equal(parsePenPath(d), null, d);
    }
  });

  it('moves a node with its handles, and mirrors a moved handle', () => {
    const nodes = [smoothNode([10, 10], [15, 10])];
    const moved = moveNode(nodes, 0, [20, 20]);
    assert.deepEqual(moved[0], { x: 20, y: 20, out: [25, 20], in: [15, 20] });
    const turned = moveHandle(moved, 0, 'out', [20, 30]);
    assert.deepEqual(turned[0].in, [20, 10]);
  });
});

describe('adding shapes to the document', () => {
  it('creates valid objects: closed → fill, open → running, default thread, next id and sequence', () => {
    let doc = empty();
    let r = addShape(doc, {
      kind: 'rect',
      d: rectPath({ x: 10, y: 10, w: 30, h: 20 }),
      closed: true,
    });
    doc = r.document;
    assert.equal(r.id, 'obj-1');
    r = addShape(doc, {
      kind: 'pen',
      d: penPath(
        [
          { x: 5, y: 5 },
          { x: 50, y: 60 },
        ],
        false,
      ),
      closed: false,
    });
    doc = r.document;
    r = addShape(doc, {
      kind: 'ellipse',
      d: ellipsePath({ x: 50, y: 50, w: 40, h: 30 }),
      closed: true,
    });
    doc = r.document;
    r = addShape(doc, {
      kind: 'polygon',
      d: polygonPath([
        [60, 5],
        [95, 5],
        [80, 40],
      ]),
      closed: true,
    });
    doc = r.document;

    assert.deepEqual(doc.threads, [{ id: 't1', hex: '#CC3344' }]);
    assert.deepEqual(
      doc.objects.map((o) => [o.id, o.name, o.stitch.type, o.geometry.closed, o.sequence]),
      [
        ['obj-1', 'Rectangle 1', 'fill', true, 1],
        ['obj-2', 'Path 1', 'running', false, 2],
        ['obj-3', 'Ellipse 1', 'fill', true, 3],
        ['obj-4', 'Polygon 1', 'fill', true, 4],
      ],
    );
    assert.deepEqual(validateDocument(doc), [], 'the API validator accepts every drawn shape');
  });

  it('continues numbering after existing objects and uses the chosen thread', () => {
    const doc = {
      ...empty(),
      threads: [
        { id: 't1', hex: '#000000' },
        { id: 'gold', hex: '#D4AF37' },
      ],
      objects: [
        {
          id: 'obj-7',
          type: 'embroidery-path',
          geometry: { kind: 'path', d: 'M1 1 L2 2', closed: false },
          stitch: { type: 'running', threadId: 't1' },
          sequence: 4,
        },
      ],
    };
    assert.equal(nextObjectId(doc), 'obj-8');
    const { document } = addShape(doc, {
      kind: 'rect',
      d: rectPath({ x: 1, y: 1, w: 5, h: 5 }),
      closed: true,
      threadId: 'gold',
    });
    assert.equal(document.objects[1].sequence, 5);
    assert.equal(document.objects[1].stitch.threadId, 'gold');
    assert.equal(document.threads.length, 2, 'existing threads kept');
  });
});
