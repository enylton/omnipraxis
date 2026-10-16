import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { prepare, reset } from '../../functions/test/portal-fixtures.ts';

import type { Page } from '@playwright/test';

test.beforeAll(prepare);
test.beforeEach(reset);

// Observe the production React reconcilers from the browser test only. Invoking
// the actual authored interaction callbacks exercises scene guards, animations,
// held models and export without adding a testing/control API to the product.
async function observeScenes(page: Page) {
  await page.addInitScript(() => {
    const roots = new Set();
    Object.assign(window, {
      authoredSceneRoots: roots,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onCommitFiberRoot: (_id: unknown, root: unknown) => roots.add(root),
        onCommitFiberUnmount: () => {},
        checkDCE: () => {},
      },
    });
  });
}
async function action(page: Page, label: string, position?: number[]) {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ label, position }) => {
            type Fiber = {
              child?: Fiber;
              sibling?: Fiber;
              memoizedProps?: {
                position?: number[];
                interaction?: { label: string; action: () => void };
              };
            };
            const roots = (window as unknown as { authoredSceneRoots: Set<{ current: Fiber }> })
              .authoredSceneRoots;
            const visit = (fiber?: Fiber): boolean => {
              if (!fiber) return false;
              const props = fiber.memoizedProps;
              if (
                props?.interaction?.label === label &&
                (!position || JSON.stringify(props.position) === JSON.stringify(position))
              ) {
                props.interaction.action();
                return true;
              }
              return visit(fiber.child) || visit(fiber.sibling);
            };
            return [...roots].some((root) => visit(root.current));
          },
          { label, position },
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  // Let React commit the next set of labels before selecting another action.
  await page.waitForTimeout(100);
}

test('cloud Circuit Breaker retains overload, removal, carrying, installation and completion feedback', async ({
  page,
}) => {
  await observeScenes(page);
  await page.goto('/circuit-breaker');
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Opening scene…' })).toHaveCount(0, {
    timeout: 90_000,
  });
  await action(page, 'Remove', [-12.4, 1.73, 4.48]);
  await action(page, 'Turn on', [0.15, 1.0, -1.76]);
  await action(page, 'Remove', [-12.4, 1.73, 4.48]);
  await action(page, 'Pick up', [-11, 1.4, -13]);
  await action(page, 'Install', [-12.4, 1.73, 4.48]);
  await action(page, 'Turn on', [0.15, 1.0, -1.76]);
  await expect(page.getByText('Training complete', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'build/cutover-circuit-breaker.png' });
});

test('cloud Pressure Gauge retains animated valve sequence, replacement and completed JSON download', async ({
  page,
}) => {
  await observeScenes(page);
  await page.goto('/pressure-gauge');
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Opening scene…' })).toHaveCount(0, {
    timeout: 90_000,
  });
  for (const label of [
    'Fechar montante',
    'Fechar jusante',
    'Abrir venteio',
    'Fechar venteio',
    'Remover manômetro',
    'Coletar manômetro',
    'Instalar manômetro',
    'Abrir montante',
  ])
    await action(page, label);
  const exported = page.waitForEvent('download');
  await action(page, 'Abrir jusante');
  const download = await exported;
  await download.saveAs('build/cutover-pressure-session.json');
  const snapshot = JSON.parse(await readFile('build/cutover-pressure-session.json', 'utf8'));
  expect(snapshot.scene).toBe('pressure-gauge');
  expect(snapshot.status).toBe('completed');
  for (const type of ['gauge.removed', 'gauge.collected', 'gauge.installed', 'training.completed'])
    expect(snapshot.events.filter((event: { type: string }) => event.type === type)).toHaveLength(
      1,
    );
  await expect(page.getByText('Treinamento concluído', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'build/cutover-pressure-gauge.png' });
});
