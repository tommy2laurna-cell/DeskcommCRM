/**
 * MediaSource do WAHA: baixa o binário hospedado pelo container WAHA.
 *
 * A URL anunciada no webhook NÃO é confiável nem correta: o HMAC é
 * best-effort (payload forjado é possível) e o WAHA anuncia seu endereço
 * INTERNO (ex.: localhost:3000 dentro do container, mapeado p/ 3030 no
 * host). Por isso o fetch é SEMPRE reconstruído sobre WAHA_API_BASE_URL,
 * aproveitando apenas o path (`/api/files/...`, sem query) da URL anunciada — SSRF impossível por
 * construção (o host nunca vem do payload). A futura MetaMediaSource
 * implementa a mesma assinatura baixando via media_id + Graph API.
 */
import {
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  type FetchedMedia,
} from "@/lib/messaging/media/types";

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Lo único que WAHA anuncia para media: `/api/files/<archivo>` o
 * `/api/files/<sesión>/<archivo>`. Sin query y sin `..`. `media_url` lo escribe
 * el cliente (PostgREST, POST /api/v1/messages, webhook forjado) y acá viaja la
 * X-Api-Key global: cualquier otra ruta de la API de WAHA (sesiones, chats,
 * screenshot) quedaría legible para cualquier miembro (C2).
 */
const RUTA_DE_MEDIA = /^\/api\/files\/(?:[\w-]+(?:\.[\w-]+)*\/)?[\w-]+(?:\.[\w-]+)*$/;

export async function fetchWahaMedia(
  mediaUrl: string,
  hintMime?: string | null,
): Promise<FetchedMedia> {
  const base = process.env.WAHA_API_BASE_URL;
  let url: URL;
  try {
    const advertised = new URL(mediaUrl);
    // Host/porta descartados: só path+query sobrevivem, resolvidos na base.
    if (advertised.search || !RUTA_DE_MEDIA.test(advertised.pathname)) {
      throw new Error("waha_media_untrusted_path");
    }
    url = new URL(advertised.pathname, base ?? "");
  } catch (e) {
    if (e instanceof Error && e.message === "waha_media_untrusted_path") throw e;
    throw new Error("waha_media_untrusted_host");
  }

  const apiKey = process.env.WAHA_API_KEY;
  const res = await fetch(url.toString(), {
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`waha_media_${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const mime = res.headers.get("content-type") || hintMime || "application/octet-stream";
  return { buffer, mime };
}
