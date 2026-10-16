import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../../tests/phase1',
  testMatch: '**/*.browser.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../../build/phase1/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    channel: 'msedge',
    launchOptions: {
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc', '--disable-gpu-sandbox'],
    },
  },
  webServer: [
    {
      command: 'pnpm phase1:dev',
      cwd: '../..',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: true,
    },
    {
      command: 'pnpm exec vite --config prototypes/phase1/legacy.vite.config.ts',
      cwd: '../..',
      url: 'http://127.0.0.1:4175/omnipraxis/',
      reuseExistingServer: true,
    },
  ],
});
