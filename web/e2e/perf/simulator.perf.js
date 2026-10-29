// S6-08 "50k-stitch design plays smoothly": plays a synthetic 50,000-stitch design in the real
// simulator (the stitch-data response is replaced in the browser) and measures frame times.
// Run: E2E_PERF=1 npx playwright test --config playwright.perf.config.js
import { expect, test } from '@playwright/test';
import { heartDocument } from '../../../test/helpers/documents.js';

const TOKEN = process.env.E2E_TOKEN;
const TAJIMA_100 = '00000000-0000-7000-8000-000000000101';
const STITCHES = Number(process.env.SIM_STITCHES ?? 50_000);
// Chrome CPU slowdown (CDP), e.g. 4 to approximate an older laptop.
const CPU_SLOWDOWN = Number(process.env.SIM_CPU_SLOWDOWN ?? 1);

/** A dense fill-like zigzag over 8 colour blocks, with a jump and trim between blocks. */
function syntheticStitchData() {
  const commands = [];
  const objectMap = [];
  const blocks = 8;
  const per = STITCHES / blocks;
  for (let b = 0; b < blocks; b++) {
    const from = commands.length;
    if (b > 0) commands.push(['trim'], ['color_change', b]);
    const top = -400 + b * 100;
    for (let i = 0; i < per; i++) {
      const row = Math.floor(i / 200);
      const col = i % 200;
      const x = -400 + (row % 2 ? 199 - col : col) * 4;
      const y = top + row * 2 + (i % 2);
      commands.push([i === 0 && b > 0 ? 'jump' : 'stitch', x, y]);
      if (i === 0 && b > 0) commands.push(['stitch', x, y]);
    }
    objectMap.push({ objectId: `block-${b}`, fromCommand: from, toCommand: commands.length - 1 });
  }
  commands.push(['end']);
  const palette = [
    '#CC3344',
    '#2244AA',
    '#22AA55',
    '#EEAA22',
    '#8844CC',
    '#22AACC',
    '#AA2266',
    '#444444',
  ];
  return {
    format: 'emb-stitch-data',
    version: 1,
    units: '0.1mm',
    threads: palette.map((hex, index) => ({ index, hex })),
    commands,
    objectMap,
  };
}

test.describe('Simulator performance', () => {
  test.skip(!TOKEN || !process.env.E2E_PERF, 'set E2E_PERF=1 and E2E_TOKEN');

  test(`plays ${STITCHES} stitches smoothly (CPU ×${CPU_SLOWDOWN})`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: 'emb_session', value: TOKEN, url: baseURL, httpOnly: true }]);
    const page = await context.newPage();
    const data = syntheticStitchData();
    await page.route('**/api/v1/artifacts/*/stitch-data', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) }),
    );
    await page.goto('/projects');
    const project = await (
      await page.request.post('/api/v1/design-projects', {
        data: { title: `Perf ${Date.now()}`, machineProfileId: TAJIMA_100 },
      })
    ).json();
    await page.request.put(`/api/v1/design-projects/${project.id}/draft`, {
      data: heartDocument(),
      headers: { 'If-Match': '"0"' },
    });
    await page.goto(`/studio/${project.id}`);

    const opened = Date.now();
    await page.getByRole('button', { name: 'Simulate' }).click();
    const sim = page.getByTestId('simulator');
    const counter = sim.getByTestId('sim-counter');
    await expect(counter).toHaveText(new RegExp(`of ${STITCHES.toLocaleString('en-GB')}$`), {
      timeout: 60_000,
    });
    const openMs = Date.now() - opened; // includes saving, the version and the digitize job
    // Slow the CPU only now: the dev build's page load is not what this measures.
    if (CPU_SLOWDOWN > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
    }

    /** Times one control action: until two animation frames have painted after it. */
    const timed = async (action) => {
      const t0 = await page.evaluate(() => performance.now());
      await action();
      return page.evaluate(
        (start) =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(performance.now() - start)),
            ),
          ),
        t0,
      );
    };
    const scrubToStartMs = await timed(() => sim.getByLabel('Position').fill('0'));
    const jumpToEndMs = await timed(() => sim.getByLabel('Position').fill(String(STITCHES + 6)));
    const jumpsToggleMs = await timed(() => sim.getByLabel('Jumps').click());

    // Play from the start at 1000 stitches/s (the top speed) and record frame intervals.
    await sim.getByLabel('Position').fill('0');
    await sim.getByLabel('Stitches per second').fill('1000');
    await page.evaluate(() => {
      window.__frames = [];
      window.__longTasks = 0;
      new PerformanceObserver((list) => (window.__longTasks += list.getEntries().length)).observe({
        type: 'longtask',
      });
      let last = performance.now();
      const loop = (now) => {
        window.__frames.push(now - last);
        last = now;
        if (window.__frames.length < 300) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await sim.getByRole('button', { name: 'Play (Space)' }).click();
    await page.waitForFunction(() => window.__frames.length >= 300, null, { timeout: 30_000 });
    const { frames, longTasks } = await page.evaluate(() => ({
      frames: window.__frames.slice(5),
      longTasks: window.__longTasks,
    }));
    await sim.getByRole('button', { name: 'Pause (Space)' }).click();

    const sorted = [...frames].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    const result = {
      openMs,
      scrubToStartMs: Math.round(scrubToStartMs),
      jumpToEndMs: Math.round(jumpToEndMs),
      jumpsToggleMs: Math.round(jumpsToggleMs),
      fps: Math.round(1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)),
      frameP50: Math.round(pct(50) * 10) / 10,
      frameP95: Math.round(pct(95) * 10) / 10,
      frameMax: Math.round(sorted[sorted.length - 1] * 10) / 10,
      longTasks,
    };
    console.log(`SIM-PERF ${JSON.stringify(result)}`);
    await context.close();

    // FS-8.2: playback holds ~60 fps. A full redraw (jump to the end, toggling jumps) is a one-off
    // pause after a click; it stays under half a second even at 100k stitches on a 4× slower CPU.
    expect(result.frameP95).toBeLessThan(25);
    expect(result.longTasks).toBe(0);
    expect(result.jumpToEndMs).toBeLessThan(500);
    expect(result.jumpsToggleMs).toBeLessThan(500);
    expect(result.scrubToStartMs).toBeLessThan(500);
  });
});
