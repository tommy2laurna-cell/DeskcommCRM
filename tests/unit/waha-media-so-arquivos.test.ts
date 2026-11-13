/**
 * C2 (auditoría 2026-11-13): `fetchWahaMedia` conservaba path y query de un
 * `media_url` que escribe el cliente y mandaba la X-Api-Key global de WAHA:
 * un miembro leía sesiones, chats y mensajes de todos los WhatsApp.
 * Propiedad: solo se baja `/api/files/[<sesión>/]<archivo>`, sin query.
 *
 *     npx vitest run tests/unit/waha-media-so-arquivos.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";

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

describe("fetchWahaMedia solo baja archivos de media (C2)", () => {
  it.each([
    "http://x/api/sessions?all=true",
    "http://x/api/sessions",
    "http://x/api/default/chats/123/messages",
    "http://x/api/screenshot",
    "http://x/api/files/default/foto.jpg?download=true",
    "http://x/api/files/../sessions",
    "http://x/api/files/%2e%2e/sessions",
    "http://x/api/files/default/a/b.jpg",
    "http://x/api/files/",
  ])("⭐ rechaza %s sin llamar a WAHA", async (url) => {
    await expect(fetchWahaMedia(url)).rejects.toThrow("waha_media_untrusted_path");
    expect(fetchMock, "se mandó la API key global a una ruta que no es media").not.toHaveBeenCalled();
  });

  it.each(["http://localhost:3030/api/files/abc.jpg", "http://x/api/files/default/abc.oga"])(
    "par de vacuidad: acepta %s",
    async (url) => {
      const r = await fetchWahaMedia(url);
      expect(r.buffer.byteLength).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0]).startsWith("http://waha:3000/api/files/")).toBe(true);
    },
  );
});
