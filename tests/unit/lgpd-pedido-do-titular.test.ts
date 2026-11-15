import type * as SupportModule from "@/lib/impersonate/support";
/**
 * POST /api/v1/lgpd/requests — el canal de acceso y supresión (auditoría
 * 2026-11-14, H8). Antes la ruta solo tenía GET: un pedido que llegaba por
 * e-mail o WhatsApp no tenía dónde registrarse ni plazo que lo vigilara.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createLgpdRequest } from "@/lib/lgpd/repository";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/lgpd/repository", () => ({
  createLgpdRequest: vi.fn(async () => ({ id: "pedido-nuevo", due_at: "2026-11-24T02:59:59.999Z" })),
}));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof SupportModule>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTATO = "33333333-3333-4333-8333-333333333333";

/** Lo que devuelve cada `from(tabla)…maybeSingle()`. */
let filas: { contacts: unknown; lgpd_requests: unknown };
const filtros: Array<[string, string, unknown]> = [];

function clienteFalso() {
  return {
    from(tabla: "contacts" | "lgpd_requests") {
      const cadeia = {
        select: () => cadeia,
        eq: (col: string, val: unknown) => {
          filtros.push([tabla, col, val]);
          return cadeia;
        },
        in: () => cadeia,
        limit: () => cadeia,
        maybeSingle: async () => ({ data: filas[tabla], error: null }),
      };
      return cadeia;
    },
  };
}

async function pedir(body: unknown) {
  const { POST } = await import("@/app/api/v1/lgpd/requests/route");
  const res = await POST(
    new NextRequest("http://localhost/api/v1/lgpd/requests", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
  return { status: res.status, corpo: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  filtros.length = 0;
  filas = { contacts: { id: CONTATO, is_anonymized: false }, lgpd_requests: null };
  vi.mocked(createClient).mockResolvedValue(clienteFalso() as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "es" },
    org: { orgId: ORG, role: "admin" },
  } as never);
});

describe("POST /api/v1/lgpd/requests", () => {
  it("⭐ registra la supresión con el plazo de la Ley 25.326, contado desde que la persona pidió", async () => {
    const r = await pedir({
      request_type: "redact",
      contact_id: CONTATO,
      received_at: "2026-11-09T10:00:00-03:00",
      canal: "email",
      detalle: "Me escribió pidiendo que la borren",
    });

    expect(r.status, JSON.stringify(r.corpo)).toBe(201);
    expect(vi.mocked(createLgpdRequest)).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        requestType: "redact",
        source: "manual",
        contactId: CONTATO,
        receivedAt: new Date("2026-11-09T13:00:00.000Z"),
      }),
    );
    expect(r.corpo.data).toMatchObject({
      id: "pedido-nuevo",
      plazo: { dias: 5, tipo: "habiles", fuente: "Ley 25.326, art. 16 inc. 2" },
      ya_existia: false,
    });
    expect(r.corpo.data.abierto_para_abogado.length).toBeGreaterThan(0);
  });

  it("la auditoría no copia el texto libre (puede tener dato personal)", async () => {
    await pedir({ request_type: "data_request", contact_id: CONTATO, detalle: "Soy Zoe, mi DNI es 12345678" });
    const linea = vi.mocked(audit).mock.calls[0]![0];
    expect(linea.action).toBe("lgpd.request_created");
    expect(JSON.stringify(linea.metadata)).not.toContain("Zoe");
  });

  it("el contacto se busca en la org de la sesión, nunca en la del body", async () => {
    await pedir({ request_type: "redact", contact_id: CONTATO });
    expect(filtros).toContainEqual(["contacts", "organization_id", ORG]);
  });

  it("contacto de otra org (o inexistente) da 404 y no crea nada", async () => {
    filas.contacts = null;
    const r = await pedir({ request_type: "redact", contact_id: CONTATO });
    expect(r.status).toBe(404);
    expect(vi.mocked(createLgpdRequest)).not.toHaveBeenCalled();
  });

  it("supresión de un contacto ya anonimizado da 409: no se abre un plazo que ya se cumplió", async () => {
    filas.contacts = { id: CONTATO, is_anonymized: true };
    expect((await pedir({ request_type: "redact", contact_id: CONTATO })).status).toBe(409);
    expect((await pedir({ request_type: "data_request", contact_id: CONTATO })).status).toBe(201);
  });

  it("un pedido igual abierto se devuelve, no se crea un segundo plazo", async () => {
    filas.lgpd_requests = { id: "pedido-viejo", due_at: "2026-11-20T02:59:59.999Z", status: "received" };
    const r = await pedir({ request_type: "redact", contact_id: CONTATO });
    expect(r.status).toBe(200);
    expect(r.corpo.data).toMatchObject({ id: "pedido-viejo", ya_existia: true });
    expect(vi.mocked(createLgpdRequest)).not.toHaveBeenCalled();
  });

  it("rechaza fecha en el futuro, tipo de la tienda y campos de más", async () => {
    const futuro = new Date(Date.now() + 86_400_000).toISOString();
    expect((await pedir({ request_type: "redact", contact_id: CONTATO, received_at: futuro })).status).toBe(422);
    expect((await pedir({ request_type: "store_redact", contact_id: CONTATO })).status).toBe(422);
    expect((await pedir({ request_type: "redact", contact_id: CONTATO, organization_id: ORG })).status).toBe(422);
    expect(vi.mocked(createLgpdRequest)).not.toHaveBeenCalled();
  });

  it("sin rol de admin no pasa", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }),
    } as never);
    expect((await pedir({ request_type: "redact", contact_id: CONTATO })).status).toBe(403);
  });
});
