/**
 * C1 (auditoría 2026-11-13): `sendOnboardingInvites` solo pedía sesión y org
 * activa, sin rol. Un vendedor (agent) o viewer llamaba la server action con
 * `role: "admin"` y se promovía a admin con un segundo e-mail suyo.
 *
 * Propiedad: ninguna server action del onboarding actúa sin rol admin leído de
 * la base (`fn_user_role_in_org`) y sin MFA probado, y el reparto de
 * invitaciones solo funciona mientras el onboarding está abierto.
 *
 *     npx vitest run tests/unit/onboarding-exige-admin.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "vendedor@example.com",
  full_name: "Vendedor",
  support: null,
  idioma: "es",
  organizations: [],
  is_platform_admin: false,
};

let rolEnLaBase: string | null = "agent";
let mfaEnDeuda = false;
let onboardedAt: string | null = null;

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: (t: string) => t }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => USER),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: "admin" })),
  mfaEmDivida: vi.fn(async () => mfaEnDeuda),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: vi.fn(async () => ({ data: rolEnLaBase, error: null })),
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { onboarding_state: {}, onboarded_at: onboardedAt },
            error: null,
          }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  })),
}));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: vi.fn(async () => ({ nome: "M" })) }));

const emitirConvite = vi.fn(async (_a: unknown, p: { email: string }) => ({
  convite: { id: "inv-1", email: p.email },
  accept_url: "http://x/accept",
  email_dispatched: true,
  renovado: false,
}));
vi.mock("@/lib/team/convites", () => ({ emitirConvite }));

async function invitar(role: string) {
  const { sendOnboardingInvites } = await import("@/app/actions/onboarding/sendOnboardingInvites");
  return sendOnboardingInvites({
    invitations: [{ email: "otro@suyo.com", role: role as "admin" }],
  }).catch((e: Error) => ({ ok: "redirect" as const, e: e.message }));
}

describe("onboarding exige admin real (C1/H2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rolEnLaBase = "agent";
    mfaEnDeuda = false;
    onboardedAt = null;
  });

  it("⭐ un vendedor no puede invitar a nadie como admin", async () => {
    const r = await invitar("admin");
    expect(r).toMatchObject({ ok: false, error: "forbidden" });
    expect(emitirConvite, "se emitió un convite admin para un vendedor").not.toHaveBeenCalled();
  });

  it("un viewer tampoco", async () => {
    rolEnLaBase = "viewer";
    expect(await invitar("admin")).toMatchObject({ ok: false, error: "forbidden" });
    expect(emitirConvite).not.toHaveBeenCalled();
  });

  it("admin con MFA sin probar en esta sesión: rechazado", async () => {
    rolEnLaBase = "admin";
    mfaEnDeuda = true;
    expect(await invitar("admin")).toMatchObject({ ok: false, error: "forbidden" });
    expect(emitirConvite).not.toHaveBeenCalled();
  });

  it("onboarding ya terminado: no se reparten invitaciones por acá", async () => {
    rolEnLaBase = "admin";
    onboardedAt = "2026-11-01T00:00:00Z";
    expect(await invitar("admin")).toMatchObject({ ok: false, error: "forbidden" });
    expect(emitirConvite).not.toHaveBeenCalled();
  });

  it("par de vacuidad: el admin con el onboarding abierto sí emite, y deja fila en team_invites", async () => {
    rolEnLaBase = "admin";
    const r = await invitar("admin");
    expect(r).toMatchObject({ ok: "redirect" });
    expect(emitirConvite).toHaveBeenCalledTimes(1);
    expect(emitirConvite.mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG,
      email: "otro@suyo.com",
      role: "admin",
      inviterId: USER.id,
    });
  });
});
