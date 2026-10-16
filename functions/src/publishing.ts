import { createHash, randomUUID } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { chunkBytes, limits, slots, validateAsset } from './validation.ts';

import type { Slot } from './validation.js';
import type { Auth } from 'firebase-admin/auth';
import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';
import type { getStorage } from 'firebase-admin/storage';
import type { CallableRequest } from 'firebase-functions/v2/https';

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;
type Manifest = Record<Slot, { bytes: number; sha256: string }>;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const fail = (
  message: string,
  code:
    | 'invalid-argument'
    | 'failed-precondition'
    | 'permission-denied'
    | 'aborted'
    | 'resource-exhausted' = 'invalid-argument',
): never => {
  throw new HttpsError(code, message);
};
function object(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail('Unsupported command fields.');
  return value as Record<string, unknown>;
}
function id(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    fail('Invalid identifier.');
  return value as string;
}
function title(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120)
    fail('Title must contain 1–120 characters.');
  return (value as string).trim();
}
function version(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail('Invalid scene version.');
  return Number(value);
}

export function publishingService(db: Firestore, auth: Auth, bucket: Bucket) {
  const quotaRef = db.doc('system/assetQuota');
  const sceneRef = (org: string, scene: string) => db.doc(`organizations/${org}/scenes/${scene}`);
  const uploadRef = (org: string, upload: string) =>
    db.doc(`organizations/${org}/uploads/${upload}`);
  const lockRef = (org: string) => db.doc(`system/uploadLocks-${org}`);
  const prefix = (org: string, upload: string) => `organizations/${org}/staging/${upload}/`;
  const revisionPrefix = (org: string, scene: string, revision: string) =>
    `organizations/${org}/scenes/${scene}/revisions/${revision}/`;
  async function actor(request: CallableRequest, org: string) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const user = await auth.getUser(request.auth.uid);
    if (
      user.disabled ||
      !user.emailVerified ||
      request.auth.token.email_verified !== true ||
      !user.email ||
      user.email.toLowerCase() !== String(request.auth.token.email).toLowerCase()
    )
      fail('A current verified identity is required.', 'permission-denied');
    const uid = id(user.uid);
    await db.runTransaction((tx) => admin(tx, org, uid));
    return uid;
  }
  async function admin(tx: Transaction, org: string, uid: string) {
    const [organization, member] = await tx.getAll(
      db.doc(`organizations/${org}`),
      db.doc(`organizations/${org}/members/${uid}`),
    );
    if (
      !organization.exists ||
      member.get('uid') !== uid ||
      member.get('role') !== 'admin' ||
      member.get('status') !== 'active'
    )
      fail('Active organization administrator required.', 'permission-denied');
  }
  async function enabled(tx: Transaction) {
    const status = await tx.get(db.doc('publicSettings/delivery'));
    if (status.get('downloadsEnabled') !== true)
      fail('Uploads and downloads are temporarily suspended.', 'failed-precondition');
  }
  function audit(tx: Transaction, org: string, uid: string, action: string, target: string) {
    tx.create(db.collection(`organizations/${org}/audit`).doc(), {
      actor: uid,
      action,
      target,
      createdAt: Timestamp.now(),
    });
  }
  function owned(upload: DocumentData | undefined, uid: string) {
    if (!upload || upload.actor !== uid)
      fail('Upload belongs to another administrator.', 'permission-denied');
    return upload!;
  }
  function uploading(upload: DocumentData) {
    if (upload.status !== 'uploading' || upload.expiresAt.toMillis() <= Date.now())
      fail('Upload expired or no longer accepts chunks.', 'failed-precondition');
  }
  async function clean(ref: ReturnType<typeof uploadRef>, now: number) {
    const token = randomUUID();
    const claimed = await db.runTransaction(async (tx) => {
      const saved = await tx.get(ref);
      const u = saved.data();
      if (
        !u ||
        !u.cleanupPending ||
        u.expiresAt.toMillis() > now ||
        (u.leaseUntil?.toMillis() ?? 0) > now
      )
        return null;
      tx.update(ref, {
        lease: token,
        leaseUntil: Timestamp.fromMillis(now + 20 * 60000),
        status: u.status === 'ready' ? 'ready' : 'cleaning',
      });
      return u;
    });
    if (!claimed) return false;
    const org = id(ref.parent.parent!.id);
    const upload = id(ref.id);
    const scene = id(claimed.sceneId);
    const revision = id(claimed.revisionId);
    // Never touch ready revisions. Cleanup is session-scoped, never bucket-wide.
    await bucket.deleteFiles({ prefix: prefix(org, upload), force: true });
    if (claimed.status !== 'ready') {
      const sceneDoc = await sceneRef(org, scene).get();
      if (sceneDoc.get('publishedRevisionId') === revision)
        fail('Published assets cannot be cleaned.', 'failed-precondition');
      await bucket.deleteFiles({ prefix: revisionPrefix(org, scene, revision), force: true });
    }
    await db.runTransaction(async (tx) => {
      const [saved, quota, locks] = await tx.getAll(ref, quotaRef, lockRef(org));
      if (saved.get('lease') !== token) fail('Cleanup ownership changed.', 'aborted');
      const keep = claimed.status === 'ready' ? claimed.totalBytes : 0;
      const active = { ...(locks.get('active') ?? {}) };
      if (active[claimed.actor] === upload) delete active[claimed.actor];
      const activeAdmins = { ...(quota.get('activeAdmins') ?? {}) };
      if (activeAdmins[claimed.actor] === upload) delete activeAdmins[claimed.actor];
      tx.set(quotaRef, {
        usedBytes: Math.max(0, (quota.get('usedBytes') ?? 0) - claimed.chargedBytes + keep),
        activeAdmins,
      });
      tx.set(lockRef(org), { active });
      tx.update(ref, {
        chargedBytes: keep,
        cleanupPending: false,
        status: claimed.status === 'ready' ? 'ready' : 'expired',
        leaseUntil: Timestamp.fromMillis(0),
      });
      if (claimed.status !== 'ready')
        tx.set(
          sceneRef(org, scene).collection('revisions').doc(revision),
          { status: 'failed', error: 'Upload expired or cancelled.' },
          { merge: true },
        );
      audit(tx, org, 'system', 'upload.cleaned', upload);
    });
    return true;
  }
  return {
    async createScene(request: CallableRequest) {
      const data = object(request.data, ['orgId', 'sceneId', 'title']);
      const org = id(data.orgId);
      const scene = id(data.sceneId);
      if (scene.length > 100) fail('Scene ID must be at most 100 characters.');
      const uid = await actor(request, org);
      const name = title(data.title);
      await db.runTransaction(async (tx) => {
        await admin(tx, org, uid);
        const ref = sceneRef(org, scene);
        const existing = await tx.get(ref);
        if (existing.exists) fail('Scene ID already exists.', 'failed-precondition');
        tx.create(ref, {
          title: name,
          status: 'draft',
          accessMode: 'organization',
          assignedUserIds: [],
          publishedRevisionId: null,
          version: 1,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
        });
        audit(tx, org, uid, 'scene.created', scene);
      });
      return { sceneId: scene, version: 1 };
    },
    async updateScene(request: CallableRequest) {
      const d = object(request.data, ['orgId', 'sceneId', 'title', 'expectedVersion']);
      const org = id(d.orgId);
      const scene = id(d.sceneId);
      const uid = await actor(request, org);
      const name = title(d.title);
      const expected = version(d.expectedVersion);
      await db.runTransaction(async (tx) => {
        await admin(tx, org, uid);
        const ref = sceneRef(org, scene);
        const saved = await tx.get(ref);
        if (saved.get('version') !== expected)
          fail('Scene changed; reload before retrying.', 'aborted');
        tx.update(ref, { title: name, version: expected + 1, updatedAt: Timestamp.now() });
        audit(tx, org, uid, 'scene.updated', scene);
      });
      return { version: expected + 1 };
    },
    async createUpload(request: CallableRequest) {
      const d = object(request.data, ['orgId', 'sceneId', 'requestId', 'files', 'spawn']);
      const org = id(d.orgId);
      const scene = id(d.sceneId);
      const uid = await actor(request, org);
      const upload = hash(`${org}:${uid}:${id(d.requestId)}`);
      if (org.length > 100 || scene.length > 100)
        fail('Organization/scene IDs must fit the descriptor contract.');
      const files = object(d.files, [...slots]) as Manifest;
      let total = 0;
      for (const slot of slots) {
        const f = object(files[slot], ['bytes', 'sha256']);
        if (
          !Number.isSafeInteger(f.bytes) ||
          Number(f.bytes) <= 0 ||
          Number(f.bytes) > limits[slot] ||
          typeof f.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(f.sha256)
        )
          fail(`Invalid ${slot} manifest.`);
        total += Number(f.bytes);
      }
      const spawn = object(d.spawn, ['position', 'yaw', 'pitch']);
      if (
        !Array.isArray(spawn.position) ||
        spawn.position.length !== 3 ||
        !spawn.position.every(
          (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000,
        ) ||
        typeof spawn.yaw !== 'number' ||
        !Number.isFinite(spawn.yaw) ||
        Math.abs(spawn.yaw) > 2 * Math.PI ||
        typeof spawn.pitch !== 'number' ||
        !Number.isFinite(spawn.pitch) ||
        Math.abs(spawn.pitch) > Math.PI / 2
      )
        fail('Invalid spawn position or orientation.');
      if (total > 250 * 1024 ** 2) fail('Upload exceeds 250 MiB.');
      await db.runTransaction(async (tx) => {
        await admin(tx, org, uid);
        await enabled(tx);
        const ref = uploadRef(org, upload);
        const [existing, savedScene, quota, locks] = await tx.getAll(
          ref,
          sceneRef(org, scene),
          quotaRef,
          lockRef(org),
        );
        if (existing.exists) {
          const prior = existing.data()!;
          if (
            prior.sceneId !== scene ||
            slots.some(
              (s) =>
                prior.files[s].bytes !== files[s].bytes ||
                prior.files[s].sha256 !== files[s].sha256,
            ) ||
            JSON.stringify(prior.spawn.position) !== JSON.stringify(spawn.position) ||
            prior.spawn.yaw !== spawn.yaw ||
            prior.spawn.pitch !== spawn.pitch
          )
            fail('Request ID already used for different input.', 'failed-precondition');
          return;
        }
        if (!savedScene.exists) fail('Scene not found.');
        const active = { ...(locks.get('active') ?? {}) };
        const activeAdmins = { ...(quota.get('activeAdmins') ?? {}) };
        const used = quota.get('usedBytes') ?? 0;
        if (
          activeAdmins[uid] ||
          Object.keys(active).length >= 2 ||
          used + 2 * total > 5 * 1024 ** 3
        )
          fail(
            'Upload concurrency or project byte quota reached. Cancel/clean an earlier session.',
            'resource-exhausted',
          );
        active[uid] = upload;
        activeAdmins[uid] = upload;
        tx.set(lockRef(org), { active });
        tx.set(quotaRef, { usedBytes: used + 2 * total, activeAdmins });
        tx.create(ref, {
          actor: uid,
          sceneId: scene,
          revisionId: upload,
          files,
          spawn,
          totalBytes: total,
          chargedBytes: 2 * total,
          offsets: Object.fromEntries(slots.map((s) => [s, 0])),
          status: 'uploading',
          expiresAt: Timestamp.fromMillis(Date.now() + 86400000),
          cleanupPending: true,
          createdAt: Timestamp.now(),
        });
        tx.create(sceneRef(org, scene).collection('revisions').doc(upload), {
          status: 'uploading',
          sourceUploadId: upload,
          createdBy: uid,
          createdAt: Timestamp.now(),
        });
        audit(tx, org, uid, 'upload.created', upload);
      });
      return { uploadId: upload, revisionId: upload, chunkBytes };
    },
    async appendChunk(request: CallableRequest) {
      const d = object(request.data, ['orgId', 'uploadId', 'slot', 'offset', 'data']);
      const org = id(d.orgId);
      const upload = id(d.uploadId);
      const uid = await actor(request, org);
      if (
        !slots.includes(d.slot as Slot) ||
        !Number.isSafeInteger(d.offset) ||
        Number(d.offset) < 0 ||
        Number(d.offset) % chunkBytes !== 0 ||
        typeof d.data !== 'string' ||
        d.data.length > Math.ceil(chunkBytes / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(d.data)
      )
        fail('Invalid upload chunk.');
      const slot = d.slot as Slot;
      const offset = Number(d.offset);
      const bytes = Buffer.from(d.data as string, 'base64');
      if (bytes.length === 0 || bytes.length > chunkBytes || bytes.toString('base64') !== d.data)
        fail('Invalid chunk encoding.');
      const ref = uploadRef(org, upload);
      const digest = hash(bytes);
      const part = bucket.file(`${prefix(org, upload)}${slot}.${offset}.part`);
      const lease = randomUUID();
      await db.runTransaction(async (tx) => {
        await admin(tx, org, uid);
        await enabled(tx);
        const u = owned((await tx.get(ref)).data(), uid);
        uploading(u);
        if ((u.leaseUntil?.toMillis() ?? 0) > Date.now())
          fail('Another upload operation is running.', 'aborted');
        const expected = Math.min(chunkBytes, u.files[slot].bytes - offset);
        if (expected !== bytes.length || offset > u.offsets[slot])
          fail('Chunk offset/length mismatch.', 'failed-precondition');
        tx.update(ref, { lease, leaseUntil: Timestamp.fromMillis(Date.now() + 20 * 60000) });
      });
      try {
        if ((await part.exists())[0]) {
          const [saved] = await part.download();
          if (hash(saved) !== digest)
            fail('Chunk conflicts with existing immutable bytes.', 'failed-precondition');
        } else
          try {
            await part.save(bytes, {
              resumable: false,
              preconditionOpts: { ifGenerationMatch: 0 },
              metadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' },
            });
          } catch (error) {
            if (Number((error as { code?: number }).code) !== 412) throw error;
            const [saved] = await part.download();
            if (hash(saved) !== digest)
              fail('Chunk conflicts with existing immutable bytes.', 'failed-precondition');
          }
        const [metadata] = await part.getMetadata();
        if (metadata.metadata && Object.keys(metadata.metadata).length)
          fail('Unexpected object metadata.', 'failed-precondition');
        await db.runTransaction(async (tx) => {
          await admin(tx, org, uid);
          await enabled(tx);
          const u = owned((await tx.get(ref)).data(), uid);
          uploading(u);
          if (u.lease !== lease) fail('Upload ownership changed.', 'aborted');
          if (u.offsets[slot] === offset)
            tx.update(ref, { offsets: { ...u.offsets, [slot]: offset + bytes.length } });
        });
        return { offset: offset + bytes.length };
      } finally {
        await db.runTransaction(async (tx) => {
          const u = await tx.get(ref);
          if (u.get('lease') === lease) tx.update(ref, { leaseUntil: Timestamp.fromMillis(0) });
        });
      }
    },
    async finalizeUpload(request: CallableRequest) {
      const d = object(request.data, ['orgId', 'uploadId']);
      const org = id(d.orgId);
      const upload = id(d.uploadId);
      const uid = await actor(request, org);
      const ref = uploadRef(org, upload);
      const lease = randomUUID();
      const u = await db.runTransaction(async (tx) => {
        await admin(tx, org, uid);
        await enabled(tx);
        const u = owned((await tx.get(ref)).data(), uid);
        if (u.status === 'ready') return u;
        if (u.status === 'validating') {
          if (u.leaseUntil.toMillis() > Date.now())
            fail('Validation is already running.', 'aborted');
        } else if (u.status !== 'failed') uploading(u);
        if ((u.leaseUntil?.toMillis() ?? 0) > Date.now())
          fail('An upload operation is running.', 'aborted');
        if (slots.some((s) => u.offsets[s] !== u.files[s].bytes))
          fail('Upload all three files before validation.', 'failed-precondition');
        tx.update(ref, {
          status: 'validating',
          lease,
          leaseUntil: Timestamp.fromMillis(Date.now() + 20 * 60000),
        });
        return u;
      });
      if (u.status === 'ready') return { revisionId: u.revisionId, status: 'ready' };
      const revision = sceneRef(org, u.sceneId).collection('revisions').doc(u.revisionId);
      const manifest: Record<string, unknown> = {};
      const fence = async () => {
        await db.runTransaction(async (tx) => {
          await admin(tx, org, uid);
          await enabled(tx);
          const current = await tx.get(ref);
          if (
            current.get('lease') !== lease ||
            current.get('status') !== 'validating' ||
            current.get('leaseUntil').toMillis() <= Date.now()
          )
            fail('Validation ownership changed.', 'aborted');
        });
      };
      try {
        for (const slot of slots) {
          await fence();
          const spec = u.files[slot];
          const parts: Buffer[] = [];
          for (let offset = 0; offset < spec.bytes; offset += chunkBytes) {
            const [part] = await bucket
              .file(`${prefix(org, upload)}${slot}.${offset}.part`)
              .download();
            if (part.length !== Math.min(chunkBytes, spec.bytes - offset))
              fail('Incomplete chunk.');
            parts.push(part);
          }
          const bytes = Buffer.concat(parts);
          if (bytes.length !== spec.bytes || hash(bytes) !== spec.sha256)
            fail('Asset length/checksum does not match its manifest.');
          const path = `${revisionPrefix(org, u.sceneId, u.revisionId)}${slot}`;
          const file = bucket.file(path);
          if (!(await file.exists())[0])
            try {
              await file.save(bytes, {
                resumable: false,
                preconditionOpts: { ifGenerationMatch: 0 },
                metadata: {
                  contentType: slot === 'thumbnail.png' ? 'image/png' : 'application/octet-stream',
                  cacheControl: 'no-store',
                },
              });
            } catch (error) {
              if (Number((error as { code?: number }).code) !== 412) throw error;
            }
          const [metadata] = await file.getMetadata();
          if (metadata.metadata && Object.keys(metadata.metadata).length)
            fail('Revision object contains forbidden metadata.');
          const [immutable] = await file.download();
          if (immutable.length !== spec.bytes || hash(immutable) !== spec.sha256)
            fail('Immutable revision checksum mismatch.');
          await validateAsset(slot, immutable);
          manifest[slot] = {
            path,
            bytes: spec.bytes,
            sha256: spec.sha256,
            generation: String(metadata.generation),
          };
        }
        await fence();
        const descriptor = {
          schemaVersion: 1,
          kind: 'environment-v1',
          sceneId: u.sceneId,
          revisionId: u.revisionId,
          scope: { kind: 'organization', organizationId: org },
          assets: {
            splats: { ...(manifest['splats.spz'] as object), format: 'spz' },
            colliders: { ...(manifest['colliders.glb'] as object), format: 'glb' },
          },
          spawn: u.spawn,
        };
        await db.runTransaction(async (tx) => {
          await admin(tx, org, uid);
          await enabled(tx);
          const [current, locks, quota] = await tx.getAll(ref, lockRef(org), quotaRef);
          if (
            current.get('lease') !== lease ||
            current.get('status') !== 'validating' ||
            current.get('leaseUntil').toMillis() <= Date.now()
          )
            fail('Validation ownership changed.', 'aborted');
          const active = { ...(locks.get('active') ?? {}) };
          if (active[uid] === upload) delete active[uid];
          tx.set(lockRef(org), { active });
          const activeAdmins = { ...(quota.get('activeAdmins') ?? {}) };
          if (activeAdmins[uid] === upload) delete activeAdmins[uid];
          tx.update(quotaRef, { activeAdmins });
          tx.set(revision, {
            status: 'ready',
            descriptor,
            manifest,
            storageBytes: u.totalBytes,
            sourceUploadId: upload,
            createdBy: uid,
            validatedAt: Timestamp.now(),
          });
          tx.update(ref, {
            status: 'ready',
            expiresAt: Timestamp.now(),
            leaseUntil: Timestamp.fromMillis(0),
          });
          audit(tx, org, uid, 'revision.ready', u.revisionId);
        });
        await clean(ref, Date.now()).catch(() => false);
        return { revisionId: u.revisionId, status: 'ready' };
      } catch (error) {
        const message =
          error instanceof HttpsError
            ? error.message
            : error instanceof Error && !('code' in error)
              ? error.message
              : 'Validation failed. Retry or cancel this upload.';
        await db.runTransaction(async (tx) => {
          const current = await tx.get(ref);
          if (current.get('lease') !== lease || current.get('status') !== 'validating') return;
          tx.update(ref, {
            status: 'failed',
            error: message.slice(0, 200),
            expiresAt: Timestamp.fromMillis(Date.now() + 7 * 86400000),
            leaseUntil: Timestamp.fromMillis(0),
          });
          tx.set(revision, { status: 'failed', error: message.slice(0, 200) }, { merge: true });
          audit(tx, org, uid, 'revision.failed', u.revisionId);
        });
        throw new HttpsError('failed-precondition', message.slice(0, 200));
      }
    },
    async cancelUpload(request: CallableRequest) {
      const d = object(request.data, ['orgId', 'uploadId']);
      const org = id(d.orgId);
      const upload = id(d.uploadId);
      const uid = await actor(request, org);
      const ref = uploadRef(org, upload);
      await db.runTransaction(async (tx) => {
        await admin(tx, org, uid);
        const u = owned((await tx.get(ref)).data(), uid);
        if (u.status === 'expired') return;
        if (u.status === 'ready')
          fail('Completed sessions cannot be cancelled.', 'failed-precondition');
        if ((u.leaseUntil?.toMillis() ?? 0) > Date.now())
          fail(
            'An upload operation is running. Retry cancellation after it finishes or its lease expires.',
            'failed-precondition',
          );
        tx.update(ref, {
          status: 'cancelled',
          expiresAt: Timestamp.now(),
          leaseUntil: Timestamp.fromMillis(0),
        });
        if (u.status !== 'cancelled') audit(tx, org, uid, 'upload.cancelled', upload);
      });
      await clean(ref, Date.now());
      return { cancelled: true };
    },
    async publishRevision(request: CallableRequest) {
      const d = object(request.data, ['orgId', 'sceneId', 'revisionId', 'expectedVersion']);
      const org = id(d.orgId);
      const scene = id(d.sceneId);
      const revision = id(d.revisionId);
      const expected = version(d.expectedVersion);
      const uid = await actor(request, org);
      await db.runTransaction(async (tx) => {
        await admin(tx, org, uid);
        await enabled(tx);
        const ref = sceneRef(org, scene);
        const [saved, ready] = await tx.getAll(ref, ref.collection('revisions').doc(revision));
        if (saved.get('version') !== expected)
          fail('Scene changed; reload before publishing.', 'aborted');
        if (ready.get('status') !== 'ready')
          fail('Only validated immutable revisions can be published.', 'failed-precondition');
        tx.update(ready.ref, { lastPublishedAt: Timestamp.now() });
        tx.update(ref, {
          status: 'published',
          publishedRevisionId: revision,
          version: expected + 1,
          updatedAt: Timestamp.now(),
        });
        audit(tx, org, uid, 'scene.published', revision);
      });
      return { version: expected + 1 };
    },
    async archiveScene(request: CallableRequest) {
      const d = object(request.data, ['orgId', 'sceneId', 'expectedVersion']);
      const org = id(d.orgId);
      const scene = id(d.sceneId);
      const expected = version(d.expectedVersion);
      const uid = await actor(request, org);
      await db.runTransaction(async (tx) => {
        await admin(tx, org, uid);
        const ref = sceneRef(org, scene);
        const saved = await tx.get(ref);
        if (saved.get('version') !== expected)
          fail('Scene changed; reload before archiving.', 'aborted');
        tx.update(ref, { status: 'archived', version: expected + 1, updatedAt: Timestamp.now() });
        audit(tx, org, uid, 'scene.archived', scene);
      });
      return { version: expected + 1 };
    },
    async cleanupExpired(org?: string, now = Date.now()) {
      const collection = org
        ? db.collection(`organizations/${id(org)}/uploads`)
        : db.collectionGroup('uploads');
      const candidates = await collection
        .where('cleanupPending', '==', true)
        .where('expiresAt', '<=', Timestamp.fromMillis(now))
        .orderBy('expiresAt')
        .limit(25)
        .get();
      let cleaned = 0;
      for (const candidate of candidates.docs)
        if (
          candidate.ref.path.startsWith('organizations/') &&
          candidate.ref.path.split('/').length === 4 &&
          (await clean(candidate.ref, now))
        )
          cleaned++;
      return { cleaned };
    },
  };
}
