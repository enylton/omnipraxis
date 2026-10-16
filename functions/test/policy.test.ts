import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  applyActionCode,
  confirmPasswordReset,
  getIdToken,
  GoogleAuthProvider,
  reload,
  signInWithCredential,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { getMetadata, ref, uploadBytes, updateMetadata, deleteObject } from 'firebase/storage';
import { Timestamp } from 'firebase-admin/firestore';

import {
  accept,
  auth,
  bucket,
  cleanup,
  client,
  db,
  email,
  initialize,
  invite,
  invoke,
  project,
  seed,
  service,
} from './helpers.ts';
import { listOrganizationScenes } from '../../src/adapters/firebase/catalog.ts';
import { createIdentity } from '../../src/adapters/firebase/identity.ts';

import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';

let env: RulesTestEnvironment;
before(async () => {
  env = await initialize();
});
beforeEach(seed);
after(async () => {
  await env.cleanup();
  await cleanup();
});
const memberPath = 'organizations/alpha/members/viewer';
const scenePath = 'organizations/alpha/scenes/assigned';
const asset = (scene = 'assigned', revision = 'r1', org = 'alpha') =>
  `organizations/${org}/scenes/${scene}/revisions/${revision}/splats.spz`;
const updateMember = (actor: string, uid: string, role: string, status: string) =>
  invoke(actor, 'updateMember', { orgId: 'alpha', uid, role, status });
const rejected = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, { code: `functions/${code}` });

