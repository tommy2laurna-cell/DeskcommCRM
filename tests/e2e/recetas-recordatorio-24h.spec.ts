/**
 * Journey de las recetas: prender «Recordatorio de turno, 24 h antes» desde la
 * pantalla, crear un turno, avanzar el reloj (`cron/recetas?ahora=`) y ver el
 * envío simulado (sin WhatsApp real: el mensaje queda registrado en la conversa).
 */
import { randomInt, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { carregarEnvLocal, credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const password = `Local-${randomUUID()}!`;
const H = 3_600_000;

async function insert(table: string, value: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}

function secreto(): string {
  const s = carregarEnvLocal().INTERNAL_SECRET?.trim();
  if (!s) throw new Error("INTERNAL_SECRET no encontrado en el ambiente de prueba");
  return s;
}

async function login(page: Page, email: string) {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.describe("recetas: recordatorio de turno 24 h", () => {
  test.setTimeout(180_000);

  test("prender, crear un turno, avanzar el reloj y ver el envío", async ({ page, request }) => {
    const email = `recetas-${randomUUID()}@invariant.test`;
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error;
    const user = data.user.id;
    const org = await insert("organizations", {
      slug: `recetas-${randomUUID()}`,
      display_name: "Recetas e2e",
      legal_name: "Recetas e2e",
      onboarded_at: new Date().toISOString(),
    });
    await insert("user_organizations", {
      organization_id: org,
      user_id: user,
      role: "admin",
      accepted_at: new Date().toISOString(),
    });
    const sesion = await insert("channel_sessions", {
      organization_id: org,
      waha_session_name: randomUUID(),
      display_name: "Canal recetas",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    // La ventana horaria del número abierta todo el día: la prueba no depende de la hora del runner.
    const knobs = await db.from("channel_knobs").insert({
      organization_id: org,
      channel_session_id: sesion,
      window_start_hour: 0,
      window_end_hour: 24,
      allow_sunday: true,
      timezone: "America/Argentina/Buenos_Aires",
    });
    if (knobs.error) throw knobs.error;
    const tipo = await insert("calendar_event_types", {
      organization_id: org,
      name: "Consulta",
      slug: "consulta-recetas",
      duration_minutes: 30,
      minimum_notice_minutes: 60,
      booking_window_days: 60,
      is_active: true,
      default_owner_user_id: user,
    });
    const nombre = `Ana Receta ${randomInt(1000, 9999)}`;
    const contacto = await insert("contacts", {
      organization_id: org,
      name: nombre,
      display_name: nombre,
      phone_number: `+54911${randomInt(10000000, 99999999)}`,
    });
    await insert("conversations", {
      organization_id: org,
      contact_id: contacto,
      channel_session_id: sesion,
      status: "open",
      assigned_to_user_id: user,
    });

    // 1) Prender la receta desde la pantalla.
    await login(page, email);
    await page.goto(`${APP_URL}/app/recetas`);
    await expect(page.getByTestId("recetas-lista")).toBeVisible();
    const [put] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/v1/recetas/recordatorio_24h") && r.request().method() === "PUT"),
      page.getByTestId("receta-switch-recordatorio_24h").click(),
    ]);
    expect(put.ok()).toBeTruthy();
    const { data: regla } = await db
      .from("automation_rules")
      .select("id, is_active, trigger_event")
      .eq("organization_id", org)
      .eq("recipe_key", "recordatorio_24h")
      .single();
    expect(regla).toMatchObject({ is_active: true, trigger_event: "appointment.reminder" });

    // 2) Un turno confirmado dentro de 25 h, sacado hace 2 días.
    const comienzo = new Date(Date.now() + 25 * H);
    const turno = await insert("calendar_appointments", {
      organization_id: org,
      contact_id: contacto,
      event_type_id: tipo,
      owner_user_id: user,
      title: "Consulta",
      status: "confirmed",
      starts_at: comienzo.toISOString(),
      ends_at: new Date(comienzo.getTime() + 30 * 60_000).toISOString(),
      created_at: new Date(Date.now() - 48 * H).toISOString(),
    });

    const cron = (path: string) =>
      request.post(`${APP_URL}${path}`, { headers: { Authorization: `Bearer ${secreto()}` }, timeout: 60_000 });

    // 3) Ahora mismo faltan 25 h: todavía no corresponde avisar.
    const antes = await (await cron("/api/v1/cron/recetas")).json();
    expect(antes.data.emitidos["appointment.reminder"] ?? 0).toBe(0);

    // 4) Avanzar el reloj 2 h: faltan 23 h, entra el aviso de 24 h. Dos veces: una sola emisión.
    const ahora = new Date(Date.now() + 2 * H).toISOString();
    const r1 = await (await cron(`/api/v1/cron/recetas?ahora=${encodeURIComponent(ahora)}`)).json();
    expect(r1.data.emitidos["appointment.reminder"]).toBe(1);
    const r2 = await (await cron(`/api/v1/cron/recetas?ahora=${encodeURIComponent(ahora)}`)).json();
    expect(r2.data.emitidos["appointment.reminder"] ?? 0).toBe(0);

    // 5) Drenar los eventos: el motor corre la regla y sale el mensaje.
    for (let i = 0; i < 4; i++) {
      const r = await cron("/api/v1/cron/event-log-drain");
      expect(r.ok()).toBeTruthy();
      await page.waitForTimeout(700);
    }

    await expect
      .poll(
        async () => {
          const { data: msgs } = await db
            .from("messages")
            .select("body, direction")
            .eq("organization_id", org)
            .eq("contact_id", contacto)
            .eq("direction", "outbound");
          return msgs?.some((m) => (m.body ?? "").includes(nombre) && /turno/i.test(m.body ?? "")) ?? false;
        },
        { timeout: 30_000, message: "el recordatorio simulado no apareció en la conversa" },
      )
      .toBe(true);

    const { data: corridas } = await db
      .from("automation_rule_runs")
      .select("status")
      .eq("organization_id", org)
      .eq("rule_id", regla!.id);
    expect(corridas?.length).toBe(1);
    expect(turno).toBeTruthy();
  });
});
