import { readDst } from './dst.js';
import { readJef } from './jef.js';

const READERS = { dst: readDst, jef: readJef };

/** Reads a machine file and returns counts, extents and colours. PES is not supported yet. */
export function readMachineFile(buffer, extension) {
  const reader = READERS[extension.toLowerCase()];
  if (!reader)
    throw new Error(`No reader for .${extension} (supported: ${Object.keys(READERS).join(', ')})`);
  return reader(buffer);
}