test('callable boundary rejects unsigned garbage, missing auth, forged organization and viewer administration', async () => {
  await rejected(invite('anonymous', email('outsider')), 'unauthenticated');
  await rejected(invite('viewer', email('outsider')), 'permission-denied');
  await rejected(invite('admin-a', email('outsider'), 'beta'), 'permission-denied');
  const response = await fetch(`http://127.0.0.1:5101/${project}/us-central1/createInvitation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-token' },
    body: JSON.stringify({ data: { orgId: 'alpha', email: email('outsider'), role: 'admin' } }),
  });
  assert.ok([401, 403].includes(response.status));
  assert.equal((await db.collection('organizations/alpha/invitations').get()).size, 0);
});

test('invitation stores only a hash, normalizes email, expires in seven days and audits without secrets', async () => {
  const invitation = await invite('admin-a', 'OUTSIDER@EXAMPLE.TEST');
  const saved = (
    await db.doc(`organizations/alpha/invitations/${invitation.invitationId}`).get()
  ).data()!;
  assert.equal(saved.email, email('outsider'));
  assert.match(saved.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(saved.token, undefined);
  assert.ok(Math.abs(invitation.expiresAt - Date.now() - 7 * 86400000) < 5000);
  const audit = await db.collection('organizations/alpha/audit').get();
  assert.ok(!JSON.stringify(audit.docs.map((d) => d.data())).includes(invitation.token));
});

test('verified recipient accepts once; concurrent retries are idempotent and another UID cannot reuse token', async () => {
  const invitation = await invite('admin-a', email('outsider'));
  await Promise.all([accept('outsider', invitation), accept('outsider', invitation)]);
  assert.equal((await db.doc('organizations/alpha/members/outsider').get()).get('role'), 'viewer');
  const events = await db
    .collection('organizations/alpha/audit')
    .where('action', '==', 'invitation.accepted')
    .get();
  assert.equal(events.size, 1);
  await rejected(accept('other', invitation), 'permission-denied');
});

test('wrong email, unverified identity, corrupt token, forged payload fields and cross-org invitation are rejected', async () => {
  const invitation = await invite('admin-a', email('outsider'));
  await rejected(accept('other', invitation), 'permission-denied');
  await rejected(accept('unverified', invitation), 'permission-denied');
  await rejected(accept('outsider', { ...invitation, token: 'bad' }), 'permission-denied');
  await rejected(accept('outsider', invitation, 'beta'), 'permission-denied');
  await rejected(
    invoke('outsider', 'acceptInvitation', {
      orgId: 'alpha',
      invitationId: invitation.invitationId,
      token: invitation.token,
      email: email('outsider'),
      role: 'admin',
    }),
    'invalid-argument',
  );
});

test('expired and revoked tokens cannot be accepted and revocation is idempotent', async () => {
  const expired = await invite('admin-a', email('outsider'));
  await db
    .doc(`organizations/alpha/invitations/${expired.invitationId}`)
    .update({ expiresAt: Timestamp.fromMillis(0) });
  await rejected(accept('outsider', expired), 'failed-precondition');
  const revoked = await invite('admin-a', email('outsider'));
  for (let i = 0; i < 2; i++)
    await invoke('admin-a', 'revokeInvitation', {
      orgId: 'alpha',
      invitationId: revoked.invitationId,
    });
  await rejected(accept('outsider', revoked), 'failed-precondition');
});

test('pending invitations lose authority when their issuer is demoted', async () => {
  const invitation = await invite('admin-a', email('outsider'), 'alpha', 'admin');
  await updateMember('admin-a', 'other', 'admin', 'active');
  await updateMember('other', 'admin-a', 'viewer', 'active');
  await rejected(accept('outsider', invitation), 'permission-denied');
  assert.equal((await db.doc('organizations/alpha/members/outsider').get()).exists, false);
});

test('admin invitations update the serialized count, while existing member roles require an explicit admin change', async () => {
  await accept('outsider', await invite('admin-a', email('outsider'), 'alpha', 'admin'));
  assert.equal((await db.doc('organizations/alpha').get()).get('activeAdminCount'), 2);
  await accept('viewer', await invite('admin-a', email('viewer'), 'alpha', 'admin'));
  assert.equal((await db.doc(memberPath).get()).get('role'), 'viewer');
  assert.equal((await db.doc('organizations/alpha').get()).get('activeAdminCount'), 2);
  await updateMember('outsider', 'admin-a', 'viewer', 'active');
  assert.equal((await db.doc('organizations/alpha').get()).get('activeAdminCount'), 1);
});

test('backend rechecks current verification, email and disabled status instead of trusting a cached token', async () => {
  const user = await client('other');
  const token = await getIdToken(user.auth.currentUser!);
  try {
    await auth.updateUser('other', { emailVerified: false });
    await rejected(invoke('other', 'listMyOrganizations', {}), 'permission-denied');
    await auth.updateUser('other', { emailVerified: true, disabled: true });
    await rejected(invoke('other', 'listMyOrganizations', {}), 'permission-denied');
    await auth.updateUser('other', { disabled: false, email: 'changed-other@example.test' });
    await rejected(invoke('other', 'listMyOrganizations', {}), 'permission-denied');
    assert.equal(await getIdToken(user.auth.currentUser!), token);
  } finally {
    await auth.updateUser('other', { email: email('other'), emailVerified: true, disabled: false });
  }
});

test('last active administrator cannot be demoted, suspended or removed, including racing changes', async () => {
  for (const status of ['active', 'suspended', 'removed'])
    await rejected(updateMember('admin-a', 'admin-a', 'viewer', status), 'failed-precondition');
  await updateMember('admin-a', 'other', 'admin', 'active');
  const results = await Promise.allSettled([
    updateMember('admin-a', 'admin-a', 'viewer', 'active'),
    updateMember('other', 'other', 'viewer', 'active'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await db.doc('organizations/alpha').get()).get('activeAdminCount'), 1);
});

test('removal clears assignments and denies reads using the same still-valid ID token; reactivation stays unassigned', async () => {
  const viewer = await client('viewer');
  const accepted = await invite('admin-a', email('viewer'));
  await accept('viewer', accepted);
  const token = await getIdToken(viewer.auth.currentUser!);
  await assertSucceeds(getDoc(doc(viewer.db, scenePath)));
  await updateMember('admin-a', 'viewer', 'viewer', 'removed');
  await accept('viewer', accepted);
  assert.equal((await db.doc(memberPath).get()).get('status'), 'removed');
  assert.deepEqual((await db.doc(scenePath).get()).get('assignedUserIds'), []);
  await assertFails(getDoc(doc(viewer.db, scenePath)));
  await assertFails(getMetadata(ref(viewer.storage, asset())));
  assert.equal(await getIdToken(viewer.auth.currentUser!), token);
  await updateMember('admin-a', 'viewer', 'viewer', 'active');
  await assertFails(getDoc(doc(viewer.db, scenePath)));
  await assertSucceeds(getDoc(doc(viewer.db, 'organizations/alpha/scenes/organization')));
});

test('invitation cannot bypass suspension or resurrect removal using a pre-removal token', async () => {
  const suspended = await invite('admin-a', email('suspended'));
  await rejected(accept('suspended', suspended), 'permission-denied');
  const stale = await invite('admin-a', email('viewer'));
  await updateMember('admin-a', 'viewer', 'viewer', 'removed');
  await rejected(accept('viewer', stale), 'permission-denied');
  const fresh = await invite('admin-a', email('viewer'));
  await accept('viewer', fresh);
  assert.deepEqual((await db.doc(scenePath).get()).get('assignedUserIds'), []);
});

test('assignment command validates members, sizes, types, duplicates and optimistic versions', async () => {
  await rejected(
    invoke('admin-a', 'updateMember', {
      orgId: 'alpha',
      uid: 'viewer',
      role: 'viewer',
      status: ['active'],
    }),
    'invalid-argument',
  );
  const base = {
    orgId: 'alpha',
    sceneId: 'assigned',
    accessMode: 'assigned',
    assignedUserIds: ['viewer'],
    expectedVersion: 1,
  };
  for (const assignedUserIds of [
    ['admin-b'],
    ['suspended'],
    ['viewer', 'viewer'],
    Array(101).fill('viewer'),
    [12],
  ]) {
    await assert.rejects(invoke('admin-a', 'setSceneAccess', { ...base, assignedUserIds }));
  }
  await rejected(invoke('viewer', 'setSceneAccess', base), 'permission-denied');
  await invoke('admin-a', 'setSceneAccess', { ...base, assignedUserIds: ['other'] });
  await rejected(invoke('admin-a', 'setSceneAccess', base), 'aborted');
  await assertFails(getDoc(doc((await client('viewer')).db, scenePath)));
  await assertSucceeds(getDoc(doc((await client('other')).db, scenePath)));
});

test('organization discovery returns only active own memberships; uninvited identity has none', async () => {
  assert.deepEqual((await invoke('viewer', 'listMyOrganizations', {})).organizations, [
    { id: 'alpha', name: 'Alpha', role: 'viewer' },
  ]);
  assert.deepEqual((await invoke('outsider', 'listMyOrganizations', {})).organizations, []);
  assert.deepEqual((await invoke('suspended', 'listMyOrganizations', {})).organizations, []);
  await rejected(
    invoke('viewer', 'listMyOrganizations', { after: 'organizations/beta/members/admin-b' }),
    'invalid-argument',
  );
  const batch = db.batch();
  for (let i = 0; i < 26; i++) {
    const org = db.doc(`organizations/discovery-${String(i).padStart(2, '0')}`);
    batch.set(org, { name: `Discovery ${i}`, activeAdminCount: 1 });
    batch.set(org.collection('members').doc('admin-a'), {
      uid: 'admin-a',
      role: 'admin',
      status: 'active',
    });
    batch.set(org.collection('members').doc('viewer'), {
      uid: 'viewer',
      role: 'viewer',
      status: 'active',
    });
  }
  await batch.commit();
  const first = await invoke<{ organizations: { id: string }[]; next: string }>(
    'viewer',
    'listMyOrganizations',
    {},
  );
  const second = await invoke<{ organizations: { id: string }[]; next: null }>(
    'viewer',
    'listMyOrganizations',
    { after: first.next },
  );
  assert.equal(first.organizations.length, 25);
  assert.equal(second.organizations.length, 2);
  assert.equal(
    new Set([...first.organizations, ...second.organizations].map((org) => org.id)).size,
    27,
  );
  assert.equal(second.next, null);
});

test('exact two-query catalog is authorized, deterministic and paginates each branch independently', async () => {
  const viewer = await client('viewer');
  const first = await listOrganizationScenes(viewer.db, 'alpha', 'viewer');
  assert.deepEqual(
    first.scenes.map((scene) => scene.id),
    ['assigned', 'organization'],
  );
  const batch = db.batch();
  for (let i = 0; i < 30; i++)
    batch.set(db.doc(`organizations/alpha/scenes/catalog-${String(i).padStart(2, '0')}`), {
      title: `Scene ${i}`,
      status: 'published',
      accessMode: 'organization',
      assignedUserIds: [],
      publishedRevisionId: 'r1',
      version: 1,
    });
  await batch.commit();
  const page1 = await listOrganizationScenes(viewer.db, 'alpha', 'viewer');
  const page2 = await listOrganizationScenes(viewer.db, 'alpha', 'viewer', page1.next);
  assert.equal(page1.next.assigned, null);
  assert.equal(new Set([...page1.scenes, ...page2.scenes].map((scene) => scene.id)).size, 32);
  assert.deepEqual(page2.next, { organization: null, assigned: null });
  await assertFails(getDocs(query(collection(viewer.db, 'organizations/alpha/scenes'), limit(25))));
  await assertFails(
    getDocs(
      query(
        collection(viewer.db, 'organizations/alpha/scenes'),
        where('status', '==', 'published'),
        limit(25),
      ),
    ),
  );
  await assertFails(getDocs(query(collection(viewer.db, 'organizations/beta/scenes'), limit(25))));
});

test('Firestore access matrix protects drafts, histories, directories, invitations, audit and other organizations', async () => {
  for (const uid of ['anonymous', 'outsider', 'unverified', 'suspended']) {
    const user = await client(uid);
    for (const path of [
      memberPath,
      scenePath,
      `${scenePath}/revisions/r1`,
      'organizations/alpha',
    ]) {
      await assertFails(getDoc(doc(user.db, path)));
    }
  }
  const viewer = await client('viewer');
  await assertSucceeds(getDoc(doc(viewer.db, memberPath)));
  for (const path of [
    'organizations/alpha/members/other',
    'organizations/alpha/scenes/draft',
    `${scenePath}/revisions/r0`,
    'organizations/beta',
    'organizations/beta/members/admin-b',
  ])
    await assertFails(getDoc(doc(viewer.db, path)));
  for (const collectionPath of ['members', 'invitations', 'audit', 'uploads']) {
    const path = `organizations/alpha/${collectionPath}`;
    await assertFails(getDocs(query(collection(viewer.db, path), limit(25))));
    await assertSucceeds(getDocs(query(collection((await client('admin-a')).db, path), limit(25))));
  }
  for (const path of ['organizations/alpha/scenes/draft', `${scenePath}/revisions/r0`])
    await assertSucceeds(getDoc(doc((await client('admin-a')).db, path)));
  await assertFails(
    getDocs(collection((await client('admin-a')).db, 'organizations/alpha/members')),
  );
  await db.doc('organizations/alpha').delete();
  await assertFails(getDoc(doc(viewer.db, scenePath)));
});

test('all direct metadata creates, updates, deletes, oversized fields, role forgeries and unknown paths are denied', async () => {
  const user = await client('admin-a');
  for (const path of [
    'organizations/forged',
    'organizations/alpha/members/forged',
    'organizations/alpha/scenes/new',
    'organizations/alpha/invitations/forged',
    'organizations/alpha/uploads/forged',
    'publicScenes/forged',
    'unknown/forged',
  ]) {
    await assertFails(
      setDoc(doc(user.db, path), {
        uid: 'admin-a',
        role: 'admin',
        name: 'x'.repeat(10000),
        extra: true,
      }),
    );
  }
  await assertFails(
    updateDoc(doc(user.db, memberPath), { role: 'admin', joinedAt: 'fake', uid: 'admin-a' }),
  );
  await assertFails(deleteDoc(doc(user.db, memberPath)));
  await assertFails(updateDoc(doc((await client('viewer')).db, memberPath), { role: 'admin' }));
});

test('Storage matrix permits only current assigned/organization assets or own-admin history and drafts', async () => {
  for (const uid of ['anonymous', 'outsider', 'unverified', 'suspended', 'admin-b', 'other'])
    await assertFails(getMetadata(ref((await client(uid)).storage, asset())));
  const viewer = await client('viewer');
  await assertSucceeds(getMetadata(ref(viewer.storage, asset())));
  await assertSucceeds(getMetadata(ref(viewer.storage, asset('organization'))));
  for (const [scene, revision, org] of [
    ['assigned', 'r0', 'alpha'],
    ['draft', 'r1', 'alpha'],
    ['archived', 'r1', 'alpha'],
    ['organization', 'r1', 'beta'],
  ])
    await assertFails(getMetadata(ref(viewer.storage, asset(scene, revision, org))));
  for (const [scene, revision] of [
    ['assigned', 'r0'],
    ['draft', 'r1'],
    ['archived', 'r1'],
  ])
    await assertSucceeds(
      getMetadata(ref((await client('admin-a')).storage, asset(scene, revision))),
    );
  await db.doc(scenePath).update({ publishedRevisionId: 'r0' });
  await assertFails(getMetadata(ref(viewer.storage, asset())));
  await assertSucceeds(getMetadata(ref(viewer.storage, asset('assigned', 'r0'))));
});

test('staging writes remain denied, including admin writes and injected download tokens, until controlled uploads exist', async () => {
  const storage = (await client('admin-a')).storage;
  const path = 'organizations/alpha/staging/upload1/splats.spz';
  const existing = 'organizations/alpha/staging/upload1/existing.spz';
  await assertSucceeds(getMetadata(ref(storage, existing)));
  for (const uid of ['viewer', 'admin-b', 'anonymous'])
    await assertFails(getMetadata(ref((await client(uid)).storage, existing)));
  for (const uid of ['admin-a', 'viewer', 'admin-b', 'anonymous'])
    await assertFails(
      uploadBytes(ref((await client(uid)).storage, path), new Uint8Array([1]), {
        contentType: 'application/octet-stream',
      }),
    );
  await assertFails(
    uploadBytes(ref(storage, path), new Uint8Array(11), {
      contentType: 'application/octet-stream',
    }),
  );
  await assertFails(
    uploadBytes(ref(storage, path), new Uint8Array([1]), { contentType: 'text/plain' }),
  );
  await assertFails(
    uploadBytes(ref(storage, path), new Uint8Array([1]), {
      contentType: 'application/octet-stream',
      customMetadata: { firebaseStorageDownloadTokens: 'injected' },
    }),
  );
  await assertFails(
    updateMetadata(ref(storage, asset()), {
      customMetadata: { firebaseStorageDownloadTokens: 'injected' },
    }),
  );
  await assertFails(deleteObject(ref(storage, asset())));
  await assertFails(uploadBytes(ref(storage, asset()), new Uint8Array([2])));
  await db
    .doc('organizations/alpha/uploads/upload1')
    .update({ expiresAt: Timestamp.fromMillis(0) });
  await assertFails(
    uploadBytes(
      ref(storage, 'organizations/alpha/staging/upload1/colliders.glb'),
      new Uint8Array([1]),
      { contentType: 'model/gltf-binary' },
    ),
  );
});

test('anonymous published metadata/binaries work; suspension denies all binary roles while keeping metadata', async () => {
  const publicDb = (await client()).db;
  await assertSucceeds(getDoc(doc(publicDb, 'publicScenes/base')));
  await assertFails(getDoc(doc(publicDb, 'publicScenes/draft')));
  await assertSucceeds(
    getDocs(
      query(collection(publicDb, 'publicScenes'), where('status', '==', 'published'), limit(25)),
    ),
  );
  const url = `http://127.0.0.1:9399/v0/b/${bucket}/o/${encodeURIComponent('public-scenes/base/revisions/r1/splats.spz')}?alt=media`;
  assert.equal((await fetch(url, { headers: { Range: 'bytes=0-1' } })).status, 206);
  const rules = await readFile('../storage.rules', 'utf8');
  const load = (source: string) =>
    fetch(`http://127.0.0.1:9399/internal/setRules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: { files: [{ name: 'storage.rules', content: source }] } }),
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
    for (const uid of ['viewer', 'admin-a'])
      await assertFails(getMetadata(ref((await client(uid)).storage, asset())));
    await assertSucceeds(getDoc(doc(publicDb, 'publicScenes/base')));
  } finally {
    assert.ok((await load(rules)).ok);
  }
});

test('operator bootstrap is verified, idempotent and not a callable', async () => {
  const count = (await db.collection('organizations/alpha/audit').get()).size;
  await service.bootstrap({ orgId: 'alpha', name: 'Alpha', adminUid: 'admin-a' });
  assert.equal((await db.collection('organizations/alpha/audit').get()).size, count);
  await assert.rejects(
    service.bootstrap({ orgId: 'gamma', name: 'Gamma', adminUid: 'unverified' }),
  );
  const response = await fetch(`http://127.0.0.1:5101/${project}/us-central1/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { orgId: 'gamma', adminUid: 'outsider', name: 'Gamma' } }),
  });
  assert.equal(response.status, 404);
});

