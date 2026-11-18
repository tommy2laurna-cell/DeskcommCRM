/**
 * JOURNEY — captar fuera de WhatsApp: formulario público → contacto con origen.
 *
 * Un manager arma un formulario en «Captar» (etapa y etiqueta de destino), abre
 * el link público como visitante anónimo, entra desde un QR con campaña
 * (`utm_*` en la dirección), lo completa y lo envía. Después, el manager ve:
 *  - el contacto, con origen «formulario», campaña y formulario en la ficha;
 *  - el lead en la etapa que eligió, con la etiqueta;
 *  - el contacto al filtrar por origen y por campaña;
 *  - el envío bloqueado sin consentimiento, y un bot (señuelo) sin efecto.
 *
 * Corre contra los contenedores del humo (`HUMO_BASE_URL`) y contra el dev
 * server local (`E2E_PORT`). Nombres con sufijo de tiempo: re-ejecutable.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const APP_URL = process.env.HUMO_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const ts = Date.now();
const NOMBRE_FORM = `E2E Captar ${ts}`;
const NOMBRE_PERSONA = `Ana Captar ${ts}`;
const ETIQUETA = `e2e-captar-${ts}`;
const CAMPANA = `e2e-verano-${ts}`;
// 8 dígitos al final del timestamp: teléfono AR de 10 dígitos único por corrida.
const TELEFONO = `011 15 ${String(ts).slice(-8, -4)}-${String(ts).slice(-4)}`;

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar|ingresar|iniciar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function leer<T>(req: APIRequestContext, ruta: string): Promise<T> {
  const res = await req.get(`${APP_URL}${ruta}`);
  expect(res.ok(), `${ruta} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

test.describe("captar: formulario público → contacto con origen", () => {
  test.setTimeout(180_000);
  test.use({ actionTimeout: 15_000 });

  test("el envío público crea el contacto en la etapa elegida, con origen, campaña y formulario", async ({
    page,
    browser,
  }) => {
    await login(page, creds.users.manager!.email);

    // ── 1. El manager arma el formulario en la pantalla Captar ──────────────
    await page.goto(`${APP_URL}/app/captar`);
    await page.getByTestId("captar-nuevo").click();
    await page.locator("#cap-nombre").fill(NOMBRE_FORM);
    await expect(page.locator("#cap-stage option").first()).toBeAttached({ timeout: 20_000 });
    const etapas = page.locator("#cap-stage option");
    const total = await etapas.count();
    const indice = total > 1 ? 1 : 0;
    const etapaId = (await etapas.nth(indice).getAttribute("value"))!;
    await page.locator("#cap-stage").selectOption(etapaId);
    await page.locator("#cap-tags").fill(ETIQUETA);
    await page.locator("#cap-gracias").fill("¡Listo, gracias!");
    await page.screenshot({ path: "test-results/captar-1-constructor.png" });
    await page.getByTestId("captar-guardar").click();
    await expect(page.getByTestId("captar-lista").getByText(NOMBRE_FORM)).toBeVisible();

    const lista = await leer<{ data: { id: string; slug: string; name: string; pipeline_id: string; stage_id: string }[] }>(
      page.request,
      "/api/v1/captar/formularios",
    );
    const form = lista.data.find((f) => f.name === NOMBRE_FORM)!;
    expect(form, "el formulario quedó guardado").toBeTruthy();
    expect(form.stage_id).toBe(etapaId);

    // ── 2. Publicar: link, snippet y QR visibles ────────────────────────────
    await page.getByTestId("captar-lista").getByRole("button", { name: /publicar/i }).first().click();
    await expect(page.getByTestId("captar-qr")).toBeVisible();
    await expect(page.getByText(`/f/${form.slug}`).first()).toBeVisible();
    await page.screenshot({ path: "test-results/captar-2-publicar-qr.png" });
    await page.keyboard.press("Escape");

    // ── 3. Un visitante anónimo, llegando desde un QR con campaña ───────────
    const visitante = await browser.newContext();
    const pub = await visitante.newPage();
    await pub.goto(`${APP_URL}/f/${form.slug}?utm_source=qr&utm_medium=qr&utm_campaign=${CAMPANA}`);
    await expect(pub.getByTestId("formulario-publico")).toBeVisible();

    // Sin consentimiento no hay envío.
    await pub.locator("#campo-nombre").fill(NOMBRE_PERSONA);
    await pub.locator("#campo-telefono").fill(TELEFONO);
    await pub.locator("button[type=submit]").click();
    await expect(pub.getByRole("alert").first()).toBeVisible();
    await expect(pub.getByTestId("formulario-gracias")).toHaveCount(0);

    // Un bot completa el señuelo: dice «listo» pero no deja nada.
    const bot = await visitante.request.post(`${APP_URL}/api/v1/captar/publico/${form.slug}`, {
      data: {
        respuestas: { nombre: `Bot ${ts}`, telefono: "011 15 0000-0000" },
        consentimiento: true,
        sitio_web: "http://spam.example",
      },
    });
    expect(bot.status()).toBe(200);

    // Con la casilla marcada, entra.
    await pub.locator("input[name=consentimiento]").check();
    await pub.locator("button[type=submit]").click();
    await expect(pub.getByTestId("formulario-gracias")).toContainText("Listo", { timeout: 20_000 });
    await pub.screenshot({ path: "test-results/captar-3-gracias.png" });
    await visitante.close();

    // ── 4. El contacto aparece, con su origen ───────────────────────────────
    type Contacto = { id: string; name: string; source: string; source_metadata: Record<string, string>; tags: string[] };
    let contacto: Contacto | undefined;
    await expect
      .poll(
        async () => {
          const r = await leer<{ data: Contacto[] }>(page.request, `/api/v1/contacts?search=${encodeURIComponent(NOMBRE_PERSONA)}`);
          contacto = r.data.find((c) => c.name === NOMBRE_PERSONA);
          return contacto?.source;
        },
        { timeout: 30_000 },
      )
      .toBe("formulario");
    expect(contacto!.source_metadata.utm_campaign).toBe(CAMPANA);
    expect(contacto!.source_metadata.utm_source).toBe("qr");
    expect(contacto!.source_metadata.formulario_nombre).toBe(NOMBRE_FORM);
    expect(contacto!.source_metadata.consentimiento_datos_en).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(contacto!.tags).toContain(ETIQUETA);

    // El bot no dejó nada.
    const bots = await leer<{ data: Contacto[] }>(page.request, `/api/v1/contacts?search=${encodeURIComponent(`Bot ${ts}`)}`);
    expect(bots.data).toHaveLength(0);

    // ── 5. El lead está en la etapa elegida, con la etiqueta ────────────────
    const tablero = await leer<{ data: { leads: { contact_id: string | null; stage_id: string; tags: string[] }[] } }>(
      page.request,
      `/api/v1/pipelines/${form.pipeline_id}/board`,
    );
    const lead = tablero.data.leads.find((l) => l.contact_id === contacto!.id);
    expect(lead, "el lead del formulario está en el tablero").toBeTruthy();
    expect(lead!.stage_id).toBe(etapaId);
    expect(lead!.tags).toContain(ETIQUETA);

    // ── 6. Se ve en la ficha y se filtra ────────────────────────────────────
    await page.goto(`${APP_URL}/app/contacts/${contacto!.id}`);
    await expect(page.getByText(CAMPANA)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(NOMBRE_FORM).first()).toBeVisible();
    await page.screenshot({ path: "test-results/captar-4-ficha-origen.png" });

    const porOrigen = await leer<{ data: Contacto[] }>(page.request, "/api/v1/contacts?source=formulario&limit=100");
    expect(porOrigen.data.some((c) => c.id === contacto!.id)).toBe(true);
    const porCampana = await leer<{ data: Contacto[] }>(page.request, `/api/v1/contacts?campaign=${encodeURIComponent(CAMPANA)}`);
    expect(porCampana.data.map((c) => c.id)).toEqual([contacto!.id]);
    const otraCampana = await leer<{ data: Contacto[] }>(page.request, "/api/v1/contacts?campaign=no-existe-esta-campana");
    expect(otraCampana.data).toHaveLength(0);

    // ── 7. Limpieza: apaga el formulario ────────────────────────────────────
    const borrado = await page.request.delete(`${APP_URL}/api/v1/captar/formularios/${form.id}`);
    expect(borrado.ok()).toBe(true);
    const cerrado = await page.request.post(`${APP_URL}/api/v1/captar/publico/${form.slug}`, {
      data: { respuestas: {}, consentimiento: true },
    });
    expect(cerrado.status()).toBe(404);
  });
});
