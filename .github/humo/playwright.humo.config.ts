// Config de Playwright para el humo: apunta al contenedor ya levantado, sin
// webServer ni `next build`. Guarda: recusa una URL que no sea local.
import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.HUMO_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE_URL)) {
  throw new Error(`HUMO_BASE_URL no es local (${BASE_URL}) — recusado.`);
}

export default defineConfig({
  testDir: "../../tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "../../test-results",
  reporter: [
    ["list"],
    ["json", { outputFile: "../../humo-resultados.json" }],
    ["html", { outputFolder: "../../playwright-report", open: "never" }],
  ],
  use: { baseURL: BASE_URL, trace: "on", screenshot: "on" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
