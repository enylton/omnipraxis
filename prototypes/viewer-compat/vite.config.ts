import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  publicDir: false,
  server: { host: '127.0.0.1', port: 4174, strictPort: true, fs: { allow: [workspace] } },
  plugins: [
    {
      name: 'built-viewer',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Serve this proof without Vite's HTML/client injection or an app entry.
          if (req.url === '/artifact-host') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(readFileSync(new URL('./artifact-host.html', import.meta.url)));
            return;
          }
          if (req.url?.startsWith('/build/viewer/'))
            req.url = `/@fs/${workspace.replaceAll('\\', '/')}${req.url.slice(1)}`;
          next();
        });
      },
    },
  ],
});
