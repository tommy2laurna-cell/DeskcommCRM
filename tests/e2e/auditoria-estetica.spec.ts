/**
 * Auditoría estética del Conectado (LIQUID-UI.md): capturas, checklist medido en el
 * navegador, contraste (axe), modos reducidos y rendimiento del kanban con 300 tarjetas.
 *
 * Solo lectura sobre el producto: no cambia código de la app. Se corre una vez por marca
 * (`APP_ACCENT_HEX`) desde `.github/workflows/auditoria-estetica.yml`.
 * Salida en `auditoria-out/`: PNG por pantalla/tema/modo, `checklist.json`, `axe.json`,
 * `modos.json`, `rendimiento.json`, `resumen.json` y `trace-*.json` (traza de Chrome).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const OUT = path.join(process.cwd(), "auditoria-out");
const MARCA = process.env.APP_ACCENT_HEX ?? "sin-marca";
const TEMAS = ["dark", "light"] as const;
type Tema = (typeof TEMAS)[number];

type Pantalla = { id: string; publica?: boolean; ruta: string | (() => string) };

function datos(): { pipeline_id: string; conversa_id: string; contato_id: string } {
  const c = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as {
    liquid?: { pipeline_id: string; conversa_id: string; contato_id: string };
  };
  if (!c.liquid) throw new Error("falta `liquid` en .e2e-creds.json: corré scripts/seed-liquid-capturas.ts");
  return c.liquid;
}

const PANTALLAS: Pantalla[] = [
  { id: "01-login", publica: true, ruta: "/login" },
  { id: "02-shell-navegacion", ruta: "/app" },
  { id: "03-kanban", ruta: () => `/app/pipelines/${datos().pipeline_id}` },
  { id: "04-bandeja", ruta: () => `/app/inbox?id=${datos().conversa_id}` },
  { id: "05-ficha-contacto", ruta: () => `/app/contacts/${datos().contato_id}` },
  { id: "06-agenda", ruta: "/app/agenda" },
  { id: "07-configuracion-marca", ruta: "/app/settings/marca" },
  { id: "08-onboarding", ruta: "/onboarding/welcome" },
  { id: "09-contactos", ruta: "/app/contacts" },
  { id: "10-tareas", ruta: "/app/tasks" },
  { id: "11-configuracion", ruta: "/app/settings" },
  { id: "12-radar", ruta: "/app/radar" },
];

let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

async function contexto(
  browser: Browser,
  o: { ancho: number; alto: number; tema: Tema; sesion: boolean; movimientoReducido: boolean },
) {
  const ctx = await browser.newContext({
    viewport: { width: o.ancho, height: o.alto },
    colorScheme: o.tema,
    reducedMotion: o.movimientoReducido ? "reduce" : "no-preference",
    baseURL: process.env.HUMO_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? "3001"}`,
    storageState: o.sesion ? storageState : undefined,
  });
  await ctx.addInitScript((t) => {
    try {
      window.localStorage.setItem("deskcomm-theme", t);
    } catch {
      /* sin localStorage: el tema cae al default */
    }
  }, o.tema);
  return ctx;
}

