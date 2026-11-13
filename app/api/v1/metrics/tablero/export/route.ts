/** GET /api/v1/metrics/tablero/export?periodo= — CSV con «;» (Excel argentino). Mismo alcance que el tablero. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK } from "@/lib/auth/types";
import { cargarTablero } from "@/lib/reports/tablero.server";
import { tableroACsv, ventanaDelPeriodo } from "@/lib/reports/tablero";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const w = ventanaDelPeriodo(new URL(req.url).searchParams.get("periodo"));
  const owner = ROLE_RANK[authz.org.role] >= ROLE_RANK.manager ? null : authz.user.id;
  const r = await cargarTablero(authz.org.orgId, w.from, w.to, owner);
  if (!r.ok) return fail("internal_error", r.error, 500, { requestId });
  return new Response(tableroACsv(r.datos, w.periodo), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="tablero-${w.periodo}d.csv"`,
      "cache-control": "no-store",
    },
  });
}
