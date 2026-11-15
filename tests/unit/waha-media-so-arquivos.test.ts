/**
 * C2 (auditoría 2026-11-13 y 2026-11-14): `fetchWahaMedia` conservaba path y
 * query de un `media_url` que escribe el cliente y mandaba la X-Api-Key global
 * de WAHA: un miembro leía sesiones, chats y mensajes de todos los WhatsApp.
 * Propiedad: solo se baja `/api/files/<sesión del mensaje>/<archivo>`, sin query.
 *
 * Formato real (código de WAHA 2026.7.2, `MediaLocalStorage.getKey`):
 * `<sesión>/<message.id>.<ext>`, y `message.id` lleva `@`.
 *
 *     npx vitest run tests/unit/waha-media-so-arquivos.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wahaAdapter } from "@/lib/channels/adapters/waha";
import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";

const SESION_A = "org_0a1b2c3d_00112233445566778899aabbccddeeff";
const SESION_B = "org_ffeeddcc_ffeeddccbbaa99887766554433221100";
/** Nombre que arma WAHA: `<fromMe>_<chatId>_<id>.<ext>`. */
const ARCHIVO_REAL = "false_5491122334455@c.us_3EB0C767D26A1D8B7F4E.jpeg";

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.WAHA_API_BASE_URL = "http://waha:3000";
  process.env.WAHA_API_KEY = "clave-global";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchWahaMedia solo baja archivos de media de la sesión del mensaje (C2)", () => {
  it.each([
    "http://x/api/sessions?all=true",
    "http://x/api/sessions",
    `http://x/api/${SESION_A}/chats/123/messages`,
    "http://x/api/screenshot",
    `http://x/api/files/${SESION_A}/foto.jpg?download=true`,
    `http://x/api/files/${SESION_A}/../../sessions`,
    `http://x/api/files/${SESION_A}/%2e%2e/%2e%2e/sessions`,
    `http://x/api/files/${SESION_A}/a/b.jpg`,
    `http://x/api/files/${SESION_A}/`,
    `http://x/api/files/${SESION_A}/a..b`,
    `http://x/api/files/${SESION_A}/a%40b.jpg`,
    // otra sesión (otro tenant), con el nombre de archivo real
    `http://x/api/files/${SESION_B}/${ARCHIVO_REAL}`,
    `http://x/api/files/${SESION_B}/foto.jpg`,
    // formato viejo sin sesión (el ejemplo de la doc): no se puede atar a nada
    `http://x/api/files/${ARCHIVO_REAL}`,
  ])("⭐ rechaza %s sin llamar a WAHA", async (url) => {
    await expect(fetchWahaMedia(url, null, SESION_A)).rejects.toThrow("waha_media_untrusted_path");
    expect(fetchMock, "se mandó la API key global a una ruta que no es media").not.toHaveBeenCalled();
  });

  it.each(["", "../sessions", "a/b", "default?x=1"])(
    "⭐ rechaza si la sesión del mensaje no es un nombre válido (%j)",
    async (sesion) => {
      await expect(
        fetchWahaMedia(`http://x/api/files/${sesion}/${ARCHIVO_REAL}`, null, sesion),
      ).rejects.toThrow("waha_media_untrusted_path");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    `http://localhost:3000/api/files/${SESION_A}/${ARCHIVO_REAL}`,
    `http://x/api/files/${SESION_A}/true_5491122334455@c.us_3EB0AB12.oga`,
    `http://x/api/files/${SESION_A}/false_120363025555555555@g.us_3EB0AB12_5491122334455@c.us.mp4`,
    `http://x/api/files/${SESION_A}/false_123456789012345@lid_3EB0AB12.webp`,
  ])("par de vacuidad: acepta %s (nombre real de WAHA, con @)", async (url) => {
    const r = await fetchWahaMedia(url, null, SESION_A);
    expect(r.buffer.byteLength).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://waha:3000${new URL(url).pathname}`,
    );
  });
});

describe("el adapter WAHA ata la sesión del path a la del mensaje", () => {
  it.each([ARCHIVO_REAL, "foto.jpg"])("⭐ un miembro de A no baja %s de la sesión de B", async (archivo) => {
    await expect(
      wahaAdapter.fetchInboundMedia!({
        organizationId: "org-a",
        sessionRef: SESION_A,
        url: `http://x/api/files/${SESION_B}/${archivo}`,
      }),
    ).rejects.toThrow("waha_media_untrusted_path");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("par de vacuidad: baja el archivo de su propia sesión", async () => {
    const r = await wahaAdapter.fetchInboundMedia!({
      organizationId: "org-a",
      sessionRef: SESION_A,
      url: `http://x/api/files/${SESION_A}/${ARCHIVO_REAL}`,
    });
    expect(r.buffer.byteLength).toBe(3);
  });
});
