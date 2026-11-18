import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/settings/puntaje — las reglas del puntaje de prioridad (viewer+).
 * PATCH /api/v1/settings/puntaje — las guarda (manager+).
 *
 * Viven en `organizations.settings.puntaje` (jsonb), igual que `routing`: no hay
 * tabla nueva porque son pocas reglas, se leen enteras y nunca se consultan por
 * separado. Leerlas es de todo el equipo (el tablero las necesita para calcular);
 * cambiarlas es de manager+, porque cambia quién aparece primero para todos.
 *
 * La escritura va por el cliente admin por la misma razón que en `routing`: la
 * única policy de escritura de `organizations` es de platform admin, y por el
 * cliente de sesión el UPDATE de un manager casaría cero filas y "guardaría" sin
 * guardar. El gate es el de arriba y el filtro por `organization_id` es explícito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { reglasDeLaOrganizacion, reglasDePuntajeSchema } from "@/lib/puntaje/reglas";
import { validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "settings_puntaje" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(reglasDeLaOrganizacion(data?.settings), { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_puntaje" });
  if (!authz.ok) return authz.response;

  let reglas;
  try {
    reglas = await validateRequest(reglasDePuntajeSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const admin = createAdminClient();
  const { data: fila, error: readErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const actuales = (fila?.settings as Record<string, unknown> | null) ?? {};
  const { error: updErr } = await admin
    .from("organizations")
    .update({ settings: { ...actuales, puntaje: reglas } })
    .eq("id", authz.org.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "puntaje.config_changed",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { reglas },
  });

  return ok(reglas, { requestId });
}
