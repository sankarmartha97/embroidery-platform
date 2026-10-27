// S2-15 done-when: the server-side validator rejects schema, cross-reference and geometry errors
// (05-digitizing-engine/document-schema.md), and snapshots hash canonically.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalize,
  emptyDocument,
  MAX_PATH_POINTS,
  validateDocument,
} from '../../src/lib/document/validate-document.js';
import { parsePath, PathError } from '../../src/lib/document/svg-path.js';
import { heartDocument } from '../helpers/documents.js';

const paths = (issues) => issues.map((i) => i.path);

describe('validateDocument', () => {
  it('accepts a valid document and an empty new-project document', () => {
    assert.deepEqual(validateDocument(heartDocument()), []);
    assert.deepEqual(validateDocument(emptyDocument({ width: 130, height: 180 })), []);
  });

  it('rejects schema errors with JSON pointer paths', () => {
    const doc = heartDocument({ units: 'in', extra: true });
    delete doc.canvas.height;
    assert.deepEqual(paths(validateDocument(doc)).sort(), ['/canvas/height', '/extra', '/units']);
  });

  it('reports only the errors of the declared stitch type', () => {
    const doc = heartDocument();
    doc.objects[0].stitch.densityMm = 5;
    assert.deepEqual(validateDocument(doc), [
      { path: '/objects/0/stitch/densityMm', issue: 'must be <= 1' },
    ]);
  });

  it('requires a stitch on embroidery paths but not on artwork paths', () => {
    const doc = heartDocument();
    delete doc.objects[0].stitch;
    assert.deepEqual(paths(validateDocument(doc)), ['/objects/0/stitch']);
    doc.objects[0].type = 'artwork-path';
    assert.deepEqual(validateDocument(doc), []);
  });

  it('rejects duplicate ids and missing thread references', () => {
    const doc = heartDocument();
    doc.threads[1].id = 't1';
    doc.objects[1].id = 'outline';
    doc.objects[1].stitch.threadId = 'nope';
    assert.deepEqual(validateDocument(doc), [
      { path: '/threads/1/id', issue: 'duplicates thread id "t1"' },
      { path: '/objects/1/id', issue: 'duplicates object id "outline"' },
      { path: '/objects/1/stitch/threadId', issue: 'thread "nope" is not in threads' },
    ]);
  });

  it('rejects unparseable path data', () => {
    const doc = heartDocument();
    doc.objects[1].geometry.d = 'M 10 10 L 20';
    assert.deepEqual(paths(validateDocument(doc)), ['/objects/1/geometry/d']);
    doc.objects[1].geometry.d = 'L 10 10';
    assert.match(validateDocument(doc)[0].issue, /must start with M/);
  });

  it('needs closed paths for fill, and closed paths or rails for satin', () => {
    const doc = heartDocument();
    doc.objects[1].stitch = { type: 'fill', threadId: 't2' };
    assert.deepEqual(paths(validateDocument(doc)), ['/objects/1/geometry/closed']);

    doc.objects[1].stitch = { type: 'satin', threadId: 't2' };
    assert.deepEqual(paths(validateDocument(doc)), ['/objects/1/geometry']);
    doc.objects[1].geometry.d = 'M30 80 h 40 M30 84 h 40';
    assert.deepEqual(validateDocument(doc), [], 'two rails make a satin column');
  });

  it('checks geometry against the canvas after the transform', () => {
    const doc = heartDocument();
    doc.objects[1].transform = [1, 0, 0, 1, 50, 0]; // 30..70 → 80..120 on a 100 mm canvas
    assert.deepEqual(validateDocument(doc), [
      { path: '/objects/1/geometry', issue: 'extends outside the canvas' },
    ]);
    doc.objects[1].transform = [0.5, 0, 0, 0.5, 0, 0];
    assert.deepEqual(validateDocument(doc), []);
  });

  it('follows curves, not just their end points, for the canvas check', () => {
    const doc = heartDocument();
    // End points are inside; the curve bulges to y ≈ -7.5.
    doc.objects[1].geometry.d = 'M10 5 C 10 -15 90 -15 90 5';
    assert.deepEqual(paths(validateDocument(doc)), ['/objects/1/geometry']);
  });

  it('ignores the canvas for reference artwork', () => {
    const doc = heartDocument();
    doc.objects[1].type = 'artwork-path';
    doc.objects[1].geometry.d = 'M -50 -50 L 500 500';
    assert.deepEqual(validateDocument(doc), []);
  });

  it('limits total path points', () => {
    const doc = heartDocument();
    const half = MAX_PATH_POINTS / 2;
    const d = `M1 1 ${'L2 2 '.repeat(half)}`;
    doc.objects[0].geometry.d = `${d}Z`;
    doc.objects[1].geometry.d = d;
    assert.deepEqual(paths(validateDocument(doc)), ['/objects']);
  });
});

describe('parsePath', () => {
  it('handles absolute and relative commands, implicit repeats and H/V', () => {
    const { subpaths, sourcePoints } = parsePath('M0 0 10 0 v10 H0 z m5 5 l1 1');
    assert.equal(subpaths.length, 2);
    assert.deepEqual(subpaths[0], {
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      closed: true,
    });
    assert.deepEqual(subpaths[1].points, [
      [5, 5],
      [6, 6],
    ]);
    assert.equal(sourcePoints, 6);
  });

  it('reflects control points for S and T', () => {
    const s = parsePath('M0 0 C 0 10 10 10 10 0 S 20 -10 20 0').subpaths[0].points;
    assert.deepEqual(s.at(-1), [20, 0]);
    // Reflected control point (10,-10) pulls the second curve below y = 0.
    assert.ok(s.slice(17).some(([, y]) => y < 0));
    const t = parsePath('M0 0 Q 5 10 10 0 T 20 0').subpaths[0].points;
    assert.ok(t.slice(17).some(([, y]) => y < 0));
  });

  it('flattens arcs through the right centre', () => {
    const points = parsePath('M0 0 A 10 10 0 0 1 20 0').subpaths[0].points;
    assert.deepEqual(points.at(-1), [20, 0]);
    for (const [x, y] of points) assert.ok(Math.abs(Math.hypot(x - 10, y) - 10) < 1e-9);
    assert.ok(
      points.some(([, y]) => y < -9.9),
      'sweep 1 goes through y = -10',
    );
  });

  it('throws PathError on bad input', () => {
    for (const d of ['', 'Z', 'M 1', 'M1 1 A 1 1 0 2 0 3 3', 'M1 1 L x', 'M1 1 Z 3']) {
      assert.throws(() => parsePath(d), PathError, d);
    }
  });
});

describe('canonicalize', () => {
  it('hashes the same document identically regardless of key order', () => {
    const doc = heartDocument();
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(doc).reverse())));
    assert.equal(canonicalize(doc).sha256, canonicalize(reordered).sha256);
    assert.notEqual(
      canonicalize(doc).sha256,
      canonicalize(heartDocument({ canvas: { width: 101, height: 100 } })).sha256,
    );
  });

  it('renumbers sequences 1..n by (sequence, position) without reordering objects', () => {
    const doc = heartDocument();
    doc.objects[0].sequence = 9;
    doc.objects[1].sequence = 4;
    const { document } = canonicalize(doc);
    assert.deepEqual(
      document.objects.map((o) => [o.id, o.sequence]),
      [
        ['outline', 2],
        ['underline', 1],
      ],
    );
    assert.equal(doc.objects[0].sequence, 9, 'input is not mutated');
  });
});
