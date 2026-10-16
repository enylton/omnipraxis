import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import { organizationService } from './service.js';

const [projectId, orgId, adminUid, name, confirmation] = process.argv.slice(2);
if (!projectId || !orgId || !adminUid || !name || confirmation !== '--confirm-bootstrap') {
  throw new Error(
    'Usage: node functions/lib/bootstrap.js PROJECT ORG VERIFIED_UID "Organization name" --confirm-bootstrap',
  );
}
const firestoreEmulated = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const authEmulated = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (firestoreEmulated !== authEmulated || (projectId.startsWith('demo-') && !firestoreEmulated)) {
  throw new Error('A demo bootstrap requires both Firestore and Auth emulators.');
}
initializeApp({ projectId });
console.log(
  await organizationService(getFirestore(), getAuth()).bootstrap({ orgId, adminUid, name }),
);
