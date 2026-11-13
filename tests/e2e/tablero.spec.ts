/**
 * TABLERO DEL DUEÑO (GC5) — números verificados contra una consulta directa a la base.
 *
 * Se siembran leads con dueño, origen y fechas conocidas y se compara lo que
 * devuelve /api/v1/metrics/tablero (y lo que dibuja la pantalla) con lo que
 * calcula ACÁ, en TypeScript, leyendo crm_leads con el service role. Dos
 * implementaciones independientes de la misma definición: si la función SQL
 * se desvía, el test lo ve.
 *
 * Prueba:
 *  1. dueño (admin) ve todo; vendedor (agent) ve solo lo suyo;
 *  2. prospectos por origen, ventas y monto en ARS, alcance por etapa, 1ª respuesta;
 *  3. cada número abre la lista con el mismo filtro (misma cantidad);
 *  4. CSV con «;», BOM y sin inyección de fórmulas;
 *  5. el manifest lleva el nombre del cliente y los íconos 192/512.
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const cred = credenciaisSupabaseDeTeste();
const admin = createClient(cred.url, cred.serviceRole, { auth: { persistSession: false } });
const DIA = 86_400_000;
const creds = lerCreds();

type Lead = {
  id: string;
  source: string;
  status: string;
  owner_user_id: string | null;
  value_cents: number | null;
  currency: string | null;
  created_at: string;
  closed_at: string | null;
  stage_id: string;
  pipeline_id: string;
};

let ORG = "";
let AGENTE = "";
let GERENTE = "";
let TAG = "";
let PRIMERA = "";
let PIPELINE = "";

async function idDe(email: string): Promise<string> {
  for (let p = 1; p < 10; p++) {
    const { data } = await admin.auth.admin.listUsers({ page: p, perPage: 200 });
    const u = data.users.find((x) => x.email === email);
    if (u) return u.id;
    if (data.users.length < 200) break;
  }
  throw new Error(`usuario ${email} no existe`);
}

async function loginPlano(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar|ingresar/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
}

test.beforeAll(async () => {
  const { data: org } = await admin.from("organizations").select("id").eq("slug", "e2e-test-org").single();
  ORG = (org as { id: string }).id;
  AGENTE = await idDe(creds.users.agent!.email);
  GERENTE = await idDe(creds.users.manager!.email);

  const { data: etapas } = await admin
    .from("crm_stages")
    .select("id,pipeline_id,position")
    .eq("organization_id", ORG)
    .eq("is_archived", false)
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("position");
  const e = etapas as { id: string; pipeline_id: string; position: number }[];
  const pipeline = e[0]!.pipeline_id;
  const delFunil = e.filter((s) => s.pipeline_id === pipeline);
  const primera = delFunil[0]!.id;
  const ultima = delFunil[delFunil.length - 1]!.id;
  const tag = randomUUID().slice(0, 6);
  TAG = tag;
  PRIMERA = primera;
  PIPELINE = pipeline;
  const ahora = Date.now();

  const lead = (o: Partial<Lead> & { source: string; owner_user_id: string; created: number }) => ({
    organization_id: ORG,
    pipeline_id: pipeline,
    stage_id: o.stage_id ?? primera,
    title: `e2e-tablero ${tag} ${o.source}`,
    source: o.source,
    owner_user_id: o.owner_user_id,
    status: o.status ?? "open",
    value_cents: o.value_cents ?? null,
    currency: o.currency ?? "ARS",
    lost_reason: o.status === "lost" ? "price" : null,
    created_at: new Date(ahora - o.created).toISOString(),
    closed_at: o.closed_at ?? null,
  });
  const cerrado = new Date(ahora - 1 * DIA).toISOString();
  const filas = [
    lead({ source: "e2e-whatsapp", owner_user_id: AGENTE, created: 2 * DIA }),
    lead({ source: "e2e-whatsapp", owner_user_id: AGENTE, created: 2 * DIA, stage_id: ultima }),
    lead({ source: "e2e-whatsapp", owner_user_id: AGENTE, created: 2 * DIA, status: "won", value_cents: 250_000, closed_at: cerrado }),
    lead({ source: "e2e-web", owner_user_id: GERENTE, created: 3 * DIA }),
    lead({ source: "e2e-web", owner_user_id: GERENTE, created: 3 * DIA, status: "won", value_cents: 100_000, closed_at: cerrado }),
    lead({ source: "e2e-web", owner_user_id: GERENTE, created: 3 * DIA, status: "won", value_cents: 5_000, currency: "USD", closed_at: cerrado }),
    lead({ source: "e2e-antiguo", owner_user_id: GERENTE, created: 60 * DIA }),
  ];
  const { error } = await admin.from("crm_leads").insert(filas as never);
  if (error) throw new Error(`seed leads: ${error.message}`);

  // Una conversación del vendedor: entra a las T, respuesta humana 120 s después.
  const canal = await admin
    .from("channel_sessions")
    .insert({
      organization_id: ORG,
      waha_session_name: `tablero-${randomUUID()}`,
      display_name: "WhatsApp tablero",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    } as never)
    .select("id")
    .single();
  const contacto = await admin
    .from("contacts")
    .insert({ organization_id: ORG, name: `Tablero ${tag}`, phone_number: `+549110${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}` } as never)
    .select("id")
    .single();
  const t0 = ahora - 1 * 3_600_000;
  const conv = await admin
    .from("conversations")
    .insert({
      organization_id: ORG,
      contact_id: (contacto.data as { id: string }).id,
      channel_session_id: (canal.data as { id: string }).id,
      status: "open",
      assigned_to_user_id: AGENTE,
      assigned_at: new Date(t0).toISOString(),
    } as never)
    .select("id")
    .single();
  const base = {
    organization_id: ORG,
    contact_id: (contacto.data as { id: string }).id,
    conversation_id: (conv.data as { id: string }).id,
    channel_session_id: (canal.data as { id: string }).id,
    type: "text",
  };
  const m = await admin.from("messages").insert([
    { ...base, direction: "inbound", status: "received", sent_via: "external_device", body: "hola", sent_at: new Date(t0).toISOString() },
    { ...base, direction: "outbound", status: "sent", sent_via: "crm", sent_by_user_id: AGENTE, body: "hola!", sent_at: new Date(t0 + 120_000).toISOString() },
  ] as never);
  if (m.error) throw new Error(`seed mensajes: ${m.error.message}`);
});

/** La definición de 0290 escrita de nuevo, a mano, sobre filas leídas directo. */
async function esperado(from: string, to: string, owner: string | null) {
  const { data: ls } = await admin.from("crm_leads").select("*").eq("organization_id", ORG);
  const { data: ss } = await admin.from("crm_stages").select("id,pipeline_id,position,is_archived").eq("organization_id", ORG);
  const leads = (ls as Lead[]).filter((l) => !owner || l.owner_user_id === owner);
  const stages = ss as { id: string; pipeline_id: string; position: number; is_archived: boolean }[];
  const pos = new Map(stages.map((s) => [s.id, s.position]));
  const enVentana = (iso: string | null) => !!iso && iso >= from && iso < to;
  const nuevos = leads.filter((l) => enVentana(new Date(l.created_at).toISOString()));
  const ganados = leads.filter((l) => l.status === "won" && enVentana(l.closed_at && new Date(l.closed_at).toISOString()));
  const porOrigen: Record<string, number> = {};
  for (const l of nuevos) porOrigen[l.source] = (porOrigen[l.source] ?? 0) + 1;
  const alcanzaron = (s: { id: string; pipeline_id: string; position: number }) =>
    nuevos.filter((l) => l.pipeline_id === s.pipeline_id && (l.status === "won" || pos.get(l.stage_id)! >= s.position)).length;
  return {
    nuevos: nuevos.length,
    porOrigen,
    ganados: ganados.length,
    monto: ganados.filter((l) => l.currency === "ARS").reduce((a, l) => a + (l.value_cents ?? 0), 0),
    otraMoneda: ganados.filter((l) => l.currency !== "ARS").length,
    etapas: stages.filter((s) => !s.is_archived).map((s) => ({ id: s.id, n: alcanzaron(s) })),
  };
}

