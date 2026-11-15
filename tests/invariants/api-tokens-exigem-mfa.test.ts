import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * H1, 2ª metade (auditoria 2026-11-14) — `api_tokens` só se cria com MFA provada.
 * Antes: o admin com sessão aal1 inseria um token persistente sem MFA (a única
 * policy era `api_tokens_admin_only`). Agora há uma policy restritiva de INSERT
 * com `fn_session_mfa_proven()`. Pares: aal2 passa, e quem não tem fator
 * verificado (sem MFA cadastrada) também passa — a trava só pesa quando há fator.
 */
const FATOR = "cccccccc-9999-4000-8000-0000000000f1";
const PREFIXO = "h1mfa";

function inserirToken(aal: "aal1" | "aal2", sufixo: string): string {
  try {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}","role":"authenticated","aal":"${aal}"}', false);
      insert into public.api_tokens(organization_id, created_by, name, prefix, token_hash)
        values ('${GOV_ORG}', '${GOV_ADMIN}', 'h1-mfa', '${PREFIXO}${sufixo}', '\x00'::bytea);
    `);
    return "ok";
  } catch (e) {
    return String((e as { stderr?: unknown }).stderr ?? e);
  }
}

function limpar(): void {
  sql(`
    delete from public.api_tokens where prefix like '${PREFIXO}%';
    delete from auth.mfa_factors where id = '${FATOR}';
  `);
}

describe("api_tokens exige MFA provada para criar token", () => {
  beforeAll(() => {
    seedGov();
    limpar();
  });
  afterAll(limpar);

  it("sem fator verificado, o admin cria token (par de vacuidade)", () => {
    expect(inserirToken("aal1", "a")).toBe("ok");
  });

  it("⭐ com fator TOTP verificado, aal1 não cria token; aal2 sim", () => {
    sql(
      `insert into auth.mfa_factors(id, user_id, status, factor_type) values ('${FATOR}', '${GOV_ADMIN}', 'verified', 'totp');`,
    );
    expect(inserirToken("aal1", "b")).toMatch(/row-level security/i);
    expect(inserirToken("aal2", "c")).toBe("ok");
  });
});
