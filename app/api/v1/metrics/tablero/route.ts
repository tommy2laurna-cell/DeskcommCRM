/**
 * GET /api/v1/metrics/tablero?periodo=7|30|90&owner_user_id=
 * Alcance = la RLS (fn_tablero_metrics es SECURITY INVOKER): un vendedor queda
 * limitado a sus leads (owner = él), gerente y dueño ven todo. Un vendedor además queda forzado a su propio id.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { cargarTablero } from "@/lib/reports/tablero.server";
import { ventanaDelPeriodo } from "@/lib/reports/tablero";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const w = ventanaDelPeriodo(url.searchParams.get("periodo"));
  const pedido = url.searchParams.get("owner_user_id");
  if (pedido && !/^[0-9a-f-]{36}$/i.test(pedido)) {
    return fail("validation_failed", "owner_user_id inválido.", 422, { requestId });
  }
  const verTodo = roleAtLeast(authz.org.role, "manager");
  const owner = verTodo ? pedido : authz.user.id;

  const r = await cargarTablero(authz.org.orgId, w.from, w.to, owner);
  if (!r.ok) return fail("internal_error", r.error, 500, { requestId });
  return ok(
    { window: { from: w.from.toISOString(), to: w.to.toISOString(), periodo: w.periodo }, ...r.datos },
    { requestId },
  );
}
