// Export dialog rules (01-product/feature-specifications.md FS-8.6, FS-8.7): the machine's native
// format is pre-selected, the design must fit the hoop, a pre-export validation runs first,
// errors block the export and warnings need "Export anyway".

import { objectBounds } from './document.js';

/** The profile's native format if it is enabled, else the first enabled format. */
export function nativeFormat(formats, profile) {
  return formats.find((f) => f.code === profile?.format)?.code ?? formats[0]?.code ?? '';
}

/** Union of all object bounds in mm, or null for an empty (or unparseable) design. */
export function designBounds(document) {
  let box = null;
  for (const object of document.objects) {
    const b = objectBounds(object);
    if (!b) continue;
    box = box
      ? {
          x: Math.min(box.x, b.x),
          y: Math.min(box.y, b.y),
          r: Math.max(box.r, b.x + b.w),
          b: Math.max(box.b, b.y + b.h),
        }
      : { x: b.x, y: b.y, r: b.x + b.w, b: b.y + b.h };
  }
  return box && { x: box.x, y: box.y, w: box.r - box.x, h: box.b - box.y };
}

/**
 * Whether the design's size fits the hoop (the machine file is centred in the hoop).
 * @returns {{ fits: boolean, width: number, height: number } | null} null without a design
 */
export function hoopFit(document, profile) {
  const bounds = designBounds(document);
  if (!bounds || !profile) return null;
  return {
    fits: bounds.w <= profile.hoopWidthMm && bounds.h <= profile.hoopHeightMm,
    width: bounds.w,
    height: bounds.h,
  };
}

/**
 * Pre-export decision from a validation report.
 * @returns {{ errors: number, warnings: number, decision: 'export' | 'confirm' | 'blocked' }}
 */
export function preExportCheck(report) {
  let errors = 0;
  let warnings = 0;
  for (const issue of report?.issues ?? []) {
    if (issue.severity === 'error') errors += 1;
    else warnings += 1;
  }
  return {
    errors,
    warnings,
    decision: errors > 0 ? 'blocked' : warnings > 0 ? 'confirm' : 'export',
  };
}

/** Stage name for the progress bar: Digitizing, Validating or Writing <format>. */
export function stageLabel(job, format) {
  if (!job) return '';
  if (job.jobType === 'validate') return 'Validating';
  if (job.jobType === 'digitize') return 'Digitizing';
  // An export chained to a digitize waits (queued) while its parent makes the stitch data.
  if (job.status === 'queued' && job.parentJobId) return 'Digitizing';
  return `Writing ${format}`;
}
