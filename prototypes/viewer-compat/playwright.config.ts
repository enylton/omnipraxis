import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../../tests/viewer-compat',
  testMatch: '**/*.browser.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../../build/viewer-compat/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    channel: 'msedge',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc', '--disable-gpu-sandbox'],
    },
  },
  webServer: [
    {
      command: 'pnpm viewer:dev',
      cwd: '../..',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm exec vite --config prototypes/viewer-compat/assets.vite.config.ts',
      cwd: '../..',
      url: 'http://127.0.0.1:4175/omnipraxis/scenes/base/colliders.glb',
      reuseExistingServer: false,
    },
  ],
});
