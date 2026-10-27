import { DigitizingEngine, EngineError, throwIfAborted } from '../digitizing-engine.js';
import { writeDst } from './dst-writer.js';
import { writeJef } from './jef-writer.js';

/**
 * FakeEngine: a deterministic test stub (delivery plan S2-03). Front end, back end and QA can run
 * full job flows before the real engine is chosen at Gate 1.
 *
 * It turns every visible object into running stitches along its path points, whatever the
 * requested stitch type. Output follows stitch-data format v1. NOT for production files:
 * its DST/JEF writers have not passed the production enablement gate.
 */
export class FakeEngine extends DigitizingEngine {
  describe() {
    return {
      name: 'fake',
      version: '0.1.0',
      formats: ['DST', 'JEF'],
      stitchTypes: ['running', 'satin', 'fill'],
    };
  }

  async generateStitches(document, { signal } = {}) {
    throwIfAborted(signal);
    const cx = document.canvas.width / 2;
    const cy = document.canvas.height / 2;
    const threads = document.threads.map((t, index) => ({ index, hex: t.hex, id: t.id }));
    const threadIndex = new Map(threads.map((t) => [t.id, t.index]));

    const objects = document.objects
      .filter((o) => !o.hidden)
      .slice()
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));

    const commands = [];
    const objectMap = [];
    let currentThread = null;

    for (const object of objects) {
      throwIfAborted(signal);
      const index = threadIndex.get(object.stitch.threadId);
      if (index === undefined) {
        throw new EngineError('INVALID_DOCUMENT', 'Object references a missing thread', {
          objectId: object.id,
        });
      }
      const points = resample(pathPoints(object), object.stitch.stitchLengthMm ?? 2.5);
      if (points.length === 0) continue;

      const toUnits = ([x, y]) => [Math.round((x - cx) * 10), Math.round((y - cy) * 10)];
      const first = toUnits(points[0]);
      const from = commands.length;
      if (currentThread !== null && index !== currentThread) commands.push(['color_change', index]);
      if (commands.length > 0) commands.push(['jump', ...first]);
      for (const p of points) commands.push(['stitch', ...toUnits(p)]);
      objectMap.push({ objectId: object.id, fromCommand: from, toCommand: commands.length - 1 });
      currentThread = index;
    }
    commands.push(['end']);

    return {
      format: 'emb-stitch-data',
      version: 1,
      units: '0.1mm',
      sourceVersionId: document.sourceVersionId ?? null,
      engine: { name: 'fake', version: this.describe().version },
      bounds: bounds(commands),
      threads: threads.map(({ index, hex }) => ({ index, hex })),
      commands,
      objectMap,
      stats: stats(commands),
    };
  }

  async renderSimulation() {
    throw new EngineError('UNSUPPORTED_STITCH_TYPE', 'FakeEngine does not render simulations');
  }

  async exportMachineFile(stitchData, formatCode, _machineProfile, { signal } = {}) {
    throwIfAborted(signal);
    if (formatCode === 'DST') return { buffer: writeDst(stitchData), formatCode };
    if (formatCode === 'JEF') return { buffer: writeJef(stitchData), formatCode };
    throw new EngineError('UNSUPPORTED_STITCH_TYPE', `FakeEngine cannot write ${formatCode}`);
  }

  async validate(stitchData, machineProfile, { signal } = {}) {
    throwIfAborted(signal);
    const issues = [];
    const { stats: s, bounds: b } = stitchData;
    if (s.stitches === 0) issues.push({ code: 'EMPTY_DESIGN', severity: 'error' });

    const halfW = (machineProfile.hoopWidthMm * 10) / 2;
    const halfH = (machineProfile.hoopHeightMm * 10) / 2;
    if (b.minX < -halfW || b.maxX > halfW || b.minY < -halfH || b.maxY > halfH) {
      issues.push({ code: 'OUT_OF_HOOP', severity: 'error' });
    }

    const maxLen = (machineProfile.maxStitchLengthMm ?? 12.1) * 10;
    let prev = null;
    for (const [type, x, y] of stitchData.commands) {
      if (type === 'stitch' && prev && Math.hypot(x - prev[0], y - prev[1]) > maxLen) {
        issues.push({ code: 'STITCH_TOO_LONG', severity: 'error' });
        break;
      }
      if (type === 'stitch' || type === 'jump') prev = [x, y];
    }

    if (machineProfile.maxColors && stitchData.threads.length > machineProfile.maxColors) {
      issues.push({ code: 'TOO_MANY_COLORS', severity: 'error' });
    }

    const status = issues.some((i) => i.severity === 'error')
      ? 'failed'
      : issues.length
        ? 'warning'
        : 'passed';
    return { status, issues };
  }
}

/** Absolute coordinate pairs from SVG path data, with the object's transform applied. */
function pathPoints(object) {
  const nums = (object.geometry.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const [a, b, c, d, e, f] = object.transform ?? [1, 0, 0, 1, 0, 0];
  const points = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i];
    const y = nums[i + 1];
    points.push([a * x + c * y + e, b * x + d * y + f]);
  }
  if (object.geometry.closed && points.length > 1) points.push(points[0]);
  return points;
}

/** Points every `stepMm` along the polyline, always including the end point. */
function resample(points, stepMm) {
  if (points.length < 2) return points;
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    let t = stepMm - carry;
    while (t <= len) {
      out.push([x0 + ((x1 - x0) * t) / len, y0 + ((y1 - y0) * t) / len]);
      t += stepMm;
    }
    carry = len - (t - stepMm);
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

function bounds(commands) {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  let seen = false;
  for (const [type, x, y] of commands) {
    if (type !== 'stitch' && type !== 'jump') continue;
    if (!seen) {
      minX = maxX = x;
      minY = maxY = y;
      seen = true;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function stats(commands) {
  const s = { stitches: 0, jumps: 0, trims: 0, colorChanges: 0 };
  for (const [type] of commands) {
    if (type === 'stitch') s.stitches += 1;
    else if (type === 'jump') s.jumps += 1;
    else if (type === 'trim') s.trims += 1;
    else if (type === 'color_change') s.colorChanges += 1;
  }
  return s;
}
