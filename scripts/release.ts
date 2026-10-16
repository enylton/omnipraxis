import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseProductionConfig } from '../src/contracts/portalConfig.ts';

type Entry = { path: string; bytes: number; sha256: string };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function inventory(root: string, prefix = ''): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}${item.name}`;
    if (item.isSymbolicLink() || /\.(spz|splat|ply|rad|radc|glb|gltf)$/i.test(path))
      throw new Error('Release contains scene binaries or symlinks.');
    if (item.isDirectory()) entries.push(...(await inventory(root, `${path}/`)));
    else if (item.isFile()) {
      const bytes = await readFile(join(root, path));
      entries.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    } else throw new Error('Unsupported release entry.');
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function validate(root: string, files: Entry[]) {
  const index = await readFile(join(root, 'index.html'), 'utf8');
  if (
    !index.includes('portal-app') ||
    !files.some((f) => f.path.startsWith('viewer/')) ||
    !files.some((f) => f.path.startsWith('public-viewer/'))
  )
    throw new Error('Only the Angular private-delivery portal is an eligible recovery artifact.');
  if (files.some((f) => f.path === 'portal-config.json'))
    parseProductionConfig(JSON.parse(await readFile(join(root, 'portal-config.json'), 'utf8')));
}
export async function recordRelease(
  root = 'build/portal/browser',
  target = 'build/release-manifest.json',
) {
  const files = await inventory(root);
  await validate(root, files);
  const sources: Entry[] = [];
  for (const path of [
    'firestore.rules',
    'storage.rules',
    'firestore.indexes.json',
    'functions/pnpm-lock.yaml',
    ...(await readdir('functions/src'))
      .filter((p) => p.endsWith('.ts'))
      .map((p) => `functions/src/${p}`),
  ]) {
    const bytes = await readFile(path);
    sources.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = {
    format: 1,
    frontend: 'angular-cloud-v1',
    environmentSchema: 1,
    publicSchema: 1,
    viewerApi: 1,
    publicViewerApi: 2,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    files,
    sources,
  };
  await writeFile(target, JSON.stringify(manifest, null, 2) + '\n');
  return { files: files.length, commit: manifest.commit, dirty: manifest.dirty };
}
export async function verifyRelease(
  root = 'build/portal/browser',
  source = 'build/release-manifest.json',
) {
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  if (
    manifest.format !== 1 ||
    manifest.frontend !== 'angular-cloud-v1' ||
    manifest.viewerApi !== 1 ||
    manifest.publicViewerApi !== 2 ||
    manifest.environmentSchema !== 1 ||
    manifest.publicSchema !== 1
  )
    throw new Error('Unsupported release compatibility contract.');
  const files = await inventory(root);
  await validate(root, files);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error('Release files differ from the recorded hashes.');
  return { files: files.length, commit: manifest.commit, dirty: manifest.dirty };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (command !== 'record' && command !== 'verify')
    throw new Error('Use release.ts record|verify [portal-directory] [manifest-file].');
  console.log(
    await (command === 'record' ? recordRelease : verifyRelease)(process.argv[3], process.argv[4]),
  );
}
