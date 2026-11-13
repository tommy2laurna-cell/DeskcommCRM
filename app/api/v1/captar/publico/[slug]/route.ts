/**
 * POST /api/v1/captar/publico/[slug] — el envío de un formulario o encuesta
 * público. SIN sesión: la organización sale del `slug` (nunca del body).
 *
 * No crea contacto ni lead por su cuenta: valida (campos + consentimiento +
 * antispam) y se lo pasa a la captación de siempre
 * (`/api/v1/webhooks/in/[token]`), que ya sabe deduplicar por teléfono, crear
 * el lead en la etapa de la fuente y dejar el historial con UTM e IP. Después
 * solo agrega lo propio del formulario: etiquetas, origen y formulario en la
 * ficha.
 */
import { randomUUID } from "node:crypto";
import { NextRequest, type NextResponse } from "next/server";

import { POST as capturar } from "@/app/api/v1/webhooks/in/[token]/route";
import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { senueloCompleto, pasaElLimitePorIp } from "@/lib/captar/antispam";
import {
  campoSchema,
  payloadDelEnvio,
  validarEnvio,
  type Campo,
  type EnvioCrudo,
} from "@/lib/captar/formulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 20_000;
const MENSAJE_POR_DEFECTO = "¡Gracias! Recibimos tus datos y te escribimos pronto.";

interface Ctx {
  params: Promise<{ slug: string }>;
}

/** Las cabeceras que la captación lee para el historial (IP, página, navegador). */
function cabecerasParaLaCaptacion(req: NextRequest): Headers {
  const h = new Headers({ "content-type": "application/json" });
  for (const k of ["x-forwarded-for", "x-real-ip", "user-agent", "origin", "referer"]) {
    const v = req.headers.get(k);
    if (v) h.set(k, v);
  }
  return h;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse | Response> {
  const requestId = randomUUID();
  const { slug } = await ctx.params;
  if (!/^[a-z0-9]{8,32}$/.test(slug)) return fail("not_found", "formulario_inexistente", 404, { requestId });

  if (!(await pasaElLimitePorIp(req.headers))) {
    return fail("rate_limited", "demasiados_envios", 429, { requestId, headers: { "Retry-After": "60" } });
  }

  const texto = await req.text();
  if (texto.length > MAX_BYTES) return fail("invalid_request", "envio_demasiado_grande", 413, { requestId });
  let cuerpo: unknown;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    return fail("invalid_request", "json_invalido", 400, { requestId });
  }

  // Señuelo completo = bot. Se le contesta que salió bien y no se guarda nada.
  if (senueloCompleto(cuerpo)) return ok({ enviado: true, mensaje: MENSAJE_POR_DEFECTO }, { requestId });

  const admin = createAdminClient();
  const { data: form } = await admin
    .from("capture_forms")
    .select("id, organization_id, name, fields, tags, thanks_message, consent_text, is_active, webhook_source_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!form || !form.is_active || !form.webhook_source_id) {
    return fail("not_found", "formulario_inexistente", 404, { requestId });
  }

  const campos = campoSchema.array().safeParse(form.fields);
  if (!campos.success) return fail("internal_error", "definicion_invalida", 500, { requestId });

  const validado = validarEnvio(campos.data as Campo[], cuerpo as EnvioCrudo);
  if (!validado.ok) return fail("invalid_request", "envio_invalido", 400, { requestId, details: validado.errores });

  const { data: fuente } = await admin
    .from("webhook_sources")
    .select("path_token")
    .eq("id", form.webhook_source_id)
    .eq("organization_id", form.organization_id)
    .maybeSingle();
  if (!fuente?.path_token) return fail("not_found", "formulario_inexistente", 404, { requestId });

  const ahora = new Date();
  const payload = payloadDelEnvio(
    { name: form.name as string, fields: campos.data as Campo[], consent_text: (form.consent_text as string) ?? "" },
    validado.respuestas,
    validado.utm,
    ahora,
  );

  const token = fuente.path_token as string;
  const reenvio = new NextRequest(new URL(`/api/v1/webhooks/in/${token}`, req.url), {
    method: "POST",
    headers: cabecerasParaLaCaptacion(req),
    body: JSON.stringify(payload),
  });
  const respuesta = await capturar(reenvio, { params: Promise.resolve({ token }) });
  if (!respuesta.ok) {
    logger.warn("[captar.publico] la captación recusó el envío", { formId: form.id, status: respuesta.status });
    return fail("internal_error", "no_se_pudo_guardar", 502, { requestId });
  }
  const dato = (await respuesta.json().catch(() => null)) as { data?: { lead_id?: string } } | null;
  const leadId = dato?.data?.lead_id;
  if (leadId) {
    await marcarOrigen(admin, {
      organizationId: form.organization_id as string,
      leadId,
      formId: form.id as string,
      formName: form.name as string,
      sourceId: form.webhook_source_id as string,
      tags: (form.tags as string[]) ?? [],
      consentimientoEn: ahora.toISOString(),
    });
  }

  const mensaje = ((form.thanks_message as string) || MENSAJE_POR_DEFECTO).slice(0, 500);
  return ok({ enviado: true, mensaje }, { requestId, status: 201 });
}

interface Marca {
  organizationId: string;
  leadId: string;
  formId: string;
  formName: string;
  sourceId: string;
  tags: string[];
  consentimientoEn: string;
}

type Admin = ReturnType<typeof createAdminClient>;

function unir(a: string[] | null | undefined, b: string[]): string[] {
  return Array.from(new Set([...(a ?? []), ...b]));
}

/**
 * Lo propio del formulario, después de que la captación hizo su trabajo:
 * etiquetas en el lead y el contacto; y, SOLO si el contacto nació con este
 * envío (la captación lo dejó con `source = webhook` de esta misma fuente),
 * su origen pasa a «formulario». Quien ya existía conserva el origen con el
 * que llegó: el primer contacto no se pisa.
 */
async function marcarOrigen(admin: Admin, m: Marca): Promise<void> {
  try {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("id, contact_id, tags, source_metadata")
      .eq("id", m.leadId)
      .eq("organization_id", m.organizationId)
      .maybeSingle();
    if (!lead) return;

    const datosDelFormulario = { formulario_id: m.formId, formulario_nombre: m.formName };
    await admin
      .from("crm_leads")
      .update({
        tags: unir(lead.tags as string[], m.tags),
        source_metadata: { ...((lead.source_metadata as Record<string, unknown>) ?? {}), ...datosDelFormulario },
      })
      .eq("id", m.leadId)
      .eq("organization_id", m.organizationId);

    const contactId = lead.contact_id as string | null;
    if (!contactId) return;
    const { data: contacto } = await admin
      .from("contacts")
      .select("id, source, source_metadata, tags")
      .eq("id", contactId)
      .eq("organization_id", m.organizationId)
      .maybeSingle();
    if (!contacto) return;

    const meta = (contacto.source_metadata as Record<string, unknown>) ?? {};
    const nacioAca = contacto.source === "webhook" && meta.webhook_source_id === m.sourceId;
    await admin
      .from("contacts")
      .update({
        tags: unir(contacto.tags as string[], m.tags),
        ...(nacioAca
          ? {
              source: "formulario",
              source_metadata: { ...meta, ...datosDelFormulario, consentimiento_datos_en: m.consentimientoEn },
            }
          : {}),
      })
      .eq("id", contactId)
      .eq("organization_id", m.organizationId);
  } catch (err) {
    // El contacto y el lead ya existen: perder la marca es malo, perder el envío es peor.
    logger.error("[captar.publico] no se pudo marcar el origen", {
      leadId: m.leadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