async function irA(page: Page, p: Pantalla): Promise<{ estado: number | null; final: string }> {
  const ruta = typeof p.ruta === "string" ? p.ruta : p.ruta();
  const r = await page.goto(ruta, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(700);
  const u = new URL(page.url());
  return { estado: r?.status() ?? null, final: u.pathname + u.search };
}

/** Mide en el navegador: tokens, radios, fuentes, dónde hay vidrio y animaciones activas. */
function medirChecklist() {
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const hist = (els: Element[], prop: "borderRadius") => {
    const h: Record<string, number> = {};
    for (const e of els) {
      if (!visible(e)) continue;
      const v = getComputedStyle(e)[prop];
      h[v] = (h[v] ?? 0) + 1;
    }
    return h;
  };
  const q = (s: string) => [...document.querySelectorAll(s)];
  const root = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const t of [
    "--color-bg", "--color-surface", "--color-text", "--color-text-muted", "--color-border",
    "--color-accent", "--radius-md", "--radius-lg", "--radius-xl", "--density-row", "--lq-font-sans", "--lq-font-mono",
  ]) tokens[t] = root.getPropertyValue(t).trim();

  const radios = {
    botones: hist(q("button"), "borderRadius"),
    campos: hist(q("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea"), "borderRadius"),
    vidrio1: hist(q(".lq-v1"), "borderRadius"),
    vidrio2: hist(q(".lq-v2"), "borderRadius"),
    vidrio3: hist(q(".lq-v3"), "borderRadius"),
    tarjetasKanban: hist(q("[data-rfd-draggable-id]"), "borderRadius"),
  };

  // Vidrio: todo elemento visible con backdrop-filter.
  const REPETIDO = "[data-rfd-draggable-id], tbody tr, [role=row], li, td";
  const vidrio: Element[] = [];
  for (const e of document.querySelectorAll("*")) {
    const s = getComputedStyle(e);
    const f = s.backdropFilter || (s as unknown as Record<string, string>)["-webkit-backdrop-filter"] || "none";
    if (f && f !== "none" && visible(e)) vidrio.push(e);
  }
  const firma = (e: Element) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).slice(0, 70)}`;
  const grupos: Record<string, number> = {};
  for (const e of vidrio) grupos[firma(e)] = (grupos[firma(e)] ?? 0) + 1;
  const enRepetidos = vidrio.filter((e) => e.closest(REPETIDO)).map(firma).slice(0, 10);
  const repetidosMas10 = Object.entries(grupos).filter(([, n]) => n > 10);

  const fuentes: Record<string, number> = {};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let nodo: Node | null;
  while ((nodo = walker.nextNode())) {
    const el = nodo.parentElement;
    if (!el || !(nodo.textContent ?? "").trim() || !visible(el)) continue;
    const fam = getComputedStyle(el).fontFamily.split(",")[0]!.trim().replace(/"/g, "");
    fuentes[fam] = (fuentes[fam] ?? 0) + 1;
  }
  const animando = document
    .getAnimations()
    .filter((a) => a.playState === "running")
    .map((a) => (a as CSSAnimation).animationName ?? a.constructor.name)
    .slice(0, 10);

  return {
    tema: document.documentElement.getAttribute("data-theme"),
    clasesHtml: document.documentElement.className,
    tokens,
    radios,
    vidrio: { total: vidrio.length, enFilasOTarjetas: enRepetidos, gruposConMasDe10: repetidosMas10 },
    fuentes,
    fuentesCargadas: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
    animacionesActivas: animando.length,
    nombresAnimacion: animando,
    mediaReducida: {
      movimiento: matchMedia("(prefers-reduced-motion: reduce)").matches,
      transparencia: matchMedia("(prefers-reduced-transparency: reduce)").matches,
    },
    cuentaVidrioNiveles: { v1: q(".lq-v1").length, v2: q(".lq-v2").length, v3: q(".lq-v3").length },
  };
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  const nodos = r.violations.flatMap((v) =>
    v.nodes.map((n) => {
      const d = (n.any[0]?.data ?? {}) as { contrastRatio?: number; expectedContrastRatio?: string; fgColor?: string; bgColor?: string };
      return {
        objetivo: n.target.join(" ").slice(0, 160),
        ratio: d.contrastRatio ?? null,
        pide: d.expectedContrastRatio ?? null,
        fg: d.fgColor ?? null,
        bg: d.bgColor ?? null,
      };
    }),
  );
  return { violaciones: nodos, incompletos: r.incomplete.reduce((n, i) => n + i.nodes.length, 0) };
}

test.describe.configure({ mode: "serial" });
test.setTimeout(15 * 60_000);

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginComoAdmin(page, lerCreds());
  storageState = await ctx.storageState();
  await ctx.close();
});

const checklist: Record<string, unknown> = {};
const axeTodo: Record<string, unknown> = {};
const finales: Record<string, unknown> = {};

// 1 + 2 + 4 — capturas (1440 y 390), checklist y axe, oscuro y claro.
for (const tema of TEMAS) {
  test(`pantallas ${tema}`, async ({ browser }) => {
    for (const ancho of [{ id: "1440", w: 1440, h: 900 }, { id: "390", w: 390, h: 844 }]) {
      const pub = await contexto(browser, { ancho: ancho.w, alto: ancho.h, tema, sesion: false, movimientoReducido: true });
      const priv = await contexto(browser, { ancho: ancho.w, alto: ancho.h, tema, sesion: true, movimientoReducido: true });
      try {
        for (const p of PANTALLAS) {
          const page = await (p.publica ? pub : priv).newPage();
          const clave = `${p.id}__${ancho.id}__${tema}`;
          try {
            const dest = await irA(page, p);
            finales[clave] = dest;
            await page.screenshot({ path: path.join(OUT, `${clave}.png`), animations: "disabled" });
            if (ancho.id === "1440") {
              checklist[clave] = await page.evaluate(medirChecklist);
              axeTodo[clave] = await axe(page);
            }
          } catch (e) {
            finales[clave] = { error: String(e).slice(0, 300) };
          } finally {
            await page.close();
          }
        }
      } finally {
        await pub.close();
        await priv.close();
      }
    }
  });
}

// 5 — modos reducidos: movimiento, transparencia (emulada por CDP) y `.efectos-reducidos`.
const modos: Record<string, unknown> = {};
for (const tema of TEMAS) {
  test(`modos reducidos ${tema}`, async ({ browser }) => {
    const ctx = await contexto(browser, { ancho: 1440, alto: 900, tema, sesion: true, movimientoReducido: false });
    const seleccion = PANTALLAS.filter((p) => ["03-kanban", "04-bandeja", "07-configuracion-marca", "09-contactos"].includes(p.id));
    try {
      for (const modo of ["movimiento", "transparencia", "efectos-reducidos"] as const) {
        for (const p of seleccion) {
          const page = await ctx.newPage();
          const clave = `${p.id}__${modo}__${tema}`;
          try {
            const cdp = await ctx.newCDPSession(page);
            if (modo === "movimiento") {
              await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
            } else if (modo === "transparencia") {
              await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
            }
            await irA(page, p);
            if (modo === "efectos-reducidos") {
              await page.evaluate(() => document.documentElement.classList.add("efectos-reducidos"));
              await page.waitForTimeout(400);
            }
            const m = await page.evaluate(medirChecklist);
            await page.screenshot({ path: path.join(OUT, `modo-${clave}.png`), animations: "disabled" });
            modos[clave] = { vidrio: m.vidrio.total, animacionesActivas: m.animacionesActivas, nombresAnimacion: m.nombresAnimacion, mediaReducida: m.mediaReducida, clasesHtml: m.clasesHtml, axe: await axe(page) };
          } catch (e) {
            modos[clave] = { error: String(e).slice(0, 300) };
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await ctx.close();
    }
  });
}

// 6 — rendimiento del kanban con 300 tarjetas: cuadros por segundo al hacer scroll y al arrastrar.
const rendimiento: Record<string, unknown> = {};

const CONTADOR = `(() => {
  window.__f = { t: [], on: true };
  const f = (ts) => { if (!window.__f.on) return; window.__f.t.push(ts); requestAnimationFrame(f); };
  requestAnimationFrame(f);
})()`;

async function resumirCuadros(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __f: { t: number[]; on: boolean } };
    w.__f.on = false;
    const t = w.__f.t;
    const d: number[] = [];
    for (let i = 1; i < t.length; i++) d.push(t[i]! - t[i - 1]!);
    const ord = [...d].sort((a, b) => a - b);
    const seg = t.length > 1 ? (t[t.length - 1]! - t[0]!) / 1000 : 0;
    const p = (q: number) => (ord.length ? +ord[Math.min(ord.length - 1, Math.floor(q * ord.length))]!.toFixed(1) : null);
    return {
      cuadros: t.length,
      segundos: +seg.toFixed(2),
      fps: seg ? +((t.length - 1) / seg).toFixed(1) : null,
      cuadroMedianaMs: p(0.5),
      cuadroP95Ms: p(0.95),
      cuadroMaxMs: ord.length ? +ord[ord.length - 1]!.toFixed(1) : null,
      cuadrosLentosMas50ms: d.filter((x) => x > 50).length,
    };
  });
}

for (const efectos of ["plenos", "reducidos"] as const) {
  test(`rendimiento kanban 300 tarjetas (${efectos})`, async ({ browser }) => {
    const ctx = await contexto(browser, { ancho: 1440, alto: 900, tema: "dark", sesion: true, movimientoReducido: false });
    const page = await ctx.newPage();
    const r: Record<string, unknown> = {};
    try {
      // Multiplica a 300 las tarjetas de la respuesta del tablero (el servidor falla con 300 reales: URI too long).
      await page.route("**/api/v1/pipelines/*/board", async (route) => {
        const resp = await route.fetch();
        const json = (await resp.json()) as { data?: { leads: Record<string, unknown>[] }; leads?: Record<string, unknown>[] };
        const cuerpo = json.data ?? (json as { leads: Record<string, unknown>[] });
        const base = cuerpo.leads ?? [];
        const sal: Record<string, unknown>[] = [];
        for (let i = 0; sal.length < 300 && base.length; i++) {
          const l = base[i % base.length]!;
          sal.push(i < base.length ? l : { ...l, id: `${String(l.id)}-x${i}` });
        }
        cuerpo.leads = sal;
        await route.fulfill({ response: resp, json });
      });
      await page.goto(`/app/pipelines/${datos().pipeline_id}`, { waitUntil: "load" });
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await page.waitForSelector("[data-rfd-draggable-id]", { timeout: 60_000 });
      if (efectos === "reducidos") await page.evaluate(() => document.documentElement.classList.add("efectos-reducidos"));
      await page.waitForTimeout(1500);
      r.tarjetasEnDom = await page.locator("[data-rfd-draggable-id]").count();
      r.vidrioEnPantalla = (await page.evaluate(medirChecklist)).vidrio.total;

      // Scroll: rueda sobre la primera columna en pasos, ~4 s.
      const col = page.locator("[data-rfd-droppable-id]").first();
      const caja = await col.boundingBox();
      if (!caja) throw new Error("sin caja de columna");
      const hayTraza = efectos === "plenos";
      if (hayTraza) await browser.startTracing(page, { path: path.join(OUT, `trace-kanban-${MARCA.replace("#", "")}.json`), screenshots: false });
      await page.evaluate(CONTADOR);
      await page.mouse.move(caja.x + caja.width / 2, caja.y + 200);
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, 250);
        await page.waitForTimeout(40);
      }
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, -250);
        await page.waitForTimeout(40);
      }
      r.scroll = await resumirCuadros(page);

      // Arrastre: toma una tarjeta visible, la lleva a la columna de la derecha en 90 pasos y cancela con Esc.
      await page.evaluate(CONTADOR);
      const tarjeta = page.locator("[data-rfd-draggable-id]").first();
      const tb = await tarjeta.boundingBox();
      const cols = await page.locator("[data-rfd-droppable-id]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
      if (tb && cols.length > 1) {
        await page.mouse.move(tb.x + tb.width / 2, tb.y + 20);
        await page.mouse.down();
        await page.mouse.move(tb.x + tb.width / 2 + 12, tb.y + 30, { steps: 4 });
        const destinoX = Math.max(...cols.slice(0, 2)) + 120;
        await page.mouse.move(destinoX, tb.y + 80, { steps: 90 });
        await page.mouse.move(destinoX - 40, tb.y + 140, { steps: 40 });
        await page.keyboard.press("Escape");
        await page.mouse.up();
      } else {
        r.arrastreOmitido = "sin tarjeta o sin segunda columna";
      }
      r.arrastre = await resumirCuadros(page);
      if (hayTraza) await browser.stopTracing();
    } catch (e) {
      r.error = String(e).slice(0, 400);
      if (efectos === "plenos") await browser.stopTracing().catch(() => {});
    } finally {
      rendimiento[efectos] = r;
      await page.close();
      await ctx.close();
    }
  });
}

test("resumen", async () => {
  fs.writeFileSync(path.join(OUT, "checklist.json"), JSON.stringify(checklist, null, 2));
  fs.writeFileSync(path.join(OUT, "axe.json"), JSON.stringify(axeTodo, null, 2));
  fs.writeFileSync(path.join(OUT, "modos.json"), JSON.stringify(modos, null, 2));
  fs.writeFileSync(path.join(OUT, "rendimiento.json"), JSON.stringify(rendimiento, null, 2));
  const total = Object.values(axeTodo).reduce<number>((n, v) => n + (v as { violaciones: unknown[] }).violaciones.length, 0);
  fs.writeFileSync(
    path.join(OUT, "resumen.json"),
    JSON.stringify({ marca: MARCA, violacionesContraste: total, pantallas: finales }, null, 2),
  );
});
