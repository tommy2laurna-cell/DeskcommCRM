/**
 * De receta a regla: la única traducción entre el catálogo y `automation_rules`.
 * Pura — sin base ni red — para que se pruebe sola.
 */
import {
  esRecetaDeMensaje,
  textoListoParaEnviar,
  type Receta,
  type VariableDeReceta,
} from "@/lib/recetas/catalogo";

export interface AjustesDeReceta {
  /** Texto editado; si falta, el sugerido. */
  texto?: string;
  /** Número por el que sale el mensaje. Obligatorio en recetas de mensaje. */
  channel_session_id?: string;
  /** Link de reseña de Google (solo la receta `resena`). */
  link?: string;
}

export interface ReglaDeReceta {
  name: string;
  trigger_event: string;
  conditions: Array<{ field: string; op: "eq" | "neq" | "contains"; value: string }>;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
  recipe_key: string;
}

/** Cómo se completa cada {{n}} de la plantilla de Meta al enviar. */
const VALOR_DE_VARIABLE: Record<Exclude<VariableDeReceta, "link">, string> = {
  nombre: "{{nombre}}",
  turno: "{{turno}}",
};

export type ErrorDeReceta = "falta_numero" | "texto_incompleto" | "falta_link";

export function reglaDeReceta(
  receta: Receta,
  ajustes: AjustesDeReceta,
): { ok: true; regla: ReglaDeReceta } | { ok: false; error: ErrorDeReceta } {
  const texto = (ajustes.texto ?? receta.texto).trim();
  const base = {
    name: receta.nombre,
    trigger_event: receta.trigger,
    conditions: receta.condiciones.map((c) => ({ ...c })),
    recipe_key: receta.id,
  };

  if (!esRecetaDeMensaje(receta)) {
    return {
      ok: true,
      regla: { ...base, actions: [{ type: "notify_owner", config: { title: texto } }] },
    };
  }

  if (!ajustes.channel_session_id) return { ok: false, error: "falta_numero" };

  const necesitaLink = receta.plantilla.variables.includes("link");
  const link = ajustes.link?.trim();
  if (necesitaLink && !link) return { ok: false, error: "falta_link" };

  // El link entra al texto libre reemplazando el marcador; sin marcador queda como está.
  const textoFinal = necesitaLink && link ? texto.replace(/\[[^\]]*link[^\]]*\]/i, link) : texto;
  if (!textoListoParaEnviar(textoFinal)) return { ok: false, error: "texto_incompleto" };

  const values: Record<string, string> = {};
  receta.plantilla.variables.forEach((v, i) => {
    values[String(i + 1)] = v === "link" ? (link as string) : VALOR_DE_VARIABLE[v];
  });

  return {
    ok: true,
    regla: {
      ...base,
      actions: [
        {
          type: "send_whatsapp_message",
          config: {
            channel_session_id: ajustes.channel_session_id,
            template: textoFinal,
            meta_template: {
              name: receta.plantilla.nombre,
              language: receta.plantilla.idioma,
              values,
            },
          },
        },
      ],
    },
  };
}
