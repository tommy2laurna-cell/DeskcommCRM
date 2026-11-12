/**
 * ENTRADA DE PROSPECTOS — una llamada de una automatización crea o actualiza
 * contacto + lead en el CRM del cliente.
 *
 * Idempotencia: la clave es (organización, source = "api", id_externo) sobre
 * `uniq_crm_leads_org_source_external`. `source` del lead es siempre "api" a
 * propósito: si fuera el origen, el mismo id_externo con otro origen crearía un
 * segundo lead. El origen y la campaña viajan en `source_metadata` y el origen
 * además queda en `contacts.source`, que la ficha ya muestra y la lista filtra.
 *
 * Es la misma lógica de `webhooks/in/[token]` (contacto por teléfono, luego por
 * email; lead por external_id; carrera resuelta por el índice único), pero con
 * auth por token de API en vez de `path_token`, y con respuesta alta/actualización.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { encontrarContatoPorTelefoneComNome } from "@/lib/channels/contato-por-telefone";
import { slugDeOrigen, type ProspectoInput } from "@/lib/schemas/prospectos";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";

import { funilDeEntrada } from "./nascimento-do-lead";

export const SOURCE_DEL_LEAD = "api";

export interface ContextoDeEntrada {
  organization_id: string;
  actor: Actor;
  requestId: string;
}

export interface ResultadoDeEntrada {
  accion: "alta" | "actualizacion";
  contacto_id: string | null;
  lead_id: string;
  telefono: string | null;
  etapa_id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recusa(status: number, code: string, message: string, requestId: string): ApiError {
  return new ApiError(status, code, undefined, requestId, message);
}

/** La etapa pedida: uuid de la organización, o nombre dentro del embudo dado. */
async function resolverEtapa(
  db: SupabaseClient,
  ctx: ContextoDeEntrada,
  etapa: string,
  pipelineId: string,
): Promise<{ pipelineId: string; stageId: string }> {
  const base = db
    .from("crm_stages")
    .select("id, name, pipeline_id")
    .eq("organization_id", ctx.organization_id)
    .eq("is_archived", false);
  const esUuid = UUID.test(etapa);
  const { data, error } = esUuid ? await base.eq("id", etapa) : await base.eq("pipeline_id", pipelineId);
  if (error) throw recusa(500, "internal_error", error.message, ctx.requestId);

  const filas = (data ?? []) as Array<{ id: string; name: string; pipeline_id: string }>;
  const hit = esUuid
    ? filas[0]
    : filas.find((f) => f.name.trim().toLowerCase() === etapa.trim().toLowerCase());
  if (!hit) {
    throw recusa(
      422,
      "etapa_no_encontrada",
      `Etapa «${etapa}» no encontrada. Etapas del embudo: ${filas.map((f) => f.name).join(", ") || "(ninguna)"}.`,
      ctx.requestId,
    );
  }
  return { pipelineId: hit.pipeline_id, stageId: hit.id };
}

