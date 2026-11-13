import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:4173/', trace: 'retain-on-failure' },
  webServer: {
    command: 'BASE_PATH=/ npx vite build && BASE_PATH=/ npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'ipad-webkit',
      use: { ...devices['iPad Pro 11 landscape'], browserName: 'webkit' },
    },
  ],
});
