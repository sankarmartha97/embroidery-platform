// Artifact metadata from stitch data (stitch-data format v1: absolute 0.1 mm units).

export function stitchStats(stitchData) {
  const { stats, bounds } = stitchData;
  return {
    stitchCount: stats.stitches,
    colorCount: stats.stitches > 0 ? stats.colorChanges + 1 : 0,
    trimCount: stats.trims,
    jumpCount: stats.jumps,
    widthMm: (bounds.maxX - bounds.minX) / 10,
    heightMm: (bounds.maxY - bounds.minY) / 10,
  };
}
