import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * H5 — O WEBHOOK GLOBAL DO WAHA TIRAVA A ORG DE `body.session` SEM FIRMA.
 *
 * `POST /api/v1/webhooks/waha` (sem token na URL) procurava a sessão pelo
 * `session` do corpo, com service role, e só depois olhava a assinatura — que
 * era opcional enquanto `WAHA_WEBHOOK_REQUIRE_SIGNATURE` não fosse "true", e o
 * default era "false". A única barreira era o `respond 403` do Caddyfile:
 * qualquer topologia sem esse Caddy (compose exposto, kit, Traefik mal
 * configurado) deixava quem soubesse o nome de uma sessão de OUTRA org injetar
 * mensagem nela.
 *
 * E o motivo do default "false" — "o WAHA Core não assina" — era o compose
 * passando `WHATSAPP_HOOK_HMAC`, um nome que o WAHA não lê. O nome certo é
 * `WHATSAPP_HOOK_HMAC_KEY` (src/modules/waha-webhook/webhook.config.ts do
 * devlikeapro/waha), e com ele o WAHA assina sha512 em hex
 * (WebhookPlugin.sender.ts), que é o que `verifyHmacSha512` confere.
 *
 * O que este arquivo segura, na própria app (sem Caddy):
 *  - sem firma válida, a rota global dá 401 ANTES de resolver sessão/org;
 *  - mesmo com `WAHA_WEBHOOK_REQUIRE_SIGNATURE=false` explícito;
 *  - o evento assinado pelo WAHA continua entrando (o conserto não pode matar
 *    a ingestão);
 *  - em produção o default da flag é "true";
 *  - os compose passam a chave com o nome que o WAHA lê, e o install grava "true".
 */

const SEGREDO = "segredo-global-do-waha-com-64-hex-0123456789abcdef0123456789abcdef";

const SESSAO_DA_ORG_B = {
  id: "sess-b",
  organization_id: "org-b",
  waha_session_name: "org_bbbbbbbb_0123456789abcdef0123456789abcdef",
  webhook_secret_encrypted: "\\x00",
  status: "WORKING",
  is_warmup_complete: true,
  warmup_started_at: null,
};

const h = vi.hoisted(() => ({
  envMut: {} as Record<string, string>,
  buscouSessao: vi.fn(),
  auditou: vi.fn(),
  arquivou: vi.fn(),
  despachou: vi.fn(),
}));

vi.mock("@/lib/env", async (original) => {
  const real = await original<{ env: Record<string, unknown> }>();
  const env = new Proxy(real.env, {
    get: (alvo, chave: string) => (chave in h.envMut ? h.envMut[chave] : alvo[chave]),
  });
  return { ...real, env };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: async (linha: Record<string, unknown>) => {
        h.arquivou(linha);
        return { error: null };
      },
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => {
    h.buscouSessao();
    return { data: SESSAO_DA_ORG_B, error: null };
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: async (e: unknown) => {
    h.auditou(e);
  },
}));

vi.mock("@/lib/waha/ingest", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  dispatchWahaEvent: async (_a: unknown, sessao: unknown) => {
    h.despachou(sessao);
  },
}));

import { POST } from "@/app/api/v1/webhooks/waha/route";

const CORPO = JSON.stringify({
  event: "message.any",
  session: SESSAO_DA_ORG_B.waha_session_name,
  payload: { id: "false_5491100000000@c.us_AAA", from: "5491100000000@c.us", fromMe: false, body: "hola" },
});

const assinar = (corpo: string, segredo: string) =>
  createHmac("sha512", segredo).update(corpo, "utf8").digest("hex");

const pedido = (corpo: string, headers: Record<string, string> = {}) =>
  ({ text: async () => corpo, headers: new Headers(headers) }) as never;

beforeEach(() => {
  h.envMut = { WAHA_HMAC_SECRET: SEGREDO, WAHA_WEBHOOK_REQUIRE_SIGNATURE: "false" };
  h.buscouSessao.mockClear();
  h.auditou.mockClear();
  h.arquivou.mockClear();
  h.despachou.mockClear();
});

