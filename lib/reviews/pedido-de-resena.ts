/**
 * Decisiones puras del pedido de reseña (cron `cron/review-requests`).
 * Sin banco ni red: lo que decide si alguien recibe un mensaje se prueba solo.
 */
import type { ReviewsSettings } from "@/lib/schemas/settings";

/** Sin link o sin mensaje aprobado no se envía: la fila queda `sin_configurar`. */
export function resenasConfiguradas(c: ReviewsSettings): boolean {
  return c.google_review_url !== "" && c.mensaje_aprobado_nombre !== "" && c.mensaje_aprobado_idioma !== "";
}

/** Texto del cuerpo (BODY) de un mensaje aprobado de Meta, o "" si no hay. */
export function textoDelCuerpo(components: unknown): string {
  if (!Array.isArray(components)) return "";
  const body = components.find(
    (c) => c && typeof c === "object" && String((c as { type?: unknown }).type).toUpperCase() === "BODY",
  ) as { text?: unknown } | undefined;
  return typeof body?.text === "string" ? body.text : "";
}

/**
 * Valores por slot del cuerpo. Convención documentada en la pantalla: {{1}} es el
 * nombre y {{2}} el link. Si el mensaje aprobado tiene un único slot, va el link
 * (es lo que importa); sin slots no se manda ningún valor.
 */
export function valoresDelMensaje(textoDelCuerpoAprobado: string, nombre: string, link: string): Record<string, string> {
  const slots = new Set(textoDelCuerpoAprobado.match(/\{\{\s*\w+\s*\}\}/g) ?? []).size;
  if (slots === 0) return {};
  if (slots === 1) return { "1": link };
  return { "1": nombre, "2": link };
}

/** Cuándo vence el pedido: `cerrado_en` + N días. */
export function vencimientoDelPedido(cerradoEn: string, diasDespues: number): string {
  return new Date(new Date(cerradoEn).getTime() + diasDespues * 86_400_000).toISOString();
}
