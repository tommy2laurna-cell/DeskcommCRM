/**
 * GET  /api/v1/captar/formularios — los formularios y encuestas de la org activa.
 * POST /api/v1/captar/formularios — crea uno (y su fuente de captación interna).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { definicionSchema } from "@/lib/captar/formulario";
import { crearFormulario, listarFormularios } from "@/lib/captar/guardar";
import { requireSupportWrite } from "@/lib/impersonate/support";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "capture_forms" });
  if (!authz.ok) return authz.response;
  const deps: DepsDaOperacao = {
    supabase: await createClient(),
    organizationId: authz.org.orgId,
    actor: { type: "user", id: authz.user.id, role: authz.org.role },
    requestId,
  };
  try {
    return ok(await listarFormularios(deps), { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const denegado = await requireSupportWrite();
  if (denegado) return denegado;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "capture_forms" });
  if (!authz.ok) return authz.response;

  const parsed = definicionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail("invalid_request", "definicion_invalida", 400, { requestId, details: parsed.error.flatten() });
  }
  const deps: DepsDaOperacao = {
    supabase: await createClient(),
    organizationId: authz.org.orgId,
    actor: { type: "user", id: authz.user.id, role: authz.org.role },
    requestId,
  };
  try {
    return ok(await crearFormulario(deps, parsed.data), { requestId, status: 201 });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
