import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('../../public/', import.meta.url)),
  base: '/omnipraxis/',
  publicDir: false,
  server: { host: '127.0.0.1', port: 4175, strictPort: true },
});
