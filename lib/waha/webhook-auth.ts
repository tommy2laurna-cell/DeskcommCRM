/**
 * Autenticação dos webhooks do WAHA — fail-closed.
 *
 * O que existia antes era fail-OPEN: se o segredo não pudesse ser obtido
 * (`fn_decrypt_oauth` falhando, ou o campo trazendo um placeholder), a rota
 * marcava `hmacSkipped = true` e **processava o evento assim mesmo**. Como as
 * duas rotas que criam sessão gravam `webhook_secret_encrypted: Buffer.from([0])`
 * — um byte de enfeite —, esse "caso de exceção" era o estado PERMANENTE de toda
 * instalação: qualquer pessoa que soubesse a URL injetava mensagem falsa no CRM
 * alheio, escolhia o remetente e fazia o WhatsApp da vítima responder para um
 * número arbitrário (provado nesta VPS, com `curl` sem header nenhum).
 *
 * Três regras, nesta ordem:
 *
 *  1. Assinatura presente que NÃO confere ⇒ rejeita. Sempre. Não existe motivo
 *     legítimo para alguém assinar errado, e era o buraco mais óbvio.
 *  2. Exigência ligada ⇒ assinatura válida em tudo. Liga por `requireSignature`
 *     (a rota global passa `true` sempre: lá a org sai de `body.session`) ou por
 *     `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true`, que é o default em produção
 *     (lib/env.ts). O "WAHA Core não assina" medido em 2026.7.2 era o compose
 *     passando `WHATSAPP_HOOK_HMAC`, nome que o WAHA não lê: o certo é
 *     `WHATSAPP_HOOK_HMAC_KEY` (src/modules/waha-webhook/webhook.config.ts do
 *     devlikeapro/waha), e com ele o WAHA manda `X-Webhook-Hmac` sha512 hex.
 *  3. Sem assinatura e sem exigência ⇒ aceita, mas devolve `signatureVerified:
 *     false` — e quem chama grava ESSA verdade no log. Antes o log registrava
 *     `valid_signature = true` para evento não verificado.
 *
 * O `respond 403` do Caddyfile para a rota global continua como segunda
 * camada; a primeira agora é a app.
 */
import { env } from "@/lib/env";

import { verifyHmacSha512 } from "./ingest";

/** Curto demais para ser segredo de verdade — é placeholder ou lixo de decrypt. */
const MIN_SECRET_LEN = 16;

export type WahaWebhookAuth =
  | { ok: true; signatureVerified: boolean }
  | { ok: false; reason: "bad_signature" | "signature_required" };

export interface WahaWebhookAuthInput {
  rawBody: string;
  signatureHeader: string | null;
  /** Segredo por sessão já decifrado (null quando não há/não decifrou). */
  sessionSecret: string | null;
  /** `true` exige assinatura válida mesmo com a flag de env desligada. */
  requireSignature?: boolean;
}

export function authenticateWahaWebhook(input: WahaWebhookAuthInput): WahaWebhookAuth {
  const { rawBody, signatureHeader, sessionSecret } = input;

  const envSecret = (env.WAHA_HMAC_SECRET ?? "").trim();
  const secret =
    sessionSecret && sessionSecret.length >= MIN_SECRET_LEN
      ? sessionSecret
      : envSecret.length >= MIN_SECRET_LEN
        ? envSecret
        : null;

  const required = input.requireSignature === true || env.WAHA_WEBHOOK_REQUIRE_SIGNATURE === "true";

  if (signatureHeader) {
    // Assinou: tem que conferir. Sem segredo para conferir, não há como
    // confiar — e confiar no que não dá para verificar é o defeito original.
    if (!secret) return { ok: false, reason: "bad_signature" };
    return verifyHmacSha512(rawBody, signatureHeader, secret)
      ? { ok: true, signatureVerified: true }
      : { ok: false, reason: "bad_signature" };
  }

  if (required) return { ok: false, reason: "signature_required" };
  return { ok: true, signatureVerified: false };
}
