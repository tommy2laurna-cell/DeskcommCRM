/**
 * H1: la sesión no puede escribir `user_recovery_codes` (0277). Las actions que
 * la tocaban con fallback al cliente de la sesión ahora usan solo service role.
 *
 *     npx vitest run tests/unit/recovery-codes-solo-admin-client.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tablasDeSesion: string[] = [];
const tablasAdmin: string[] = [];
let conServiceRole = true;

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => conServiceRole,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1" } } }),
      mfa: { listFactors: async () => ({ data: { totp: [{ status: "verified" }] } }) },
    },
    from: (t: string) => {
      tablasDeSesion.push(t);
      const c: Record<string, unknown> = {};
      c.delete = () => c;
      c.insert = async () => ({ error: null });
      c.eq = async () => ({ error: null });
      return c;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      tablasAdmin.push(t);
      const c: Record<string, unknown> = {};
      c.delete = () => c;
      c.insert = async () => ({ error: null });
      c.eq = async () => ({ error: null });
      return c;
    },
  }),
}));

describe("regenerateRecoveryCodes escribe solo con service role", () => {
  beforeEach(() => {
    tablasDeSesion.length = 0;
    tablasAdmin.length = 0;
    conServiceRole = true;
  });

  it("⭐ nunca toca user_recovery_codes con el cliente de la sesión", async () => {
    const { regenerateRecoveryCodes } = await import("@/app/actions/settings/regenerateRecoveryCodes");
    const r = await regenerateRecoveryCodes();
    expect(r.ok).toBe(true);
    expect(tablasDeSesion).not.toContain("user_recovery_codes");
    expect(tablasAdmin).toContain("user_recovery_codes");
  });

  it("sin service role no regenera (y tampoco cae al cliente de la sesión)", async () => {
    conServiceRole = false;
    const { regenerateRecoveryCodes } = await import("@/app/actions/settings/regenerateRecoveryCodes");
    expect(await regenerateRecoveryCodes()).toMatchObject({ ok: false, error: "service_unavailable" });
    expect(tablasDeSesion).not.toContain("user_recovery_codes");
  });
});
