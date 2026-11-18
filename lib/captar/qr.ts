/**
 * QR que abre el formulario público o una charla de WhatsApp con texto inicial.
 *
 * Los links llevan `utm_source=qr`: el formulario los reenvía al enviar, y así
 * el contacto queda con su origen («qr») y su campaña sin código aparte.
 * Se dibuja en el navegador (la librería corre igual en Node, que es como se
 * prueba), así el QR usa la dirección real desde la que se administra el CRM.
 */
import QRCode from "qrcode";

import { normalizePhoneBR } from "@/lib/webhooks/inbound";

/** Link de un formulario, con la marca de que vino de un QR. */
export function linkDeFormulario(origen: string, slug: string, campana: string): string {
  const base = `${origen.replace(/\/+$/, "")}/f/${encodeURIComponent(slug)}`;
  const q = new URLSearchParams({ utm_source: "qr", utm_medium: "qr" });
  const c = campana.trim();
  if (c) q.set("utm_campaign", c.slice(0, 100));
  return `${base}?${q.toString()}`;
}

/** Link `wa.me` con el texto que la persona va a mandar. null = número inválido. */
export function linkDeWhatsApp(telefono: string, texto: string): string | null {
  const e164 = normalizePhoneBR(telefono);
  if (!e164) return null;
  const digitos = e164.replace(/\D/g, "");
  const t = texto.trim().slice(0, 500);
  return t ? `https://wa.me/${digitos}?text=${encodeURIComponent(t)}` : `https://wa.me/${digitos}`;
}

export async function qrComoSvg(contenido: string): Promise<string> {
  return QRCode.toString(contenido, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
}

/** PNG de 1024 px como data URL — se descarga tal cual desde un `<a download>`. */
export async function qrComoPngDataUrl(contenido: string): Promise<string> {
  return QRCode.toDataURL(contenido, { margin: 2, width: 1024, errorCorrectionLevel: "M" });
}
