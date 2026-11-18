/**
 * GET /api/v1/campaigns/tarifa — la tarifa de Meta cargada (agent+), o `null`.
 * PUT /api/v1/campaigns/tarifa — la carga (admin). `null` la borra.
 *
 * NO hay tarifa por defecto: sin ella la pantalla no muestra ninguna cifra.
 * Fuente oficial: FUENTE_OFICIAL_DE_TARIFAS (rate cards descargables por país).
 * Escribe con `fn_set_campaign_tarifa` (un UPDATE atómico del jsonb).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { FUENTE_OFICIAL_DE_TARIFAS, leerTarifa, tarifaSchema } from "@/lib/campaigns/costo";
import { clienteDeUsuario } from "@/lib/campaigns/http";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;

  const db = await clienteDeUsuario();
  const { data } = await db.from("organizations").select("settings").eq("id", authz.org.orgId).maybeSingle();
  return ok(
    {
      tarifa: leerTarifa((data as { settings?: unknown } | null)?.settings),
      fuente_oficial: FUENTE_OFICIAL_DE_TARIFAS,
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const parsed = z.object({ tarifa: tarifaSchema.nullable() }).strict().safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten() as unknown as Record<string, unknown>,
    });
  }

  // Solo service_role ejecuta la función; el admin ya lo exigió requireRole arriba y
  // `org.orgId` sale de la sesión, nunca del body.
  const admin = createAdminClient();
  const { error } = await admin.rpc("fn_set_campaign_tarifa" as never, {
    p_org: org.orgId,
    p_tarifa: parsed.data.tarifa,
  } as never);
  if (error) return fail("internal_error", "Erro ao guardar a tarifa.", 500, { requestId });

  void audit({
    action: "campaign.tarifa_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
    metadata: { removida: parsed.data.tarifa === null },
  });
  return ok({ tarifa: parsed.data.tarifa }, { requestId });
}
