import { randomUUID } from 'node:crypto';

import { FieldPath, Timestamp } from 'firebase-admin/firestore';

import type { DocumentData, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { getStorage } from 'firebase-admin/storage';

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;
type Asset = { path: string; bytes: number; generation: string };
export type RetentionPlan = {
  scenePath: string;
  version: number;
  candidates: { revisionId: string; bytes: number; files: number }[];
  retained: { revisionId: string; reason: string }[];
};
const grace = 7 * 86400000;
const millis = (value: unknown): number => (value instanceof Timestamp ? value.toMillis() : 0);
export function sceneLocation(path: string) {
  const privateMatch =
    /^organizations\/([A-Za-z0-9_-]{1,100})\/scenes\/([A-Za-z0-9_-]{1,100})$/.exec(path);
  const publicMatch = /^publicScenes\/(base|circuit-breaker|pressure-gauge)$/.exec(path);
  if (!privateMatch && !publicMatch) throw new Error('An application scene path is required.');
  return {
    revisions: publicMatch ? `publicSceneImports/${publicMatch[1]}/revisions` : `${path}/revisions`,
    prefix: (revision: string) =>
      publicMatch
        ? `public-scenes/${publicMatch[1]}/revisions/${revision}/`
        : `${path}/revisions/${revision}/`,
    org: privateMatch?.[1],
  };
}
function manifest(data: DocumentData, prefix: string): Asset[] {
  const entries = Object.values(data.manifest ?? {}) as Asset[];
  if (
    !entries.length ||
    entries.length > 1000 ||
    !Number.isSafeInteger(data.storageBytes) ||
    data.storageBytes <= 0 ||
    data.storageBytes > 500 * 1024 ** 2
  )
    throw new Error('A complete, accounted revision manifest is required.');
  const paths = new Set<string>();
  let bytes = 0;
  for (const asset of entries) {
    if (
      !asset ||
      typeof asset.path !== 'string' ||
      !asset.path.startsWith(prefix) ||
      !/^[A-Za-z0-9_./-]+$/.test(asset.path) ||
      asset.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      !/^[1-9][0-9]*$/.test(asset.generation) ||
      paths.has(asset.path)
    )
      throw new Error('Unsafe revision manifest.');
    paths.add(asset.path);
    bytes += asset.bytes;
  }
  if (bytes !== data.storageBytes) throw new Error('Revision byte accounting does not match.');
  return entries;
}
function planFrom(
  scenePath: string,
  scene: DocumentData,
  revisions: QueryDocumentSnapshot[],
  now: number,
): RetentionPlan {
  if (revisions.length > 100)
    throw new Error('Review/paginate scenes exceeding 100 revision records before retention.');
  if (!Number.isSafeInteger(scene.version) || scene.version < 1)
    throw new Error('A reviewed scene version is required.');
  const location = sceneLocation(scenePath);
  const history = revisions
    .filter(
      (r) =>
        r.id !== scene.publishedRevisionId &&
        r.get('status') === 'ready' &&
        millis(r.get('lastPublishedAt')) > 0,
    )
    .sort(
      (a, b) =>
        millis(b.get('lastPublishedAt')) - millis(a.get('lastPublishedAt')) ||
        a.id.localeCompare(b.id),
    );
  const rollback = new Set(history.slice(0, 2).map((r) => r.id));
  const plan: RetentionPlan = { scenePath, version: scene.version, candidates: [], retained: [] };
  for (const revision of revisions) {
    const data = revision.data();
    let reason =
      revision.id === scene.publishedRevisionId
        ? 'current publication'
        : rollback.has(revision.id)
          ? 'rollback window'
          : '';
    if (!reason && data.status === 'deleting') {
      if (millis(data.retention?.leaseUntil) > now) reason = 'cleanup lease active';
    } else if (!reason && (data.status !== 'ready' || millis(data.lastPublishedAt) <= 0))
      reason = 'unpublished, untracked or non-ready candidate';
    else if (!reason && millis(data.lastPublishedAt) > now - grace)
      reason = 'seven-day recovery window';
    if (!reason) {
      try {
        const files = manifest(data, location.prefix(revision.id));
        if (!data.sourceUploadId && !data.importReceiptPath)
          throw new Error('No accounting owner.');
        plan.candidates.push({
          revisionId: revision.id,
          bytes: data.storageBytes,
          files: files.length,
        });
      } catch {
        reason = 'incomplete accounting/manifest; operator review required';
      }
    }
    if (reason) plan.retained.push({ revisionId: revision.id, reason });
  }
  return plan;
}

export function retentionService(db: Firestore, bucket: Bucket) {
  const revisionQuery = (path: string) =>
    db.collection(sceneLocation(path).revisions).orderBy(FieldPath.documentId()).limit(101);
  async function plan(scenePath: string, now = Date.now()) {
    const [scene, revisions] = await Promise.all([
      db.doc(scenePath).get(),
      revisionQuery(scenePath).get(),
    ]);
    if (!scene.exists) throw new Error('Scene not found.');
    return planFrom(scenePath, scene.data()!, revisions.docs, now);
  }
  async function apply(reviewed: RetentionPlan, now = Date.now()) {
    const location = sceneLocation(reviewed.scenePath);
    let deleted = 0;
    let reclaimedBytes = 0;
    // Only IDs in the reviewed dry run are eligible. Every claim rechecks publication and retention.
    for (const candidate of reviewed.candidates) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(candidate.revisionId))
        throw new Error('Invalid revision identity.');
      const ref = db.doc(`${location.revisions}/${candidate.revisionId}`);
      const token = randomUUID();
      const owned = await db.runTransaction(async (tx) => {
        const [scene, revisions, quota] = await Promise.all([
          tx.get(db.doc(reviewed.scenePath)),
          tx.get(revisionQuery(reviewed.scenePath)),
          tx.get(db.doc('system/assetQuota')),
        ]);
        if (scene.get('version') !== reviewed.version)
          throw new Error('Scene changed after the dry run.');
        const fresh = planFrom(reviewed.scenePath, scene.data()!, revisions.docs, now);
        if (
          !fresh.candidates.some(
            (r) => r.revisionId === candidate.revisionId && r.bytes === candidate.bytes,
          )
        )
          return null;
        const current = revisions.docs.find((r) => r.id === candidate.revisionId)!;
        const data = current.data();
        const assets = manifest(data, location.prefix(candidate.revisionId));
        let ownerPath: string;
        if (
          data.sourceUploadId &&
          location.org &&
          /^[A-Za-z0-9_-]{1,128}$/.test(data.sourceUploadId)
        )
          ownerPath = `organizations/${location.org}/uploads/${data.sourceUploadId}`;
        else if (
          typeof data.importReceiptPath === 'string' &&
          /^system\/legacyImport-[A-Za-z0-9_-]+$/.test(data.importReceiptPath)
        )
          ownerPath = data.importReceiptPath;
        else throw new Error('Invalid accounting owner.');
        const owner = await tx.get(db.doc(ownerPath));
        const ownerBytes = data.sourceUploadId ? owner.get('chargedBytes') : owner.get('bytes');
        if (
          !owner.exists ||
          ownerBytes !== data.storageBytes ||
          owner.get('cleanupPending') === true ||
          millis(owner.get('leaseUntil')) > now ||
          !['ready', 'retiring'].includes(owner.get('status')) ||
          !Number.isSafeInteger(quota.get('usedBytes')) ||
          quota.get('usedBytes') < data.storageBytes
        )
          throw new Error('Staging/owner/quota must be reconciled before pruning.');
        if (
          data.sourceUploadId &&
          (owner.get('revisionId') !== candidate.revisionId ||
            `${reviewed.scenePath}` !==
              `organizations/${location.org}/scenes/${owner.get('sceneId')}`)
        )
          throw new Error('Revision accounting owner mismatch.');
        if (!data.sourceUploadId && owner.get('fingerprint') !== data.fingerprint)
          throw new Error('Import accounting owner mismatch.');
        tx.update(ref, {
          status: 'deleting',
          retention: { token, ownerPath, leaseUntil: Timestamp.fromMillis(now + 20 * 60000) },
        });
        tx.update(owner.ref, { status: 'retiring' });
        return { assets, bytes: data.storageBytes, ownerPath };
      });
      if (!owned) continue;
      const [objects, next] = await bucket.getFiles({
        prefix: location.prefix(candidate.revisionId),
        maxResults: 1001,
        autoPaginate: false,
      });
      const allowed = new Set(owned.assets.map((asset) => asset.path));
      if (next || objects.some((file) => !allowed.has(file.name)))
        throw new Error('Unexpected objects require operator review; quota remains reserved.');
      for (const asset of owned.assets) {
        const file = bucket.file(asset.path);
        try {
          const [metadata] = await file.getMetadata();
          if (
            String(metadata.generation) !== asset.generation ||
            Number(metadata.size) !== asset.bytes
          )
            throw new Error('Immutable object generation/size changed; refusing deletion.');
          await file.delete({ ifGenerationMatch: asset.generation, ignoreNotFound: true });
        } catch (error) {
          if (Number((error as { code?: number }).code) !== 404) throw error;
        }
      }
      await db.runTransaction(async (tx) => {
        const [scene, revision, quota, owner] = await tx.getAll(
          db.doc(reviewed.scenePath),
          ref,
          db.doc('system/assetQuota'),
          db.doc(owned.ownerPath),
        );
        if (
          scene.get('publishedRevisionId') === candidate.revisionId ||
          revision.get('status') !== 'deleting' ||
          revision.get('retention.token') !== token
        )
          throw new Error('Retention ownership/publication changed.');
        if (
          !Number.isSafeInteger(quota.get('usedBytes')) ||
          quota.get('usedBytes') < owned.bytes ||
          owner.get('status') !== 'retiring'
        )
          throw new Error('Quota/owner reconciliation required.');
        tx.update(ref, {
          status: 'deleted',
          deletedAt: Timestamp.now(),
          retention: { token, leaseUntil: Timestamp.fromMillis(0) },
        });
        tx.update(owner.ref, dataOwner(owner.data()!));
        tx.update(quota.ref, { usedBytes: quota.get('usedBytes') - owned.bytes });
        tx.create(
          db
            .collection(location.org ? `organizations/${location.org}/audit` : 'systemOperations')
            .doc(),
          {
            actor: 'system',
            action: 'revision.deleted',
            target: ref.path,
            bytes: owned.bytes,
            createdAt: Timestamp.now(),
          },
        );
      });
      deleted++;
      reclaimedBytes += owned.bytes;
    }
    return { deleted, reclaimedBytes };
  }
  function dataOwner(owner: DocumentData) {
    return Object.hasOwn(owner, 'chargedBytes')
      ? { status: 'retired', chargedBytes: 0 }
      : { status: 'deleted' };
  }
  async function sweep() {
    const scenes = new Set<string>();
    const deleting = await db
      .collectionGroup('revisions')
      .where('status', '==', 'deleting')
      .limit(25)
      .get();
    const cursorRef = db.doc('system/retentionCursor');
    const cursor = await cursorRef.get();
    let query = db
      .collectionGroup('revisions')
      .where('status', '==', 'ready')
      .where('lastPublishedAt', '<=', Timestamp.fromMillis(Date.now() - grace))
      .orderBy('lastPublishedAt')
      .orderBy(FieldPath.documentId())
      .limit(25);
    if (cursor.get('at') instanceof Timestamp && typeof cursor.get('path') === 'string')
      query = query.startAfter(cursor.get('at'), db.doc(cursor.get('path')));
    const ready = await query.get();
    let last: QueryDocumentSnapshot | undefined;
    for (const revision of [...deleting.docs, ...ready.docs]) {
      const parts = revision.ref.path.split('/');
      const path =
        parts.length === 6 && parts[0] === 'organizations' && parts[2] === 'scenes'
          ? parts.slice(0, 4).join('/')
          : parts.length === 4 && parts[0] === 'publicSceneImports'
            ? `publicScenes/${parts[1]}`
            : '';
      if (path) {
        try {
          sceneLocation(path);
        } catch {
          continue;
        }
        if (!scenes.has(path) && scenes.size >= 5) break;
        scenes.add(path);
      }
      if (revision.get('status') === 'ready') last = revision;
    }
    let deleted = 0;
    let reclaimedBytes = 0;
    for (const path of scenes) {
      const result = await apply(await plan(path));
      deleted += result.deleted;
      reclaimedBytes += result.reclaimedBytes;
    }
    await cursorRef.set(
      last ? { at: last.get('lastPublishedAt'), path: last.ref.path } : { at: null, path: null },
    );
    return { scenes: scenes.size, deleted, reclaimedBytes };
  }
  return { plan, apply, sweep };
}
