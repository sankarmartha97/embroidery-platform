import { createSummary } from './summary.js';

// Independent DST reader for QA (S1-16). Decodes 3-byte records after a 512-byte header.
const bit = (b, n) => (b >> n) & 1;

function decodeX(b0, b1, b2) {
  return (
    bit(b2, 2) * 81 -
    bit(b2, 3) * 81 +
    bit(b1, 2) * 27 -
    bit(b1, 3) * 27 +
    bit(b0, 2) * 9 -
    bit(b0, 3) * 9 +
    bit(b1, 0) * 3 -
    bit(b1, 1) * 3 +
    bit(b0, 0) -
    bit(b0, 1)
  );
}

function decodeY(b0, b1, b2) {
  const up =
    bit(b2, 5) * 81 -
    bit(b2, 4) * 81 +
    bit(b1, 5) * 27 -
    bit(b1, 4) * 27 +
    bit(b0, 5) * 9 -
    bit(b0, 4) * 9 +
    bit(b1, 7) * 3 -
    bit(b1, 6) * 3 +
    bit(b0, 7) -
    bit(b0, 6);
  return -up; // report with y pointing down, like stitch data
}

function headerField(header, key) {
  const m = header.match(new RegExp(`${key}:([^\\r]*)\\r`));
  return m ? m[1].trim() : null;
}

export function readDst(buffer) {
  if (buffer.length < 512) throw new Error('DST file is shorter than its 512-byte header');
  const header = buffer.subarray(0, 512).toString('latin1');
  const summary = createSummary('DST');
  let records = 0;

  for (let i = 512; i + 2 < buffer.length; i += 3) {
    const [b0, b1, b2] = [buffer[i], buffer[i + 1], buffer[i + 2]];
    records += 1;
    if ((b2 & 0b11110011) === 0b11110011) {
      summary.end();
      break;
    }
    const dx = decodeX(b0, b1, b2);
    const dy = decodeY(b0, b1, b2);
    if ((b2 & 0b11000011) === 0b11000011) summary.colorChange();
    else if ((b2 & 0b10000011) === 0b10000011) summary.move('jump', dx, dy);
    else summary.move('stitch', dx, dy);
  }

  const declared = Number(headerField(header, 'ST'));
  if (Number.isFinite(declared) && declared !== records) {
    summary.warn(`header ST=${declared} but file has ${records} records`);
  }
  const declaredColours = Number(headerField(header, 'CO'));
  const result = summary.result({ label: headerField(header, 'LA'), records });
  if (Number.isFinite(declaredColours) && declaredColours !== result.colorChanges) {
    result.warnings.push(
      `header CO=${declaredColours} but file has ${result.colorChanges} colour changes`,
    );
  }
  if (!result.ended) result.warnings.push('no end record');
  return result;
}
