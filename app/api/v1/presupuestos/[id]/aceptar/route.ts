import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/presupuestos/[id]/aceptar — registra que el cliente aceptó.
 *
 * Lo dispara quien atiende (no hay link público: el presupuesto es un PDF que se
 * manda por el chat). La lógica y su porqué están en `lib/presupuestos/aceptar.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { aceptarPresupuesto, repoSupabase } from "@/lib/presupuestos/aceptar";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "presupuestos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  let r;
  try {
    r = await aceptarPresupuesto(repoSupabase(supabase, authz.org.orgId), {
      presupuestoId: id,
      userId: authz.user.id,
    });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "error", 500, { requestId });
  }

  if (!r.ok) {
    const mensajes = {
      no_encontrado: "Presupuesto no encontrado.",
      rechazado: "Este presupuesto fue rechazado y no se puede aceptar.",
      vencido: "Este presupuesto está vencido. Emití uno nuevo.",
    } as const;
    return fail(r.codigo, t(mensajes[r.codigo]), r.status, { requestId });
  }

  if (!r.yaAceptado) {
    void audit({
      action: "presupuesto.accepted",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "presupuesto",
      resourceId: id,
      requestId,
      metadata: { movio_a_etapa: r.movioAEtapa, tarea_para: r.tareaPara },
    });
  }

  return ok(r, { requestId });
}
