import { readFile } from 'node:fs/promises';

import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { initializeApp as adminApp } from 'firebase-admin/app';
import { getAuth as adminAuth } from 'firebase-admin/auth';
import { getFirestore as adminFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage as adminStorage } from 'firebase-admin/storage';

import { organizationService } from '../src/service.ts';

export const project = 'demo-omnipraxis';
export const bucket = `${project}.appspot.com`;
export const password = 'Phase2-test-only-123!';
for (const [name, expected] of Object.entries({
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8280',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9199',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9399',
})) {
  if (process.env[name] !== expected)
    throw new Error(`Refusing non-demo tests: ${name} must be ${expected}.`);
}
if (process.env.GCLOUD_PROJECT !== project)
  throw new Error('Refusing tests outside the dedicated demo project.');
const app = adminApp({ projectId: project, storageBucket: bucket }, 'phase2-tests');
export const db = adminFirestore(app);
export const auth = adminAuth(app);
export const assetBucket = adminStorage(app).bucket();
export const service = organizationService(db, auth);
export const identities = [
  'admin-a',
  'viewer',
  'other',
  'admin-b',
  'outsider',
  'unverified',
  'suspended',
];
export const email = (uid: string) => `${uid}@example.test`;

export async function initialize() {
  for (const uid of identities) {
    const user = {
      email: email(uid),
      password,
      emailVerified: uid !== 'unverified',
    };
    try {
      await auth.createUser({ uid, ...user });
    } catch (error) {
      if (
        (error as { code?: string }).code !== 'auth/uid-already-exists' &&
        (error as { code?: string }).code !== 'auth/email-already-exists'
      )
        throw error;
      await auth.updateUser(uid, user);
    }
  }
  return initializeTestEnvironment({
    projectId: project,
    firestore: {
      host: '127.0.0.1',
      port: 8280,
      rules: await readFile('../firestore.rules', 'utf8'),
    },
    storage: { host: '127.0.0.1', port: 9399 },
  });
}

export async function seed() {
  const response = await fetch(
    `http://127.0.0.1:8280/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error('Could not clear dedicated demo fixtures.');
  await service.bootstrap({ orgId: 'alpha', name: 'Alpha', adminUid: 'admin-a' });
  await service.bootstrap({ orgId: 'beta', name: 'Beta', adminUid: 'admin-b' });
  const batch = db.batch();
  for (const uid of ['viewer', 'other', 'suspended']) {
    batch.set(db.doc(`organizations/alpha/members/${uid}`), {
      uid,
      email: email(uid),
      displayName: uid,
      role: 'viewer',
      status: uid === 'suspended' ? 'suspended' : 'active',
      joinedAt: Timestamp.now(),
    });
  }
  for (const orgId of ['alpha', 'beta']) {
    for (const [sceneId, status, accessMode, assignedUserIds] of [
      ['organization', 'published', 'organization', []],
      ['assigned', 'published', 'assigned', ['viewer']],
      ['draft', 'draft', 'assigned', ['viewer']],
      ['archived', 'archived', 'organization', []],
    ] as const) {
      const scene = db.doc(`organizations/${orgId}/scenes/${sceneId}`);
      batch.set(scene, {
        title: sceneId,
        status,
        accessMode,
        assignedUserIds,
        publishedRevisionId: 'r1',
        version: 1,
      });
      for (const revision of ['r0', 'r1'])
        batch.set(scene.collection('revisions').doc(revision), { status: 'ready', descriptor: {} });
    }
  }
  batch.set(db.doc('publicScenes/base'), {
    title: 'Public base',
    status: 'published',
    publishedRevisionId: 'r1',
  });
  batch.set(db.doc('publicScenes/draft'), {
    title: 'Hidden',
    status: 'draft',
    publishedRevisionId: 'r1',
  });
  batch.set(db.doc('organizations/alpha/uploads/upload1'), {
    actor: 'admin-a',
    status: 'uploading',
    expiresAt: Timestamp.fromMillis(Date.now() + 60000),
    slots: { 'splats.spz': 10, 'colliders.glb': 10, 'thumbnail.webp': 10 },
  });
  await batch.commit();
  const storage = adminStorage(app).bucket();
  for (const path of [
    'public-scenes/base/revisions/r1/splats.spz',
    'public-scenes/base/revisions/r0/splats.spz',
    'organizations/alpha/staging/upload1/existing.spz',
    'organizations/beta/scenes/organization/revisions/r1/splats.spz',
    ...['organization', 'assigned', 'draft', 'archived'].flatMap((scene) =>
      ['r0', 'r1'].map((r) => `organizations/alpha/scenes/${scene}/revisions/${r}/splats.spz`),
    ),
  ]) {
    await storage.file(path).save(Buffer.from([1, 2, 3, 4]), {
      resumable: false,
      metadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' },
    });
  }
}

const clients = new Map<string, ReturnType<typeof createClient>>();
function createClient(key: string) {
  const app = initializeApp(
    { projectId: project, apiKey: 'demo-phase2-key', storageBucket: bucket },
    `phase2-${key}`,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9199', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8280);
  const functions = getFunctions(app, 'us-central1');
  connectFunctionsEmulator(functions, '127.0.0.1', 5101);
  const storage = getStorage(app);
  connectStorageEmulator(storage, '127.0.0.1', 9399);
  return { app, auth, db, functions, storage };
}
export async function client(uid = 'anonymous') {
  let value = clients.get(uid);
  if (!value) {
    value = createClient(uid);
    clients.set(uid, value);
  }
  if (uid !== 'anonymous' && !value.auth.currentUser)
    await signInWithEmailAndPassword(value.auth, email(uid), password);
  return value;
}
export async function invoke<T = Record<string, unknown>>(
  uid: string,
  name: string,
  data: unknown,
) {
  return (await httpsCallable<unknown, T>((await client(uid)).functions, name)(data)).data;
}
export type Invitation = { invitationId: string; token: string; expiresAt: number };
export const invite = (uid: string, invitedEmail: string, orgId = 'alpha', role = 'viewer') =>
  invoke<Invitation>(uid, 'createInvitation', { orgId, email: invitedEmail, role });
export const accept = (uid: string, invitation: Invitation, orgId = 'alpha') =>
  invoke(uid, 'acceptInvitation', {
    orgId,
    invitationId: invitation.invitationId,
    token: invitation.token,
  });
export async function cleanup() {
  await Promise.all([...clients.values()].map(({ app }) => deleteApp(app)));
  await db.terminate();
}
