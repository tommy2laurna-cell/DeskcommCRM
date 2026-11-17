import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/presupuestos — emite un presupuesto desde un negocio.
 * GET  /api/v1/leads/[id]/presupuestos — los presupuestos de ese negocio.
 *
 * Los precios salen SIEMPRE del catálogo de la organización, nunca del cuerpo:
 * el cliente de la API manda `producto_id` y `cantidad`, y el servidor pone el
 * precio y la descripción que tiene el producto ahora (que quedan congelados en
 * el presupuesto). Si el cuerpo pudiera traer el precio, un presupuesto sería
 * una forma de prometer cualquier número con el sello de la empresa.
 *
 * La moneda es la de la organización (ARS por defecto). Un producto cargado en
 * otra moneda se rechaza en vez de convertirse: no hay tipo de cambio acá.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { traduzir } from "@/lib/i18n/dicionario";
import { calcularTotales, hoyEnZona, presupuestoCreateSchema } from "@/lib/presupuestos/calculo";
import { validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUMNAS = "id, lead_id, numero, estado, moneda, subtotal_cents, descuento_pct, descuento_cents, total_cents, valido_hasta, notas, created_at, accepted_at, recibo_emitido_at, recibo_medio";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;
  const authz = await requireRole("viewer", { requestId, resource: "presupuestos" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("presupuestos")
    .select(`${COLUMNAS}, presupuesto_items(id, descripcion, cantidad, precio_unit_cents, total_cents, position)`)
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .order("numero", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "presupuestos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  let input;
  try {
    input = await validateRequest(presupuestoCreateSchema, req);
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

  const { data: lead } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!lead) return fail("not_found", t("Negocio no encontrado."), 404, { requestId });

  const { data: org } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", orgId)
    .maybeSingle();
  const zona = (org as { timezone?: string | null } | null)?.timezone ?? "America/Argentina/Buenos_Aires";
  if (input.valido_hasta < hoyEnZona(zona)) {
    return fail("validation_error", t("La fecha de validez ya pasó."), 422, { requestId });
  }

  const moneda = await moedaDaOrganizacao(supabase, orgId);
  const ids = [...new Set(input.items.map((i) => i.producto_id))];
  const { data: productos, error: prodErr } = await supabase
    .from("catalog_products")
    .select("id, nome, preco_cents, moeda, ativo")
    .eq("organization_id", orgId)
    .in("id", ids);
  if (prodErr) return fail("internal_error", prodErr.message, 500, { requestId });

  const porId = new Map(
    ((productos ?? []) as unknown as Array<{
      id: string;
      nome: string;
      preco_cents: number;
      moeda: string;
      ativo: boolean;
    }>).map((p) => [p.id, p]),
  );
  for (const id of ids) {
    const p = porId.get(id);
    if (!p || !p.ativo) {
      return fail("producto_no_disponible", t("Un producto no existe o está inactivo."), 422, { requestId });
    }
    if (p.moeda !== moneda) {
      return fail(
        "moneda_distinta",
        t("Un producto está en otra moneda que la de la organización."),
        422,
        { requestId },
      );
    }
  }

  const lineas = input.items.map((i) => {
    const p = porId.get(i.producto_id)!;
    return {
      producto_id: p.id,
      descripcion: p.nome,
      cantidad: i.cantidad,
      precio_unit_cents: p.preco_cents,
    };
  });

  const { data: creado, error: rpcErr } = await supabase.rpc("fn_crear_presupuesto", {
    p_organization_id: orgId,
    p_lead_id: leadId,
    p_moneda: moneda,
    p_descuento_pct: input.descuento_pct,
    p_valido_hasta: input.valido_hasta,
    p_notas: input.notas ?? null,
    p_items: lineas,
  });
  if (rpcErr) {
    if (rpcErr.message.includes("lead_no_encontrado")) {
      return fail("not_found", t("Negocio no encontrado."), 404, { requestId });
    }
    return fail("internal_error", rpcErr.message, 500, { requestId });
  }

  // La base es la fuente de la cifra; esta cuenta es el contrato que el PDF y la
  // pantalla comparten. Si alguna vez divergen, que se vea en el log y no en la
  // factura de un cliente.
  const esperado = calcularTotales(
    lineas.map((l) => ({ cantidad: l.cantidad, precioUnitCents: l.precio_unit_cents })),
    input.descuento_pct,
  );
  const fila = creado as unknown as { id: string; total_cents: number };
  if (Number(fila.total_cents) !== esperado.totalCents) {
    console.error("[presupuestos] total de la base distinto del calculado", {
      id: fila.id,
      base: fila.total_cents,
      calculado: esperado.totalCents,
    });
  }

  void audit({
    action: "presupuesto.created",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "presupuesto",
    resourceId: fila.id,
    requestId,
    metadata: { lead_id: leadId, total_cents: fila.total_cents, moneda },
  });

  return ok(creado, { status: 201, requestId });
}
