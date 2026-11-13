/**
 * EL ENVÍO DE CAMPAÑAS — un lote chico por tick, escalonado.
 *
 * Toma las campañas `confirmada`/`enviando` cuya hora ya llegó y procesa un lote
 * de cada una (`procesarLote`): opt-out revaluado antes de CADA envío, espera
 * anti-ban entre envíos, tope diario de la sesión, reintento idempotente. Sale
 * SOLO por la API de Meta: una sesión que no sea `meta_cloud` se salta.
 *
 * Presupuesto de tiempo: el crontab da 60 s; no se arranca otra campaña pasados
 * ~30 s del tick. Rodada que no hizo nada NO audita (ver CLAUDE.md § Audit log).
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { depsDeProduccion } from "@/lib/campaigns/deps";
import { procesarLote, type CampanaEnCurso } from "@/lib/campaigns/procesar";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const PRESUPUESTO_MS = 30_000;
const MAX_CAMPANAS_POR_TICK = 5;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const fornecido = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (aceitos.length === 0 || !fornecido || !aceitos.includes(fornecido)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient() as unknown as SupabaseClient;
  const inicio = Date.now();
  const ahora = new Date().toISOString();

  const { data: campanas, error } = await admin
    .from("campaigns")
    .select(
      "id, organization_id, channel_session_id, template_name, template_language, template_values",
    )
    .in("status", ["confirmada", "enviando"])
    .or(`scheduled_at.is.null,scheduled_at.lte.${ahora}`)
    // Rotación justa: cada lote toca `updated_at`, así la campaña atendida pasa al final.
    .order("updated_at", { ascending: true })
    .limit(MAX_CAMPANAS_POR_TICK);
  if (error) {
    logger.error("[campaigns] consulta falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar campanhas.", 500, { requestId });
  }

  const deps = depsDeProduccion(admin);
  const total = { campanas: 0, enviados: 0, excluidos: 0, errores: 0, saltadas_no_meta: 0 };

  for (const c of (campanas ?? []) as (Omit<CampanaEnCurso, "session_ref"> & {
    channel_session_id: string | null;
  })[]) {
    if (Date.now() - inicio > PRESUPUESTO_MS) break;

    const { data: sesion } = c.channel_session_id
      ? await admin
          .from("channel_sessions")
          .select("provider, meta_phone_number_id")
          .eq("id", c.channel_session_id)
          .eq("organization_id", c.organization_id)
          .maybeSingle()
      : { data: null };
    const s = sesion as { provider: string; meta_phone_number_id: string | null } | null;
    if (!c.channel_session_id || !s || s.provider !== "meta_cloud" || !s.meta_phone_number_id) {
      // Jamás por WAHA. Dejarla `confirmada` ocuparía uno de los cupos del tick para
      // siempre: se cancela con el motivo a la vista.
      await admin
        .from("campaigns")
        .update({ status: "cancelada", status_reason: "sesion_no_meta" })
        .eq("id", c.id)
        .eq("organization_id", c.organization_id)
        .in("status", ["confirmada", "enviando"]);
      total.saltadas_no_meta += 1;
      continue;
    }

    try {
      const r = await procesarLote(
        admin,
        { ...c, channel_session_id: c.channel_session_id, session_ref: s.meta_phone_number_id },
        deps,
      );
      total.campanas += 1;
      total.enviados += r.enviados;
      total.excluidos += r.excluidos;
      total.errores += r.errores;
    } catch (err) {
      logger.error("[campaigns] lote falhou", {
        campaign_id: c.id,
        error: err instanceof Error ? err.message : "desconhecido",
        requestId,
      });
    }
  }

  if (total.enviados + total.excluidos + total.errores + total.saltadas_no_meta > 0) {
    await audit({
      action: "campaign.batch_sent",
      resourceType: "campaign",
      metadata: total,
      requestId,
    });
  }
  return ok(total, { requestId });
}

export const GET = handle;
export const POST = handle;
