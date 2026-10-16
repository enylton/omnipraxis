import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    {
      name: 'public-viewer-types',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'types/index.d.ts',
          source:
            "export * from './public-api';\nexport declare const mountPublicDemo: import('./public-api').MountPublicDemo;\n",
        });
      },
    },
  ],
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'build/public-viewer',
    target: 'es2022',
    lib: {
      entry: fileURLToPath(new URL('./src/viewer/public.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'public-demos.js',
      cssFileName: 'viewer',
    },
  },
});
