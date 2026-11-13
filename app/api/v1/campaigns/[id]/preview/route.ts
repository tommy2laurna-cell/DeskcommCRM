/**
 * GET /api/v1/campaigns/[id]/preview — el mensaje como lo leerá el contacto, a
 * cuántos llega, cuántos quedan excluidos por baja/sin teléfono y, SOLO si la
 * organización cargó la tarifa, el costo estimado con su fuente.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { mensajeAprobado } from "@/lib/campaigns/cargar";
import { leerTarifa } from "@/lib/campaigns/costo";
import { clienteDeUsuario } from "@/lib/campaigns/http";
import { calcularVistaPrevia, ListaDemasiadoGrande } from "@/lib/campaigns/vista-previa";
import { traduzir } from "@/lib/i18n/dicionario";
import { filtrosDeListaSchema } from "@/lib/smart-lists/resolver";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { id } = await params;

  const db = await clienteDeUsuario();
  const { data: c } = await db
    .from("campaigns")
    .select("list_id, template_name, template_language, template_values")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  const camp = c as {
    list_id: string | null;
    template_name: string;
    template_language: string;
    template_values: Record<string, string>;
  } | null;
  if (!camp) return fail("not_found", t("Campanha não encontrada."), 404, { requestId });
  if (!camp.list_id) return fail("list_missing", t("A lista desta campanha foi apagada."), 422, { requestId });

  const { data: lista } = await db
    .from("smart_lists")
    .select("filters")
    .eq("id", camp.list_id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  const filtros = filtrosDeListaSchema.safeParse((lista as { filters?: unknown } | null)?.filters);
  if (!filtros.success) return fail("invalid_filters", t("Os filtros desta lista são inválidos."), 422, { requestId });

  const mensaje = await mensajeAprobado(db, org.orgId, camp.template_name, camp.template_language);
  if (!mensaje) return fail("template_missing", t("A mensagem não está aprovada pela Meta."), 422, { requestId });

  const { data: orgRow } = await db.from("organizations").select("settings").eq("id", org.orgId).maybeSingle();

  try {
    // La misma membresía que verá el envío: se lee con el cliente de servicio y
    // filtro de org explícito, sin depender de la visibilidad del usuario.
    const admin = createAdminClient() as unknown as SupabaseClient;
    const vista = await calcularVistaPrevia(admin, {
      organizationId: org.orgId,
      filtros: filtros.data,
      mensaje,
      valores: camp.template_values,
      tarifa: leerTarifa((orgRow as { settings?: unknown } | null)?.settings),
    });
    return ok(vista, { requestId });
  } catch (err) {
    if (err instanceof ListaDemasiadoGrande) {
      return fail("list_too_large", t("A lista é grande demais para uma campanha."), 422, { requestId });
    }
    return fail("internal_error", "Erro ao calcular a prévia.", 500, { requestId });
  }
}
