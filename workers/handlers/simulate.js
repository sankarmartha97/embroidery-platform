/**
 * stitch_data → preview image. The return shape of renderSimulation ({ buffer, formatCode })
 * is provisional until the real engine is chosen at Gate 1; FakeEngine does not render.
 */
export async function simulate({ job, stitchData, engine, signal }) {
  const { buffer, formatCode } = await engine.renderSimulation(stitchData, {
    width: job.settings?.width ?? 800,
    height: job.settings?.height ?? 800,
    signal,
  });
  return [
    {
      artifactType: 'preview',
      formatCode,
      ext: formatCode,
      body: buffer,
      contentType: formatCode === 'svg' ? 'image/svg+xml' : `image/${formatCode}`,
    },
  ];
}
