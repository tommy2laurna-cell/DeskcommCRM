/**
 * Qué se manda según la ventana de 24 h del canal — pura, para probarla sola.
 *  - Ventana abierta o canal sin restricción → texto libre (el de siempre).
 *  - Ventana cerrada → la plantilla aprobada de Meta, con sus {{n}} completados
 *    desde el contexto de la regla.
 * Nunca hay un tercer camino: texto libre con la ventana cerrada es el 131047 de Meta.
 */
import type { EstadoDaJanela } from "@/lib/channels/janela";
import { renderTemplate } from "@/lib/automation/template";

export interface MetaTemplateDeRegla {
  name: string;
  language: string;
  values: Record<string, string>;
}

export type MensajeAEnviar =
  | { type: "text"; body: string }
  | { type: "template"; template_name: string; template_language: string; template_values: Record<string, string> }
  | { type: "skip"; reason: "fuera_de_ventana_sin_plantilla" | "plantilla_con_valores_vacios" };

export function montarMensajeDeReceta(
  ventana: EstadoDaJanela,
  body: string,
  meta: MetaTemplateDeRegla | null,
  contexto: Record<string, unknown>,
): MensajeAEnviar {
  if (ventana.tipo !== "fechada") return { type: "text", body };
  if (!meta?.name || !meta.language) return { type: "skip", reason: "fuera_de_ventana_sin_plantilla" };

  const values: Record<string, string> = {};
  for (const [slot, plantilla] of Object.entries(meta.values ?? {})) {
    const valor = renderTemplate(plantilla, contexto).trim();
    // Meta rechaza (132000) un parámetro vacío: se corta antes de pagar el envío.
    if (!valor) return { type: "skip", reason: "plantilla_con_valores_vacios" };
    values[slot] = valor;
  }
  return { type: "template", template_name: meta.name, template_language: meta.language, template_values: values };
}
