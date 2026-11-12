/**
 * POST /api/v1/prospectos — auth por token, límite por token y mapeo alta/actualización.
 * La lógica de contacto + lead está en `lib/leads/entrada-de-prospectos.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { isPublicPath } from "@/lib/auth/public-paths";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/leads/entrada-de-prospectos", () => ({ ingresarProspecto: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }));

const { resolveAuthDual } = await import("@/lib/api/auth-dual");
const { checkRateLimit } = await import("@/lib/ai/dispatcher/rate-limit");
const { ingresarProspecto } = await import("@/lib/leads/entrada-de-prospectos");
const { POST } = await import("./route");

const ORG = "22222222-2222-4222-8222-222222222222";
const actor = { type: "api_token", id: "tok-1", role: "agent" };

function post(body: unknown) {
  return new NextRequest("http://localhost/api/v1/prospectos", {
    method: "POST",
    headers: { authorization: "Bearer dsk_x_y", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveAuthDual).mockResolvedValue({ ok: true, organizationId: ORG, actor, supabase: {}, via: "token" } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 60, window_sec: 60 });
});

describe("POST /api/v1/prospectos", () => {
  it("es alcanzable con Bearer (el proxy no lo corta)", () => {
    expect(isPublicPath("/api/v1/prospectos")).toBe(true);
    expect(isPublicPath("/api/v1/prospectos/otra-cosa")).toBe(false);
  });

  it("pide scope mcp:write y rol agent", async () => {
    vi.mocked(ingresarProspecto).mockResolvedValue({ accion: "alta", contacto_id: "c", lead_id: "l", telefono: null, etapa_id: "s" });
    await POST(post({ telefono: "+5491112345678", id_externo: "x" }));
    expect(vi.mocked(resolveAuthDual).mock.calls[0]![1]).toMatchObject({ role: "agent", scope: "mcp:write" });
  });

  it("devuelve la respuesta de auth tal cual si no hay token válido", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValue({ ok: false, response: new Response("no", { status: 401 }) });
    const res = await POST(post({ telefono: "+5491112345678", id_externo: "x" }));
    expect(res.status).toBe(401);
    expect(ingresarProspecto).not.toHaveBeenCalled();
  });

  it("alta → 201 con ids; la organización sale del token", async () => {
    vi.mocked(ingresarProspecto).mockResolvedValue({ accion: "alta", contacto_id: "c1", lead_id: "l1", telefono: "+5491112345678", etapa_id: "s1" });
    const res = await POST(post({ telefono: "011 15 1234-5678", id_externo: "x", organization_id: "otra" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toMatchObject({ accion: "alta", contacto_id: "c1", lead_id: "l1" });
    expect(vi.mocked(ingresarProspecto).mock.calls[0]![1].organization_id).toBe(ORG);
  });

  it("actualización → 200", async () => {
    vi.mocked(ingresarProspecto).mockResolvedValue({ accion: "actualizacion", contacto_id: "c1", lead_id: "l1", telefono: null, etapa_id: "s1" });
    const res = await POST(post({ email: "a@b.co", id_externo: "x" }));
    expect(res.status).toBe(200);
  });

  it("límite por token: 429 con Retry-After, sin tocar la base", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 61, limit: 60, window_sec: 60 });
    const res = await POST(post({ telefono: "+5491112345678", id_externo: "x" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(vi.mocked(checkRateLimit).mock.calls[0]![0]).toBe("prospectos:tok-1");
    expect(ingresarProspecto).not.toHaveBeenCalled();
  });

  it("sin id_externo → 422", async () => {
    const res = await POST(post({ telefono: "+5491112345678" }));
    expect(res.status).toBe(422);
  });
});
