import { gzipSync } from 'node:zlib';
import { validateDocument } from '../../src/lib/document/validate-document.js';
import { EngineError } from '../engines/digitizing-engine.js';
import { stitchStats } from './stitch-stats.js';

/** Project version → one stitch_data artifact (gzip JSON). Simulate and export read it. */
export async function digitize({ version, engine, machineProfile, signal }) {
  // Never trust the stored document blindly: it is validated again before the engine sees it.
  const issues = validateDocument(version.document);
  if (issues.length) {
    throw new EngineError('INVALID_DOCUMENT', `document failed validation: ${issues[0].path}`);
  }
  const stitchData = await engine.generateStitches(
    { ...version.document, sourceVersionId: version.id },
    { machineProfile, signal },
  );
  return [
    {
      artifactType: 'stitch_data',
      formatCode: 'json',
      ext: 'json.gz',
      body: gzipSync(JSON.stringify(stitchData)),
      contentType: 'application/json',
      contentEncoding: 'gzip',
      ...stitchStats(stitchData),
    },
  ];
}
