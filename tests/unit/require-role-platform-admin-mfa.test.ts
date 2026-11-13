/**
 * H4 (auditoría 2026-11-13): `requireRole({allowPlatformAdmin:true})` retornaba
 * antes del chequeo de MFA: un platform admin con sesión aal1 anonimizaba
 * contactos o borraba canales de cualquier tenant. Propiedad: el MFA corre
 * también para el platform admin.
 *
 *     npx vitest run tests/unit/require-role-platform-admin-mfa.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let mfaEnDeuda = false;
const USER = {
  id: "u1",
  email: "p@x.com",
  idioma: "es",
  support: null,
  is_platform_admin: true,
  organizations: [],
};

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: (t: string) => t }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => USER),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "o1", name: "O", role: "viewer" })),
  mfaEmDivida: vi.fn(async () => mfaEnDeuda),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: async () => ({ data: "viewer", error: null }) }),
}));

describe("requireRole con allowPlatformAdmin respeta el MFA (H4)", () => {
  beforeEach(() => {
    mfaEnDeuda = false;
  });

  it("⭐ platform admin aal1 con TOTP sin probar: 403 mfa_required", async () => {
    mfaEnDeuda = true;
    const { requireRole } = await import("@/lib/auth/require-role");
    const r = await requireRole("admin", { allowPlatformAdmin: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect((await r.response.json()).error.code).toBe("mfa_required");
    }
  });

  it("par de vacuidad: con MFA probado el platform admin pasa", async () => {
    const { requireRole } = await import("@/lib/auth/require-role");
    const r = await requireRole("admin", { allowPlatformAdmin: true });
    expect(r.ok).toBe(true);
  });
});
