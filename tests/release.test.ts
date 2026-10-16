import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { recordRelease, verifyRelease } from '../scripts/release.ts';

test('recovery verifies exact hashes and refuses legacy/binary artifacts', async () => {
  const root = await mkdtemp('build/release-test-');
  const manifest = `${root}-manifest.json`;
  await mkdir(join(root, 'viewer'));
  await mkdir(join(root, 'public-viewer'));
  await writeFile(join(root, 'index.html'), '<portal-app></portal-app>');
  await writeFile(join(root, 'viewer/index.js'), 'private');
  await writeFile(join(root, 'public-viewer/index.js'), 'public');
  await recordRelease(root, manifest);
  assert.equal((await verifyRelease(root, manifest)).files, 3);
  const original = await readFile(join(root, 'viewer/index.js'));
  await writeFile(join(root, 'viewer/index.js'), 'tampered');
  await assert.rejects(verifyRelease(root, manifest), /hashes/);
  await writeFile(join(root, 'viewer/index.js'), original);
  await writeFile(join(root, 'extra.js'), 'extra');
  await assert.rejects(verifyRelease(root, manifest), /hashes/);
  await writeFile(join(root, 'index.html'), '<div id="root"></div>');
  await assert.rejects(recordRelease(root, manifest), /Angular/);
  await writeFile(join(root, 'private.glb'), 'forbidden');
  await assert.rejects(recordRelease(root, manifest), /binaries/);
});
