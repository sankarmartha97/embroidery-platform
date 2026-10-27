/** Accumulates absolute positions (0.1 mm, y down) and counts from decoded moves. */
export function createSummary(format) {
  let x = 0;
  let y = 0;
  const s = {
    format,
    stitches: 0,
    jumps: 0,
    colorChanges: 0,
    ended: false,
    extents: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    warnings: [],
  };
  let seenStitch = false;
  return {
    move(type, dx, dy) {
      x += dx;
      y += dy;
      if (type === 'stitch') {
        s.stitches += 1;
        if (!seenStitch) {
          s.extents = { minX: x, minY: y, maxX: x, maxY: y };
          seenStitch = true;
        }
      } else if (type === 'jump') s.jumps += 1;
      if (type === 'stitch' || (type === 'jump' && seenStitch)) {
        s.extents.minX = Math.min(s.extents.minX, x);
        s.extents.maxX = Math.max(s.extents.maxX, x);
        s.extents.minY = Math.min(s.extents.minY, y);
        s.extents.maxY = Math.max(s.extents.maxY, y);
      }
    },
    colorChange() {
      s.colorChanges += 1;
    },
    end() {
      s.ended = true;
    },
    warn(message) {
      s.warnings.push(message);
    },
    result(extra = {}) {
      const e = s.extents;
      return {
        ...s,
        widthMm: (e.maxX - e.minX) / 10,
        heightMm: (e.maxY - e.minY) / 10,
        colours: s.colorChanges + 1,
        ...extra,
      };
    },
  };
}
