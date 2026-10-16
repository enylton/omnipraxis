import { stat, writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

test('built ESM viewer opens private scenes, denies unassigned identities, and releases ten sessions', async ({
  page,
  browser,
  browserName,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const urls = new Set<string>();
    URL.createObjectURL = (blob) => {
      const url = originalCreate(blob);
      urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      originalRevoke(url);
    };
    Object.assign(window, { phase1ObjectUrls: urls });
  });
  await page.goto('/');
  await page.selectOption('#identity', 'unassigned');
  await page.click('#open');
  await expect(page.locator('#status')).toContainText('Error:', { timeout: 20_000 });
  await expect(page.locator('canvas')).toHaveCount(0);

  await page.selectOption('#identity', 'assigned');
  await page.click('#open');
  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 90_000 });
  await page.screenshot({ path: 'build/phase1/drill-rig.png' });
  await page.click('#close');
  await page.waitForTimeout(1_000);
  await page.selectOption('#scene', 'base');
  const cdp = await page.context().newCDPSession(page);
  const samples: {
    heap: number;
    nodes: number;
    listeners: number;
    workers: number;
    loadMs: number;
  }[] = [];
  for (let cycle = 0; cycle < 10; cycle++) {
    const started = Date.now();
    await page.click('#open');
    await expect(page.locator('#status')).toHaveText('Ready', { timeout: 90_000 });
    const loadMs = Date.now() - started;
    await expect(page.locator('canvas')).toHaveCount(1);
    await page.screenshot({ path: `build/phase1/base-cycle-${cycle}.png` });
    await page.click('#close');
    await expect(page.locator('canvas')).toHaveCount(0);
    await page.waitForTimeout(1_000); // R3F releases the canvas asynchronously after unmount.
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    const targets = await cdp.send('Target.getTargets');
    samples.push({
      heap: heap.usedSize,
      nodes: dom.nodes,
      listeners: dom.jsEventListeners,
      workers: targets.targetInfos.filter((target) => target.type === 'worker').length,
      loadMs,
    });
    expect(
      await page.evaluate(
        () => (window as unknown as { phase1ObjectUrls: Set<string> }).phase1ObjectUrls.size,
      ),
    ).toBeLessThanOrEqual(1); // Spark may retain one shared worker URL.
  }
  const settled = samples.slice(2);
  const detached = await cdp.send('DOM.getDetachedDomNodes');
  const [splats, colliders] = await Promise.all([
    stat('public/scenes/base/splats.spz'),
    stat('public/scenes/base/colliders.glb'),
  ]);
  const receipt = {
    browserName,
    browserVersion: browser.version(),
    userAgent: await page.evaluate(() => navigator.userAgent),
    fixtureBytes: splats.size + colliders.size,
    samples,
    detachedTrees: detached.detachedNodes.length,
    errors,
  };
  await writeFile('build/phase1/lifecycle.json', JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  expect(settled.at(-1)!.heap - settled[0].heap).toBeLessThan(8 * 1024 * 1024);
  expect(
    Math.max(...settled.map((sample) => sample.nodes)) -
      Math.min(...settled.map((sample) => sample.nodes)),
  ).toBeLessThanOrEqual(3);
  expect(settled.at(-1)!.listeners - settled[0].listeners).toBeLessThanOrEqual(1);
  expect(
    Math.max(...settled.map((sample) => sample.workers)) -
      Math.min(...settled.map((sample) => sample.workers)),
  ).toBeLessThanOrEqual(1);
  // R3F retains its last loop state; there must not be a canvas for every old session.
  expect(detached.detachedNodes.length).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('public RAD/RADC pages load anonymously from tokenless Storage URLs', async ({ page }) => {
  const pages: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('.radc') && response.ok()) pages.push(response.url());
  });
  await page.goto('/');
  await page.selectOption('#identity', 'anonymous');
  await page.selectOption('#scene', 'circuit-breaker');
  await page.click('#open');
  await expect(page.locator('#status')).toHaveText('Ready', { timeout: 90_000 });
  await expect.poll(() => pages.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(pages.every((url) => url.includes('alt=media') && !url.includes('token='))).toBe(true);
  await page.screenshot({ path: 'build/phase1/public-paging.png' });
  await page.click('#close');
  await page.waitForTimeout(1_000);
  expect(errors).toEqual([]);
});

test('closing during a private download does not mount a stale viewer', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/splats\.spz\?alt=media/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/');
  const request = page.waitForRequest(/splats\.spz\?alt=media/);
  await page.click('#open');
  await request;
  await page.click('#close');
  const response = page.waitForResponse(/splats\.spz\?alt=media/);
  release();
  await response;
  await page.waitForTimeout(500);
  await expect(page.locator('#status')).toHaveText('Closed');
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('checksum failure prevents decoding or mounting altered private assets', async ({ page }) => {
  await page.route(/splats\.spz\?alt=media/, async (route) => {
    const response = await route.fetch();
    const bytes = await response.body();
    bytes[0] ^= 0xff;
    await route.fulfill({ response, body: bytes });
  });
  await page.goto('/');
  await page.click('#open');
  await expect(page.locator('#status')).toContainText('checksum', { timeout: 20_000 });
  await expect(page.locator('canvas')).toHaveCount(0);
});

for (const slug of ['base', 'drill-rig', 'circuit-breaker', 'pressure-gauge']) {
  test(`existing Strict Mode web scene still renders: ${slug}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:4175/omnipraxis/${slug}`);
    await expect(page.locator('canvas')).toHaveCount(1);
    await expect
      .poll(async () => (await page.locator('canvas').screenshot()).byteLength, {
        timeout: 60_000,
        message: 'Scene should render visible content rather than the initial empty canvas.',
      })
      .toBeGreaterThan(20_000);
    await page.screenshot({ path: `build/phase1/legacy-${slug}.png` });
    expect(errors).toEqual([]);
  });
}
