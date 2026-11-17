/**
 * GET /api/v1/reports/referrals — quién trae más clientes (manager+).
 * Read-only => sin audit. Cliente de sesión: la RLS de `contacts`/`crm_leads`
 * recorta además del filtro explícito por organización.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { cargarReferidos } from "@/lib/reports/referidos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "reports_referrals" });
  if (!authz.ok) return authz.response;

  try {
    const { filas, truncado } = await cargarReferidos(await createClient(), authz.org.orgId);
    return ok({ filas, truncado }, { requestId });
  } catch {
    return fail("internal_error", "Erro ao carregar indicações.", 500, { requestId });
  }
}
