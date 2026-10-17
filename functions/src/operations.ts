import { randomUUID } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';

import { sceneLocation } from './retention.ts';

import type { Firestore } from 'firebase-admin/firestore';
import type { getStorage } from 'firebase-admin/storage';

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;
export function operatorReason(reason: string) {
  if (
    typeof reason !== 'string' ||
    reason.trim().length < 3 ||
    reason.length > 160 ||
    /[\r\n]/.test(reason)
  )
    throw new Error('Provide an operator reason of 3–160 characters on one line.');
  return reason.trim();
}
export function operationsService(db: Firestore, bucket: Bucket) {
  const delivery = db.doc('publicSettings/delivery');
  async function setDelivery(enabled: boolean, reason: string) {
    reason = operatorReason(reason);
    const token = randomUUID();
    const lock = db.doc('system/deliveryOperation');
    await db.runTransaction(async (tx) => {
      const current = await tx.get(lock);
      const lease = current.get('leaseUntil');
      if (lease instanceof Timestamp && lease.toMillis() > Date.now())
        throw new Error('Another delivery operation is active.');
      tx.set(lock, {
        token,
        status: 'applying',
        enabled,
        reason,
        leaseUntil: Timestamp.fromMillis(Date.now() + 300000),
      });
      // Both directions start with backend uploads/imports blocked.
      tx.set(delivery, { downloadsEnabled: false });
      tx.create(db.collection('systemOperations').doc(), {
        action: 'delivery.started',
        enabled,
        reason,
        token,
        createdAt: Timestamp.now(),
      });
    });
    try {
      await db.runTransaction(async (tx) => {
        const current = await tx.get(lock);
        if (current.get('token') !== token)
          throw new Error('Delivery operation ownership changed.');
        tx.set(delivery, { downloadsEnabled: enabled });
        tx.update(lock, { status: 'complete', leaseUntil: Timestamp.fromMillis(0) });
        tx.create(db.collection('systemOperations').doc(), {
          action: 'delivery.completed',
          enabled,
          reason,
          token,
          createdAt: Timestamp.now(),
        });
      });
    } catch (error) {
      await db.runTransaction(async (tx) => {
        const current = await tx.get(lock);
        if (current.get('token') !== token) return;
        tx.set(delivery, { downloadsEnabled: false });
        tx.update(lock, { status: 'failed', leaseUntil: Timestamp.fromMillis(0) });
        tx.create(db.collection('systemOperations').doc(), {
          action: 'delivery.failed',
          reason,
          token,
          createdAt: Timestamp.now(),
        });
      });
      throw error;
    }
    return { downloadsEnabled: enabled };
  }
  async function restorePublic(
    scene: string,
    revision: string,
    expectedVersion: number,
    reason: string,
  ) {
    reason = operatorReason(reason);
    const path = `publicScenes/${scene}`;
    const location = sceneLocation(path);
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(revision) ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    )
      throw new Error('A revision identity and reviewed scene version are required.');
    await db.runTransaction(async (tx) => {
      const [status, current, target] = await tx.getAll(
        delivery,
        db.doc(path),
        db.doc(`${location.revisions}/${revision}`),
      );
      if (status.get('downloadsEnabled') !== true)
        throw new Error('Scene publication is suspended.');
      if (current.get('version') !== expectedVersion)
        throw new Error('Scene changed; review its current version.');
      const descriptor = target.get('descriptor');
      if (
        target.get('status') !== 'ready' ||
        descriptor?.sceneId !== scene ||
        descriptor?.revisionId !== revision ||
        descriptor?.kind !== 'public-demo-v1'
      )
        throw new Error('Only a matching ready public revision can be restored.');
      tx.update(current.ref, {
        status: 'published',
        publishedRevisionId: revision,
        descriptor,
        version: expectedVersion + 1,
      });
      tx.update(target.ref, { lastPublishedAt: Timestamp.now() });
      tx.create(db.collection('systemOperations').doc(), {
        action: 'public.restored',
        scene,
        revision,
        reason,
        createdAt: Timestamp.now(),
      });
    });
    return { version: expectedVersion + 1 };
  }
  async function report() {
    const [quota, status, inventories] = await Promise.all([
      db.doc('system/assetQuota').get(),
      delivery.get(),
      Promise.all(
        ['organizations/', 'public-scenes/'].map(async (prefix) => {
          const [files, next] = await bucket.getFiles({
            prefix,
            maxResults: 1000,
            autoPaginate: false,
          });
          let bytes = 0;
          let tokenBearingObjects = 0;
          for (const file of files) {
            const size = Number(file.metadata.size);
            if (!Number.isSafeInteger(size) || size < 0)
              throw new Error('Inventory lacks object byte sizes.');
            bytes += size;
            if (file.metadata.metadata?.firebaseStorageDownloadTokens) tokenBearingObjects++;
          }
          return { prefix, objects: files.length, bytes, truncated: !!next, tokenBearingObjects };
        }),
      ),
    ]);
    return {
      downloadsEnabled: status.get('downloadsEnabled') === true,
      reservedBytes: quota.get('usedBytes') ?? null,
      inventories,
      scope:
        'Current objects in application prefixes only. Reservations include staging; soft-deleted/versioned objects, traffic, other project usage and billing are excluded.',
    };
  }
  return { setDelivery, restorePublic, report };
}
