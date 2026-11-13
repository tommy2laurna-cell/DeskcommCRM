/**
 * GET  /api/v1/smart-lists — listas inteligentes de la organización (agent+).
 * POST /api/v1/smart-lists — crea una lista: nombre + filtros validados con Zod (manager+).
 *
 * La lista guarda los FILTROS; los contactos se calculan al leer
 * (`GET /api/v1/smart-lists/:id/contacts`). Ver `lib/smart-lists/resolver.ts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { clienteDeUsuario, crearIdempotente } from "@/lib/campaigns/http";
import { createSmartListSchema } from "@/lib/campaigns/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
const COLS = "id, organization_id, name, filters, created_by_user_id, created_at, updated_at";
const ENDPOINT = "/api/v1/smart-lists";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "smart_lists" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const db = await clienteDeUsuario();
  const { data, error } = await db
    .from("smart_lists")
    .select(COLS)
    .eq("organization_id", org.orgId)
    .order("name", { ascending: true });
  if (error) return fail("internal_error", "Erro ao listar.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "smart_lists" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const parsed = createSmartListSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten() as unknown as Record<string, unknown>,
    });
  }

  const db = await clienteDeUsuario();
  return crearIdempotente({
    req,
    db,
    organizationId: org.orgId,
    endpoint: ENDPOINT,
    corpo: parsed.data,
    requestId,
    idioma: user.idioma,
    crear: async () => {
      const { data, error } = await db
        .from("smart_lists")
        .insert({
          organization_id: org.orgId,
          name: parsed.data.name,
          filters: parsed.data.filters,
          created_by_user_id: user.id,
        })
        .select(COLS)
        .single();
      if (error || !data) throw error ?? new Error("insert_failed");
      void audit({
        action: "smart_list.created",
        actorUserId: user.id,
        organizationId: org.orgId,
        resourceType: "smart_list",
        resourceId: data.id as string,
        requestId,
        metadata: { name: parsed.data.name },
      });
      return data;
    },
  });
}
