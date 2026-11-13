/**
 * POST /api/v1/campaigns/[id]/confirm — congela los destinatarios y deja la
 * campaña lista para el cron (manager+).
 *
 * Reglas que bloquean la confirmación:
 *   - la sesión tiene que ser de Meta (jamás WAHA);
 *   - el mensaje tiene que seguir aprobado;
 *   - marketing sin botón de baja => 422 «Los mensajes de marketing necesitan un botón de baja».
 *
 * Re-ejecutar es seguro: `unique(campaign_id, contact_id)` + `ignoreDuplicates`.
 * El opt-out NO se decide acá de forma definitiva: el cron lo revalúa antes de
 * cada envío. Acá solo se marca el estado inicial de cada destinatario.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { tieneBotonDeBaja } from "@/lib/campaigns/boton-de-baja";
import { mensajeAprobado, sesionDeMeta } from "@/lib/campaigns/cargar";
import { clasificarContacto } from "@/lib/campaigns/destinatarios";
import { clienteDeUsuario } from "@/lib/campaigns/http";
import { categoriaDelMensaje, ListaDemasiadoGrande, recorrerLista } from "@/lib/campaigns/vista-previa";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { filtrosDeListaSchema } from "@/lib/smart-lists/resolver";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { id } = await params;

  const db = await clienteDeUsuario();
  const { data: c } = await db
    .from("campaigns")
    .select("status, list_id, channel_session_id, template_name, template_language")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  const camp = c as {
    status: string;
    list_id: string | null;
    channel_session_id: string | null;
    template_name: string;
    template_language: string;
  } | null;
  if (!camp) return fail("not_found", t("Campanha não encontrada."), 404, { requestId });
  if (camp.status !== "borrador") {
    return fail("not_draft", t("Só dá para editar uma campanha em rascunho."), 409, { requestId });
  }
  if (!camp.list_id) return fail("list_missing", t("A lista desta campanha foi apagada."), 422, { requestId });
  if (!camp.channel_session_id || !(await sesionDeMeta(db, org.orgId, camp.channel_session_id))) {
    return fail("not_meta_session", t("As campanhas só saem pela API oficial da Meta."), 422, { requestId });
  }

  const mensaje = await mensajeAprobado(db, org.orgId, camp.template_name, camp.template_language);
  if (!mensaje || mensaje.status !== "APPROVED") {
    return fail("template_not_approved", t("A mensagem não está aprovada pela Meta."), 422, { requestId });
  }
  if (categoriaDelMensaje(mensaje.category) === "marketing" && !tieneBotonDeBaja(mensaje.components)) {
    return fail(
      "marketing_needs_opt_out_button",
      t("Mensagens de marketing precisam de um botão de saída"),
      422,
      { requestId },
    );
  }

  const { data: lista } = await db
    .from("smart_lists")
    .select("filters")
    .eq("id", camp.list_id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  const filtros = filtrosDeListaSchema.safeParse((lista as { filters?: unknown } | null)?.filters);
  if (!filtros.success) return fail("invalid_filters", t("Os filtros desta lista são inválidos."), 422, { requestId });

  const admin = createAdminClient() as unknown as SupabaseClient;
  let total = 0;
  let excluidos = 0;
  try {
    await recorrerLista(admin, org.orgId, filtros.data, async (contactos) => {
      const filas = contactos.map((ct) => {
        const v = clasificarContacto(ct);
        total += 1;
        if (v.estado !== "pendiente") excluidos += 1;
        return {
          campaign_id: id,
          organization_id: org.orgId,
          contact_id: ct.id,
          status: v.estado,
          reason: v.estado === "pendiente" ? null : v.motivo,
        };
      });
      const { error } = await admin
        .from("campaign_recipients")
        .upsert(filas, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    });
  } catch (err) {
    if (err instanceof ListaDemasiadoGrande) {
      return fail("list_too_large", t("A lista é grande demais para uma campanha."), 422, { requestId });
    }
    return fail("internal_error", "Erro ao confirmar.", 500, { requestId });
  }

  const { data: confirmada } = await db
    .from("campaigns")
    .update({
      status: "confirmada",
      confirmed_at: new Date().toISOString(),
      confirmed_by_user_id: user.id,
      total_recipients: total,
      total_excluded: excluidos,
    })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .eq("status", "borrador")
    .select("id, status, total_recipients, total_excluded")
    .maybeSingle();
  if (!confirmada) return fail("not_draft", t("Só dá para editar uma campanha em rascunho."), 409, { requestId });

  void audit({
    action: "campaign.confirmed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "campaign",
    resourceId: id,
    requestId,
    metadata: { total, excluidos },
  });
  return ok(confirmada, { requestId });
}
