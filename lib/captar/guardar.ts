/**
 * Crear, editar y borrar formularios públicos (lado administración).
 *
 * Cada formulario tiene una fuente interna de captación (`webhook_sources`):
 * por ahí entra el envío. Se crea con la operación que ya existe
 * (`criarEntradaAutomatica`) y se mantiene sincronizada (nombre, destino y
 * activo) cuando el formulario cambia, para que la captación de siempre mande
 * el lead a la etapa que el formulario dice.
 */
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import {
  criarEntradaAutomatica,
  type DepsDaOperacao,
} from "@/lib/operacao/entradas-automaticas";
import { nuevoSlug, type DefinicionDeFormulario } from "@/lib/captar/formulario";

const COLUMNAS =
  "id, slug, kind, name, fields, pipeline_id, stage_id, tags, thanks_message, consent_text, is_active, created_at, updated_at";

/** El funil y la etapa son de ESTA organización y la etapa cuelga de ese funil. */
async function exigirDestino(deps: DepsDaOperacao, pipelineId: string, stageId: string): Promise<void> {
  const { data } = await deps.supabase
    .from("crm_stages")
    .select("id")
    .eq("id", stageId)
    .eq("pipeline_id", pipelineId)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (!data) {
    throw new ApiError(422, "unprocessable_entity", undefined, deps.requestId, "destino_invalido");
  }
}

export async function listarFormularios(deps: DepsDaOperacao): Promise<Record<string, unknown>[]> {
  const { data, error } = await deps.supabase
    .from("capture_forms")
    .select(COLUMNAS)
    .eq("organization_id", deps.organizationId)
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);
  return (data ?? []) as Record<string, unknown>[];
}

export async function crearFormulario(
  deps: DepsDaOperacao,
  def: DefinicionDeFormulario,
): Promise<Record<string, unknown>> {
  await exigirDestino(deps, def.pipeline_id, def.stage_id);
  const fuente = await criarEntradaAutomatica(deps, {
    name: `Formulario: ${def.name}`.slice(0, 160),
    default_pipeline_id: def.pipeline_id,
    default_stage_id: def.stage_id,
  });

  const { data, error } = await deps.supabase
    .from("capture_forms")
    .insert({
      organization_id: deps.organizationId,
      slug: nuevoSlug(),
      kind: def.kind,
      name: def.name,
      fields: def.fields,
      pipeline_id: def.pipeline_id,
      stage_id: def.stage_id,
      tags: def.tags,
      thanks_message: def.thanks_message,
      consent_text: def.consent_text,
      is_active: def.is_active,
      webhook_source_id: fuente.id,
      created_by_user_id: deps.actor.type === "user" ? deps.actor.id : null,
    })
    .select(COLUMNAS)
    .single();
  if (error || !data) {
    // Sin formulario, la fuente que recién se creó quedaría huérfana en la lista de Webhooks.
    await deps.supabase.from("webhook_sources").delete().eq("id", fuente.id).eq("organization_id", deps.organizationId);
    throw new ApiError(500, "internal_error", undefined, deps.requestId, error?.message ?? "insert_failed");
  }
  await audit({
    action: "captar.form_created",
    actorUserId: deps.actor.type === "user" ? deps.actor.id : null,
    organizationId: deps.organizationId,
    resourceType: "capture_form",
    resourceId: (data as { id: string }).id,
    requestId: deps.requestId,
    metadata: { name: def.name, kind: def.kind },
  });
  return data as Record<string, unknown>;
}

export async function actualizarFormulario(
  deps: DepsDaOperacao,
  id: string,
  def: DefinicionDeFormulario,
): Promise<Record<string, unknown>> {
  await exigirDestino(deps, def.pipeline_id, def.stage_id);
  const { data: actual } = await deps.supabase
    .from("capture_forms")
    .select("id, webhook_source_id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (!actual) throw new ApiError(404, "not_found", undefined, deps.requestId, "formulario_inexistente");

  const { data, error } = await deps.supabase
    .from("capture_forms")
    .update({
      kind: def.kind,
      name: def.name,
      fields: def.fields,
      pipeline_id: def.pipeline_id,
      stage_id: def.stage_id,
      tags: def.tags,
      thanks_message: def.thanks_message,
      consent_text: def.consent_text,
      is_active: def.is_active,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .select(COLUMNAS)
    .single();
  if (error || !data) throw new ApiError(500, "internal_error", undefined, deps.requestId, error?.message ?? "update_failed");

  const fuenteId = (actual as { webhook_source_id: string | null }).webhook_source_id;
  if (fuenteId) {
    await deps.supabase
      .from("webhook_sources")
      .update({
        name: `Formulario: ${def.name}`.slice(0, 160),
        default_pipeline_id: def.pipeline_id,
        default_stage_id: def.stage_id,
        is_active: def.is_active,
      })
      .eq("id", fuenteId)
      .eq("organization_id", deps.organizationId);
  }
  await audit({
    action: "captar.form_updated",
    actorUserId: deps.actor.type === "user" ? deps.actor.id : null,
    organizationId: deps.organizationId,
    resourceType: "capture_form",
    resourceId: id,
    requestId: deps.requestId,
    metadata: { name: def.name },
  });
  return data as Record<string, unknown>;
}

export async function borrarFormulario(deps: DepsDaOperacao, id: string): Promise<void> {
  const { data: actual } = await deps.supabase
    .from("capture_forms")
    .select("id, name, webhook_source_id")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (!actual) throw new ApiError(404, "not_found", undefined, deps.requestId, "formulario_inexistente");

  const { error } = await deps.supabase
    .from("capture_forms")
    .delete()
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);

  // La fuente se apaga y se deja: el historial de captaciones la referencia por nombre y fecha.
  const fuenteId = (actual as { webhook_source_id: string | null }).webhook_source_id;
  if (fuenteId) {
    await deps.supabase
      .from("webhook_sources")
      .update({ is_active: false })
      .eq("id", fuenteId)
      .eq("organization_id", deps.organizationId);
  }
  await audit({
    action: "captar.form_deleted",
    actorUserId: deps.actor.type === "user" ? deps.actor.id : null,
    organizationId: deps.organizationId,
    resourceType: "capture_form",
    resourceId: id,
    requestId: deps.requestId,
    metadata: { name: (actual as { name: string }).name },
  });
}
