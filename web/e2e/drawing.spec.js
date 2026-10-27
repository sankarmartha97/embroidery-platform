// S3-05 / S3-06: draw with real pointer input, check the saved document through the API,
// edit nodes, and run Validate on the drawn design.
import { expect, test } from '@playwright/test';

const TOKEN = process.env.E2E_TOKEN;
const SHOTS = process.env.E2E_SCREENSHOTS;
const TAJIMA_100 = '00000000-0000-7000-8000-000000000101';

test.describe.configure({ mode: 'serial' });

test.describe('Drawing tools', () => {
  test.skip(!TOKEN, 'E2E_TOKEN is not set');
  let page;
  let projectId;
  const consoleErrors = [];

  const api = async (method, path, data) => {
    const res = await page.request.fetch(`/api/v1${path}`, { method, data });
    return res.json();
  };
  const savedObjects = async () =>
    (await api('GET', `/design-projects/${projectId}`)).draft.objects;
  const saved = () =>
    expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });

  /** Screen position of a canvas point in mm, from the hoop's on-screen box (100 × 100 mm). */
  async function at(x, y) {
    const box = await page.locator('.hoop-field').boundingBox();
    return [box.x + (x * box.width) / 100, box.y + (y * box.height) / 100];
  }
  async function drag(from, to, { shift = false } = {}) {
    await page.mouse.move(...(await at(...from)));
    await page.mouse.down();
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(...(await at(...to)), { steps: 8 });
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  }
  async function click(x, y) {
    await page.mouse.click(...(await at(x, y)));
  }
  /** Path data numbers, for comparisons within the 0.1 mm snapping. */
  const numbers = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);
  const near = (actual, expected, tolerance = 0.25) =>
    expected.forEach((v, i) => expect(Math.abs(actual[i] - v)).toBeLessThanOrEqual(tolerance));

  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: 'emb_session', value: TOKEN, url: baseURL, httpOnly: true }]);
    page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    await page.goto('/projects');
    const project = await api('POST', '/design-projects', {
      title: `Drawing ${Date.now()}`,
      machineProfileId: TAJIMA_100,
    });
    projectId = project.id;
    await page.goto(`/studio/${projectId}`);
    await expect(page.locator('.hoop-field')).toBeVisible();
    await page.getByTestId('canvas').focus();
  });
  test.afterAll(async () => page.context().close());

  test('draws a rectangle by dragging, as a closed fill object', async () => {
    await page.keyboard.press('r');
    await expect(page.getByRole('button', { name: 'Rectangle (R)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await drag([10, 10], [40, 30]);
    await expect(page.locator('.sequence-name')).toHaveText(['Rectangle 1']);
    await expect(page.getByRole('button', { name: 'Select (V)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByLabel('Stitch type')).toHaveValue('fill');
    await saved();
    const [rect] = await savedObjects();
    expect(rect.geometry.closed).toBe(true);
    expect(rect.stitch).toEqual({ type: 'fill', threadId: 't1' });
    near(numbers(rect.geometry.d), [10, 10, 40, 10, 40, 30, 10, 30]);
  });

  test('draws a circle with Shift + ellipse', async () => {
    await page.keyboard.press('e');
    await drag([50, 10], [80, 20], { shift: true });
    await expect(page.locator('.sequence-name').last()).toHaveText('Ellipse 1');
    await saved();
    const ellipse = (await savedObjects()).find((o) => o.name === 'Ellipse 1');
    // M x cy A rx ry …: Shift made rx = ry = 15 (a 30 mm circle)
    const [, , rx, ry] = numbers(ellipse.geometry.d);
    near([rx, ry], [15, 15]);
  });

  test('draws a polygon by clicking points and closing on the first one', async () => {
    await page.keyboard.press('g');
    await click(10, 50);
    await click(40, 50);
    await click(25, 75);
    await click(10, 50); // the first point closes the shape
    await expect(page.locator('.sequence-name').last()).toHaveText('Polygon 1');
    await saved();
    const polygon = (await savedObjects()).find((o) => o.name === 'Polygon 1');
    expect(polygon.geometry.closed).toBe(true);
    near(numbers(polygon.geometry.d), [10, 50, 40, 50, 25, 75]);
  });

  test('draws an open pen path with a curve, finished with Enter', async () => {
    await page.keyboard.press('p');
    await click(50, 50);
    await drag([70, 60], [80, 60]); // click-drag: a smooth node with handles
    await click(90, 90);
    await page.keyboard.press('Enter');
    await expect(page.locator('.sequence-name').last()).toHaveText('Path 1');
    await expect(page.getByLabel('Stitch type')).toHaveValue('running');
    await saved();
    const path = (await savedObjects()).find((o) => o.name === 'Path 1');
    expect(path.geometry.closed).toBe(false);
    expect(path.geometry.d).toMatch(/^M\S+ \S+ C/);
  });

  test('cancels a shape in progress with Escape', async () => {
    const before = await page.locator('.sequence-name').count();
    await page.keyboard.press('g');
    await click(60, 80);
    await click(70, 80);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape'); // second Escape leaves the tool
    await expect(page.getByRole('button', { name: 'Select (V)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.sequence-name')).toHaveCount(before);
  });

  test('edits nodes: dragging a corner of the rectangle reshapes it', async () => {
    await page.getByRole('button', { name: 'Rectangle 1 fill' }).click();
    await page.getByRole('button', { name: 'Edit points' }).click();
    await expect(page.locator('[data-node]')).toHaveCount(4);
    const corner = page.locator('[data-node="1"]'); // (40, 10)
    const box = await corner.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(...(await at(45, 5)), { steps: 8 });
    await page.mouse.up();
    await saved();
    const rect = (await savedObjects()).find((o) => o.name === 'Rectangle 1');
    near(numbers(rect.geometry.d).slice(2, 4), [45, 5]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/drawing.png` });
    await page.getByRole('button', { name: 'Done editing points' }).click();
    await expect(page.locator('[data-node]')).toHaveCount(0);
  });

  test('undo removes the last drawn shape', async () => {
    const count = await page.locator('.sequence-name').count();
    await page.getByRole('button', { name: 'Undo' }).click(); // the node edit
    await page.getByRole('button', { name: 'Undo' }).click(); // the pen path
    await expect(page.locator('.sequence-name')).toHaveCount(count - 1);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.locator('.sequence-name')).toHaveCount(count);
    await saved();
  });

  test('the drawn design validates against the machine', async () => {
    await page.getByRole('button', { name: /^Validate/ }).click();
    await expect(page.getByTestId('job-validate')).toContainText('Done', { timeout: 30_000 });
    await expect(page.getByRole('tab', { name: /Issues/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('logged no errors in the browser console', () => {
    expect(consoleErrors).toEqual([]);
  });
});
