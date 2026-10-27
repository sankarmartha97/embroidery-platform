// Canvas camera in millimetres (06-ui-ux/studio-editor.md): zoom to cursor, pan, fit hoop,
// actual size. A camera is { scale: px per mm, x, y: screen px of the mm origin }.

/** CSS pixels per millimetre at 96 dpi. "Actual size" is exact only on a calibrated display. */
export const PX_PER_MM = 96 / 25.4;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 200;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const toScreen = (cam, [x, y]) => [cam.x + x * cam.scale, cam.y + y * cam.scale];
export const toWorld = (cam, [sx, sy]) => [(sx - cam.x) / cam.scale, (sy - cam.y) / cam.scale];

/** Zooms by `factor` keeping the world point under (sx, sy) fixed on screen. */
export function zoomAt(cam, factor, sx, sy) {
  const scale = clamp(cam.scale * factor, MIN_SCALE, MAX_SCALE);
  const [wx, wy] = toWorld(cam, [sx, sy]);
  return { scale, x: sx - wx * scale, y: sy - wy * scale };
}

export const pan = (cam, dx, dy) => ({ ...cam, x: cam.x + dx, y: cam.y + dy });

/** Fits a mm rectangle into the viewport with padding (px) on every side. */
export function fit(viewW, viewH, rect, padding = 48) {
  const scale = clamp(
    Math.min((viewW - 2 * padding) / rect.w, (viewH - 2 * padding) / rect.h),
    MIN_SCALE,
    MAX_SCALE,
  );
  return {
    scale,
    x: viewW / 2 - (rect.x + rect.w / 2) * scale,
    y: viewH / 2 - (rect.y + rect.h / 2) * scale,
  };
}

/** 1:1 physical size (96 dpi), centred on a mm point. */
export function actualSize(viewW, viewH, [cx, cy]) {
  return { scale: PX_PER_MM, x: viewW / 2 - cx * PX_PER_MM, y: viewH / 2 - cy * PX_PER_MM };
}

/**
 * Grid: 1 mm minor and 10 mm major lines (design-system canvas tokens). Lines closer than
 * `minGapPx` on screen are hidden, so zoomed out only major (or no) lines show.
 */
export function gridLevels(scale, minGapPx = 6) {
  return { minor: scale >= minGapPx, major: scale * 10 >= minGapPx };
}

/**
 * Ruler ticks along one axis for `lengthPx` of screen, starting at screen px 0.
 * Tick spacing adapts to zoom (1, 5, 10, 50, 100 mm …); labels every major tick.
 * @returns {{ px: number, mm: number, major: boolean }[]}
 */
export function rulerTicks(cam, axis, lengthPx, minGapPx = 8) {
  const origin = axis === 'x' ? cam.x : cam.y;
  const steps = [1, 5, 10, 50, 100, 500, 1000];
  const step = steps.find((s) => s * cam.scale >= minGapPx) ?? steps.at(-1);
  const major = step * (step === 1 || step === 10 || step === 100 ? 10 : 2);
  const startMm = Math.ceil(-origin / cam.scale / step) * step + 0; // + 0 turns -0 into 0
  const ticks = [];
  for (let mm = startMm; origin + mm * cam.scale <= lengthPx; mm += step) {
    ticks.push({ px: origin + mm * cam.scale, mm, major: mm % major === 0 });
  }
  return ticks;
}
