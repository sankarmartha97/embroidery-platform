import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ajvErrorsToDetails } from '../ajv-details.js';
import { applyTransform, parsePath, PathError } from './svg-path.js';

// Server-side document validation (S2-15, 05-digitizing-engine/document-schema.md):
// JSON Schema first, then the cross-reference and geometry rules the schema cannot express.
// The API runs it on autosave and snapshot; workers can run it again before digitizing.

const contractsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../contracts',
);
const schema = JSON.parse(
  readFileSync(path.join(contractsDir, 'project-document.schema.json'), 'utf8'),
);

// No useDefaults: the stored draft is exactly what the client sent.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

export const SUPPORTED_SCHEMA_VERSION = 1;
export const MAX_PATH_POINTS = 200_000;
export const MAX_ISSUES = 50;
const CANVAS_EPSILON_MM = 1e-6;
const STITCH_DEFS = { running: 'runningStitch', satin: 'satinStitch', fill: 'fillStitch' };

const stitchValidators = Object.fromEntries(
  Object.entries(STITCH_DEFS).map(([type, def]) => [
    type,
    ajv.getSchema(`${schema.$id}#/$defs/${def}`),
  ]),
);

/**
 * oneOf over stitch types reports the errors of every branch. For a stitch with a known type,
 * replace them with the errors of that type's schema alone, so the client sees what matters.
 * "must match then schema" is dropped: the failing `then` rule is reported on its own.
 */
function relevantErrors(errors, doc) {
  const out = [];
  const replaced = new Set();
  for (const e of errors) {
    if (e.keyword === 'if') continue;
    const m = /^\/objects\/(\d+)\/stitch(?:\/|$)/.exec(e.instancePath);
    const stitch = m && doc.objects?.[m[1]]?.stitch;
    const validateStitch = stitchValidators[stitch?.type];
    if (!validateStitch) {
      out.push(e);
      continue;
    }
    if (replaced.has(m[1])) continue;
    replaced.add(m[1]);
    validateStitch(stitch);
    const prefix = `/objects/${m[1]}/stitch`;
    for (const se of validateStitch.errors ?? []) {
      out.push({ ...se, instancePath: prefix + se.instancePath });
    }
  }
  return out;
}

/**
 * @returns {{ path: string, issue: string }[]} empty when the document is valid.
 */
export function validateDocument(doc) {
  if (!validateSchema(doc)) {
    return dedupe(ajvErrorsToDetails(relevantErrors(validateSchema.errors, doc))).slice(
      0,
      MAX_ISSUES,
    );
  }

  const issues = [];
  const add = (p, issue) => issues.push({ path: p, issue });

  const threadIds = new Set();
  doc.threads.forEach((t, i) => {
    if (threadIds.has(t.id)) add(`/threads/${i}/id`, `duplicates thread id "${t.id}"`);
    threadIds.add(t.id);
  });

  const objectIds = new Set();
  let totalPoints = 0;
  doc.objects.forEach((o, i) => {
    const at = `/objects/${i}`;
    if (objectIds.has(o.id)) add(`${at}/id`, `duplicates object id "${o.id}"`);
    objectIds.add(o.id);

    if (o.stitch && !threadIds.has(o.stitch.threadId)) {
      add(`${at}/stitch/threadId`, `thread "${o.stitch.threadId}" is not in threads`);
    }

    let parsed;
    try {
      parsed = parsePath(o.geometry.d);
    } catch (err) {
      if (!(err instanceof PathError)) throw err;
      add(`${at}/geometry/d`, `is not valid path data: ${err.message}`);
      return;
    }
    totalPoints += parsed.sourcePoints;

    if (o.stitch?.type === 'fill' && !o.geometry.closed) {
      add(`${at}/geometry/closed`, 'fill needs a closed path');
    }
    if (o.stitch?.type === 'satin' && !o.geometry.closed && parsed.subpaths.length < 2) {
      add(`${at}/geometry`, 'satin needs a closed path or a pair of rails');
    }

    if (o.type === 'embroidery-path' && !withinCanvas(parsed, o.transform, doc.canvas)) {
      add(`${at}/geometry`, 'extends outside the canvas');
    }
  });

  if (totalPoints > MAX_PATH_POINTS) {
    add('/objects', `has ${totalPoints} path points; the limit is ${MAX_PATH_POINTS}`);
  }
  return issues.slice(0, MAX_ISSUES);
}

function withinCanvas(parsed, transform, canvas) {
  for (const { points } of parsed.subpaths) {
    for (const point of points) {
      const [x, y] = applyTransform(point, transform);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      if (x < -CANVAS_EPSILON_MM || y < -CANVAS_EPSILON_MM) return false;
      if (x > canvas.width + CANVAS_EPSILON_MM || y > canvas.height + CANVAS_EPSILON_MM)
        return false;
    }
  }
  return true;
}

function dedupe(details) {
  const seen = new Set();
  return details.filter((d) => {
    const key = `${d.path}\u0000${d.issue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Prepares a valid draft for an immutable version: sequence numbers are renumbered 1..n in
 * (sequence, array position) order ("the server renumbers on snapshot"), and the document is
 * serialised with sorted keys so identical drafts always hash the same.
 * @returns {{ document: object, json: string, sha256: string }}
 */
export function canonicalize(doc) {
  const order = doc.objects
    .map((o, index) => ({ index, sequence: o.sequence }))
    .sort((a, b) => a.sequence - b.sequence || a.index - b.index);
  const sequenceOf = new Map(order.map(({ index }, rank) => [index, rank + 1]));
  const document = {
    ...doc,
    objects: doc.objects.map((o, index) => ({ ...o, sequence: sequenceOf.get(index) })),
  };
  const json = canonicalJson(document);
  return { document, json, sha256: createHash('sha256').update(json).digest('hex') };
}

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

/** A valid, empty document for a new project. */
export function emptyDocument({ width = 100, height = 100 } = {}) {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    units: 'mm',
    canvas: { width, height },
    threads: [],
    objects: [],
  };
}
