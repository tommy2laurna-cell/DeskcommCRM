/**
 * POST /api/v1/campaigns/[id]/cancel — corta una campaña confirmada o en curso
 * (manager+). Lo ya enviado queda; lo pendiente no sale (el cron solo toma
 * campañas `confirmada`/`enviando`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { SupabaseClient } from "@supabase/supabase-js";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
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

  // Transición de estado: la hace el servidor; el rol manager ya lo exigió requireRole.
  const db = createAdminClient() as unknown as SupabaseClient;
  const { data } = await db
    .from("campaigns")
    .update({ status: "cancelada" })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .in("status", ["borrador", "confirmada", "enviando"])
    .select("id, status")
    .maybeSingle();
  if (!data) return fail("not_cancellable", t("Esta campanha não pode ser cancelada."), 409, { requestId });

  void audit({
    action: "campaign.cancelled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "campaign",
    resourceId: id,
    requestId,
  });
  return ok(data, { requestId });
}