function nadaTocouNaOrg() {
  expect(h.buscouSessao, "resolveu a sessão (e a org) a partir de body.session").not.toHaveBeenCalled();
  expect(h.arquivou, "gravou no arquivo de webhooks da org").not.toHaveBeenCalled();
  expect(h.despachou, "despachou o evento para a org").not.toHaveBeenCalled();
  expect(h.auditou, "escreveu no audit da org tirada do corpo").not.toHaveBeenCalled();
}

describe("POST /api/v1/webhooks/waha (global) sem Caddy na frente", () => {
  it("sem firma e com a sessão de outra org: 401, mesmo com REQUIRE_SIGNATURE=false", async () => {
    const res = await POST(pedido(CORPO));
    expect(res.status).toBe(401);
    nadaTocouNaOrg();
  });

  it("sem firma e sem a flag definida: 401", async () => {
    delete h.envMut.WAHA_WEBHOOK_REQUIRE_SIGNATURE;
    const res = await POST(pedido(CORPO));
    expect(res.status).toBe(401);
    nadaTocouNaOrg();
  });

  it("firma errada: 401 sem resolver a org", async () => {
    const res = await POST(pedido(CORPO, { "x-webhook-hmac": assinar(CORPO, "outro-segredo-qualquer-123") }));
    expect(res.status).toBe(401);
    nadaTocouNaOrg();
  });

  it("firma válida de OUTRO corpo: 401", async () => {
    const res = await POST(pedido(CORPO, { "x-webhook-hmac": assinar('{"x":1}', SEGREDO) }));
    expect(res.status).toBe(401);
    nadaTocouNaOrg();
  });

  it("sem WAHA_HMAC_SECRET na instalação: fecha (401), não confia no corpo", async () => {
    h.envMut.WAHA_HMAC_SECRET = "";
    const res = await POST(pedido(CORPO, { "x-webhook-hmac": assinar(CORPO, "") }));
    expect(res.status).toBe(401);
    nadaTocouNaOrg();
  });

  it("JSON inválido sem firma: 401 (não fala do contrato com quem não se autenticou)", async () => {
    const res = await POST(pedido("{nao é json"));
    expect(res.status).toBe(401);
  });

  it("evento assinado pelo WAHA com WAHA_HMAC_SECRET: entra na sessão certa", async () => {
    const res = await POST(
      pedido(CORPO, { "x-webhook-hmac": assinar(CORPO, SEGREDO), "x-webhook-hmac-algorithm": "sha512" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { accepted: true } });
    expect(h.despachou).toHaveBeenCalledWith(expect.objectContaining({ organization_id: "org-b" }));
    expect(h.arquivou).toHaveBeenCalledWith(expect.objectContaining({ valid_signature: true }));
  });
});

describe("WAHA_WEBHOOK_REQUIRE_SIGNATURE em produção", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('o default é "true" quando NODE_ENV=production', async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    // Fase de build: o lib/env semeia placeholders nas obrigatórias que faltam,
    // então dá para importar em modo produção sem montar uma instalação inteira.
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("WAHA_WEBHOOK_REQUIRE_SIGNATURE", undefined as unknown as string);
    delete process.env.WAHA_WEBHOOK_REQUIRE_SIGNATURE;
    const { env } = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");
    expect(env.WAHA_WEBHOOK_REQUIRE_SIGNATURE).toBe("true");
  });
});

describe("a instalação entrega a chave que o WAHA lê", () => {
  for (const arquivo of ["docker-compose.prod.yml", "docker-compose.yml"]) {
    it(`${arquivo}: WHATSAPP_HOOK_HMAC_KEY recebe WAHA_HMAC_SECRET`, () => {
      const txt = readFileSync(arquivo, "utf8");
      expect(txt).toMatch(/^\s*WHATSAPP_HOOK_HMAC_KEY:\s*\$\{WAHA_HMAC_SECRET\}\s*$/m);
      // O nome antigo o WAHA ignora em silêncio: é por ele que "o Core não assinava".
      expect(txt).not.toMatch(/^\s*WHATSAPP_HOOK_HMAC:/m);
    });
  }

  it('install.sh grava WAHA_WEBHOOK_REQUIRE_SIGNATURE com default "true"', () => {
    const txt = readFileSync("hostgator-setup-kit/install.sh", "utf8");
    expect(txt).toContain('envq WAHA_WEBHOOK_REQUIRE_SIGNATURE "${WAHA_WEBHOOK_REQUIRE_SIGNATURE:-true}"');
  });
});