type Api = {
  window: { from: string; to: string };
  por_origen: { source: string; count: number }[];
  etapas: { stage_id: string; alcanzaron: number }[];
  ventas: { ganados: number; monto_ars_cents: number; ganados_otra_moneda: number };
  primera_respuesta_segundos: number | null;
  por_usuario: { user_id: string; nuevos: number; ganados: number; monto_ars_cents: number }[];
};

async function comparar(page: Page, owner: string | null) {
  const r = await page.request.get("/api/v1/metrics/tablero?periodo=30");
  expect(r.status()).toBe(200);
  const api = (await r.json()).data as Api;
  const ex = await esperado(api.window.from, api.window.to, owner);
  const origen = Object.fromEntries(api.por_origen.map((o) => [o.source, o.count]));
  expect(origen).toEqual(ex.porOrigen);
  expect(api.por_origen.reduce((a, o) => a + o.count, 0)).toBe(ex.nuevos);
  expect(api.ventas.ganados).toBe(ex.ganados);
  expect(api.ventas.monto_ars_cents).toBe(ex.monto);
  expect(api.ventas.ganados_otra_moneda).toBe(ex.otraMoneda);
  for (const e of ex.etapas) {
    expect(api.etapas.find((x) => x.stage_id === e.id)?.alcanzaron, `etapa ${e.id}`).toBe(e.n);
  }
  return { api, ex };
}

