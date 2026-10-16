import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

import {
  bucket,
  createTestEnvironment,
  seedFixtures,
  storageOrigin,
} from '../../prototypes/phase1/fixtures.ts';

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
const assetPath = 'organizations/phase1/scenes/drill-rig/revisions/r1/colliders.glb';
const publicPath = 'public-scenes/circuit-breaker/revisions/r1/splats-lod.rad';
const context = (uid: string, emailVerified = true) =>
  environment.authenticatedContext(uid, { email_verified: emailVerified });
const readAsset = (uid: string, path = assetPath) =>
  getBytes(ref(context(uid).storage(`gs://${bucket}`), path));
const loadStorageRules = async (rules: string) => {
  const response = await fetch(`${storageOrigin}/internal/setRules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'storage.rules', content: rules }] } }),
  });
  assert.equal(response.ok, true, await response.text());
};

before(async () => {
  environment = await createTestEnvironment();
  await seedFixtures(environment);
});
after(async () => {
  await environment?.cleanup();
});

test('assigned member reads metadata and immutable asset', async () => {
  await assertSucceeds(
    getDoc(doc(context('assigned').firestore(), 'organizations/phase1/scenes/drill-rig')),
  );
  assert.ok((await assertSucceeds(readAsset('assigned'))).byteLength > 0);
});

for (const uid of ['unassigned', 'outsider', 'suspended', 'missing-member']) {
  test(`${uid} cannot read scene metadata or assets`, async () => {
    await assertFails(
      getDoc(doc(context(uid).firestore(), 'organizations/phase1/scenes/drill-rig')),
    );
    await assertFails(readAsset(uid));
  });
}

test('anonymous and unverified identities cannot download restricted assets', async () => {
  await assertFails(
    getBytes(ref(environment.unauthenticatedContext().storage(`gs://${bucket}`), assetPath)),
  );
  await assertFails(getBytes(ref(context('assigned', false).storage(`gs://${bucket}`), assetPath)));
});

test('stale publication stops new asset requests with a still-valid identity', async () => {
  await environment.withSecurityRulesDisabled(async (admin) => {
    await setDoc(
      doc(admin.firestore(), 'organizations/phase1/scenes/drill-rig'),
      { publishedRevisionId: 'r2' },
      { merge: true },
    );
  });
  try {
    await assertFails(readAsset('assigned'));
  } finally {
    await environment.withSecurityRulesDisabled(async (admin) => {
      await setDoc(
        doc(admin.firestore(), 'organizations/phase1/scenes/drill-rig'),
        { publishedRevisionId: 'r1' },
        { merge: true },
      );
    });
  }
});

test('client cannot grant itself access or replace immutable objects', async () => {
  await assertFails(
    setDoc(doc(context('unassigned').firestore(), 'organizations/phase1/members/unassigned'), {
      role: 'admin',
      status: 'active',
    }),
  );
  await assertFails(
    uploadBytes(ref(context('admin').storage(`gs://${bucket}`), assetPath), new Uint8Array([1])),
  );
});

test('tokenless public media endpoint supports range requests and denies unknown revisions', async () => {
  const url = `${storageOrigin}/v0/b/${bucket}/o/${encodeURIComponent(publicPath)}?alt=media`;
  const response = await fetch(url, { headers: { Range: 'bytes=0-63' } });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 64);
  const unknown = await fetch(url.replace('r1%2F', 'r0%2F'));
  assert.ok([403, 404].includes(unknown.status));
});

test('suspension denies raw public/private binaries and staging writes while metadata remains readable', async () => {
  const rules = await readFile('prototypes/phase1/storage.rules', 'utf8');
  const adminStorage = context('admin').storage(`gs://${bucket}`);
  const slot = 'organizations/phase1/staging/upload1/splats.spz';
  await assertSucceeds(uploadBytes(ref(adminStorage, slot), new Uint8Array([1, 2])));
  await loadStorageRules(
    rules.replace(
      'function deliveryEnabled() { return true; }',
      'function deliveryEnabled() { return false; }',
    ),
  );
  try {
    await assertFails(readAsset('assigned'));
    const response = await fetch(
      `${storageOrigin}/v0/b/${bucket}/o/${encodeURIComponent(publicPath)}?alt=media`,
    );
    assert.equal(response.status, 403);
    await environment.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'organizations/phase1/uploads/upload2'), {
        actor: 'admin',
        status: 'uploading',
        expiresAt: new Date(Date.now() + 60_000),
        slots: { 'splats.spz': 1024 },
      });
    });
    await assertFails(
      uploadBytes(
        ref(adminStorage, 'organizations/phase1/staging/upload2/splats.spz'),
        new Uint8Array([1]),
      ),
    );
    await assertSucceeds(
      getDoc(doc(context('assigned').firestore(), 'organizations/phase1/scenes/drill-rig')),
    );
    await assertSucceeds(
      getDoc(doc(environment.unauthenticatedContext().firestore(), 'publicScenes/circuit-breaker')),
    );
  } finally {
    await loadStorageRules(rules);
  }
});
