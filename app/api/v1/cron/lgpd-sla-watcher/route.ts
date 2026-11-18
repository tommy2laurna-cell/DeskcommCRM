/**
 * GET /api/v1/cron/lgpd-sla-watcher
 *
 * Daily cron (09:00 BRT / 12:00 UTC) — scans active lgpd_requests and fires
 * SLA alarms when the request is within MARGEM_DE_AVISO_MS of its `due_at`, or
 * past it. `due_at` already carries the Ley 25.326 deadline (lib/lgpd/sla.ts):
 * antes o alarme saía em received_at + 5/10 dias corridos, e com supressão em
 * 5 dias hábeis isso avisava DEPOIS do vencimento.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET|INTERNAL_SECRET>` (fail-closed).
 * Audit: emite `lgpd.sla_watcher_run` quando houve alarme, dedup ou erro — tick
 *   de instalação sem solicitação vencida NÃO audita (ver a guarda "cron que não
 *   fez nada não audita", vigiada por `cron-audita-so-quando-ha-efeito.test.ts`).
 *
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { triggerSlaAlarm } from "@/lib/lgpd/sla-alarm";
import { marcaDaSaida, type MarcaDeSaida } from "@/lib/branding/saida";
import type { LgpdRequest } from "@/lib/lgpd/types";
import type { AlarmThreshold } from "@/lib/lgpd/sla-alarm";

export const dynamic = "force-dynamic";

/** Max requests processed per cron invocation (safety cap). */
const SCAN_LIMIT = 500;

/**
 * Aviso operacional, não prazo legal: 2 dias antes do vencimento. O cron roda
 * uma vez por dia, então 2 dias dão ao menos um aviso antes de vencer.
 */
const MARGEM_DE_AVISO_MS = 2 * 86_400_000;

interface OrgRow {
  dpo_email: string | null;
  display_name: string | null;
}

type RequestWithOrg = LgpdRequest & OrgRow;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const startedAt = Date.now();

  // ────────────────────────────────────────────────────────────────────────
  // Auth — Bearer INTERNAL_CRON_SECRET or INTERNAL_SECRET (fail-closed)
  // ────────────────────────────────────────────────────────────────────────
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";

  const cronSecret = env.INTERNAL_CRON_SECRET;
  const fallbackSecret = env.INTERNAL_SECRET;
  const accepted: string[] = [];
  if (cronSecret) accepted.push(cronSecret);
  if (fallbackSecret) accepted.push(fallbackSecret);

  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Query — system-wide scan via admin client (bypasses RLS intentionally;
  //          this is a platform-level cron, not a tenant-scoped request)
  // ────────────────────────────────────────────────────────────────────────
  const supabaseAdmin = createAdminClient();

  const { data: rows, error: queryError } = await supabaseAdmin
    .from("lgpd_requests")
    .select(
      `
      *,
      organizations!inner(
        dpo_email,
        display_name
      )
    `,
    )
    .not("status", "in", '("completed","failed")')
    .lte("due_at", new Date(Date.now() + MARGEM_DE_AVISO_MS).toISOString())
    .order("due_at", { ascending: true })
    .limit(SCAN_LIMIT);

  if (queryError) {
    console.error("[lgpd-sla-watcher] query failed", queryError.message);
    return fail("internal_error", "Failed to query lgpd_requests.", 500, { requestId });
  }

  const requests = (rows ?? []) as unknown as RequestWithOrg[];

  // ────────────────────────────────────────────────────────────────────────
  // Process each request
  // ────────────────────────────────────────────────────────────────────────
  let alarmedCount = 0;
  let dedupedCount = 0;
  let errorsCount = 0;

  // Uma organização pode ter muitas solicitações vencidas no mesmo lote (o teto
  // é 500), e a marca dela é a mesma para todas. Sem esta memória o cron faria
  // uma leitura de `organizations.settings` por LINHA para devolver o mesmo
  // objeto. Vive só dentro desta invocação de propósito: o próximo ciclo (12h
  // depois) tem de reler, senão uma troca de marca demoraria meio dia a valer.
  const marcaPorOrg = new Map<string, MarcaDeSaida>();
  const marcaDe = async (orgId: string): Promise<MarcaDeSaida> => {
    const guardada = marcaPorOrg.get(orgId);
    if (guardada) return guardada;
    const resolvida = await marcaDaSaida(orgId);
    marcaPorOrg.set(orgId, resolvida);
    return resolvida;
  };

  for (const row of requests) {
    const threshold: AlarmThreshold =
      row.request_type === "data_request" ? "data_request_d5" : "redact_d10";

    // Extract org columns from the joined relation
    const orgData = (row as unknown as { organizations: OrgRow }).organizations;
    const dpoEmail = orgData?.dpo_email ?? null;
    const orgName = orgData?.display_name ?? null;

    // Build a clean LgpdRequest (strip joined columns)
    const lgpdRequest: LgpdRequest = {
      id: row.id,
      organization_id: row.organization_id,
      request_type: row.request_type,
      source: row.source,
      contact_id: row.contact_id,
      external_customer_id: row.external_customer_id,
      status: row.status,
      attempts: row.attempts,
      received_at: row.received_at,
      due_at: row.due_at,
      completed_at: row.completed_at,
      request_payload: row.request_payload,
      result: row.result,
      error_message: row.error_message,
      cascaded_to: row.cascaded_to,
      emergency: row.emergency,
      scope: row.scope,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    try {
      const result = await triggerSlaAlarm({
        request: lgpdRequest,
        threshold,
        organizationDpoEmail: dpoEmail,
        organizationName: orgName,
        marca: await marcaDe(row.organization_id),
      });

      if (result.reason === "dedup_24h") {
        dedupedCount++;
      } else if (result.alarmed) {
        alarmedCount++;
      } else {
        // alarmed=false but no dedup reason — both sentry + email failed
        errorsCount++;
      }
    } catch (err) {
      errorsCount++;
      console.error("[lgpd-sla-watcher] triggerSlaAlarm threw for request", row.id, err);
    }
  }

  const durationMs = Date.now() - startedAt;
  const scanned = requests.length;

  // ────────────────────────────────────────────────────────────────────────
  // Master audit entry (fire-and-forget)
  // ────────────────────────────────────────────────────────────────────────
  // Varredura que não achou solicitação vencida não é mutação e não ocupa linha
  // de auditoria (mesmo critério do snooze-watcher e do recover-stuck-messages).
  //
  // `deduped` ENTRA na condição, e aqui a régua é mais generosa que nos irmãos
  // de propósito: dedup significa que existe prazo LGPD estourado sendo
  // reencontrado, e num caminho de compliance o registro de que o alarme
  // continua de pé vale mais que a linha economizada. O que sai é só o tick de
  // uma instalação sem nenhuma solicitação vencida — que é o caso normal.
  if (alarmedCount > 0 || dedupedCount > 0 || errorsCount > 0) {
    void audit({
      action: "lgpd.sla_watcher_run",
      requestId,
      bypassedRls: true,
      metadata: {
        scanned,
        alarmed: alarmedCount,
        deduped: dedupedCount,
        errors: errorsCount,
        duration_ms: durationMs,
      },
    });
  }

  return ok(
    { scanned, alarmed: alarmedCount, deduped: dedupedCount, errors: errorsCount },
    { requestId },
  );
}