test('password verification/reset and mocked Google linking preserve UID without granting uninvited access', async () => {
  const context = await client();
  const identity = createIdentity(context.auth);
  const account = await identity.createPasswordAccount(
    'new-password@example.test',
    'Initial-password-123!',
  );
  await identity.sendVerification();
  let codes = (await (
    await fetch(`http://127.0.0.1:9199/emulator/v1/projects/${project}/oobCodes`)
  ).json()) as { oobCodes: { email: string; oobCode: string; requestType: string }[] };
  const code = codes.oobCodes.find(
    (c) => c.email === account.user.email && c.requestType === 'VERIFY_EMAIL',
  )!;
  await applyActionCode(context.auth, code.oobCode);
  await reload(account.user);
  await getIdToken(account.user, true);
  assert.equal(account.user.emailVerified, true);
  assert.deepEqual(
    (
      await (
        await import('firebase/functions')
      ).httpsCallable(
        context.functions,
        'listMyOrganizations',
      )({})
    ).data,
    { organizations: [], next: null },
  );
  await identity.sendPasswordReset(account.user.email!);
  codes = (await (
    await fetch(`http://127.0.0.1:9199/emulator/v1/projects/${project}/oobCodes`)
  ).json()) as typeof codes;
  await confirmPasswordReset(
    context.auth,
    codes.oobCodes.find(
      (c) => c.email === account.user.email && c.requestType === 'PASSWORD_RESET',
    )!.oobCode,
    'Changed-password-456!',
  );
  const uid = account.user.uid;
  await identity.signOut();
  assert.equal(
    (await identity.signInPassword('new-password@example.test', 'Changed-password-456!')).user.uid,
    uid,
  );
  await identity.signOut();
  const google = await signInWithCredential(
    context.auth,
    GoogleAuthProvider.credential(
      JSON.stringify({
        sub: 'mock-google',
        email: 'mock-google@example.test',
        email_verified: true,
      }),
    ),
  );
  assert.equal(google.user.email, 'mock-google@example.test');
  assert.equal(context.auth.currentUser!.uid, google.user.uid);
  assert.equal((await auth.getUserByEmail('mock-google@example.test')).uid, google.user.uid);
  await identity.setPassword('Google-linked-password-123!');
  const googleUid = google.user.uid;
  assert.equal((await auth.getUser(googleUid)).providerData.length, 2);
  await identity.signOut();
  assert.equal(
    (await identity.signInPassword('mock-google@example.test', 'Google-linked-password-123!')).user
      .uid,
    googleUid,
  );
  await identity.signOut();
});
