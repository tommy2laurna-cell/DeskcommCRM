/**
 * Datos de muestra para las capturas Liquid (tests/e2e/liquid-capturas.spec.ts).
 *
 * Sin esto la bandeja, los contactos y el kanban salen vacíos y la captura no
 * muestra nada que comparar. Corre DESPUÉS de seed-e2e-credentials y
 * seed-e2e-kanban; escribe en el Supabase LOCAL (la guarda de `env-de-teste`
 * rechaza cualquier otro destino). Deja en `.e2e-creds.json`:
 *   liquid: { pipeline_id, conversa_id, contato_id }
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-liquid-capturas", credenciais);
const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function insertar(tabla: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(tabla).insert(valores as never).select("id").single();
  if (error || !data) throw new Error(`${tabla}: ${error?.message}`);
  return (data as { id: string }).id;
}

const NOMBRES = [
  "Lucía Fernández",
  "Martín Gómez",
  "Carolina Ruiz",
  "Joaquín Pereyra",
  "Valentina Díaz",
  "Nicolás Herrera",
  "Camila Sosa",
  "Federico Aguirre",
];
const MENSAJES = [
  "Hola, quería saber si tienen turno para esta semana",
  "¿Me pasás el precio del plan mensual?",
  "Gracias, quedo atenta",
  "Perfecto, nos vemos el jueves",
  "¿Hacen factura A?",
  "Te mando la foto del modelo que me interesa",
  "Buenísimo, lo hablo con mi socio y te aviso",
  "¿Tienen envío a Rosario?",
];

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as {
    org_id: string;
    kanban?: { pipeline_id: string };
    liquid?: unknown;
  };
  const org = creds.org_id;
  const pipelineId = creds.kanban?.pipeline_id;
  if (!pipelineId) throw new Error("falta kanban.pipeline_id: corré seed-e2e-kanban antes");

  const { data: etapas, error: eErr } = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position");
  if (eErr || !etapas?.length) throw new Error(`sin etapas: ${eErr?.message}`);
  const etapaIds = (etapas as { id: string }[]).map((e) => e.id);

  const canal = await insertar("channel_sessions", {
    organization_id: org,
    waha_session_name: `liquid-${randomUUID()}`,
    display_name: "WhatsApp principal",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });

  let primeraConversa = "";
  let primerContacto = "";
  for (let i = 0; i < NOMBRES.length; i++) {
    const contacto = await insertar("contacts", {
      organization_id: org,
      name: NOMBRES[i],
      phone_number: `+54911${String(40000000 + i * 137).padStart(8, "0")}`,
      tags: i % 3 === 0 ? ["vip"] : i % 3 === 1 ? ["consulta"] : [],
    });
    const conversa = await insertar("conversations", {
      organization_id: org,
      contact_id: contacto,
      channel_session_id: canal,
      status: "open",
    });
    await insertar("messages", {
      organization_id: org,
      contact_id: contacto,
      conversation_id: conversa,
      channel_session_id: canal,
      direction: "inbound",
      type: "text",
      status: "received",
      sent_via: "manual",
      body: MENSAJES[i],
      sent_at: new Date(Date.now() - i * 37 * 60_000).toISOString(),
    });
    if (i === 0) {
      primeraConversa = conversa;
      primerContacto = contacto;
      await insertar("messages", {
        organization_id: org,
        contact_id: contacto,
        conversation_id: conversa,
        channel_session_id: canal,
        direction: "outbound",
        type: "text",
        status: "sent",
        sent_via: "manual",
        body: "¡Hola Lucía! Sí, tenemos el jueves a las 11 o el viernes a las 16. ¿Cuál te queda mejor?",
        sent_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      });
    }
    await insertar("crm_leads", {
      organization_id: org,
      pipeline_id: pipelineId,
      stage_id: etapaIds[i % etapaIds.length],
      contact_id: contacto,
      title: `${NOMBRES[i]} — consulta`,
      position_in_stage: 100 + i,
      source: "manual",
    });
  }

  creds.liquid = { pipeline_id: pipelineId, conversa_id: primeraConversa, contato_id: primerContacto };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  console.log(`[seed-liquid] ${NOMBRES.length} contactos, conversaciones y leads. pipeline=${pipelineId}`);
}

main().catch((err) => {
  console.error("❌ seed-liquid-capturas falló:", err);
  process.exit(1);
});
