/**
 * POST /api/v1/webhooks/waha — global webhook receiver (no path token).
 *
 * Usado quando o WAHA tem um único WHATSAPP_HOOK_URL global (docker-compose
 * atual). Resolve a channel_session por `body.session` (= waha_session_name).
 * A variante /waha/[token] é a rota per-tenant canônica de produção.
 *
 * Pipeline: verifica HMAC SHA512 (obrigatório) -> lookup session -> loga em
 * webhook_events_log -> dispatchWahaEvent (ingestão compartilhada, ver
 * lib/waha/ingest.ts). Idempotência e resolução atômica de contato/conversa
 * vivem no módulo compartilhado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { conferirContratoWaha, lerRoteamentoWaha } from "@/lib/waha/envelope";
import { dispatchWahaEvent } from "@/lib/waha/ingest";
import { authenticateWahaWebhook } from "@/lib/waha/webhook-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const rawBody = await req.text();

  // ─── H5: assinatura ANTES de qualquer coisa ───────────────────────────────────
  //
  // Esta rota não tem token na URL: o único identificador é `body.session`, que
  // quem chama escreve. Resolver a sessão (e com ela a org) antes de conferir a
  // assinatura deixava qualquer um que soubesse o nome de uma sessão alheia injetar
  // mensagem nela, sempre que o Caddy não estivesse na frente. Por isso aqui a
  // assinatura é exigida SEMPRE, independente de WAHA_WEBHOOK_REQUIRE_SIGNATURE, e
  // conferida com o segredo GLOBAL (WAHA_HMAC_SECRET = WHATSAPP_HOOK_HMAC_KEY do
  // contêiner), que é com o que o WAHA assina o hook global. Sem assinatura válida:
  // 401 sem tocar no banco, sem audit (a org do corpo não é confiável) e sem
  // falar do contrato do payload.
  const sigHeader = req.headers.get("x-webhook-hmac");
  const auth = authenticateWahaWebhook({
    rawBody,
    signatureHeader: sigHeader,
    sessionSecret: null,
    requireSignature: true,
  });
  if (!auth.ok) {
    logger.warn("[waha.webhook] assinatura ausente ou inválida (rota global)", {
      request_id: requestId,
      reason: auth.reason,
      had_signature: Boolean(sigHeader),
    });
    return fail("unauthenticated", auth.reason, 401, { requestId });
  }

  // ─── O contrato do fio, em DOIS momentos ─────────────────────────────────
  //
  // Isto era `JSON.parse(rawBody) as WahaEnvelope`: um cast, que não checa nada
  // em tempo de execução. Um `payload.from` não-string fazia `parseChatId`
  // lançar lá dentro, o `catch` do dispatch engolia, e a rota devolvia **200** —
  // o provider riscava o evento da fila achando que entregou.
  //
  // O estágio 1 confere só o que é preciso para RESOLVER O TENANT e ARQUIVAR o
  // corpo. O contrato completo vem depois do INSERT, porque o AC do
  // `docs/prd/03-prd-whatsapp-waha.md` §3.3 manda gravar o raw "mesmo se o
  // parse falhar depois" — e o corpo cru de um payload cujo formato mudou é
  // justamente o artefato que responde o que mudou.
  //
  // Desfecho da recusa: 400 com os CAMPOS (nunca os valores: são dado de
  // cliente e podem ter megabytes) e uma linha no log estruturado. Não 200,
  // porque payload fora do contrato não é "evento que não interessa" — é o fio
  // ter mudado, e isso precisa ser barulhento. Não 500, porque o corpo é do
  // chamador, e 5xx mandaria o provider reentregar o que nunca vai passar.
  //
  // O schema é LOOSE: campo desconhecido passa intacto. Ver lib/waha/envelope.ts.
  const roteamento = lerRoteamentoWaha(rawBody);
  if (!roteamento.ok) {
    if (roteamento.motivo === "json_invalido") {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
    logger.error("[waha.webhook] payload fora do contrato do canal", {
      request_id: requestId,
      estagio: "roteamento",
      campos: roteamento.campos,
    });
    return fail("validation_failed", "payload fora do contrato do canal", 400, {
      requestId,
      details: { campos: roteamento.campos },
    });
  }
  // Nome deliberado: isto ainda NÃO é o envelope conferido. É o que o estágio
  // 1 garante — sessão e id —, e só. Chamá-lo de `envelope` convidaria a ler
  // `payload.from` daqui, que é justamente o campo ainda não conferido.
  const roteado = roteamento.envelope;

  const sessionName = roteado.session;
  if (!sessionName) {
    return fail("invalid_request", "missing session field", 400, { requestId });
  }

  const admin = createAdminClient();

  // Canal ARQUIVADO não ingere — mesmo motivo da rota per-tenant: a sessão já foi
  // removida do transporte, e o que ainda chega é evento em voo. Cai no ramo
  // `session_not_registered` abaixo, que responde 200 (a plataforma pararia de
  // retentar de qualquer forma, porque a sessão não existe mais lá).
  const base = () =>
    admin
      .from("channel_sessions")
      .select(
        "id, organization_id, waha_session_name, status, is_warmup_complete, warmup_started_at",
      )
      .eq("waha_session_name", sessionName);
  const { data: session, error: sessErr } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    // Sessão ainda não registrada no nosso DB — aceita e ignora (200 p/ WAHA
    // não ficar retentando). Comum quando a sessão foi iniciada pelo dashboard
    // antes da nossa linha existir.
    return ok(
      { accepted: false, reason: "session_not_registered", session: sessionName },
      { requestId },
    );
  }

  const validSignature = auth.signatureVerified;

  const eventType = roteado.event ?? "unknown";
  const externalId = roteado.payload?.id ?? null;

  const headersJson: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("authorization")) return;
    if (key.toLowerCase() === "cookie") return;
    headersJson[key] = value;
  });
  await admin.from("webhook_events_log").insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "waha",
    webhook_path_token: null,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: roteado as unknown as Record<string, unknown>,
    signature_header: sigHeader ?? null,
    valid_signature: validSignature,
    event_type: eventType,
    external_id: externalId,
    status: "received",
    attempts: 0,
  });

  // Estágio 2: o resto do contrato, agora que o corpo cru já está arquivado.
  const contrato = conferirContratoWaha(roteado);
  if (!contrato.ok) {
    logger.error("[waha.webhook] payload fora do contrato do canal", {
      request_id: requestId,
      estagio: "conteudo",
      campos: contrato.campos,
    });
    return fail("validation_failed", "payload fora do contrato do canal", 400, {
      requestId,
      details: { campos: contrato.campos },
    });
  }

  try {
    await dispatchWahaEvent(admin, session, contrato.envelope, requestId);
  } catch (err) {
    console.error("[waha.webhook] handler failed", err);
  }

  return ok({ accepted: true }, { requestId });
}
