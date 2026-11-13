/**
 * 300 tarjetas en el kanban para medir cuadros por segundo (auditoría estética).
 * Corre DESPUÉS de seed-e2e-kanban. Reparte 100 por etapa en las 3 primeras etapas
 * abiertas (las últimas son ganado/perdido y exigen motivo). Solo Supabase LOCAL
 * (la guarda de `env-de-teste` rechaza cualquier otro destino).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-auditoria-300", credenciais);
const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TOTAL = 300;

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as {
    org_id: string;
    kanban?: { pipeline_id: string };
  };
  const pipelineId = creds.kanban?.pipeline_id;
  if (!pipelineId) throw new Error("falta kanban.pipeline_id: corré seed-e2e-kanban antes");

  const { data: etapas, error } = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position");
  if (error || !etapas?.length) throw new Error(`sin etapas: ${error?.message}`);
  const ids = (etapas as { id: string }[]).map((e) => e.id).slice(0, 3);

  const filas = Array.from({ length: TOTAL }, (_, i) => ({
    organization_id: creds.org_id,
    pipeline_id: pipelineId,
    stage_id: ids[i % ids.length],
    title: `Auditoría ${String(i + 1).padStart(3, "0")} — consulta de muestra`,
    position_in_stage: 1000 + i,
    source: "manual",
  }));
  for (let i = 0; i < filas.length; i += 100) {
    const { error: e } = await admin.from("crm_leads").insert(filas.slice(i, i + 100) as never);
    if (e) throw new Error(`insert leads ${i}: ${e.message}`);
  }
  console.log(`[seed-auditoria] ${TOTAL} leads en ${ids.length} etapas. pipeline=${pipelineId}`);
}

main().catch((err) => {
  console.error("❌ seed-auditoria-300 falló:", err);
  process.exit(1);
});
