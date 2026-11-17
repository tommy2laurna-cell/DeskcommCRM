/**
 * PUT    /api/v1/captar/formularios/[id] — reemplaza la definición.
 * DELETE /api/v1/captar/formularios/[id] — borra el formulario y apaga su fuente.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { definicionSchema } from "@/lib/captar/formulario";
import { actualizarFormulario, borrarFormulario } from "@/lib/captar/guardar";
import { requireSupportWrite } from "@/lib/impersonate/support";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function depsDe(requestId: string): Promise<{ deps: DepsDaOperacao } | { response: Response }> {
  const authz = await requireRole("manager", { requestId, resource: "capture_forms" });
  if (!authz.ok) return { response: authz.response };
  return {
    deps: {
      supabase: await createClient(),
      organizationId: authz.org.orgId,
      actor: { type: "user", id: authz.user.id, role: authz.org.role },
      requestId,
    },
  };
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<Response> {
  const denegado = await requireSupportWrite();
  if (denegado) return denegado;
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return fail("not_found", "formulario_inexistente", 404, { requestId });
  const r = await depsDe(requestId);
  if ("response" in r) return r.response;

  const parsed = definicionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail("invalid_request", "definicion_invalida", 400, { requestId, details: parsed.error.flatten() });
  }
  try {
    return ok(await actualizarFormulario(r.deps, id, parsed.data), { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const denegado = await requireSupportWrite();
  if (denegado) return denegado;
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return fail("not_found", "formulario_inexistente", 404, { requestId });
  const r = await depsDe(requestId);
  if ("response" in r) return r.response;
  try {
    await borrarFormulario(r.deps, id);
    return ok({ borrado: true }, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
