/**
 * H4 / M14 (auditoría 2026-11-14): un platform admin con `scope = support_readonly`
 * suspendía tenants. Solo `scope = full` escribe.
 *
 *     npx vitest run tests/unit/platform-admin-scope-full-para-escribir.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let scope = "support_readonly";
const suspenderEnBase = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1" } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) c[m] = () => c;
      c.maybeSingle = async () => ({
        data: { user_id: "u1", scope, mfa_required: true, revoked_at: null },
      });
      return c;
    },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    suspenderEnBase();
    return {};
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const TENANT = "33333333-3333-4333-8333-333333333333";

async function suspender() {
  const { POST } = await import("@/app/api/v1/admin/tenants/[id]/suspend/route");
  const req = new Request("http://x/suspend", {
    method: "POST",
    body: JSON.stringify({ reason: "motivo de prueba largo" }),
  });
  return POST(req as never, { params: Promise.resolve({ id: TENANT }) });
}

describe("platform admin escribe solo con scope = full", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope = "support_readonly";
  });

  it("⭐ requirePlatformAdminWrite rechaza support_readonly", async () => {
    const { requirePlatformAdminWrite } = await import("@/lib/auth/requirePlatformAdmin");
    await expect(requirePlatformAdminWrite()).rejects.toThrow();
  });

  it("par de vacuidad: scope full pasa", async () => {
    scope = "full";
    const { requirePlatformAdminWrite } = await import("@/lib/auth/requirePlatformAdmin");
    await expect(requirePlatformAdminWrite()).resolves.toMatchObject({
      platformAdmin: { scope: "full" },
    });
  });

  it("⭐ suspend con support_readonly: 403 y sin tocar la base", async () => {
    const r = await suspender();
    expect(r.status).toBe(403);
    expect(suspenderEnBase, "support_readonly llegó a escribir con service role").not.toHaveBeenCalled();
  }, 60_000);
});
