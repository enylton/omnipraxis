// Deliberately fixed local endpoints. This helper cannot seed a live project.
process.env.GCLOUD_PROJECT = 'demo-omnipraxis';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9199';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8280';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9399';
// This fixed local helper cannot use Compute Engine credentials/metadata.
process.env.METADATA_SERVER_DETECTION = 'none';
const { seed } = await import('../functions/test/portal-fixtures.ts');
await seed();
process.exit(0);
