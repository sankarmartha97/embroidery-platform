import { relativeMoves } from './relative-moves.js';

// Tajima DST: 512-byte ASCII header, then 3-byte records. Each axis is a balanced-ternary
// sum of ±1, ±3, ±9, ±27, ±81 (max ±121 per record). Y is positive upwards in DST.
// [byte, bit] positions for +/- of each weight.
const X_POS = { 1: [0, 0], 3: [1, 0], 9: [0, 2], 27: [1, 2], 81: [2, 2] };
const X_NEG = { 1: [0, 1], 3: [1, 1], 9: [0, 3], 27: [1, 3], 81: [2, 3] };
const Y_POS = { 1: [0, 7], 3: [1, 7], 9: [0, 5], 27: [1, 5], 81: [2, 5] };
const Y_NEG = { 1: [0, 6], 3: [1, 6], 9: [0, 4], 27: [1, 4], 81: [2, 4] };
const WEIGHTS = [1, 3, 9, 27, 81];
export const DST_MAX_STEP = 121;

function balancedTernary(value) {
  const digits = {};
  let n = value;
  for (const w of WEIGHTS) {
    let r = ((n % 3) + 3) % 3;
    if (r === 2) r = -1;
    digits[w] = r;
    n = (n - r) / 3;
  }
  if (n !== 0) throw new RangeError(`DST step out of range: ${value}`);
  return digits;
}

function encodeRecord(dx, dy, type) {
  const bytes = [0, 0, 0];
  const set = ([byte, bit]) => {
    bytes[byte] |= 1 << bit;
  };
  const xd = balancedTernary(dx);
  const yd = balancedTernary(-dy); // our y points down
  for (const w of WEIGHTS) {
    if (xd[w] === 1) set(X_POS[w]);
    if (xd[w] === -1) set(X_NEG[w]);
    if (yd[w] === 1) set(Y_POS[w]);
    if (yd[w] === -1) set(Y_NEG[w]);
  }
  bytes[2] |= 0x03;
  if (type === 'jump') bytes[2] |= 0x80;
  if (type === 'color_change') bytes[2] |= 0xc0;
  return bytes;
}

export function writeDst(stitchData, { label = 'emb-fake' } = {}) {
  const records = [];
  let colorChanges = 0;
  for (const move of relativeMoves(stitchData.commands, DST_MAX_STEP)) {
    if (move.type === 'end') {
      records.push([0x00, 0x00, 0xf3]);
      break;
    }
    if (move.type === 'color_change') colorChanges += 1;
    records.push(encodeRecord(move.dx, move.dy, move.type));
  }

  const b = stitchData.bounds;
  const pad = (n, w) => String(n).padStart(w, ' ');
  const header =
    `LA:${label.slice(0, 16).padEnd(16, ' ')}\r` +
    `ST:${pad(records.length, 7)}\r` +
    `CO:${pad(colorChanges, 3)}\r` +
    `+X:${pad(Math.max(0, b.maxX), 5)}\r` +
    `-X:${pad(Math.max(0, -b.minX), 5)}\r` +
    `+Y:${pad(Math.max(0, -b.minY), 5)}\r` +
    `-Y:${pad(Math.max(0, b.maxY), 5)}\r` +
    `AX:+${pad(0, 5)}\r` +
    `AY:+${pad(0, 5)}\r` +
    `MX:+${pad(0, 5)}\r` +
    `MY:+${pad(0, 5)}\r` +
    `PD:******\r\x1a`;
  const head = Buffer.alloc(512, 0x20);
  head.write(header, 0, 'latin1');
  return Buffer.concat([head, Buffer.from(records.flat())]);
}
