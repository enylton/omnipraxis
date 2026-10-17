import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';

import { Timestamp } from 'firebase-admin/firestore';

import { assetBucket, auth, cleanup, db, initialize, seed } from './helpers.ts';
import { importLegacyAssets, planLegacyImport } from '../src/legacy-assets.ts';
import { operationsService } from '../src/operations.ts';
import { publishingService } from '../src/publishing.ts';
import { retentionService } from '../src/retention.ts';

import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';

let env: RulesTestEnvironment;
const scenePath = 'organizations/alpha/scenes/retention-proof';
const retention = retentionService(db, assetBucket);
const ops = operationsService(db, assetBucket);
const now = Date.now();
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
async function fixture() {
  await db.doc(scenePath).set({ version: 1, status: 'published', publishedRevisionId: 'r5' });
  let total = 0;
  for (let i = 1; i <= 6; i++) {
    const file = assetBucket.file(`${scenePath}/revisions/r${i}/splats.spz`);
    await file.save(Buffer.from(`test${i}`), { resumable: false });
    const [metadata] = await file.getMetadata();
    await db.doc(`${scenePath}/revisions/r${i}`).set({
      status: 'ready',
      storageBytes: 5,
      sourceUploadId: `retention-${i}`,
      manifest: {
        splats: { path: file.name, bytes: 5, generation: String(metadata.generation) },
      },
      ...(i === 6 ? {} : { lastPublishedAt: Timestamp.fromMillis(now - (20 - i) * 86400000) }),
    });
    await db.doc(`organizations/alpha/uploads/retention-${i}`).set({
      status: 'ready',
      sceneId: 'retention-proof',
      revisionId: `r${i}`,
      chargedBytes: 5,
      cleanupPending: false,
    });
    total += 5;
  }
  await db.doc('system/assetQuota').set({ usedBytes: total });
}
test('retention dry run protects publication, two rollback revisions and unpublished candidates; deletion reclaims once', async () => {
  await fixture();
  const unrelated = assetBucket.file('outside-application/keep');
  await unrelated.save(Buffer.from('keep'), { resumable: false });
  const plan = await retention.plan(scenePath, now);
  assert.deepEqual(
    plan.candidates.map((r) => r.revisionId),
    ['r1', 'r2'],
  );
  assert.equal((await db.doc('system/assetQuota').get()).get('usedBytes'), 30);
  assert.deepEqual(await retention.apply(plan, now), { deleted: 2, reclaimedBytes: 10 });
  assert.deepEqual(await retention.apply(plan, now), { deleted: 0, reclaimedBytes: 0 });
  assert.equal((await db.doc('system/assetQuota').get()).get('usedBytes'), 20);
  assert.equal((await unrelated.exists())[0], true);
  assert.equal((await assetBucket.file(`${scenePath}/revisions/r6/splats.spz`).exists())[0], true);
});
test('changed publication, staging ownership and recent recovery window prevent pruning', async () => {
  await fixture();
  const plan = await retention.plan(scenePath, now);
  await db.doc(scenePath).update({ version: 2, publishedRevisionId: 'r1' });
  await assert.rejects(retention.apply(plan, now), /Scene changed/);
  await db.doc(scenePath).update({ version: 1, publishedRevisionId: 'r5' });
  await db.doc('organizations/alpha/uploads/retention-1').update({ cleanupPending: true });
  await assert.rejects(retention.apply(plan, now), /reconciled/);
  await db
    .doc(`${scenePath}/revisions/r2`)
    .update({ lastPublishedAt: Timestamp.fromMillis(now - 1000) });
  assert.ok(!(await retention.plan(scenePath, now)).candidates.some((r) => r.revisionId === 'r2'));
});
test('generation mismatch retains charge and deletion lease; publication refuses claimed revision; expired cleanup resumes', async () => {
  await fixture();
  const plan = await retention.plan(scenePath, now);
  plan.candidates = plan.candidates.slice(0, 1);
  const ref = db.doc(`${scenePath}/revisions/r1`);
  await ref.update({ 'manifest.splats.generation': '1' });
  await assert.rejects(retention.apply(plan, now), /generation/);
  assert.equal((await db.doc('system/assetQuota').get()).get('usedBytes'), 30);
  assert.equal((await ref.get()).get('status'), 'deleting');
  const publishing = publishingService(db, auth, assetBucket);
  await assert.rejects(
    publishing.publishRevision({
      auth: { uid: 'admin-a', token: { email_verified: true, email: 'admin-a@example.test' } },
      data: { orgId: 'alpha', sceneId: 'retention-proof', revisionId: 'r1', expectedVersion: 1 },
    } as Parameters<typeof publishing.publishRevision>[0]),
    /validated/,
  );
  const [metadata] = await assetBucket.file(`${scenePath}/revisions/r1/splats.spz`).getMetadata();
  await ref.update({
    'manifest.splats.generation': String(metadata.generation),
    'retention.leaseUntil': Timestamp.fromMillis(0),
  });
  assert.deepEqual(await retention.apply(plan, now), { deleted: 1, reclaimedBytes: 5 });
});
test('unexpected object refuses cleanup; missing already deleted object resumes safely', async () => {
  await fixture();
  const plan = await retention.plan(scenePath, now);
  plan.candidates = plan.candidates.slice(0, 1);
  const extra = assetBucket.file(`${scenePath}/revisions/r1/untracked.glb`);
  await extra.save(Buffer.from('extra'), { resumable: false });
  await assert.rejects(retention.apply(plan, now), /Unexpected objects/);
  await extra.delete();
  await assetBucket.file(`${scenePath}/revisions/r1/splats.spz`).delete();
  await db
    .doc(`${scenePath}/revisions/r1`)
    .update({ 'retention.leaseUntil': Timestamp.fromMillis(0) });
  assert.deepEqual(await retention.apply(plan, now), { deleted: 1, reclaimedBytes: 5 });
});
test('scheduled retention uses bounded shared cleanup and refuses unknown application paths', async () => {
  await fixture();
  assert.deepEqual(await retention.sweep(), { scenes: 1, deleted: 2, reclaimedBytes: 10 });
  await assert.rejects(retention.plan('other/scenes'), /application scene/);
});
test('legacy retention releases its receipt once and retired imports cannot recreate deleted bytes', async () => {
  const imported = await planLegacyImport('../public', 'base', 'retention-legacy', 'alpha');
  await db.doc('publicScenes/base').delete();
  await importLegacyAssets(db, assetBucket, imported);
  const revision = db.doc('publicSceneImports/base/revisions/retention-legacy');
  await revision.update({ lastPublishedAt: Timestamp.fromMillis(now - 20 * 86400000) });
  for (let i = 1; i <= 3; i++)
    await db
      .doc(`publicSceneImports/base/revisions/history-${i}`)
      .set({ status: 'ready', lastPublishedAt: Timestamp.fromMillis(now - (10 - i) * 86400000) });
  await db.doc('publicScenes/base').update({ publishedRevisionId: 'history-3', version: 4 });
  const result = await retention.apply(await retention.plan('publicScenes/base', now), now);
  assert.deepEqual(result, { deleted: 1, reclaimedBytes: imported.bytes });
  assert.equal((await db.doc('system/assetQuota').get()).get('usedBytes'), 0);
  await assert.rejects(importLegacyAssets(db, assetBucket, imported), /Retired/);
  assert.equal((await assetBucket.file(imported.files[0].asset.path).exists())[0], false);
});
test('delivery suspension/resumption is audited, serialized and fails closed', async () => {
  await ops.setDelivery(false, 'budget drill');
  assert.equal((await db.doc('publicSettings/delivery').get()).get('downloadsEnabled'), false);
  await ops.setDelivery(true, 'reviewed resumption');
  assert.equal((await db.doc('publicSettings/delivery').get()).get('downloadsEnabled'), true);
  await db
    .doc('system/deliveryOperation')
    .update({ leaseUntil: Timestamp.fromMillis(Date.now() + 10000) });
  await assert.rejects(ops.setDelivery(true, 'concurrent drill'), /active/);
  assert.equal(
    (await db.collection('systemOperations').where('action', '==', 'delivery.completed').get())
      .size,
    2,
  );
});
test('public recovery uses version/status checks and suspension; Drill Rig cannot become public', async () => {
  await db
    .doc('publicScenes/base')
    .set({ version: 2, publishedRevisionId: 'newer', status: 'published' });
  await db.doc('publicSceneImports/base/revisions/older').set({
    status: 'ready',
    descriptor: { kind: 'public-demo-v1', sceneId: 'base', revisionId: 'older' },
  });
  await assert.rejects(
    ops.restorePublic('drill-rig', 'older', 2, 'recovery drill'),
    /application scene/,
  );
  await assert.rejects(ops.restorePublic('base', 'older', 1, 'recovery drill'), /changed/);
  assert.deepEqual(await ops.restorePublic('base', 'older', 2, 'recovery drill'), { version: 3 });
  await db.doc('publicSceneImports/base/revisions/older').update({ status: 'deleting' });
  await assert.rejects(ops.restorePublic('base', 'older', 3, 'recovery drill'), /ready public/);
  await db.doc('publicSettings/delivery').set({ downloadsEnabled: false });
  await assert.rejects(ops.restorePublic('base', 'older', 3, 'recovery drill'), /suspended/);
});
test('operator CLI changes delivery state without changing deny-all rules and hides token values', async () => {
  const source = await readFile('../storage.rules');
  const run = (args: string[], env = process.env) =>
    promisify(execFile)(process.execPath, ['src/operator.ts', ...args], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
  await assert.rejects(run(['report'], { ...process.env, GCLOUD_PROJECT: 'foreign' }), /non-demo/);
  try {
    await run(['suspend', '--reason', 'local controlled drill', '--apply']);
    assert.equal((await db.doc('publicSettings/delivery').get()).get('downloadsEnabled'), false);
    assert.deepEqual(await readFile('../storage.rules'), source);
    const file = assetBucket.file('public-scenes/base/revisions/r1/splats.spz');
    const response = await fetch(
      `http://127.0.0.1:9399/v0/b/${assetBucket.name}/o/${encodeURIComponent(file.name)}?alt=media`,
    );
    assert.equal(response.status, 403);
    await run(['resume', '--reason', 'local reviewed resumption', '--apply']);
    assert.equal((await db.doc('publicSettings/delivery').get()).get('downloadsEnabled'), true);
    const [metadata] = await file.getMetadata();
    await file.setMetadata({
      metadata: { firebaseStorageDownloadTokens: 'do-not-print-this-token' },
    });
    const report = await ops.report();
    assert.ok(report.inventories.some((i) => i.tokenBearingObjects > 0));
    assert.ok(!JSON.stringify(report).includes('do-not-print-this-token'));
    await file.setMetadata({ metadata: metadata.metadata ?? {} });
  } finally {
    await db.doc('publicSettings/delivery').set({ downloadsEnabled: true });
  }
});
