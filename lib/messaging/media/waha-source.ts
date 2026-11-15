/**
 * MediaSource do WAHA: baixa o binário hospedado pelo container WAHA.
 *
 * A URL anunciada no webhook NÃO é confiável nem correta: o HMAC é
 * best-effort (payload forjado é possível) e o WAHA anuncia seu endereço
 * INTERNO (ex.: localhost:3000 dentro do container, mapeado p/ 3030 no
 * host). Por isso o fetch é SEMPRE reconstruído sobre WAHA_API_BASE_URL,
 * aproveitando apenas o path (`/api/files/<sessão>/...`, sem query) da URL anunciada — SSRF impossível por
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
 * Lo único que WAHA anuncia para media: `/api/files/<sesión>/<archivo>`, sin
 * query. `media_url` lo escribe el cliente (PostgREST, POST /api/v1/messages,
 * webhook forjado) y acá viaja la X-Api-Key global: cualquier otra ruta de la API
 * de WAHA (sesiones, chats, screenshot) quedaría legible para cualquier miembro, y
 * la sesión de otro tenant también (C2). Por eso la sesión del path tiene que ser
 * la `channel_session` del mensaje, no una que diga la URL.
 *
 * Formato medido en el código de WAHA, no en la doc (la doc todavía muestra el
 * formato viejo sin sesión): `MediaLocalStorage.getKey` arma
 * `${session}/${message.id}.${ext}` desde que la media entró al Core (3ad5b67, 2024-09), igual en la imagen pineada
 * `latest-2026.7.2` (MediaPsqlStorage arma la misma URL).
 * https://github.com/devlikeapro/waha/blob/2026.7.2/src/core/media/local/MediaLocalStorage.ts#L91-L93
 * `message.id` lleva `@`: `true_11111111111@c.us_AAAA….jpg`
 * (https://waha.devlike.pro/docs/how-to/receive-messages/). Segmentos sin
 * vacíos: `..` no pasa.
 */
const ARCHIVO_DE_MEDIA = /^[\w@-]+(?:\.[\w@-]+)*$/;
const NOMBRE_DE_SESION = /^[\w-]+$/;

function esRutaDeMediaDeLaSesion(pathname: string, sessionRef: string): boolean {
  if (!NOMBRE_DE_SESION.test(sessionRef)) return false;
  const prefijo = `/api/files/${sessionRef}/`;
  return pathname.startsWith(prefijo) && ARCHIVO_DE_MEDIA.test(pathname.slice(prefijo.length));
}

export async function fetchWahaMedia(
  mediaUrl: string,
  hintMime: string | null | undefined,
  sessionRef: string,
): Promise<FetchedMedia> {
  const base = process.env.WAHA_API_BASE_URL;
  let url: URL;
  try {
    const advertised = new URL(mediaUrl);
    // Host/porta descartados: só o path sobrevive, resolvido na base.
    if (advertised.search || !esRutaDeMediaDeLaSesion(advertised.pathname, sessionRef)) {
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
