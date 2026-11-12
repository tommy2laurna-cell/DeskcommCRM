import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/prospectos — entrada de prospectos desde una automatización (n8n).
 *
 * Auth: token de API del cliente (`Authorization: Bearer dsk_…`, scope
 * `mcp:write`) o sesión de navegador, vía `resolveAuthDual`. La organización
 * sale de la fila del token, nunca del cuerpo.
 *
 * Idempotente por `id_externo`: la misma llamada dos veces deja un contacto y
 * un lead. 201 si fue alta, 200 si fue actualización. Límite: 60 llamadas por
 * minuto por token.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { ingresarProspecto } from "@/lib/leads/entrada-de-prospectos";
import { prospectoSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const LIMITE_POR_MINUTO = 60;

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;

  const rl = await checkRateLimit(`prospectos:${authz.actor.id}`, LIMITE_POR_MINUTO, 60);
  if (!rl.allowed) {
    return fail("rate_limited", "Demasiadas llamadas. Reintentá en un minuto.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  let input;
  try {
    input = await validateRequest(prospectoSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const r = await ingresarProspecto(
      createAdminClient(),
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      input,
    );
    return ok(r, { requestId, status: r.accion === "alta" ? 201 : 200 });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
