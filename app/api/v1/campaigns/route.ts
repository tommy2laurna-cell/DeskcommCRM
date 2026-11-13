/**
 * GET  /api/v1/campaigns — campañas de la organización (agent+).
 * POST /api/v1/campaigns — crea un BORRADOR (manager+). Valida que la sesión sea
 *      de Meta (jamás WAHA) y que el mensaje esté aprobado; la categoría sale del
 *      espejo, no del cliente.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { CAMPAIGN_COLS, mensajeAprobado, sesionDeMeta } from "@/lib/campaigns/cargar";
import { clienteDeUsuario, crearIdempotente } from "@/lib/campaigns/http";
import { createCampaignSchema } from "@/lib/campaigns/schemas";
import { categoriaDelMensaje } from "@/lib/campaigns/vista-previa";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
const ENDPOINT = "/api/v1/campaigns";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;

  const db = await clienteDeUsuario();
  const { data, error } = await db
    .from("campaigns")
    .select(CAMPAIGN_COLS)
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return fail("internal_error", "Erro ao listar.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const parsed = createCampaignSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten() as unknown as Record<string, unknown>,
    });
  }
  const c = parsed.data;
  const db = await clienteDeUsuario();

  if (!(await sesionDeMeta(db, org.orgId, c.channel_session_id))) {
    return fail("not_meta_session", t("As campanhas só saem pela API oficial da Meta."), 422, {
      requestId,
    });
  }
  const { data: lista } = await db
    .from("smart_lists")
    .select("id")
    .eq("id", c.list_id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!lista) return fail("not_found", t("Lista não encontrada."), 404, { requestId });

  const mensaje = await mensajeAprobado(db, org.orgId, c.template_name, c.template_language);
  if (!mensaje || mensaje.status !== "APPROVED") {
    return fail("template_not_approved", t("A mensagem não está aprovada pela Meta."), 422, {
      requestId,
    });
  }

  return crearIdempotente({
    req,
    db,
    organizationId: org.orgId,
    endpoint: ENDPOINT,
    corpo: c,
    requestId,
    idioma: user.idioma,
    crear: async () => {
      const { data, error } = await db
        .from("campaigns")
        .insert({
          organization_id: org.orgId,
          name: c.name,
          list_id: c.list_id,
          channel_session_id: c.channel_session_id,
          template_name: c.template_name,
          template_language: c.template_language,
          template_category: categoriaDelMensaje(mensaje.category),
          template_values: c.template_values,
          scheduled_at: c.scheduled_at ?? null,
          created_by_user_id: user.id,
        })
        .select(CAMPAIGN_COLS)
        .single();
      if (error || !data) throw error ?? new Error("insert_failed");
      void audit({
        action: "campaign.created",
        actorUserId: user.id,
        organizationId: org.orgId,
        resourceType: "campaign",
        resourceId: data.id as string,
        requestId,
        metadata: { name: c.name, list_id: c.list_id },
      });
      return data;
    },
  });
}
