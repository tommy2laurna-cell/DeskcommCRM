/**
 * H3 (auditoría 2026-11-13): las server actions de admin chequeaban el rol a
 * mano, sin MFA. Un admin con sesión aal1 (solo contraseña, TOTP sin probar)
 * apagaba el MFA obligatorio de la org, cambiaba el tenant y el pipeline,
 * conectaba Nuvemshop o publicaba agentes.
 *
 *     npx vitest run tests/unit/actions-de-admin-exigen-mfa.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let mfaEnDeuda = true;
const adminTocado = vi.fn();
const USER = { id: "u1", email: "a@x.com", support: null, is_platform_admin: false, full_name: "A", idioma: "es" };

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({
  supportWriteError: () => null,
  authenticatedSessionId: async () => "s1",
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => USER),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "o1", name: "O", role: "admin" })),
  mfaEmDivida: vi.fn(async () => mfaEnDeuda),
  sessionAal: vi.fn(async () => "aal1"),
  isMfaEnrolled: vi.fn(async () => true),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminTocado();
    throw new Error("service role tocado por una sesión sin MFA");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    adminTocado();
    throw new Error("cliente tocado por una sesión sin MFA");
  },
}));

describe("actions de admin exigen MFA probado (H3)", () => {
  beforeEach(() => {
    mfaEnDeuda = true;
    adminTocado.mockClear();
  });

  it("⭐ definirExigenciaDeMfa: aal1 no apaga el MFA obligatorio", async () => {
    const { definirExigenciaDeMfa } = await import("@/app/actions/auth/politicaDeMfa");
    const r = await definirExigenciaDeMfa(false);
    expect(r.ok).toBe(false);
    expect(adminTocado).not.toHaveBeenCalled();
  });

  it("⭐ updateTenant", async () => {
    const { updateTenant } = await import("@/app/actions/settings/updateTenant");
    const r = await updateTenant({ display_name: "X", timezone: "America/Argentina/Buenos_Aires" } as never);
    expect(r).toMatchObject({ ok: false });
    expect(adminTocado).not.toHaveBeenCalled();
  });

  it("⭐ updatePipelineConfig", async () => {
    const { updatePipelineConfig } = await import("@/app/actions/settings/updatePipelineConfig");
    const r = await updatePipelineConfig("11111111-1111-4111-8111-111111111111", {} as never);
    expect(r).toMatchObject({ ok: false });
    expect(adminTocado).not.toHaveBeenCalled();
  });

  it("⭐ connectNuvemshop", async () => {
    const { connectNuvemshop } = await import("@/app/actions/integrations/connectNuvemshop");
    expect(await connectNuvemshop()).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("par de vacuidad: sin deuda de MFA, connectNuvemshop llega más lejos que 'forbidden'", async () => {
    mfaEnDeuda = false;
    const { connectNuvemshop } = await import("@/app/actions/integrations/connectNuvemshop");
    const r = await connectNuvemshop();
    expect(r).not.toMatchObject({ ok: false, error: "forbidden" });
  });
});
