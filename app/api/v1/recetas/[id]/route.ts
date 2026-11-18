/**
 * PUT /api/v1/recetas/[id] — prende, apaga o edita una receta.
 * Es un upsert sobre `automation_rules` por (organización, recipe_key): la receta
 * no es un motor aparte, es una regla del motor de siempre.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { recetaPorId } from "@/lib/recetas/catalogo";
import { ajustesDeRegla, type ReglaGuardada } from "@/lib/recetas/estado";
import { reglaDeReceta, type ErrorDeReceta } from "@/lib/recetas/regla";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const cuerpoSchema = z.object({
  activa: z.boolean().optional(),
  texto: z.string().min(1).max(2000).optional(),
  channel_session_id: z.string().uuid().optional(),
  link: z.string().url().max(500).optional(),
});

const MENSAJE_DE_ERROR: Record<ErrorDeReceta, string> = {
  falta_numero: "Elegí el número de WhatsApp por el que sale.",
  falta_link: "Pegá el link de reseña de Google.",
  texto_incompleto: "El texto todavía tiene el marcador del link: reemplazalo antes de prender.",
};

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const receta = recetaPorId(id);
  if (!receta) return fail("not_found", t("Receta no encontrada."), 404, { requestId });

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = cuerpoSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, { requestId, details: parsed.error.flatten() });
  }

  const supabase = await createClient();
  const { data: existente, error: errLectura } = await supabase
    .from("automation_rules")
    .select("id, recipe_key, is_active, run_count, last_run_at, actions")
    .eq("organization_id", org.orgId)
    .eq("recipe_key", receta.id)
    .maybeSingle();
  if (errLectura) return fail("internal_error", errLectura.message, 500, { requestId });
  const previa = existente as unknown as ReglaGuardada | null;

  const activa = parsed.data.activa ?? previa?.is_active ?? false;
  const soloInterruptor = Object.keys(parsed.data).length === 1 && parsed.data.activa !== undefined;

  // Apagar (o prender una ya guardada) sin tocar nada más es solo mover el interruptor.
  if (soloInterruptor && previa && !activa) {
    const { error } = await supabase
      .from("automation_rules")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", previa.id)
      .eq("organization_id", org.orgId);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    return ok({ id: receta.id, activa: false }, { requestId });
  }
  if (soloInterruptor && !previa && !activa) return ok({ id: receta.id, activa: false }, { requestId });

  const guardados = ajustesDeRegla(receta, previa ?? undefined);
  const ajustes = {
    texto: parsed.data.texto ?? guardados.texto,
    channel_session_id: parsed.data.channel_session_id ?? guardados.channel_session_id,
    link: parsed.data.link ?? guardados.link,
  };

  if (ajustes.channel_session_id) {
    const { data: sesion } = await supabase
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", org.orgId)
      .eq("id", ajustes.channel_session_id)
      .maybeSingle();
    if (!sesion) return fail("invalid_request", t("Número no encontrado."), 400, { requestId });
  }

  // Siempre se reconstruye la regla entera desde el catálogo + los ajustes: así
  // una edición nunca deja una regla a medias ni con un texto que no sale.
  const armada = reglaDeReceta(receta, ajustes);
  if (!armada.ok) {
    return fail("invalid_request", t(MENSAJE_DE_ERROR[armada.error]), 422, {
      requestId,
      details: { motivo: armada.error },
    });
  }

  if (previa) {
    const { error } = await supabase
      .from("automation_rules")
      .update({
        is_active: activa,
        name: armada.regla.name,
        conditions: armada.regla.conditions,
        actions: armada.regla.actions,
        updated_at: new Date().toISOString(),
      })
      .eq("id", previa.id)
      .eq("organization_id", org.orgId);
    if (error) return fail("internal_error", error.message, 500, { requestId });
  } else {
    const { error } = await supabase.from("automation_rules").insert({
      organization_id: org.orgId,
      created_by_user_id: user.id,
      recipe_key: receta.id,
      name: armada.regla.name,
      trigger_event: armada.regla.trigger_event,
      conditions: armada.regla.conditions,
      actions: armada.regla.actions,
      is_active: activa,
    });
    if (error) return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "automation.rule_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "automation_rule",
    resourceId: previa?.id ?? null,
    requestId,
    metadata: { receta: receta.id, activa },
  });

  return ok({ id: receta.id, activa }, { requestId });
}
