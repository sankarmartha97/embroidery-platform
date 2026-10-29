// S6-08 / S7-02: the stitch simulator against the live stack. It digitizes the saved draft (or
// reuses the version's stitch data), plays it, steps with the keyboard, selects an object by
// clicking a stitch, and marks itself out of date after an edit.
import { expect, test } from '@playwright/test';
import { heartDocument } from '../../test/helpers/documents.js';

const TOKEN = process.env.E2E_TOKEN;
const SHOTS = process.env.E2E_SCREENSHOTS;
const TAJIMA_100 = '00000000-0000-7000-8000-000000000101';

test.describe('Stitch simulator', () => {
  test.skip(!TOKEN, 'E2E_TOKEN is not set');

  test('plays, steps, selects by stitch and goes out of date', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: 'emb_session', value: TOKEN, url: baseURL, httpOnly: true }]);
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/projects');
    const project = await (
      await page.request.post('/api/v1/design-projects', {
        data: { title: `Simulate ${Date.now()}`, machineProfileId: TAJIMA_100 },
      })
    ).json();
    await page.request.put(`/api/v1/design-projects/${project.id}/draft`, {
      data: heartDocument(),
      headers: { 'If-Match': '"0"' },
    });
    await page.goto(`/studio/${project.id}`);

    await page.getByRole('button', { name: 'Simulate' }).click();
    const sim = page.getByTestId('simulator');
    await expect(sim).toBeVisible({ timeout: 30_000 });
    const counter = sim.getByTestId('sim-counter');
    await expect(counter).toHaveText(/^Stitch (\S+) of \1$/); // opens on the finished design
    const total = Number((await counter.textContent()).match(/of (\S+)/)[1].replace(/,/g, ''));
    expect(total).toBeGreaterThan(10);
    await expect(sim.getByText(/\d+ colour changes?$/)).toBeVisible();

    // Keyboard: back to the first colour, then step.
    await sim.getByLabel('Stitch simulator').focus();
    await page.keyboard.press('[');
    await page.keyboard.press('[');
    await expect(counter).toHaveText(`Stitch 1 of ${total}`);
    await page.keyboard.press('.');
    await expect(counter).toHaveText(`Stitch 2 of ${total}`);

    // Play a moment, then pause.
    await sim.getByRole('button', { name: 'Play (Space)' }).click();
    await expect(counter).not.toHaveText(`Stitch 2 of ${total}`);
    await sim.getByRole('button', { name: 'Pause (Space)' }).click();
    await sim.getByRole('button', { name: 'Next colour (])' }).click();
    await sim.getByRole('button', { name: 'Next colour (])' }).click();
    await expect(counter).toHaveText(`Stitch ${total} of ${total}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/simulator.png` });

    // Click a stitch of the underline (y = 80 mm, x 30–70) to select it.
    const box = await sim.locator('.simulator-overlay').boundingBox();
    const scale = Math.min((box.width - 64) / 100, (box.height - 64) / 100);
    const sx = box.x + box.width / 2 + (50 - 50) * scale;
    const sy = box.y + box.height / 2 + (80 - 50) * scale;
    await page.mouse.click(sx, sy);
    await expect(page.getByLabel('Name')).toHaveAttribute('placeholder', 'underline');

    // An edit makes the simulation out of date; simulating again clears it.
    await page.getByLabel('Name').fill('Base line');
    await page.getByLabel('Name').blur();
    await expect(sim.getByText('The design changed after this simulation.')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });
    await sim.getByRole('button', { name: 'Simulate again' }).click();
    await expect(sim.getByText('The design changed after this simulation.')).toBeHidden({
      timeout: 30_000,
    });

    await sim.getByRole('button', { name: 'Back to editing' }).click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  });
});
