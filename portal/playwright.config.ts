import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.browser.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../build/portal-tests',
  use: {
    baseURL: 'http://127.0.0.1:4200',
    channel: 'msedge',
    launchOptions: { args: ['--disable-gpu-sandbox'] },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node portal/serve.ts',
    cwd: '..',
    url: 'http://127.0.0.1:4200',
    reuseExistingServer: false,
  },
});
