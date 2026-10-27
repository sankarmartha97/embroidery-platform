import { relativeMoves } from './relative-moves.js';

// Janome JEF (minimal): 116-byte header, colour table, then 2-byte signed steps (max ±127).
// Escapes: 0x80 0x01 colour change, 0x80 0x02 jump, 0x80 0x10 end. Y is positive upwards.
export const JEF_MAX_STEP = 127;
const FIXED_DATE = '20261102000000'; // fixed for deterministic output

const int8 = (v) => (v < 0 ? v + 256 : v);

export function writeJef(stitchData) {
  const colours = Math.max(1, stitchData.threads.length);
  const body = [];
  let points = 0;
  for (const move of relativeMoves(stitchData.commands, JEF_MAX_STEP)) {
    if (move.type === 'end') {
      body.push(0x80, 0x10);
      break;
    }
    if (move.type === 'color_change') {
      body.push(0x80, 0x01, 0x00, 0x00);
    } else if (move.type === 'jump') {
      body.push(0x80, 0x02, int8(move.dx), int8(-move.dy));
    } else {
      body.push(int8(move.dx), int8(-move.dy));
    }
    points += 1;
  }

  const stitchOffset = 116 + colours * 8;
  const header = Buffer.alloc(stitchOffset, 0);
  header.writeInt32LE(stitchOffset, 0);
  header.writeInt32LE(0x14, 4);
  header.write(FIXED_DATE, 8, 'latin1');
  header.writeInt32LE(colours, 24);
  header.writeInt32LE(points, 28);
  header.writeInt32LE(0, 32); // hoop code: not chosen by the fake writer

  const b = stitchData.bounds;
  header.writeInt32LE(Math.max(0, -b.minX), 36);
  header.writeInt32LE(Math.max(0, b.maxY), 40);
  header.writeInt32LE(Math.max(0, b.maxX), 44);
  header.writeInt32LE(Math.max(0, -b.minY), 48);
  for (let off = 52; off < 116; off += 4) header.writeInt32LE(-1, off);

  for (let i = 0; i < colours; i++) {
    header.writeInt32LE((i % 78) + 1, 116 + i * 4); // Janome palette index (placeholder mapping)
    header.writeInt32LE(0x0d, 116 + colours * 4 + i * 4);
  }
  return Buffer.concat([header, Buffer.from(body)]);
}
