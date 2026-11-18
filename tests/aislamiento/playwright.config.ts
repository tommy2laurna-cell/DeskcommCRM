import { defineConfig } from "@playwright/test";

/**
 * Gate de aislamiento entre organizaciones. Sin navegador: solo llamadas HTTP
 * contra el stack que levanta .github/workflows/aislamiento.yml.
 * Pre-requisito: scripts/seed-aislamiento.ts ya corrió (aislamiento-out/seed.json).
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
