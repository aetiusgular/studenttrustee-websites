// Playwright runs the accessibility and layout checks against local static servers
// (tools/dev-server.js) at three viewports: desktop 1440, tablet 768, phone 390.
import { defineConfig, devices } from "@playwright/test";

const viewports = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 } },
  { name: "tablet-768", viewport: { width: 768, height: 1024 } },
  { name: "phone-390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8100",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: viewports.map((v) => ({
    name: v.name,
    use: { ...devices["Desktop Chrome"], viewport: v.viewport, isMobile: v.isMobile || false, hasTouch: v.hasTouch || false, deviceScaleFactor: v.deviceScaleFactor || 1 },
  })),
  webServer: {
    command: "node tools/dev-server.js",
    url: "http://127.0.0.1:8100/",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
