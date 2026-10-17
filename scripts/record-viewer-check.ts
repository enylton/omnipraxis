import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const workspace = new URL('../', import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, workspace), 'utf8'));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trimEnd();
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(new URL(path, workspace)))
    .digest('hex');

mkdirSync(new URL('build/viewer-compat/', workspace), { recursive: true });
if (process.argv.includes('--start')) {
  writeFileSync(
    new URL('build/viewer-compat/viewer-check.json', workspace),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        automatedChecks: 'running',
        sourceCommit: git('rev-parse', 'HEAD'),
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(0);
}
const started = readJson('build/viewer-compat/viewer-check.json');
const baseline = readJson('config/viewer-upstream.json');
if (started.automatedChecks !== 'running' || started.sourceCommit !== git('rev-parse', 'HEAD')) {
  throw new Error(
    'Run pnpm viewer:check from the beginning; its source commit must not change during checks.',
  );
}
const manifest = readJson('build/viewer/viewer.manifest.json');
if (manifest.apiVersion !== baseline.viewerApiVersion) {
  throw new Error(
    'Review the viewer API version and upstream integration record before accepting it.',
  );
}
git('merge-base', '--is-ancestor', baseline.lastIntegratedCommit, 'HEAD');
const status = git('status', '--porcelain=v1');
const files = [
  'viewer.js',
  'viewer.css',
  'viewer.manifest.json',
  'types/index.d.ts',
  'types/api.d.ts',
  'types/version.d.ts',
];
const dependencies = [
  'react',
  'react-dom',
  'three',
  '@react-three/fiber',
  '@react-three/drei',
  '@react-three/rapier',
  '@sparkjsdev/spark',
  'firebase',
  'firebase-tools',
  '@firebase/rules-unit-testing',
  '@playwright/test',
  'vite',
  'typescript',
];

// Called by viewer:check only after builds, emulator tests, and browser tests succeed.
// A dirty-tree receipt is local verification evidence, not release approval.
const receipt = {
  startedAt: started.recordedAt,
  recordedAt: new Date().toISOString(),
  automatedChecks: 'passed',
  manualAcceptance: 'not-recorded',
  upstream: baseline,
  sourceCommit: git('rev-parse', 'HEAD'),
  sourceTreeClean: status === '',
  workingTreeStatus: status.split('\n').filter(Boolean),
  node: process.version,
  packageManager: readJson('package.json').packageManager,
  dependencies: Object.fromEntries(
    dependencies.map((name) => [name, readJson(`node_modules/${name}/package.json`).version]),
  ),
  lockfileSha256: sha256('pnpm-lock.yaml'),
  artifactSha256: Object.fromEntries(files.map((file) => [file, sha256(`build/viewer/${file}`)])),
  lifecycle: readJson('build/viewer-compat/lifecycle.json'),
};
writeFileSync(
  new URL('build/viewer-compat/viewer-check.json', workspace),
  JSON.stringify(receipt, null, 2) + '\n',
);
console.log('Viewer compatibility checks passed. Receipt: build/viewer-compat/viewer-check.json');
console.log('Manual scene/input/event-export acceptance is still a separate review requirement.');
