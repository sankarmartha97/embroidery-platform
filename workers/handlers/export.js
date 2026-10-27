import { stitchStats } from './stitch-stats.js';

/** stitch_data → machine file in the requested format. Never re-digitizes. */
export async function exportFile({ job, stitchData, engine, machineProfile, signal }) {
  const { buffer, formatCode } = await engine.exportMachineFile(
    stitchData,
    job.targetFormat,
    machineProfile,
    { signal },
  );
  return [
    {
      artifactType: 'machine_file',
      formatCode,
      ext: formatCode.toLowerCase(),
      body: buffer,
      contentType: 'application/octet-stream',
      ...stitchStats(stitchData),
    },
  ];
}