test.describe("tablero", () => {
  test("dueño: ve todo y los números coinciden con la base", async ({ page }) => {
    await loginComoAdmin(page, creds);
    const { api, ex } = await comparar(page, null);
    expect(api.primera_respuesta_segundos).toBeCloseTo(120, 0);
    expect(new Set(api.por_usuario.map((u) => u.user_id))).toContain(AGENTE);
    expect(new Set(api.por_usuario.map((u) => u.user_id))).toContain(GERENTE);
    expect(ex.monto).toBeGreaterThanOrEqual(350_000);

    await page.goto("/app/metrics");
    await expect(page.getByTestId("tablero-nuevos")).toHaveText(String(ex.nuevos));
    await expect(page.getByTestId("tablero-ganados")).toHaveText(String(ex.ganados));

    // Al tocar el número se abre la lista con el mismo filtro y la misma cantidad.
    await page.getByTestId("tablero-ganados").getByRole("link").click();
    await expect(page.getByTestId("lista-total")).toHaveText(String(ex.ganados));
    await page.goBack();
    await page.getByRole("link", { name: /e2e-whatsapp/ }).first().click();
    await expect(page.getByTestId("lista-total")).toHaveText(String(ex.porOrigen["e2e-whatsapp"]));
  });

  test("dueño: CSV con «;», BOM y celdas seguras", async ({ page }) => {
    await loginComoAdmin(page, creds);
    const r = await page.request.get("/api/v1/metrics/tablero/export?periodo=30");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("text/csv");
    const txt = await r.text();
    expect(txt.charCodeAt(0)).toBe(0xfeff);
    const lineas = txt.slice(1).trim().split("\r\n");
    expect(lineas[0]).toBe("Período (30 días);Dato;Valor");
    expect(lineas.some((l) => l.startsWith("Prospectos por origen;e2e-whatsapp;"))).toBe(true);
    // El monto sale con coma decimal, listo para Excel argentino.
    expect(lineas.find((l) => l.startsWith("Resumen;Ventas en ARS;"))).toMatch(/;\d+(,\d+)?$/);
  });

  test("vendedor: ve solo lo suyo", async ({ page }) => {
    await loginPlano(page, creds.users.agent!.email);
    const { api, ex } = await comparar(page, AGENTE);
    expect(ex.nuevos).toBeGreaterThanOrEqual(3);
    expect(api.por_usuario.map((u) => u.user_id)).toEqual([AGENTE]);

    // Aunque pida el filtro del gerente, el servidor lo fuerza a su propio id.
    const forzado = await page.request.get(`/api/v1/metrics/tablero?periodo=30&owner_user_id=${GERENTE}`);
    const f = (await forzado.json()).data as Api;
    expect(f.por_usuario.every((u) => u.user_id === AGENTE)).toBe(true);

    // Y la lista del gerente, abierta a mano, no le muestra nada ajeno.
    await page.goto(`/app/metrics/lista?tipo=nuevos&from=${encodeURIComponent(api.window.from)}&to=${encodeURIComponent(api.window.to)}&owner=${GERENTE}`);
    await expect(page.getByTestId("lista-total")).toHaveText("0");
  });

  test("manifest: nombre del cliente e íconos 192 y 512", async ({ request }) => {
    const r = await request.get("/manifest.webmanifest");
    expect(r.status()).toBe(200);
    const man = await r.json();
    expect(man.display).toBe("standalone");
    expect(man.name).toBe(process.env.APP_NAME ?? man.name);
    expect(man.name).not.toMatch(/deskcomm/i);
    const tamanos = (man.icons as { sizes: string }[]).map((i) => i.sizes);
    expect(tamanos).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const lado of [192, 512]) {
      const ic = await request.get(`/icone/${lado}`);
      expect(ic.status()).toBe(200);
      expect(ic.headers()["content-type"]).toContain("image/png");
    }
  });
});

