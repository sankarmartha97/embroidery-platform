// Usage: npm run harness -- <file.dst|file.jef> [...] [--json]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readMachineFile } from './index.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const files = args.filter((a) => a !== '--json');
if (files.length === 0) {
  console.error('Usage: npm run harness -- <file.dst|file.jef> [...] [--json]');
  process.exit(2);
}

let failed = false;
const results = [];
for (const file of files) {
  try {
    const result = readMachineFile(await readFile(file), path.extname(file).slice(1));
    results.push({ file, ...result });
  } catch (err) {
    failed = true;
    results.push({ file, error: err.message });
  }
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    if (r.error) {
      console.log(`${r.file}: ERROR ${r.error}`);
      continue;
    }
    console.log(
      `${r.file}: ${r.format} · ${r.stitches} stitches · ${r.jumps} jumps · ${r.colours} colours · ` +
        `${r.widthMm.toFixed(1)} × ${r.heightMm.toFixed(1)} mm${r.warnings.length ? ` · WARN ${r.warnings.join('; ')}` : ''}`,
    );
  }
}
process.exitCode = failed ? 1 : 0;
