import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as logger from 'firebase-functions/logger';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { publishingService } from './publishing.js';
import { retentionService } from './retention.js';
import { organizationService } from './service.js';

initializeApp();
setGlobalOptions({
  region: 'us-central1',
  minInstances: 0,
  maxInstances: 1,
  timeoutSeconds: 30,
  memory: '256MiB',
  cpu: 'gcf_gen1',
  concurrency: 1,
});
const service = organizationService(getFirestore(), getAuth());

export const createInvitation = onCall(service.createInvitation);
export const revokeInvitation = onCall(service.revokeInvitation);
export const acceptInvitation = onCall(service.acceptInvitation);
export const updateMember = onCall(service.updateMember);
export const setSceneAccess = onCall(service.setSceneAccess);
export const listMyOrganizations = onCall(service.listMyOrganizations);

const publishing = publishingService(getFirestore(), getAuth(), getStorage().bucket());
export const createScene = onCall(publishing.createScene);
export const updateScene = onCall(publishing.updateScene);
export const createUpload = onCall(publishing.createUpload);
export const appendChunk = onCall(publishing.appendChunk);
export const finalizeUpload = onCall(
  { timeoutSeconds: 300, memory: '512MiB' },
  publishing.finalizeUpload,
);
export const cancelUpload = onCall(publishing.cancelUpload);
export const publishRevision = onCall(publishing.publishRevision);
export const archiveScene = onCall(publishing.archiveScene);
export const expireUploads = onSchedule(
  { schedule: 'every 60 minutes', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    await monitored('expireUploads', () => publishing.cleanupExpired());
  },
);

async function monitored(operation: string, run: () => Promise<unknown>) {
  try {
    const result = await run();
    logger.info('Maintenance completed', { component: 'omnipraxis.operations', operation, result });
  } catch {
    logger.error('Maintenance failed; reconcile before retrying', {
      component: 'omnipraxis.operations',
      operation,
    });
    throw new Error(`${operation} failed; operator reconciliation required.`);
  }
}
export const pruneRevisions = onSchedule(
  { schedule: 'every 24 hours', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    await monitored('pruneRevisions', () =>
      retentionService(getFirestore(), getStorage().bucket()).sweep(),
    );
  },
);
