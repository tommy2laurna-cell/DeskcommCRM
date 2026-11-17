import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/presupuestos/[id]/recibo — registra el cobro y habilita el recibo.
 *
 * El CRM no cobra (decisión del 10/11): esto solo deja asentado que el cliente
 * pagó POR FUERA (efectivo, transferencia…) y con qué medio. El PDF sale por
 * `GET /api/v1/presupuestos/[id]/pdf?tipo=recibo` y lleva la leyenda
 * «Comprobante no válido como factura». Nada de facturación fiscal.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const reciboSchema = z.object({ medio: z.string().trim().min(1).max(60) });

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "presupuestos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let input;
  try {
    input = await validateRequest(reciboSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();
  const { data: p } = await supabase
    .from("presupuestos")
    .select("id, estado, recibo_emitido_at")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!p) return fail("not_found", t("Presupuesto no encontrado."), 404, { requestId });
  if (p.estado !== "aceptado") {
    return fail("no_aceptado", t("El recibo se emite sobre un presupuesto aceptado."), 409, { requestId });
  }
  if (p.recibo_emitido_at) {
    return fail("recibo_ya_emitido", t("Este presupuesto ya tiene recibo."), 409, { requestId });
  }

  // `is null` en el WHERE: dos personas registrando el cobro a la vez no pisan el
  // medio de la primera.
  const { data: upd, error } = await supabase
    .from("presupuestos")
    .update({ recibo_emitido_at: new Date().toISOString(), recibo_medio: input.medio })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .is("recibo_emitido_at", null)
    .select("id, recibo_emitido_at, recibo_medio")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!upd) return fail("recibo_ya_emitido", t("Este presupuesto ya tiene recibo."), 409, { requestId });

  void audit({
    action: "presupuesto.recibo_issued",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "presupuesto",
    resourceId: id,
    requestId,
    metadata: { medio: input.medio },
  });

  return ok(upd, { status: 201, requestId });
}
