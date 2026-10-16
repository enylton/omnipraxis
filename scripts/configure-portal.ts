import { readFile, writeFile } from 'node:fs/promises';

import { parseProductionConfig } from '../src/contracts/portalConfig.ts';

const source = process.argv[2];
const json = source ? await readFile(source, 'utf8') : process.env.PORTAL_CONFIG_JSON;
if (!json) throw new Error('Provide a reviewed config file or PORTAL_CONFIG_JSON.');
const config = parseProductionConfig(JSON.parse(json));
await writeFile('build/portal/browser/portal-config.json', JSON.stringify(config, null, 2) + '\n');
console.log('Reviewed web configuration written to the built portal. No deployment performed.');