async function resolverContacto(
  db: SupabaseClient,
  ctx: ContextoDeEntrada,
  input: ProspectoInput,
  telefono: string | null,
): Promise<{ id: string; existia: boolean }> {
  type Hallado = { id: string } | null;

  const porTelefono = async (): Promise<Hallado> =>
    telefono ? await encontrarContatoPorTelefoneComNome(db, ctx.organization_id, telefono) : null;
  const porEmail = async (): Promise<Hallado> => {
    if (!input.email) return null;
    const { data } = await db
      .from("contacts")
      .select("id")
      .eq("organization_id", ctx.organization_id)
      .eq("email_normalized", input.email.trim().toLowerCase())
      .is("is_merged_into", null)
      .maybeSingle();
    return (data as Hallado) ?? null;
  };

  const existente = (await porTelefono()) ?? (await porEmail());
  if (existente) {
    // Completa el email faltante; nunca pisa lo que el contacto ya tiene.
    if (input.email) {
      await db
        .from("contacts")
        .update({ email: input.email })
        .eq("id", existente.id)
        .eq("organization_id", ctx.organization_id)
        .is("email", null);
    }
    return { id: existente.id, existia: true };
  }

  const { data: creado, error } = await db
    .from("contacts")
    .insert({
      organization_id: ctx.organization_id,
      name: input.nombre ?? telefono ?? input.email,
      phone_number: telefono,
      email: input.email ?? null,
      source: slugDeOrigen(input.origen) ?? "api",
      source_metadata: {
        via: "api",
        origen: input.origen ?? null,
        campana: input.campana ?? null,
        id_externo: input.id_externo,
      },
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // Carrera: otra llamada igual creó el contacto entre la búsqueda y el insert.
    if (error.code === "23505") {
      const ganador = (await porTelefono()) ?? (await porEmail());
      if (ganador) return { id: ganador.id, existia: true };
    }
    throw recusa(500, "internal_error", error.message, ctx.requestId);
  }
  if (!creado) throw recusa(500, "internal_error", "contact_insert_empty", ctx.requestId);
  return { id: (creado as { id: string }).id, existia: false };
}

interface LeadPrevio {
  id: string;
  contact_id: string | null;
  stage_id: string;
  pipeline_id: string;
  source_metadata: Record<string, unknown> | null;
}

async function leadPorIdExterno(
  db: SupabaseClient,
  orgId: string,
  idExterno: string,
): Promise<LeadPrevio | null> {
  const { data } = await db
    .from("crm_leads")
    .select("id, contact_id, stage_id, pipeline_id, source_metadata")
    .eq("organization_id", orgId)
    .eq("source", SOURCE_DEL_LEAD)
    .eq("external_id", idExterno)
    .maybeSingle();
  return (data as LeadPrevio | null) ?? null;
}

export async function ingresarProspecto(
  db: SupabaseClient,
  ctx: ContextoDeEntrada,
  input: ProspectoInput,
): Promise<ResultadoDeEntrada> {
  const telefono = input.telefono ? normalizePhoneBR(input.telefono) : null;
  const metadata = { via: "api", origen: input.origen ?? null, campana: input.campana ?? null };

  const actualizar = async (lead: LeadPrevio): Promise<ResultadoDeEntrada> => {
    let stageId = lead.stage_id;
    if (input.etapa) {
      const destino = await resolverEtapa(db, ctx, input.etapa, lead.pipeline_id);
      if (destino.pipelineId !== lead.pipeline_id) {
        throw recusa(422, "etapa_otro_embudo", "La etapa es de otro embudo.", ctx.requestId);
      }
      if (destino.stageId !== lead.stage_id) {
        await moveLeadHandler(db, ctx, lead.id, { to_stage_id: destino.stageId });
        stageId = destino.stageId;
      }
    }
    const patch: Record<string, unknown> = {
      source_metadata: { ...(lead.source_metadata ?? {}), ...metadata },
    };
    if (input.mensaje) patch.description = input.mensaje;
    const { error } = await db
      .from("crm_leads")
      .update(patch)
      .eq("id", lead.id)
      .eq("organization_id", ctx.organization_id);
    if (error) throw recusa(500, "internal_error", error.message, ctx.requestId);

    const contactoId = lead.contact_id ?? (await resolverContacto(db, ctx, input, telefono)).id;
    return {
      accion: "actualizacion",
      contacto_id: contactoId,
      lead_id: lead.id,
      telefono,
      etapa_id: stageId,
    };
  };

  const previo = await leadPorIdExterno(db, ctx.organization_id, input.id_externo);
  if (previo) return actualizar(previo);

  // Destino del lead nuevo: la etapa pedida (por nombre, en el embudo de
  // entrada) o la primera etapa abierta del embudo de entrada.
  const entrada = await funilDeEntrada(db, ctx.organization_id);
  if ("erro" in entrada) {
    throw recusa(
      422,
      "sin_embudo_de_entrada",
      "La organización no tiene un embudo de entrada con etapas abiertas.",
      ctx.requestId,
    );
  }
  const destino = input.etapa ? await resolverEtapa(db, ctx, input.etapa, entrada.pipelineId) : entrada;

  const contacto = await resolverContacto(db, ctx, input, telefono);

  try {
    const lead = await createLeadHandler(db, ctx, {
      pipeline_id: destino.pipelineId,
      stage_id: destino.stageId,
      title: input.nombre ?? telefono ?? input.email ?? "Prospecto sin nombre",
      description: input.mensaje ?? null,
      contact_id: contacto.id,
      tags: [],
      source: SOURCE_DEL_LEAD,
      source_metadata: metadata,
      external_id: input.id_externo,
    });
    return {
      accion: "alta",
      contacto_id: contacto.id,
      lead_id: String(lead.id),
      telefono,
      etapa_id: destino.stageId,
    };
  } catch (err) {
    // Carrera entre dos llamadas iguales: el índice único deja ganar a una.
    if (err instanceof ApiError && err.message?.includes("uniq_crm_leads_org_source_external")) {
      const ganador = await leadPorIdExterno(db, ctx.organization_id, input.id_externo);
      if (ganador) return actualizar(ganador);
    }
    throw err;
  }
}
