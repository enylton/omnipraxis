import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'build/portal/browser';
async function check(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || /\.(spz|splat|ply|rad|radc|glb|gltf)$/i.test(entry.name))
      throw new Error(`Scene binary or symlink must not ship through Hosting: ${path}`);
    if (entry.isDirectory()) await check(path);
  }
}
const config = JSON.parse(await readFile('firebase.json', 'utf8'));
if (config.hosting.public !== root || !(await stat(`${root}/index.html`)).isFile())
  throw new Error('Hosting must serve the built Angular portal.');
await check(root);
console.log('Web artifact contains no scene binaries; Hosting points to Angular.');
