import { defineConfig, devices } from "@playwright/test";

/**
 * UI tests run against the Vite dev server with the in-memory Tauri mock
 * (`/?mock=1`). No native window, no database: they cover the React side —
 * dialogs, sidebar tree, grid, editing flow, query editor, Redis views.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://localhost:1430",
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    port: 1430,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
