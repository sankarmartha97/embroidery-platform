import { EngineError } from '../engines/digitizing-engine.js';

/** stitch_data + machine profile → validation report artifact (QUALITY-01). */
export async function validateStitches({ stitchData, engine, machineProfile, signal }) {
  if (!machineProfile) {
    throw new EngineError('INVALID_DOCUMENT', 'validation needs a machine profile');
  }
  const report = await engine.validate(stitchData, machineProfile, { signal });
  return [
    {
      artifactType: 'report',
      formatCode: 'json',
      ext: 'json',
      body: Buffer.from(JSON.stringify(report)),
      contentType: 'application/json',
      validationStatus: report.status,
    },
  ];
}
