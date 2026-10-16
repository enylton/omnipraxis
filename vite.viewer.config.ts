import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'build/viewer',
    target: 'es2022',
    lib: {
      entry: fileURLToPath(new URL('./src/viewer/index.tsx', import.meta.url)),
      formats: ['es'],
      fileName: () => 'viewer.js',
    },
  },
});
