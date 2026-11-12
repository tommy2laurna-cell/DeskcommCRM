/**
 * ENTRADA DE PROSPECTOS — POST /api/v1/prospectos contra el app real.
 *
 * Es el camino que usa un nodo HTTP Request de n8n: token de API en el header,
 * JSON en el cuerpo. Nada de insert a mano: el contacto y el lead los crea la
 * ruta, y la base se mira sólo para contarlos.
 *
 * Prueba:
 *  1. la misma llamada dos veces = 1 contacto y 1 lead (201 alta, 200 actualización);
 *  2. «011 15 1234-5678» queda como +5491112345678;
 *  3. origen y campaña quedan en la ficha y se filtran por campaña;
 *  4. sin token = 401.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const TOKEN_PATH = path.join(process.cwd(), ".e2e-entrada-prospectos.json");

function leerToken(): { organization_id: string; bearer: string } {
  if (!fs.existsSync(TOKEN_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-entrada-prospectos.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
}

const { organization_id: ORG, bearer } = leerToken();
const cred = credenciaisSupabaseDeTeste();
const admin = createClient(cred.url, cred.serviceRole, { auth: { persistSession: false } });

const TELEFONO_CRUDO = "011 15 1234-5678";
const TELEFONO_E164 = "+5491112345678";

test.describe("entrada de prospectos", () => {
  test("la misma llamada dos veces deja un contacto y un lead; el teléfono queda normalizado", async ({ request }) => {
    const idExterno = `e2e-${randomUUID()}`;
    const campana = `verano-${idExterno.slice(-8)}`;
    const cuerpo = {
      nombre: "Prospecto E2E",
      telefono: TELEFONO_CRUDO,
      email: `${idExterno}@example.com`,
      origen: "Instagram",
      campana,
      mensaje: "Hola, quiero info",
      id_externo: idExterno,
    };
    const headers = { Authorization: `Bearer ${bearer}` };

    const a = await request.post("/api/v1/prospectos", { headers, data: cuerpo });
    expect(a.status()).toBe(201);
    const ra = (await a.json()).data;
    expect(ra).toMatchObject({ accion: "alta", telefono: TELEFONO_E164 });

    const b = await request.post("/api/v1/prospectos", { headers, data: cuerpo });
    expect(b.status()).toBe(200);
    const rb = (await b.json()).data;
    expect(rb).toMatchObject({ accion: "actualizacion", lead_id: ra.lead_id, contacto_id: ra.contacto_id });

    const { data: leads, error: eL } = await admin
      .from("crm_leads")
      .select("id, contact_id, source, source_metadata")
      .eq("organization_id", ORG)
      .eq("external_id", idExterno);
    expect(eL).toBeNull();
    expect(leads).toHaveLength(1);
    expect(leads![0]).toMatchObject({ id: ra.lead_id, source: "api", contact_id: ra.contacto_id });
    expect(leads![0]!.source_metadata).toMatchObject({ origen: "Instagram", campana });

    const { data: contactos, error: eC } = await admin
      .from("contacts")
      .select("id, phone_number, source, source_metadata")
      .eq("organization_id", ORG)
      .eq("email", cuerpo.email);
    expect(eC).toBeNull();
    expect(contactos).toHaveLength(1);
    expect(contactos![0]).toMatchObject({ id: ra.contacto_id, phone_number: TELEFONO_E164, source: "instagram" });

    // Origen y campaña llegan a la lista de contactos y se filtran por token.
    const lista = await request.get(`/api/v1/contacts?campaign=${encodeURIComponent(campana)}`, { headers });
    expect(lista.status()).toBe(200);
    const filas = (await lista.json()).data as Array<{ id: string; source: string }>;
    expect(filas.map((f) => f.id)).toEqual([ra.contacto_id]);
  });

  test("sin token → 401, y con datos inválidos → 422", async ({ request }) => {
    const sin = await request.post("/api/v1/prospectos", { data: { telefono: TELEFONO_CRUDO, id_externo: "x" } });
    expect(sin.status()).toBe(401);

    const invalido = await request.post("/api/v1/prospectos", {
      headers: { Authorization: `Bearer ${bearer}` },
      data: { nombre: "Sin contacto", id_externo: "y" },
    });
    expect(invalido.status()).toBe(422);
  });
});
