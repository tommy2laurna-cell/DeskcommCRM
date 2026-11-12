/**
 * Capturas de pantallas + contraste (axe) para el rediseño Liquid.
 *
 * Se corre dos veces desde `.github/workflows/liquid-capturas.yml`: contra `main`
 * (ANTES) y contra la rama (DESPUÉS). Misma lista de pantallas, mismas semillas,
 * misma marca (`APP_ACCENT_HEX`), así que la diferencia entre las dos corridas es
 * el diseño y nada más.
 *
 * Salida en `liquid-out/`: `<pantalla>__<ancho>__<tema>.png`, `axe.json` y
 * `resumen.json`. Con `LIQUID_AXE_ENFORCE=1` el test falla si axe encuentra
 * una violación de `color-contrast` (la corrida ANTES no lo exige).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Browser, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const OUT = path.join(process.cwd(), "liquid-out");
const ENFORCE = process.env.LIQUID_AXE_ENFORCE === "1";

const ANCHOS = [
  { id: "1440", width: 1440, height: 900 },
  { id: "390", width: 390, height: 844 },
] as const;
const TEMAS = ["dark", "light"] as const;

type Pantalla = {
  id: string;
  /** Sin sesión (login). El resto usa la sesión del admin. */
  publica?: boolean;
  ruta: string | (() => string);
};

const PANTALLAS: Pantalla[] = [
  { id: "01-login", publica: true, ruta: "/login" },
  { id: "02-shell-navegacion", ruta: "/app" },
  { id: "03-kanban", ruta: () => `/app/pipelines/${datos().pipeline_id}` },
  { id: "04-bandeja", ruta: () => `/app/inbox?id=${datos().conversa_id}` },
  { id: "05-ficha-contacto", ruta: () => `/app/contacts/${datos().contato_id}` },
  { id: "06-agenda", ruta: "/app/agenda" },
  { id: "07-configuracion-marca", ruta: "/admin/marca" },
  { id: "08-onboarding", ruta: "/onboarding/welcome" },
];

type Violacion = {
  pantalla: string;
  ancho: string;
  tema: string;
  url: string;
  nodos: { objetivo: string; resumen: string }[];
};

let storageState: Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;
const violaciones: Violacion[] = [];
const incompletos: Record<string, number> = {};
const omitidas: string[] = [];
const urlsFinales: Record<string, string> = {};

/** Ids que deja scripts/seed-liquid-capturas.ts en .e2e-creds.json. */
function datos(): { pipeline_id: string; conversa_id: string; contato_id: string } {
  const c = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as {
    liquid?: { pipeline_id: string; conversa_id: string; contato_id: string };
  };
  if (!c.liquid) throw new Error("falta `liquid` en .e2e-creds.json: corré scripts/seed-liquid-capturas.ts");
  return c.liquid;
}

async function contexto(browser: Browser, ancho: (typeof ANCHOS)[number], tema: string, conSesion: boolean) {
  const ctx = await browser.newContext({
    viewport: { width: ancho.width, height: ancho.height },
    colorScheme: tema === "dark" ? "dark" : "light",
    reducedMotion: "reduce",
    baseURL: process.env.HUMO_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? "3001"}`,
    storageState: conSesion ? storageState : undefined,
  });
  await ctx.addInitScript((t) => {
    try {
      window.localStorage.setItem("deskcomm-theme", t);
    } catch {
      /* sin localStorage: el tema cae al default */
    }
  }, tema);
  return ctx;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(10 * 60_000);

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const creds = lerCreds();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginComoAdmin(page, creds);
  storageState = await ctx.storageState();
  await ctx.close();
});

for (const ancho of ANCHOS) {
  for (const tema of TEMAS) {
    test(`capturas ${ancho.id}px ${tema}`, async ({ browser }) => {
      const publico = await contexto(browser, ancho, tema, false);
      const privado = await contexto(browser, ancho, tema, true);
      try {
        for (const p of PANTALLAS) {
          const ctx = p.publica ? publico : privado;
          const page = await ctx.newPage();
          const clave = `${p.id}__${ancho.id}__${tema}`;
          try {
            const ruta = typeof p.ruta === "string" ? p.ruta : p.ruta();
            await page.goto(ruta, { waitUntil: "load" });
            await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
            await page.waitForTimeout(600);

            const tema_aplicado = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
            await page.screenshot({
              path: path.join(OUT, `${clave}.png`),
              fullPage: false,
              animations: "disabled",
            });

            // Axe solo a 1440: a 390 el árbol es el mismo y el ruido se duplica.
            if (ancho.id === "1440") {
              const r = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
              incompletos[clave] = r.incomplete.reduce((n, i) => n + i.nodes.length, 0);
              const nodos = r.violations.flatMap((v) =>
                v.nodes.map((n) => ({
                  objetivo: n.target.join(" "),
                  resumen: (n.any[0]?.message ?? n.failureSummary ?? "").slice(0, 220),
                })),
              );
              if (nodos.length > 0) {
                violaciones.push({ pantalla: p.id, ancho: ancho.id, tema, url: page.url(), nodos });
              }
            }
            urlsFinales[clave] = new URL(page.url()).pathname + new URL(page.url()).search;
            if (tema_aplicado !== tema) omitidas.push(`${clave}: data-theme=${tema_aplicado} (se pidió ${tema})`);
          } finally {
            await page.close();
          }
        }
      } finally {
        await publico.close();
        await privado.close();
      }
    });
  }
}

test("resumen y contraste", async () => {
  const total = violaciones.reduce((n, v) => n + v.nodos.length, 0);
  fs.writeFileSync(path.join(OUT, "axe.json"), JSON.stringify({ violaciones, incompletos }, null, 2));
  fs.writeFileSync(
    path.join(OUT, "resumen.json"),
    JSON.stringify(
      {
        acento: process.env.APP_ACCENT_HEX ?? null,
        violacionesDeContraste: total,
        pantallasConViolacion: violaciones.length,
        omitidas,
        urlsFinales,
      },
      null,
      2,
    ),
  );
  if (ENFORCE) expect(total, "violaciones de color-contrast (ver liquid-out/axe.json)").toBe(0);
});
