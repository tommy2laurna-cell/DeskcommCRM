import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Seguridad § 2.1 (medium): el formulario público se podía saltear con un POST directo a
 * `/api/v1/webhooks/in/<path_token>` (el token lo lee cualquier miembro de la org, M4).
 * Una fuente que pertenece a un formulario solo acepta el reenvío interno de /captar/publico.
 */
const h = vi.hoisted(() => ({ deFormulario: null as null | { id: string } }));

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabla: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => {
        if (tabla === "webhook_sources") {
          return { data: { id: "src-1", organization_id: "org-1", is_active: true, secret_encrypted: null, field_map: {} }, error: null };
        }
        if (tabla === "capture_forms") return { data: h.deFormulario, error: null };
        return { data: null, error: null };
      };
      return q;
    },
  }),
}));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";
import { marcarReenvioInterno, esReenvioInterno } from "@/lib/captar/reenvio-interno";

const nuevo = () =>
  new NextRequest("http://localhost/api/v1/webhooks/in/tokentokentoken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "X", phone: "+5491100000000", consentimiento_datos: "aceptado" }),
  });
// Pasar el guard = llegar a código más profundo (el mock no lo implementa y lanza): no es 404.
const estado = async (req: NextRequest): Promise<number | "paso-el-guard"> => {
  try {
    return (await POST(req, ctx)).status;
  } catch {
    return "paso-el-guard";
  }
};
const ctx = { params: Promise.resolve({ token: "tokentokentoken" }) };

describe("fuente de formulario: el path_token no es una puerta", () => {
  beforeEach(() => {
    h.deFormulario = { id: "form-1" };
  });

  it("POST externo a la URL con el token de un formulario → 404 (antes entraba sin casilla ni límite)", async () => {
    expect(await estado(nuevo())).toBe(404);
  });

  it("una cabecera no sirve de pase: el marcador es la identidad del objeto", async () => {
    const req = new NextRequest("http://localhost/api/v1/webhooks/in/tokentokentoken", {
      method: "POST",
      headers: { "content-type": "application/json", "x-reenvio-interno": "1", "x-internal": "true" },
      body: "{}",
    });
    expect(esReenvioInterno(req)).toBe(false);
    expect(await estado(req)).toBe(404);
  });

  it("control positivo: marcado como interno pasa el guard (no 404)", async () => {
    expect(await estado(marcarReenvioInterno(nuevo()) as NextRequest)).not.toBe(404);
  });

  it("control: una fuente que NO es de formulario (webhook común) no se toca", async () => {
    h.deFormulario = null;
    expect(await estado(nuevo())).not.toBe(404);
  });
});
