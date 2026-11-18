/**
 * Acción `notify_owner` — le deja una tarea al responsable del lead del contexto.
 * Es el "aviso" de la receta de 3 días sin movimiento: queda en Tareas, no se
 * pierde si nadie tiene la pantalla abierta y no manda nada al cliente.
 * Sin responsable asignado la tarea nace sin dueño, visible para todo el equipo.
 */
import { registerAction } from "@/lib/automation/actions";
import { renderTemplate } from "@/lib/automation/template";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const title = typeof config.title === "string" ? renderTemplate(config.title, ctx.context).trim() : "";
  const lead = ctx.context.lead as { id: string; owner_user_id?: string | null; contact_id?: string | null } | undefined;
  if (!title || !lead) return { type: "notify_owner", status: "skipped", detail: { reason: "missing_input" } };

  const { error } = await ctx.admin.from("crm_tasks").insert({
    organization_id: ctx.organizationId,
    title: title.slice(0, 200),
    lead_id: lead.id,
    contact_id: lead.contact_id ?? null,
    assigned_to: lead.owner_user_id ?? null,
    priority: "high",
  });
  if (error) return { type: "notify_owner", status: "failed", error: error.message };
  return {
    type: "notify_owner",
    status: "success",
    detail: { assigned_to: lead.owner_user_id ?? null, sin_responsable: !lead.owner_user_id },
  };
}

registerAction({ type: "notify_owner", execute });
