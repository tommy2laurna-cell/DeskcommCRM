/**
 * GET  /api/v1/lgpd/requests — lista paginada de lgpd_requests da org ativa.
 * POST /api/v1/lgpd/requests — registra um pedido do titular (acesso ou
 *      supressão) que chegou por fora do CRM: e-mail, WhatsApp, carta, balcão.
 *      Era o canal que faltava (auditoria 2026-11-14, H8). O prazo sai da Lei
 *      25.326 (`lib/lgpd/sla.ts`), contado da data em que a pessoa pediu.
 *      Executar continua sendo o `approve`; aqui só nasce o pedido e o prazo.
 *
 * Apenas role >= admin. organization_id sempre da sessão — nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createLgpdRequest } from "@/lib/lgpd/repository";
import { ABIERTO_PARA_ABOGADO, PLAZOS_LEY_25326 } from "@/lib/lgpd/sla";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z
    .enum(["received", "processing", "completed", "failed", "pending_review"])
    .optional(),
  type: z
    .enum(["redact", "data_request", "store_redact"])
    .optional(),
  sla_bucket: z.enum(["overdue", "critical", "warning", "ok"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

type SlaBucket = "overdue" | "critical" | "warning" | "ok";

function computeSlaBucket(dueAt: string | null, receivedAt: string): SlaBucket {
  if (!dueAt) return "ok";
  const now = Date.now();
  const due = new Date(dueAt).getTime();
  const received = new Date(receivedAt).getTime();
  const msUntilDue = due - now;

  if (msUntilDue < 0) return "overdue";
  if (msUntilDue < 2 * 24 * 60 * 60 * 1000) return "critical";
  const totalWindow = due - received;
  if (totalWindow > 0 && msUntilDue < totalWindow * 0.5) return "warning";
  return "ok";
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const supabase = await createClient();

  // Parse + validate query params
  const rawParams: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    rawParams[k] = v;
  });
  const parsed = querySchema.safeParse(rawParams);
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      details: parsed.error.flatten(),
      requestId,
    });
  }
  const { status, type, page, limit } = parsed.data;

  const orgId = activeOrg.orgId;
  const offset = (page - 1) * limit;

  // Count query (before sla_bucket filter which is client-side)
  let countQuery = supabase
    .from("lgpd_requests")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (status) countQuery = countQuery.eq("status", status);
  if (type) countQuery = countQuery.eq("request_type", type);
  const { count } = await countQuery;
  const total = count ?? 0;

  // Data query
  let dataQuery = supabase
    .from("lgpd_requests")
    .select(
      "id, organization_id, request_type, source, contact_id, external_customer_id, status, attempts, received_at, due_at, completed_at, emergency, scope, error_message",
    )
    .eq("organization_id", orgId)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("received_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) dataQuery = dataQuery.eq("status", status);
  if (type) dataQuery = dataQuery.eq("request_type", type);

  const { data: rows, error: dbErr } = await dataQuery;
  if (dbErr) {
    return fail("internal_error", dbErr.message, 500, { requestId });
  }

  // Compute sla_bucket per row and apply optional filter
  const enriched = (rows ?? []).map((r) => ({
    ...r,
    sla_bucket: computeSlaBucket(r.due_at, r.received_at),
  }));

  const filtered = parsed.data.sla_bucket
    ? enriched.filter((r) => r.sla_bucket === parsed.data.sla_bucket)
    : enriched;

  return ok(filtered, {
    requestId,
    meta: {
      total,
      page,
      limit,
      has_more: offset + limit < total,
    },
  });
}

const bodySchema = z
  .object({
    request_type: z.enum(["data_request", "redact"]),
    contact_id: z.string().uuid(),
    /** Quando o titular pediu. O prazo legal corre daí, não de quando se cadastrou. */
    received_at: z.string().datetime({ offset: true }).optional(),
    canal: z.enum(["email", "whatsapp", "telefono", "presencial", "carta", "outro"]).default("outro"),
    detalle: z.string().max(1000).optional(),
  })
  .strict();

/** Tolerância de relógio para `received_at` "no futuro". */
const FOLGA_DE_RELOGIO_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("validation_failed", t("Corpo da requisição inválido."), 422, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      details: parsed.error.flatten(),
      requestId,
    });
  }
  const input = parsed.data;

  const recebido = input.received_at ? new Date(input.received_at) : new Date();
  if (recebido.getTime() > Date.now() + FOLGA_DE_RELOGIO_MS) {
    return fail("validation_failed", t("A data do pedido não pode estar no futuro."), 422, { requestId });
  }

  // O contato tem de ser da org ativa — lido com RLS E filtro explícito.
  const supabase = await createClient();
  const { data: contato, error: contatoErr } = await supabase
    .from("contacts")
    .select("id, is_anonymized")
    .eq("organization_id", orgId)
    .eq("id", input.contact_id)
    .maybeSingle();
  if (contatoErr) return fail("internal_error", contatoErr.message, 500, { requestId });
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  // Duplo clique ou o mesmo pedido cadastrado duas vezes: devolve o aberto, não
  // cria um segundo prazo para o mesmo direito.
  const { data: aberto, error: abertoErr } = await supabase
    .from("lgpd_requests")
    .select("id, due_at, status")
    .eq("organization_id", orgId)
    .eq("contact_id", input.contact_id)
    .eq("request_type", input.request_type)
    .in("status", ["received", "processing"])
    .limit(1)
    .maybeSingle();
  if (abertoErr) return fail("internal_error", abertoErr.message, 500, { requestId });
  const plazo = PLAZOS_LEY_25326[input.request_type];
  if (aberto) {
    return ok({ ...aberto, plazo, ya_existia: true }, { requestId });
  }

  let criado: { id: string; due_at: string };
  try {
    criado = await createLgpdRequest({
      organizationId: orgId,
      requestType: input.request_type,
      source: "manual",
      contactId: input.contact_id,
      receivedAt: recebido,
      payload: {
        canal: input.canal,
        ...(input.detalle ? { detalle: input.detalle } : {}),
        registrado_por: authz.user.id,
      },
    });
  } catch (err) {
    console.error("[lgpd.requests] create", (err as Error).message);
    return fail("internal_error", t("Não foi possível registrar a solicitação."), 500, { requestId });
  }

  await audit({
    action: "lgpd.request_created",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "lgpd_request",
    resourceId: criado.id,
    requestId,
    // Sin `detalle`: texto livre pode ter dado pessoal, e ele mora no pedido.
    metadata: { request_type: input.request_type, canal: input.canal, contact_id: input.contact_id },
  });

  return ok(
    {
      id: criado.id,
      status: "received",
      received_at: recebido.toISOString(),
      due_at: criado.due_at,
      plazo,
      abierto_para_abogado: ABIERTO_PARA_ABOGADO,
      ya_existia: false,
    },
    { requestId, status: 201 },
  );
}