// ── Journey en el celular (390 px): bandeja → responder → mover un lead ─────────────
test.describe("celular 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("bandeja, respuesta, lead y tablero se usan sin scroll horizontal", async ({ page }, info) => {
    const foto = async (n: string) =>
      page.screenshot({ path: `movil-out/${n}.png`, fullPage: false });
    const sinScrollLateral = async () => {
      const ancho = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      expect(ancho.s, "scroll horizontal").toBeLessThanOrEqual(ancho.c + 1);
    };

    await loginPlano(page, creds.users.agent!.email);

    // 1. Bandeja: la lista ocupa toda la pantalla.
    await page.goto("/app/inbox");
    const item = page.getByText(`Tablero`).first();
    await expect(item).toBeVisible({ timeout: 30_000 });
    await sinScrollLateral();
    await foto("1-bandeja");

    // 2. Abrir la conversación y responder.
    await item.click();
    const caja = page.getByPlaceholder(/Escriba|Escribí|Escreva/i).first();
    await expect(caja).toBeVisible({ timeout: 15_000 });
    const texto = `respuesta movil ${Date.now()}`;
    await caja.fill(texto);
    await caja.press("Enter");
    await expect(page.getByText(texto).first()).toBeVisible({ timeout: 15_000 });
    await sinScrollLateral();
    await foto("2-respuesta");

    // 3. Mover un lead: se marca la tarjeta y se elige la etapa en el menú (sin arrastrar).
    const enPrimera = async () =>
      (await admin.from("crm_leads").select("id", { count: "exact", head: true })
        .eq("organization_id", ORG).eq("owner_user_id", AGENTE).eq("status", "open")
        .eq("source", "e2e-whatsapp").eq("stage_id", PRIMERA)).count ?? 0;
    const antes = await enPrimera();
    expect(antes).toBeGreaterThan(0);

    await page.goto(`/app/pipelines/${PIPELINE}`);
    const tarjeta = page.getByRole("checkbox", { name: new RegExp(`e2e-tablero ${TAG} e2e-whatsapp`) }).first();
    await expect(tarjeta).toBeAttached({ timeout: 30_000 });
    await tarjeta.check({ force: true });
    await foto("3-lead-seleccionado");
    await page.getByRole("button", { name: /Mover (para|a)/i }).click();
    const destino = (await admin.from("crm_stages").select("name").eq("pipeline_id", PIPELINE).eq("is_archived", false).eq("is_won", false).eq("is_lost", false).order("position").limit(2)).data as { name: string }[];
    await page.getByRole("menuitem", { name: destino[1]!.name }).click();
    await expect.poll(enPrimera, { timeout: 15_000 }).toBe(antes - 1);
    await sinScrollLateral();
    await foto("3-lead-movido");
  });

  test("tablero a 390 px", async ({ page }) => {
    await loginPlano(page, creds.users.agent!.email);
    await page.goto("/app/metrics");
    await expect(page.getByTestId("tablero")).toBeVisible({ timeout: 30_000 });
    const ancho = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    expect(ancho.s).toBeLessThanOrEqual(ancho.c + 1);
    await page.screenshot({ path: "movil-out/4-tablero.png", fullPage: true });
  });
});
