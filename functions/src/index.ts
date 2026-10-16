import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';

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
