import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc } from 'firebase/firestore';
import { getMetadata, ref } from 'firebase/storage';

import { assetBucket, cleanup, client, db, initialize, seed } from './helpers.ts';
import { parsePublicScene } from '../../src/contracts/publicScene.ts';
import { importLegacyAssets, planLegacyImport } from '../src/legacy-assets.ts';

import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';

let env: RulesTestEnvironment;
before(async () => {
  env = await initialize();
});
beforeEach(async () => {
  await seed();
  await db.doc('publicSettings/delivery').set({ downloadsEnabled: true });
});
after(async () => {
  await env.cleanup();
  await cleanup();
});

test('legacy CLI refuses foreign endpoints and applies only to the fixed demo project', async () => {
  const args = [
    'src/import-legacy.ts',
    '--source',
    '../public',
    '--scene',
    'drill-rig',
    '--revision',
    'cli-proof',
    '--apply',
  ];
  const refused = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GCLOUD_PROJECT: 'other-project' },
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refuses non-demo endpoints/);
  assert.equal((await db.doc('organizations/alpha/scenes/drill-rig').get()).exists, false);
  const applied = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
  });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(
    (await db.doc('organizations/alpha/scenes/drill-rig').get()).get('publishedRevisionId'),
    'cli-proof',
  );
});

test('trusted restricted import checks bytes, counts quota once, preserves newer publications and denies anonymous access', async () => {
  const plan = await planLegacyImport('../public', 'drill-rig', 'import-proof', 'alpha');
  const result = await importLegacyAssets(db, assetBucket, plan);
  assert.equal(result.files, 2);
  assert.equal((await db.doc('system/assetQuota').get()).get('usedBytes'), plan.bytes);
  const path = plan.files[0].asset.path;
  await db
    .doc('organizations/alpha/scenes/drill-rig')
    .update({ publishedRevisionId: 'newer', version: 2 });
  await importLegacyAssets(db, assetBucket, plan);
  assert.equal((await db.doc('system/assetQuota').get()).get('usedBytes'), plan.bytes);
  assert.equal(
    (await db.doc('organizations/alpha/scenes/drill-rig').get()).get('publishedRevisionId'),
    'newer',
  );
  const next = await planLegacyImport('../public', 'drill-rig', 'import-replacement', 'alpha');
  await assert.rejects(importLegacyAssets(db, assetBucket, next), /Scene changed/);
  await importLegacyAssets(db, assetBucket, next, 2);
  assert.equal(
    (await db.doc('organizations/alpha/scenes/drill-rig').get()).get('publishedRevisionId'),
    'import-replacement',
  );
  await assertSucceeds(
    getMetadata(ref((await client('viewer')).storage, next.files[0].asset.path)),
  );
  await assertFails(getMetadata(ref((await client()).storage, next.files[0].asset.path)));
  // Firebase emulator GET generates a token; a retry must fail closed if an object acquired one.
  await assert.rejects(importLegacyAssets(db, assetBucket, next, 2), /token\/cache/);
  await assetBucket.file(path).save(Buffer.from('changed'), { resumable: false });
  await assert.rejects(importLegacyAssets(db, assetBucket, plan), /checksum/);
});

test('imports start token-free; rule-governed suspension works and the emulator GET token bypass remains a release blocker', async () => {
  const plan = await planLegacyImport('../public', 'base', 'import-proof', 'alpha');
  // The ordinary policy fixture already has Base; this is an optimistic replacement.
  await assert.rejects(importLegacyAssets(db, assetBucket, plan), /Scene changed/);
  await db.doc('publicScenes/base').update({ version: 1 });
  const current = await db.doc('publicScenes/base').get();
  const result = await importLegacyAssets(db, assetBucket, plan, current.get('version') ?? 0);
  assert.equal(parsePublicScene(result.descriptor).sceneId, 'base');
  const anonymous = await client();
  await assertSucceeds(getDoc(doc(anonymous.db, 'publicScenes/base')));
  const asset = plan.files[0].asset;
  const url = `http://127.0.0.1:9399/v0/b/${assetBucket.name}/o/${encodeURIComponent(asset.path)}?alt=media`;
  const [metadata] = await assetBucket.file(asset.path).getMetadata();
  assert.deepEqual(metadata.metadata ?? {}, {});
  assert.equal((await fetch(url, { headers: { Range: 'bytes=0-1' } })).status, 206);
  const [afterRead] = await assetBucket.file(asset.path).getMetadata();
  const generatedToken = afterRead.metadata?.firebaseStorageDownloadTokens;
  assert.equal(typeof generatedToken, 'string');
  const rules = await readFile('../storage.rules', 'utf8');
  const load = (content: string) =>
    fetch('http://127.0.0.1:9399/internal/setRules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: { files: [{ name: 'storage.rules', content }] } }),
    });
  try {
    assert.ok(
      (
        await load(
          rules.replace(
            'function deliveryEnabled() { return true; }',
            'function deliveryEnabled() { return false; }',
          ),
        )
      ).ok,
    );
    assert.equal((await fetch(url)).status, 403);
    // Preserve this evidence rather than claim emulator rule enforcement covers bearer tokens.
    assert.equal(
      (await fetch(`${url}&token=${generatedToken}`, { headers: { Range: 'bytes=0-1' } })).status,
      206,
    );
    await assertSucceeds(getDoc(doc(anonymous.db, 'publicScenes/base')));
  } finally {
    assert.ok((await load(rules)).ok);
  }
  await db.doc('publicSettings/delivery').update({ downloadsEnabled: false });
  const blocked = await planLegacyImport('../public', 'drill-rig', 'blocked-import', 'alpha');
  await assert.rejects(importLegacyAssets(db, assetBucket, blocked), /suspended/);
});
