import { createSummary } from './summary.js';

// Independent JEF reader for QA (S1-16).
// Header: int32 stitch offset @0, int32 colour count @24, palette indexes from @116.
const signed8 = (b) => (b > 127 ? b - 256 : b);

export function readJef(buffer) {
  if (buffer.length < 116) throw new Error('JEF file is shorter than its header');
  const stitchOffset = buffer.readInt32LE(0);
  const colourCount = buffer.readInt32LE(24);
  if (stitchOffset < 116 || stitchOffset > buffer.length)
    throw new Error('Invalid JEF stitch offset');

  const palette = [];
  for (let i = 0; i < colourCount && 116 + i * 4 + 3 < stitchOffset; i++) {
    palette.push(buffer.readInt32LE(116 + i * 4));
  }

  const summary = createSummary('JEF');
  let i = stitchOffset;
  while (i + 1 < buffer.length) {
    const b0 = buffer[i];
    const b1 = buffer[i + 1];
    i += 2;
    if (b0 !== 0x80) {
      summary.move('stitch', signed8(b0), -signed8(b1));
      continue;
    }
    if (b1 === 0x10) {
      summary.end();
      break;
    }
    if (i + 1 >= buffer.length) break;
    const dx = signed8(buffer[i]);
    const dy = -signed8(buffer[i + 1]);
    i += 2;
    if (b1 === 0x01) summary.colorChange();
    else if (b1 === 0x02) summary.move('jump', dx, dy);
    else summary.warn(`unknown control 0x${b1.toString(16)}`);
  }

  const result = summary.result({ paletteIndexes: palette });
  if (colourCount !== result.colours) {
    result.warnings.push(
      `header colour count ${colourCount} but file has ${result.colours} colour blocks`,
    );
  }
  if (!result.ended) result.warnings.push('no end record');
  return result;
}
