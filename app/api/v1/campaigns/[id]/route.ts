/**
 * GET    /api/v1/campaigns/[id] — la campaña y sus totales (agent+).
 * PATCH  /api/v1/campaigns/[id] — edita un BORRADOR (manager+).
 * DELETE /api/v1/campaigns/[id] — borra un BORRADOR (manager+).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, noContent, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { CAMPAIGN_COLS, mensajeAprobado } from "@/lib/campaigns/cargar";
import { sesionOficialDeMeta } from "@/lib/channels/sesion-oficial";
import { clienteDeUsuario } from "@/lib/campaigns/http";
import { updateCampaignSchema } from "@/lib/campaigns/schemas";
import { categoriaDelMensaje } from "@/lib/campaigns/vista-previa";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const db = await clienteDeUsuario();
  const { data } = await db
    .from("campaigns")
    .select(CAMPAIGN_COLS)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!data) return fail("not_found", t("Campanha não encontrada."), 404, { requestId });
  return ok(data, { requestId });
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { id } = await params;

  const parsed = updateCampaignSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten() as unknown as Record<string, unknown>,
    });
  }
  const db = await clienteDeUsuario();
  const { data: actual } = await db
    .from("campaigns")
    .select("status, channel_session_id, template_name, template_language")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  const a = actual as {
    status: string;
    channel_session_id: string;
    template_name: string;
    template_language: string;
  } | null;
  if (!a) return fail("not_found", t("Campanha não encontrada."), 404, { requestId });
  if (a.status !== "borrador") {
    return fail("not_draft", t("Só dá para editar uma campanha em rascunho."), 409, { requestId });
  }

  const cambios: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.channel_session_id) {
    if (!(await sesionOficialDeMeta(db, org.orgId, parsed.data.channel_session_id))) {
      return fail("not_meta_session", t("As campanhas só saem pela API oficial da Meta."), 422, {
        requestId,
      });
    }
  }
  if (parsed.data.template_name || parsed.data.template_language) {
    const m = await mensajeAprobado(
      db,
      org.orgId,
      parsed.data.template_name ?? a.template_name,
      parsed.data.template_language ?? a.template_language,
    );
    if (!m || m.status !== "APPROVED") {
      return fail("template_not_approved", t("A mensagem não está aprovada pela Meta."), 422, {
        requestId,
      });
    }
    cambios.template_category = categoriaDelMensaje(m.category);
  }

  const { data, error } = await db
    .from("campaigns")
    .update(cambios)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .eq("status", "borrador")
    .select(CAMPAIGN_COLS)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao atualizar.", 500, { requestId });
  if (!data) return fail("not_draft", t("Só dá para editar uma campanha em rascunho."), 409, { requestId });

  void audit({
    action: "campaign.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "campaign",
    resourceId: id,
    requestId,
    metadata: { campos: Object.keys(parsed.data) },
  });
  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { id } = await params;

  const db = await clienteDeUsuario();
  const { data, error } = await db
    .from("campaigns")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .eq("status", "borrador")
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao apagar.", 500, { requestId });
  if (!data) return fail("not_draft", t("Só dá para editar uma campanha em rascunho."), 409, { requestId });

  void audit({
    action: "campaign.deleted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "campaign",
    resourceId: id,
    requestId,
  });
  return noContent();
}
