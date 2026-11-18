/**
 * GET    /api/v1/smart-lists/[id] — una lista (agent+).
 * PATCH  /api/v1/smart-lists/[id] — cambia nombre y/o filtros (manager+).
 * DELETE /api/v1/smart-lists/[id] — borra la lista (manager+). Las campañas ya
 *        confirmadas siguen: sus destinatarios están materializados.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, noContent, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { clienteDeUsuario } from "@/lib/campaigns/http";
import { updateSmartListSchema } from "@/lib/campaigns/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
const COLS = "id, organization_id, name, filters, created_by_user_id, created_at, updated_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "smart_lists" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const db = await clienteDeUsuario();
  const { data } = await db
    .from("smart_lists")
    .select(COLS)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!data) return fail("not_found", t("Lista não encontrada."), 404, { requestId });
  return ok(data, { requestId });
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "smart_lists" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { id } = await params;

  const parsed = updateSmartListSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten() as unknown as Record<string, unknown>,
    });
  }

  const db = await clienteDeUsuario();
  const { data, error } = await db
    .from("smart_lists")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(COLS)
    .maybeSingle();
  if (error?.code === "23505") {
    return fail("conflict", t("Já existe um registro com esse nome."), 409, { requestId });
  }
  if (error) return fail("internal_error", "Erro ao atualizar.", 500, { requestId });
  if (!data) return fail("not_found", t("Lista não encontrada."), 404, { requestId });

  void audit({
    action: "smart_list.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "smart_list",
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
  const authz = await requireRole("manager", { requestId, resource: "smart_lists" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { id } = await params;

  const db = await clienteDeUsuario();
  const { data, error } = await db
    .from("smart_lists")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao apagar.", 500, { requestId });
  if (!data) return fail("not_found", t("Lista não encontrada."), 404, { requestId });

  void audit({
    action: "smart_list.deleted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "smart_list",
    resourceId: id,
    requestId,
  });
  return noContent();
}
