/**
 * GET /api/v1/smart-lists/[id]/contacts?despues=<uuid>&limite=50 — contactos que
 * cumplen hoy los filtros de la lista, paginados por keyset (`id > despues`).
 *
 * La URL no crece con la lista: no hay `.in()` de ids. `meta.cursor` es el
 * `despues` de la página siguiente; el total solo se calcula en la primera.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { clienteDeUsuario } from "@/lib/campaigns/http";
import { paginaSchema } from "@/lib/campaigns/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { filtrosDeListaSchema, leerPaginaDeLista } from "@/lib/smart-lists/resolver";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "smart_lists" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { id } = await params;

  const q = paginaSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!q.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  const db = await clienteDeUsuario();
  const { data: lista } = await db
    .from("smart_lists")
    .select("filters")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!lista) return fail("not_found", t("Lista não encontrada."), 404, { requestId });

  const filtros = filtrosDeListaSchema.safeParse((lista as { filters: unknown }).filters);
  if (!filtros.success) {
    return fail("invalid_filters", t("Os filtros desta lista são inválidos."), 422, { requestId });
  }

  try {
    const pagina = await leerPaginaDeLista(db, org.orgId, filtros.data, {
      despues: q.data.despues ?? null,
      limite: q.data.limite,
      contar: !q.data.despues,
    });
    return ok(pagina.contactos, {
      requestId,
      meta: {
        cursor: pagina.siguiente,
        has_more: pagina.siguiente !== null,
        ...(pagina.total !== null ? { total: pagina.total } : {}),
      },
    });
  } catch {
    return fail("internal_error", "Erro ao ler a lista.", 500, { requestId });
  }
}
