/** Validação do upload outbound (Onda 2). Allowlist por categoria + cap 50MB. */
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

export type MessageKind = "image" | "video" | "audio" | "document";

/**
 * Posse do objeto no bucket: o path DEVE estar sob {org}/{conversation}/
 * (chaves do Storage são literais — sem semântica de traversal).
 *
 * Morava dentro do módulo de transporte do provider legado e não tinha nada a
 * ver com o canal: valida um path do NOSSO Storage, antes de qualquer coisa
 * tocar um provider. Ficar lá obrigava o handler de envio a importar do módulo
 * do provider — o acoplamento que o invariante 1 de
 * `docs/doctrine/restricao-de-canal.md` proíbe.
 */
export function isMediaPathOwnedBy(path: string, orgId: string, conversationId: string): boolean {
  return path.startsWith(`${orgId}/${conversationId}/`);
}

/** El objeto es de la organización (lo que la ruta de media puede firmar, M1). */
export function isMediaPathOfOrg(path: string, orgId: string): boolean {
  return path.startsWith(`${orgId}/`);
}

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);

/**
 * Lo que `GET /api/v1/messages/[id]/media` sirve inline desde NUESTRO origen.
 * El tipo sale del transporte o de `media_mime` (que escribe el cliente): un
 * `text/html` o un SVG servido acá corre script con la cookie de sesión. Lo que
 * no está en la lista se baja como adjunto `application/octet-stream`.
 */
export function esMimeServibleInline(mime: string): boolean {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base === "image/svg+xml") return false;
  return /^(image|video|audio)\/[\w.+-]+$/.test(base) || DOCUMENT_MIMES.has(base);
}

type Ok = { ok: true; kind: MessageKind };
type Fail = { ok: false; code: "unsupported_media_type" | "payload_too_large" | "validation_failed"; message: string };

export function validateOutboundMedia(mime: string, sizeBytes: number): Ok | Fail {
  if (!sizeBytes || sizeBytes <= 0) {
    return { ok: false, code: "validation_failed", message: "Arquivo vazio." };
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Arquivo acima de 50MB." };
  }
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.startsWith("image/")) return { ok: true, kind: "image" };
  if (base.startsWith("video/")) return { ok: true, kind: "video" };
  if (base.startsWith("audio/")) return { ok: true, kind: "audio" };
  if (DOCUMENT_MIMES.has(base)) return { ok: true, kind: "document" };
  return { ok: false, code: "unsupported_media_type", message: "Tipo de arquivo não suportado." };
}
