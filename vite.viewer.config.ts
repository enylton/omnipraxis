import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { VIEWER_API_VERSION } from './src/viewer/version';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'viewer-contract',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'types/index.d.ts',
          source:
            "export * from './api';\nexport declare const mountViewer: import('./api').MountViewer;\n",
        });
        this.emitFile({
          type: 'asset',
          fileName: 'viewer.manifest.json',
          source:
            JSON.stringify(
              {
                apiVersion: VIEWER_API_VERSION,
                module: 'viewer.js',
                stylesheet: 'viewer.css',
                types: 'types/index.d.ts',
                resources: {
                  workers: 'embedded-blob',
                  webAssembly: 'embedded',
                  sceneAssets: 'host-provided',
                },
              },
              null,
              2,
            ) + '\n',
        });
      },
    },
  ],
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'build/viewer',
    target: 'es2022',
    lib: {
      entry: fileURLToPath(new URL('./src/viewer/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'viewer.js',
      cssFileName: 'viewer',
    },
  },
});
