/**
 * CRON DE PEDIDO DE RESEÑA — N días después de ganar un negocio, manda el link de
 * reseñas de Google al cliente con un MENSAJE APROBADO de Meta.
 *
 * Sin IA y sin responder reseñas. Dos pasos por rodada:
 *
 *  1. MATERIALIZA: los negocios `won` de los últimos 30 días ganan una fila en
 *     `review_requests` (`unique(lead_id)` => idempotente; `due_at` = cierre + días
 *     de `settings.reviews`). Se lee de `crm_leads` y no del `event_log` porque el
 *     trigger que emite `lead.won` cambia el estado en la misma escritura: el
 *     negocio ganado ES la fuente, y evita depender de un drain.
 *  2. ENVÍA los vencidos (ventana de 14 días: un pedido viejo ya no tiene gracia).
 *     Sin link o sin mensaje aprobado no envía y la fila queda `sin_configurar`
 *     (se reintenta sola cuando la organización configura). Respeta
 *     `checarGuardasDeContato` y el espaciado de `espacarEnvio`.
 *
 * ⚠️ organization_id sale SIEMPRE de la fila del negocio/pedido, nunca de un body.
 * Rodada sin envíos no es mutación y no audita (CLAUDE.md §Audit log).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { espacarEnvio } from "@/lib/automation/throttle";
import type { ActionCtx } from "@/lib/automation/types";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  resenasConfiguradas,
  textoDelCuerpo,
  valoresDelMensaje,
  vencimientoDelPedido,
} from "@/lib/reviews/pedido-de-resena";
import { reviewsSettingsLeituraSchema, type ReviewsSettings } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DIAS_PARA_MATERIALIZAR = 30;
const DIAS_DE_GRACIA = 14;
const LIMITE_MATERIALIZAR = 500;
const LIMITE_DE_ENVIOS = 50;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const fornecido = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (aceitos.length === 0 || !fornecido || !aceitos.includes(fornecido)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  const configs = new Map<string, ReviewsSettings>();
  async function configDe(org: string): Promise<ReviewsSettings> {
    const cacheada = configs.get(org);
    if (cacheada) return cacheada;
    const { data } = await admin.from("organizations").select("settings").eq("id", org).maybeSingle();
    const settings = (data?.settings as Record<string, unknown> | null) ?? {};
    const config = reviewsSettingsLeituraSchema.parse(settings.reviews ?? {});
    configs.set(org, config);
    return config;
  }

  // 1. Materializa
  const desde = new Date(agora.getTime() - DIAS_PARA_MATERIALIZAR * 86_400_000).toISOString();
  const { data: ganados, error: erroGanados } = await admin
    .from("crm_leads")
    .select("id, organization_id, contact_id, closed_at")
    .eq("status", "won")
    .not("contact_id", "is", null)
    .not("closed_at", "is", null)
    .gte("closed_at", desde)
    .order("closed_at", { ascending: false })
    .limit(LIMITE_MATERIALIZAR);
  if (erroGanados) {
    logger.error("[review-requests] consulta de ganados falhou", { error: erroGanados.message, requestId });
    return fail("internal_error", "Falha ao buscar negócios ganhos.", 500, { requestId });
  }

  const filas = [];
  for (const lead of ganados ?? []) {
    const config = await configDe(lead.organization_id as string);
    filas.push({
      organization_id: lead.organization_id as string,
      lead_id: lead.id as string,
      contact_id: lead.contact_id as string,
      due_at: vencimientoDelPedido(lead.closed_at as string, config.dias_despues),
    });
  }
  if (filas.length > 0) {
    const { error } = await admin
      .from("review_requests")
      .upsert(filas, { onConflict: "lead_id", ignoreDuplicates: true });
    if (error) {
      logger.error("[review-requests] materializar falhou", { error: error.message, requestId });
      return fail("internal_error", "Falha ao registrar pedidos.", 500, { requestId });
    }
  }

  // 2. Envía
  const { data: vencidos, error: erroVencidos } = await admin
    .from("review_requests")
    .select("id, organization_id, contact_id, status")
    .in("status", ["pendiente", "sin_configurar"])
    .lte("due_at", agora.toISOString())
    .gte("due_at", new Date(agora.getTime() - DIAS_DE_GRACIA * 86_400_000).toISOString())
    .order("due_at", { ascending: true })
    .limit(LIMITE_DE_ENVIOS);
  if (erroVencidos) {
    logger.error("[review-requests] consulta de vencidos falhou", { error: erroVencidos.message, requestId });
    return fail("internal_error", "Falha ao buscar pedidos.", 500, { requestId });
  }

  let enviados = 0;
  const motivos: Record<string, number> = {};
  const pular = (motivo: string) => {
    motivos[motivo] = (motivos[motivo] ?? 0) + 1;
  };
  const cerrar = async (id: string, org: string, status: string, error?: string) => {
    await admin
      .from("review_requests")
      .update({ status, ...(error ? { error } : {}) })
      .eq("id", id)
      .eq("organization_id", org);
  };

  for (const pedido of vencidos ?? []) {
    const org = pedido.organization_id as string;
    const config = await configDe(org);

    if (!resenasConfiguradas(config)) {
      if (pedido.status !== "sin_configurar") await cerrar(pedido.id as string, org, "sin_configurar");
      pular("sin_configurar");
      continue;
    }

    const { data: modelo } = await admin
      .from("meta_templates")
      .select("components")
      .eq("organization_id", org)
      .eq("name", config.mensaje_aprobado_nombre)
      .eq("language", config.mensaje_aprobado_idioma)
      .eq("status", "APPROVED")
      .limit(1)
      .maybeSingle();
    if (!modelo) {
      if (pedido.status !== "sin_configurar") await cerrar(pedido.id as string, org, "sin_configurar");
      pular("mensaje_no_aprobado");
      continue;
    }

    const { data: contato } = await admin
      .from("contacts")
      .select("id, name, display_name, phone_number, is_blocked, is_anonymized, consent")
      .eq("id", pedido.contact_id)
      .eq("organization_id", org)
      .maybeSingle();
    const guarda =
      contato && !contato.is_anonymized
        ? checarGuardasDeContato({ context: { contact: contato } } as unknown as ActionCtx)
        : ({ ok: false, reason: "no_contact" } as const);
    if (!guarda.ok) {
      await cerrar(pedido.id as string, org, "omitido", guarda.reason);
      pular(guarda.reason);
      continue;
    }

    const { data: canal } = await admin
      .from("channel_sessions")
      .select("id, meta_phone_number_id")
      .eq("organization_id", org)
      .eq("status", "WORKING")
      .not("meta_phone_number_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (!canal) {
      pular("sin_canal");
      continue;
    }

    // Reclama la fila ANTES de enviar: dos rodadas solapadas no mandan dos veces.
    const { data: reclamada } = await admin
      .from("review_requests")
      .update({ status: "enviado", sent_at: agora.toISOString() })
      .eq("id", pedido.id)
      .eq("organization_id", org)
      .in("status", ["pendiente", "sin_configurar"])
      .select("id");
    if (!reclamada?.length) continue;

    await espacarEnvio(canal.id as string);
    try {
      const conversaId = await ensureConversation(admin, org, guarda.contact.id, canal.id as string);
      await sendMessageHandler(
        admin,
        {
          organization_id: org,
          actor: { type: "webhook_source", id: pedido.id as string },
          requestId: `review-requests:${pedido.id}`,
        },
        {
          conversation_id: conversaId,
          type: "template",
          template_name: config.mensaje_aprobado_nombre,
          template_language: config.mensaje_aprobado_idioma,
          template_values: valoresDelMensaje(
            textoDelCuerpo(modelo.components),
            nomeDoContato(contato) ?? "",
            config.google_review_url,
          ),
        } as Parameters<typeof sendMessageHandler>[2],
      );
      enviados += 1;
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      logger.error("[review-requests] envio falhou", { pedidoId: pedido.id, error: mensagem, requestId });
      await cerrar(pedido.id as string, org, "fallido", mensagem.slice(0, 500));
      pular("error_en_el_envio");
    }
  }

  if (enviados > 0) {
    await audit({
      action: "reviews.pedido_enviado",
      resourceType: "review_request",
      requestId,
      metadata: { enviados, motivos },
    });
  }

  return ok({ materializados: filas.length, vencidos: vencidos?.length ?? 0, enviados, motivos }, { requestId });
}

export const GET = handle;
export const POST = handle;
