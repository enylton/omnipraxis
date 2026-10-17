import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import { operationsService, operatorReason } from './operations.ts';
import { retentionService } from './retention.ts';

// No live mode: cloud operations require the release gates in docs/cloud-cutover.md.
for (const [name, expected] of Object.entries({
  GCLOUD_PROJECT: 'demo-omnipraxis',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8280',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9399',
})) {
  if (process.env[name] && process.env[name] !== expected)
    throw new Error('Operator CLI refuses non-demo endpoints.');
  process.env[name] = expected;
}
const args = process.argv.slice(2);
const command = args[0];
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};
const apply = args.includes('--apply');
const app = initializeApp(
  { projectId: 'demo-omnipraxis', storageBucket: 'demo-omnipraxis.appspot.com' },
  'operator',
);
try {
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket();
  const ops = operationsService(db, bucket);
  let result: unknown;
  if (command === 'report') result = await ops.report();
  else if (command === 'retain') {
    const retention = retentionService(db, bucket);
    const plan = await retention.plan(value('--scene'));
    console.log(JSON.stringify(plan, null, 2));
    if (apply) result = await retention.apply(plan);
  } else if (command === 'suspend' || command === 'resume') {
    const reason = operatorReason(value('--reason'));
    result = { dryRun: true, command, reason };
    if (apply) result = await ops.setDelivery(command === 'resume', reason);
  } else if (command === 'restore-public') {
    const reason = operatorReason(value('--reason'));
    result = {
      dryRun: true,
      command,
      scene: value('--scene'),
      revision: value('--revision'),
      expectedVersion: Number(value('--expected-version')),
      reason,
    };
    if (apply)
      result = await ops.restorePublic(
        value('--scene'),
        value('--revision'),
        Number(value('--expected-version')),
        reason,
      );
  } else
    throw new Error(
      'Use report, retain --scene PATH, suspend/resume --reason TEXT, or restore-public --scene ID --revision ID --expected-version N --reason TEXT. Mutations require --apply.',
    );
  if (result) console.log(JSON.stringify(result, null, 2));
} finally {
  await deleteApp(app);
}
