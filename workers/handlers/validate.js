import { EngineError } from '../engines/digitizing-engine.js';

/** stitch_data + machine profile → validation report artifact (QUALITY-01). */
export async function validateStitches({ stitchData, engine, machineProfile, signal }) {
  if (!machineProfile) {
    throw new EngineError('INVALID_DOCUMENT', 'validation needs a machine profile');
  }
  const result = await engine.validate(stitchData, machineProfile, { signal });
  // The report records what it was checked against, so a reader knows which machine it is for.
  const report = {
    ...result,
    machineProfile: {
      id: machineProfile.id ?? null,
      name: machineProfile.name ?? null,
      hoopWidthMm: machineProfile.hoopWidthMm,
      hoopHeightMm: machineProfile.hoopHeightMm,
    },
    engine: engine.describe().name,
  };
  return [
    {
      artifactType: 'report',
      formatCode: 'json',
      ext: 'json',
      body: Buffer.from(JSON.stringify(report)),
      contentType: 'application/json',
      validationStatus: result.status,
    },
  ];
}
