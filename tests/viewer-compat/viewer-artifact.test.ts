import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('viewer artifact packages its declared files without runtime declarations', async () => {
  const artifact = new URL('../../build/viewer/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('viewer.manifest.json', artifact), 'utf8'));
  assert.equal(manifest.apiVersion, 1);
  assert.deepEqual((await readdir(artifact)).sort(), [
    'types',
    'viewer.css',
    'viewer.js',
    'viewer.manifest.json',
  ]);
  for (const file of [manifest.module, manifest.stylesheet, manifest.types]) {
    assert.ok((await readFile(new URL(file, artifact))).length > 0);
  }
  assert.deepEqual((await readdir(new URL('types/', artifact))).sort(), [
    'api.d.ts',
    'index.d.ts',
    'version.d.ts',
  ]);
  for (const file of ['api.d.ts', 'index.d.ts', 'version.d.ts']) {
    assert.doesNotMatch(
      await readFile(new URL(`types/${file}`, artifact), 'utf8'),
      /runtime\/|firebase|react|three|contracts\//i,
    );
  }
});

test('plain TypeScript consumer compiles only against the built public declarations', async () => {
  const directory = new URL('../../build/viewer-compat/consumer/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL('consumer.ts', directory),
    `
import { mountViewer, VIEWER_API_VERSION } from '../../viewer/types/index';
import type { ViewerHandle, ViewerOptions, ViewerSessionSnapshot } from '../../viewer/types/index';
const onComplete = (snapshot: ViewerSessionSnapshot): string => JSON.stringify(snapshot.events);
const supportedVersion: 1 = VIEWER_API_VERSION;
const options: ViewerOptions = {
  apiVersion: supportedVersion,
  scene: { template: 'environment', sessionId: 'consumer',
    assets: { splatsUrl: '/scene.spz', splatsFormat: 'spz', collidersUrl: '/scene.glb' },
    spawn: { position: [0, 1, 0], yaw: 0, pitch: 0 } },
  onSessionComplete: snapshot => { onComplete(snapshot); }
};
const handle: ViewerHandle = mountViewer(document.createElement('div'), options);
handle.dispose();
// @ts-expect-error API versions must be explicitly compatible.
const unsupported: ViewerOptions['apiVersion'] = 2;
void unsupported;
`,
  );
  await writeFile(
    new URL('tsconfig.json', directory),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2023', 'DOM'],
        types: [],
        skipLibCheck: false,
      },
      files: ['consumer.ts'],
    }),
  );
  const result = spawnSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', fileURLToPath(new URL('tsconfig.json', directory))],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
