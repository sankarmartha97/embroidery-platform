// Engine-neutral validation of stitch data against a machine profile (QUALITY-01, delivery plan
// S6-01; rules in 05-digitizing-engine/validation-and-errors.md). Stitch data is the same for
// every engine (stitch-data format v1), so any engine adapter can reuse these rules.
//
// Units: stitch data is absolute 0.1 mm, centred on the design origin; profiles are in mm.
// Issue: { code, severity: 'error' | 'warning', count, objectIds, message }

export const DEFAULTS = Object.freeze({
  minStitchLengthMm: 0.3,
  maxStitchLengthMm: 12.1,
  hoopMarginMm: 0,
});
const MAX_OBJECT_IDS = 20;

/** commandIndex → objectId, from the stitch data's objectMap. */
function objectLookup(objectMap = []) {
  const ranges = [...objectMap].sort((a, b) => a.fromCommand - b.fromCommand);
  return (index) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid];
      if (index < r.fromCommand) hi = mid - 1;
      else if (index > r.toCommand) lo = mid + 1;
      else return r.objectId;
    }
    return null;
  };
}

/** Collects occurrences of one rule, keeping the objects involved (capped). */
function collector(code, severity, message) {
  const ids = new Set();
  let count = 0;
  return {
    hit(objectId) {
      count += 1;
      if (objectId && ids.size < MAX_OBJECT_IDS) ids.add(objectId);
    },
    issue() {
      return count ? { code, severity, count, objectIds: [...ids], message } : null;
    },
  };
}

/**
 * @param stitchData stitch-data format v1
 * @param profile { hoopWidthMm, hoopHeightMm, minStitchLengthMm?, maxStitchLengthMm?,
 *   maxColors?, trimJumpThresholdMm?, hoopMarginMm? }
 * @param options { longStitchesSplit?: boolean } true when the target writer splits long stitches
 *   (then STITCH_TOO_LONG is a warning, otherwise an error)
 * @returns {{ status: 'passed' | 'warning' | 'failed', issues: object[] }}
 */
export function validateStitchData(stitchData, profile, { longStitchesSplit = false } = {}) {
  const p = { ...DEFAULTS, ...dropNulls(profile) };
  const objectAt = objectLookup(stitchData.objectMap);
  const minLen = p.minStitchLengthMm * 10;
  const maxLen = p.maxStitchLengthMm * 10;
  const halfW = ((p.hoopWidthMm - 2 * p.hoopMarginMm) * 10) / 2;
  const halfH = ((p.hoopHeightMm - 2 * p.hoopMarginMm) * 10) / 2;
  const trimThreshold = p.trimJumpThresholdMm ? p.trimJumpThresholdMm * 10 : null;

  const outOfHoop = collector('OUT_OF_HOOP', 'error', 'Stitches fall outside the hoop');
  const tooLong = collector(
    'STITCH_TOO_LONG',
    longStitchesSplit ? 'warning' : 'error',
    `Stitches longer than ${p.maxStitchLengthMm} mm`,
  );
  const tooShort = collector(
    'STITCH_TOO_SHORT',
    'warning',
    `Stitches shorter than ${p.minStitchLengthMm} mm`,
  );
  const missingTrim = collector(
    'MISSING_TRIM',
    'warning',
    `Jumps longer than ${p.trimJumpThresholdMm} mm without a trim`,
  );

  let stitches = 0;
  let pos = null; // frame position after the previous move
  let afterStitch = false; // the previous move was a stitch (a needle penetration)
  let trimmed = false; // a trim since the last stitch
  let jump = null; // current run of jumps: { length, objectId }

  const endJumpRun = () => {
    if (jump && trimThreshold !== null && jump.length > trimThreshold && !trimmed) {
      missingTrim.hit(jump.objectId);
    }
    jump = null;
  };

  stitchData.commands.forEach(([type, x, y], index) => {
    if (type === 'trim') trimmed = true;
    if (type !== 'stitch' && type !== 'jump') {
      afterStitch = false;
      return;
    }
    const objectId = objectAt(index);
    if (Math.abs(x) > halfW || Math.abs(y) > halfH) outOfHoop.hit(objectId);
    const length = pos ? Math.hypot(x - pos[0], y - pos[1]) : 0;

    if (type === 'jump') {
      if (!jump) jump = { length: 0, objectId };
      jump.length += length;
    } else {
      endJumpRun();
      stitches += 1;
      if (pos && length > maxLen) tooLong.hit(objectId);
      // Short stitches count only between two penetrations: the first stitch after a jump lands
      // where the jump ended, which is a normal needle-down, not a short stitch.
      if (afterStitch && length < minLen) tooShort.hit(objectId);
      trimmed = false;
    }
    afterStitch = type === 'stitch';
    pos = [x, y];
  });
  endJumpRun();

  const issues = [];
  if (stitches === 0) {
    issues.push({
      code: 'EMPTY_DESIGN',
      severity: 'error',
      count: 1,
      objectIds: [],
      message: 'The design has no stitches',
    });
  }
  const colours = stitches > 0 ? (stitchData.stats?.colorChanges ?? 0) + 1 : 0;
  if (p.maxColors && colours > p.maxColors) {
    issues.push({
      code: 'TOO_MANY_COLORS',
      severity: 'error',
      count: colours,
      objectIds: [],
      message: `${colours} colours; this machine allows ${p.maxColors}`,
    });
  }
  for (const c of [outOfHoop, tooLong, tooShort, missingTrim]) {
    const issue = c.issue();
    if (issue) issues.push(issue);
  }

  const status = issues.some((i) => i.severity === 'error')
    ? 'failed'
    : issues.length
      ? 'warning'
      : 'passed';
  return { status, issues };
}

function dropNulls(obj = {}) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}
