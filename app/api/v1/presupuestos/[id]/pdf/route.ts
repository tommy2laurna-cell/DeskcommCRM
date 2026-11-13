/**
 * GET /api/v1/presupuestos/[id]/pdf            — el presupuesto, con la marca del cliente.
 * GET /api/v1/presupuestos/[id]/pdf?tipo=recibo — el recibo («Comprobante no válido
 *                                                 como factura»); solo si ya se registró el cobro.
 *
 * Se arma en el servidor con `@react-pdf` (nada de HTML → PDF en el navegador).
 * La marca sale de `marcaDaSaida(organización)`: nombre, logo y color del CLIENTE.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { marcaDaSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  logoParaPdf,
  renderPresupuestoPdf,
  renderReciboPdf,
  type DatosDelDocumento,
} from "@/lib/presupuestos/pdf";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fecha(iso: string, zona: string): string {
  // `valido_hasta` es una fecha sin hora: se formatea como UTC para que la zona
  // no la corra un día. Los timestamps sí van en la zona de la organización.
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: soloFecha ? "UTC" : zona,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(soloFecha ? `${iso}T00:00:00Z` : iso));
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("viewer", { requestId, resource: "presupuestos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const tipo = req.nextUrl.searchParams.get("tipo") === "recibo" ? "recibo" : "presupuesto";

  const supabase = await createClient();
  const { data: p } = await supabase
    .from("presupuestos")
    .select(
      "id, lead_id, numero, estado, moneda, subtotal_cents, descuento_pct, descuento_cents, total_cents, valido_hasta, notas, created_at, recibo_emitido_at, recibo_medio",
    )
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!p) return fail("not_found", t("Presupuesto no encontrado."), 404, { requestId });
  if (tipo === "recibo" && !p.recibo_emitido_at) {
    return fail("sin_recibo", t("Todavía no se registró el cobro de este presupuesto."), 409, { requestId });
  }

  const [{ data: items }, { data: lead }, { data: org }] = await Promise.all([
    supabase
      .from("presupuesto_items")
      .select("descripcion, cantidad, precio_unit_cents, total_cents, position")
      .eq("presupuesto_id", id)
      .order("position"),
    supabase.from("crm_leads").select("title, contact_id").eq("id", p.lead_id).maybeSingle(),
    supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle(),
  ]);
  const zona = (org as { timezone?: string | null } | null)?.timezone ?? "America/Argentina/Buenos_Aires";

  let clienteNombre: string | null = null;
  const contactId = (lead as { contact_id?: string | null } | null)?.contact_id;
  if (contactId) {
    const { data: c } = await supabase
      .from("contacts")
      .select("display_name")
      .eq("id", contactId)
      .maybeSingle();
    clienteNombre = (c as { display_name?: string | null } | null)?.display_name ?? null;
  }
  clienteNombre ??= (lead as { title?: string } | null)?.title ?? null;

  const marca = await marcaDaSaida(orgId);
  const datos: DatosDelDocumento = {
    marca: { nome: marca.nome, accent: marca.accent, accentFg: marca.accentFg },
    logoDataUri: await logoParaPdf(marca.logoUrl),
    numero: p.numero,
    moneda: p.moneda,
    clienteNombre,
    fechaEmision: fecha(p.created_at, zona),
    validoHasta: fecha(p.valido_hasta, zona),
    lineas: (items ?? []).map((i) => ({
      descripcion: i.descripcion,
      cantidad: i.cantidad,
      precioUnitCents: Number(i.precio_unit_cents),
      totalCents: Number(i.total_cents),
    })),
    subtotalCents: Number(p.subtotal_cents),
    descuentoPct: Number(p.descuento_pct),
    descuentoCents: Number(p.descuento_cents),
    totalCents: Number(p.total_cents),
    notas: p.notas,
  };

  const numero = String(p.numero).padStart(4, "0");
  const pdf =
    tipo === "recibo"
      ? await renderReciboPdf({
          ...datos,
          medio: p.recibo_medio ?? "",
          fechaDePago: fecha(p.recibo_emitido_at as string, zona),
        })
      : await renderPresupuestoPdf(datos);

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${tipo === "recibo" ? "recibo" : "presupuesto"}-${numero}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Request-Id": requestId,
    },
  });
}
