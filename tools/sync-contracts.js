// Copies the contract files from the docs repository (the source of truth) into contracts/.
// Usage: npm run contracts:sync [-- <path-to-embroidery-platform-docs>]
import { copyFile } from 'node:fs/promises';
import path from 'node:path';

const docs = path.resolve(process.argv[2] ?? '../embroidery-platform-docs');
const files = [
  ['04-api/openapi.yaml', 'contracts/openapi.yaml'],
  ['05-digitizing-engine/project-document.schema.json', 'contracts/project-document.schema.json'],
];
for (const [from, to] of files) {
  await copyFile(path.join(docs, from), to);
  console.log(`synced ${to}`);
}
console.log('Migrations are copied by hand: never edit an applied migration.');
