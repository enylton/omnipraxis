import { createTestEnvironment, seedFixtures } from './fixtures.ts';

const environment = await createTestEnvironment();
try {
  const descriptors = await seedFixtures(environment);
  console.log(`Seeded emulator scenes: ${Object.keys(descriptors).join(', ')}.`);
} finally {
  await environment.cleanup();
}
