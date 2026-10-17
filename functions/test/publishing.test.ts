import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { crc32, deflateSync, gzipSync } from 'node:zlib';

import { assertFails } from '@firebase/rules-unit-testing';
import { getIdToken } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { getMetadata, ref, updateMetadata, uploadBytes } from 'firebase/storage';
import { Timestamp } from 'firebase-admin/firestore';

import { assetBucket, auth, cleanup, client, db, initialize, invoke, seed } from './helpers.ts';
import { publishingService } from '../src/publishing.ts';
import { validateAsset } from '../src/validation.ts';

import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';

let env: RulesTestEnvironment;
const publishing = publishingService(db, auth, assetBucket);
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
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function png() {
  const chunk = (name: string, b: Buffer) => {
    const tag = Buffer.from(name);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(b.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([tag, b])));
    return Buffer.concat([header, tag, b, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 30, 150, 100, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const raw = Buffer.alloc(36);
raw.write('NGSP');
raw.writeUInt32LE(3, 4);
raw.writeUInt32LE(1, 8);
raw[13] = 10;
const files = {
  'splats.spz': gzipSync(raw),
  'colliders.glb': await readFile(
    new URL('../../public/scenes/drill-rig/colliders.glb', import.meta.url),
  ),
  'thumbnail.png': png(),
};
const manifest = Object.fromEntries(
  Object.entries(files).map(([slot, b]) => [slot, { bytes: b.length, sha256: digest(b) }]),
);
async function create(sceneId = 'new-environment') {
  await invoke('admin-a', 'createScene', { orgId: 'alpha', sceneId, title: 'New environment' });
}
async function start(requestId = randomUUID(), sceneId = 'new-environment') {
  return invoke<{ uploadId: string; revisionId: string }>('admin-a', 'createUpload', {
    orgId: 'alpha',
    sceneId,
    requestId,
    files: manifest,
    spawn: { position: [0, 0, 0], yaw: 0, pitch: 0 },
  });
}
async function chunks(uploadId: string, override: Partial<typeof files> = {}) {
  for (const [slot, b] of Object.entries({ ...files, ...override }))
    await invoke('admin-a', 'appendChunk', {
      orgId: 'alpha',
      uploadId,
      slot,
      offset: 0,
      data: b.toString('base64'),
    });
}
const reject = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, { code: `functions/${code}` });

test('controlled chunks are immutable and token-free; only a ready revision publishes, archives and rolls back', async () => {
  await create();
  const requestId = randomUUID();
  const upload = await start(requestId);
  assert.deepEqual(await start(requestId), upload);
  await reject(
    invoke('admin-a', 'finalizeUpload', { orgId: 'alpha', uploadId: upload.uploadId }),
    'failed-precondition',
  );
  await chunks(upload.uploadId);
  const staging = `organizations/alpha/staging/${upload.uploadId}/splats.spz.0.part`;
  assert.equal(
    (await assetBucket.file(staging).getMetadata())[0].metadata?.firebaseStorageDownloadTokens,
    undefined,
  );
  await invoke('admin-a', 'appendChunk', {
    orgId: 'alpha',
    uploadId: upload.uploadId,
    slot: 'splats.spz',
    offset: 0,
    data: files['splats.spz'].toString('base64'),
  });
  await reject(
    invoke('admin-a', 'appendChunk', {
      orgId: 'alpha',
      uploadId: upload.uploadId,
      slot: 'splats.spz',
      offset: 0,
      data: Buffer.alloc(files['splats.spz'].length, 1).toString('base64'),
    }),
    'failed-precondition',
  );
  const finalized = await invoke('admin-a', 'finalizeUpload', {
    orgId: 'alpha',
    uploadId: upload.uploadId,
  });
  assert.equal(finalized.status, 'ready');
  assert.deepEqual(
    await invoke('admin-a', 'finalizeUpload', { orgId: 'alpha', uploadId: upload.uploadId }),
    finalized,
  );
  const path = `organizations/alpha/scenes/new-environment/revisions/${upload.revisionId}/splats.spz`;
  const [metadata] = await assetBucket.file(path).getMetadata();
  assert.equal(metadata.metadata?.firebaseStorageDownloadTokens, undefined);
  const viewer = await client('viewer');
  const delivered = async () =>
    fetch(
      `http://127.0.0.1:5101/demo-omnipraxis/us-central1/deliverAsset?path=${encodeURIComponent(path)}`,
      { headers: { Authorization: `Bearer ${await getIdToken(viewer.auth.currentUser!)}` } },
    );
  await assertFails(getMetadata(ref(viewer.storage, path)));
  const admin = await client('admin-a');
  await assertFails(
    updateMetadata(ref(admin.storage, path), {
      customMetadata: { firebaseStorageDownloadTokens: 'injected' },
    }),
  );
  await assertFails(
    uploadBytes(ref(admin.storage, staging), Buffer.from([1]), {
      customMetadata: { firebaseStorageDownloadTokens: 'injected' },
    }),
  );
  const direct = await fetch(
    `http://127.0.0.1:9399/v0/b/${assetBucket.name}/o/${encodeURIComponent(path)}?alt=media&token=injected`,
  );
  assert.ok([401, 403].includes(direct.status));
  await invoke('admin-a', 'publishRevision', {
    orgId: 'alpha',
    sceneId: 'new-environment',
    revisionId: upload.revisionId,
    expectedVersion: 1,
  });
  assert.equal((await delivered()).status, 200);
  await invoke('admin-a', 'archiveScene', {
    orgId: 'alpha',
    sceneId: 'new-environment',
    expectedVersion: 2,
  });
  assert.equal((await delivered()).status, 403);
  await invoke('admin-a', 'publishRevision', {
    orgId: 'alpha',
    sceneId: 'new-environment',
    revisionId: upload.revisionId,
    expectedVersion: 3,
  });
  assert.equal((await delivered()).status, 200);
  assert.equal(
    (await db.doc('system/assetQuota').get()).get('usedBytes'),
    Object.values(files).reduce((n, b) => n + b.length, 0),
  );
});
test('unsigned/viewer/cross-organization commands, arbitrary paths and forged metadata are denied', async () => {
  await reject(
    invoke('anonymous', 'createScene', { orgId: 'alpha', sceneId: 'new', title: 'New' }),
    'unauthenticated',
  );
  await reject(
    invoke('viewer', 'createScene', { orgId: 'alpha', sceneId: 'new', title: 'New' }),
    'permission-denied',
  );
  await reject(
    invoke('admin-a', 'createScene', { orgId: 'beta', sceneId: 'new', title: 'New' }),
    'permission-denied',
  );
  await create();
  const u = await start();
  await reject(
    invoke('admin-a', 'appendChunk', {
      orgId: 'alpha',
      uploadId: u.uploadId,
      slot: '../escape',
      offset: 0,
      data: 'AAAA',
    }),
    'invalid-argument',
  );
  await reject(
    invoke('admin-a', 'appendChunk', {
      orgId: 'alpha',
      uploadId: u.uploadId,
      slot: 'splats.spz',
      offset: 0,
      data: 'AAAA',
      metadata: { firebaseStorageDownloadTokens: 'secret' },
    }),
    'invalid-argument',
  );
  await reject(
    invoke('viewer', 'cancelUpload', { orgId: 'alpha', uploadId: u.uploadId }),
    'permission-denied',
  );
  await assertFails(
    getDoc(doc((await client('viewer')).db, `organizations/alpha/uploads/${u.uploadId}`)),
  );
});
test('concurrent sessions reserve project bytes and per-admin locks atomically; cancel/expiry release reservations', async () => {
  await create();
  const attempts = await Promise.allSettled([start(), start()]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  const u = (
    attempts.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ uploadId: string }>
  ).value;
  const used = (await db.doc('system/assetQuota').get()).get('usedBytes');
  assert.equal(used, 2 * Object.values(files).reduce((n, b) => n + b.length, 0));
  await chunks(u.uploadId);
  await invoke('admin-a', 'cancelUpload', { orgId: 'alpha', uploadId: u.uploadId });
  assert.equal((await db.doc('system/assetQuota').get()).get('usedBytes'), 0);
  const expired = await start();
  await db
    .doc(`organizations/alpha/uploads/${expired.uploadId}`)
    .update({ expiresAt: Timestamp.fromMillis(0) });
  assert.equal((await publishing.cleanupExpired('alpha')).cleaned, 1);
  assert.equal((await publishing.cleanupExpired('alpha')).cleaned, 0);
  const unrelated = db.doc('anotherApplication/alpha/uploads/unrelated');
  await unrelated.set({
    cleanupPending: true,
    expiresAt: Timestamp.fromMillis(0),
    status: 'uploading',
  });
  assert.equal((await publishing.cleanupExpired()).cleaned, 0);
  assert.equal((await unrelated.get()).get('status'), 'uploading');
  await db.doc('system/assetQuota').set({ usedBytes: 5 * 1024 ** 3, activeAdmins: {} });
  await reject(start(), 'resource-exhausted');
});
test('suspension, active leases, wrong ownership and stale publication versions cannot advance the pipeline', async () => {
  await create();
  const u = await start();
  await db.doc('publicSettings/delivery').update({ downloadsEnabled: false });
  await reject(
    invoke('admin-a', 'appendChunk', {
      orgId: 'alpha',
      uploadId: u.uploadId,
      slot: 'splats.spz',
      offset: 0,
      data: files['splats.spz'].toString('base64'),
    }),
    'failed-precondition',
  );
  await db.doc('publicSettings/delivery').update({ downloadsEnabled: true });
  await chunks(u.uploadId);
  const upload = db.doc(`organizations/alpha/uploads/${u.uploadId}`);
  await upload.update({
    status: 'validating',
    lease: 'other-worker',
    leaseUntil: Timestamp.fromMillis(Date.now() + 60000),
  });
  await reject(
    invoke('admin-a', 'finalizeUpload', { orgId: 'alpha', uploadId: u.uploadId }),
    'aborted',
  );
  assert.equal((await publishing.cleanupExpired('alpha', Date.now() + 1000)).cleaned, 0);
  await upload.update({ leaseUntil: Timestamp.fromMillis(0) });
  await invoke('admin-a', 'finalizeUpload', { orgId: 'alpha', uploadId: u.uploadId });
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      invoke('admin-a', 'publishRevision', {
        orgId: 'alpha',
        sceneId: 'new-environment',
        revisionId: u.revisionId,
        expectedVersion: 1,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await reject(
    invoke('admin-a', 'publishRevision', {
      orgId: 'alpha',
      sceneId: 'new-environment',
      revisionId: u.revisionId,
      expectedVersion: 1,
    }),
    'aborted',
  );
  await db.doc('organizations/alpha/members/admin-a').update({ status: 'suspended' });
  await reject(
    invoke('admin-a', 'updateScene', {
      orgId: 'alpha',
      sceneId: 'new-environment',
      title: 'Forged',
      expectedVersion: 2,
    }),
    'permission-denied',
  );
});
test('malformed assets fail before publication and keep the prior publication intact', async () => {
  await create();
  const bad = Buffer.alloc(files['splats.spz'].length, 1);
  const badManifest = { ...manifest, 'splats.spz': { bytes: bad.length, sha256: digest(bad) } };
  const u = await invoke<{ uploadId: string }>('admin-a', 'createUpload', {
    orgId: 'alpha',
    sceneId: 'new-environment',
    requestId: randomUUID(),
    files: badManifest,
    spawn: { position: [0, 0, 0], yaw: 0, pitch: 0 },
  });
  await chunks(u.uploadId, { 'splats.spz': bad });
  await reject(
    invoke('admin-a', 'finalizeUpload', { orgId: 'alpha', uploadId: u.uploadId }),
    'failed-precondition',
  );
  assert.equal(
    (await db.doc('organizations/alpha/scenes/new-environment').get()).get('publishedRevisionId'),
    null,
  );
  await reject(
    invoke('admin-a', 'publishRevision', {
      orgId: 'alpha',
      sceneId: 'new-environment',
      revisionId: u.uploadId,
      expectedVersion: 1,
    }),
    'failed-precondition',
  );
  await invoke('admin-a', 'cancelUpload', { orgId: 'alpha', uploadId: u.uploadId });
  assert.equal((await db.doc('system/assetQuota').get()).get('usedBytes'), 0);
});
test('validators accept representative retained assets and reject bombs, unsafe colliders and invalid thumbnails', async () => {
  for (const [slot, bytes] of Object.entries(files))
    await validateAsset(slot as keyof typeof files, bytes);
  await validateAsset(
    'splats.spz',
    await readFile(new URL('../../public/scenes/base/splats.spz', import.meta.url)),
  );
  await validateAsset(
    'colliders.glb',
    await readFile(new URL('../../public/scenes/base/colliders.glb', import.meta.url)),
  );
  const bomb = Buffer.from(raw);
  bomb.writeUInt32LE(0xffffffff, 8);
  await assert.rejects(validateAsset('splats.spz', gzipSync(bomb)));
  await assert.rejects(validateAsset('colliders.glb', Buffer.from('not a glb')));
  await assert.rejects(validateAsset('thumbnail.png', Buffer.from('not a png')));
  const invalid = Buffer.from(files['thumbnail.png']);
  invalid[20] = 255;
  await assert.rejects(validateAsset('thumbnail.png', invalid));
});
