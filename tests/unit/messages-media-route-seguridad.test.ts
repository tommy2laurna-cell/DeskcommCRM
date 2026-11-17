/**
 * GET /api/v1/messages/[id]/media — C2 y M1 (auditoría 2026-11-13 y 2026-11-14),
 * contra el Route Handler REAL (auth y Supabase mockados, adapter WAHA real).
 *
 *  - M1: la ruta firma con service role. Un path fuera de `<org activa>/` → 404
 *    sin firmar. Otra conversación de la misma org sí (fusión de contactos mueve
 *    mensajes sin renombrar el archivo); eso se valida al escribir (0291).
 *  - C2: el proxy solo baja `/api/files/<sesión del mensaje>/…`.
 *  - MIME: lo que no está en la allowlist se sirve como adjunto octet-stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const CONV_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONV_B = "bbbbbbbb-1111-4000-8000-000000000001";
const MSG = "aaaaaaaa-2222-4000-8000-000000000001";
const SESION_A = "org_aaaaaaaa_00112233445566778899aabbccddeeff";
const SESION_B = "org_bbbbbbbb_ffeeddccbbaa99887766554433221100";
const ARCHIVO = "false_5491122334455@c.us_3EB0C767D26A1D8B7F4E.jpeg";

interface Msg {
  media_url: string | null;
  media_mime: string | null;
  media_storage_path: string | null;
}

const signMock = vi.fn();
const fetchMock = vi.fn();

function montar(msg: Msg) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: { id: MSG, conversation_id: CONV_A, channel_session_id: "cs-a", ...msg },
          error: null,
        }),
      };
      return chain;
    },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue({
    storage: { from: () => ({ createSignedUrl: signMock }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: { provider: "waha", waha_session_name: SESION_A },
          error: null,
        }),
      };
      return chain;
    },
  } as never);
}

async function pedir() {
  const { GET } = await import("@/app/api/v1/messages/[id]/media/route");
  return GET(new NextRequest(`http://app/api/v1/messages/${MSG}/media`), {
    params: Promise.resolve({ id: MSG }),
  });
}

beforeEach(() => {
  vi.mocked(loadAuthUser).mockResolvedValue({ idioma: "es" } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_A } as never);
  signMock.mockReset().mockResolvedValue({ data: { signedUrl: "https://storage/firmada" }, error: null });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.WAHA_API_BASE_URL = "http://waha:3000";
  process.env.WAHA_API_KEY = "clave-global";
});
afterEach(() => vi.unstubAllGlobals());

describe("M1: la ruta solo firma media de la org activa", () => {
  it.each([
    `${ORG_B}/${CONV_B}/x.jpg`,
    `${ORG_B}/${CONV_A}/x.jpg`,
    `${ORG_A}x/${CONV_A}/x.jpg`,
  ])("⭐ %s → 404 sin firmar", async (path) => {
    montar({ media_url: null, media_mime: null, media_storage_path: path });
    const res = await pedir();
    expect(res.status).toBe(404);
    expect(signMock).not.toHaveBeenCalled();
  });

  it.each([`${ORG_A}/${CONV_A}/x.jpg`, `${ORG_A}/${CONV_B}/x.jpg`])(
    "par de vacuidad: %s (propia, o de una conversación fusionada) → 302 firmada",
    async (path) => {
      montar({ media_url: null, media_mime: null, media_storage_path: path });
      const res = await pedir();
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://storage/firmada");
    },
  );
});

describe("C2: el proxy no baja otra sesión ni otra ruta de WAHA", () => {
  it.each([
    `http://x/api/files/${SESION_B}/${ARCHIVO}`,
    `http://x/api/files/${SESION_B}/foto.jpg`,
    "http://x/api/sessions?all=true",
  ])("⭐ %s → 502 sin llamar a WAHA", async (url) => {
    montar({ media_url: url, media_mime: "image/jpeg", media_storage_path: null });
    const res = await pedir();
    expect(res.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("allowlist de MIME en el proxy", () => {
  it.each(["text/html", "image/svg+xml", "application/javascript"])(
    "⭐ %s se sirve como adjunto octet-stream con nosniff",
    async (tipo) => {
      montar({ media_url: `http://x/api/files/${SESION_A}/${ARCHIVO}`, media_mime: null, media_storage_path: null });
      fetchMock.mockResolvedValue(
        new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": tipo } }),
      );
      const res = await pedir();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toBe("attachment");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );

  it("par de vacuidad: image/jpeg de la propia sesión se sirve inline", async () => {
    montar({ media_url: `http://x/api/files/${SESION_A}/${ARCHIVO}`, media_mime: null, media_storage_path: null });
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://waha:3000/api/files/${SESION_A}/${ARCHIVO}`);
  });
});
