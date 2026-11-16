import { defineConfig } from "@playwright/test";

// Only explicitly audited, network-isolated specs may run concurrently.
const mockedSpecs =
  /(?:^|[\\/])(?:acceptance|bug-reports|notification-eta|onboarding|safe-area|student-permissions|weighted-grading|statistics|subject-groups)\.spec\.ts$/;

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 2,
  projects: [
    {
      name: "mocked",
      testMatch: mockedSpecs,
      fullyParallel: true,
      workers: 2,
    },
    {
      name: "integration",
      testIgnore: mockedSpecs,
      fullyParallel: false,
      workers: 1,
      // Keep CPU-sensitive SSE/recovery assertions separate from the mock workers.
      dependencies: ["mocked"],
    },
  ],
  use: {
    baseURL: process.env.BASE_URL || "http://127.0.0.1:8080",
    headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  reporter: "list",
});
