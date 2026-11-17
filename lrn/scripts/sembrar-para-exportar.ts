/**
 * Siembra una org del Conectado con datos de cliente (para probar lrn/scripts/exportar-a-base.ts en CI):
 * dos embudos con ganada/perdida, contactos con etiquetas y cumpleaños, oportunidades abiertas/ganadas/perdidas,
 * una sin contacto, notas y tareas (pendiente, hecha, cancelada, sin fecha) y la marca.
 *
 *   npx tsx lrn/scripts/sembrar-para-exportar.ts <slug-de-la-org>
 *
 * Imprime una línea JSON con lo sembrado. Credenciales: NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

const env: Record<string, string | undefined> = { ...process.env };
for (const f of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), f);
  if (!fs.existsSync(p)) continue;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !env[m[1]!]) env[m[1]!] = (m[2] ?? "").replace(/^"(.*)"$/, "$1");
  }
}
const slug = process.argv[2];
if (!slug || !env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Uso: sembrar-para-exportar.ts <slug>  (y NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function ins<T extends { id: string }>(tabla: string, fila: Record<string, unknown>): Promise<string> {
  const r = await db.from(tabla).insert(fila).select("id").single();
  if (r.error) throw new Error(`insert ${tabla}: ${r.error.message}`);
  return (r.data as T).id;
}

async function main() {
  const org = await db.from("organizations").select("id").eq("slug", slug).maybeSingle();
  if (org.error || !org.data) throw new Error(`No existe la organización «${slug}»`);
  const o = (org.data as { id: string }).id;

  const embudo = async (name: string, s: string, position: number, extra: Record<string, unknown> = {}) =>
    ins("crm_pipelines", { organization_id: o, name, slug: s, position, settings: { lost_reasons: ["Precio"] }, ...extra });
  const etapa = (pipeline_id: string, name: string, s: string, position: number, extra: Record<string, unknown> = {}) =>
    ins("crm_stages", { organization_id: o, pipeline_id, name, slug: s, position, ...extra });

  const ventas = await embudo("Ventas", "seed-ventas", 1000, { is_default: false });
  const nuevo = await etapa(ventas, "Nuevo", "nuevo", 1000, { color: "#3366cc", expected_duration_hours: 120 });
  const ganada = await etapa(ventas, "Ganada", "ganada", 2000, { is_won: true });
  const perdida = await etapa(ventas, "Perdida", "perdida", 3000, { is_lost: true });
  const post = await embudo("Postventa", "seed-postventa", 2000);
  const reclamo = await etapa(post, "Reclamo", "reclamo", 1000);

  const contacto = (name: string, phone: string | null, email: string | null, tags: string[], birthdate: string | null = null) =>
    ins("contacts", { organization_id: o, name, phone_number: phone, email, tags, birthdate, source: "manual" });
  const ana = await contacto("Ana Álvarez", "+5491123456789", "ana@ejemplo.com", ["vip", "referido"], "1990-03-14");
  const bruno = await contacto("Bruno Díaz", "+5493515550101", null, ["referido"]);
  const carla = await contacto("Carla Gómez", null, "carla@ejemplo.com", []);

  const lead = (pipeline_id: string, stage_id: string, contact_id: string | null, title: string, extra: Record<string, unknown> = {}) =>
    ins("crm_leads", { organization_id: o, pipeline_id, stage_id, contact_id, title, source: "manual", currency: "ARS", ...extra });
  const l1 = await lead(ventas, nuevo, ana, "Web institucional", { value_cents: 12000000, tags: ["vip"], custom_fields: { origen: "Instagram" } });
  await lead(ventas, ganada, bruno, "Mantenimiento", { status: "won", value_cents: 4500000, closed_at: "2026-10-20T12:00:00Z" });
  await lead(ventas, perdida, carla, "Tienda online", { status: "lost", lost_reason: "Precio", closed_at: "2026-10-21T12:00:00Z" });
  await lead(post, reclamo, null, "Reclamo sin contacto");

  const nota = (contact_id: string, headline: string, body: string) => ins("lead_notes", { organization_id: o, contact_id, headline, body });
  await nota(ana, "Pidió presupuesto", "Con dominio incluido");
  await nota(bruno, "Base t2 · llamada · Llamó para confirmar", "Llamó para confirmar la reunión");

  const tarea = (title: string, extra: Record<string, unknown>) => ins("crm_tasks", { organization_id: o, title, ...extra });
  await tarea("Mandar propuesta v2", { contact_id: ana, lead_id: l1, due_date: "2026-11-20T12:00:00Z" });
  await tarea("Cobrar la seña", { contact_id: bruno, due_date: "2026-10-30T12:00:00Z", status: "done" });
  await tarea("Tarea cancelada", { contact_id: ana, due_date: "2026-11-01T12:00:00Z", status: "cancelled" });
  await tarea("Tarea suelta", { lead_id: l1 });

  const b = await db.from("platform_branding").upsert({ id: 1, app_name: "Panadería Ñandú", accent_hex: "#aa3300", seeded_from_env: false }, { onConflict: "id" });
  if (b.error) throw new Error(`branding: ${b.error.message}`);
  console.info(JSON.stringify({ org: o, embudos: 2, etapas: 5, contactos: 3, leads: 4, notas: 2, tareas: 4 }));
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
