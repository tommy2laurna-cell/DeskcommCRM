/**
 * La vista de una receta para la pantalla: el catálogo + lo que la organización
 * ya guardó en `automation_rules`. Pura; la usan la API y los tests.
 */
import { RECETAS, esRecetaDeMensaje, type Receta } from "@/lib/recetas/catalogo";
import type { AjustesDeReceta } from "@/lib/recetas/regla";

export interface ReglaGuardada {
  id: string;
  recipe_key: string | null;
  is_active: boolean;
  run_count: number | null;
  last_run_at: string | null;
  actions: Array<{ type: string; config?: Record<string, unknown> }> | null;
}

export interface PlantillaEnMeta {
  name: string;
  status: string;
}

export interface VistaDeReceta {
  id: string;
  nombre: string;
  descripcion: string;
  trigger: string;
  accion: Receta["accion"];
  activa: boolean;
  ajustes: { texto: string; channel_session_id?: string; link?: string };
  textoSugerido: string;
  plantilla: null | {
    nombre: string;
    categoria: string;
    cuerpo: string;
    idioma: string;
    variables: string[];
    porQueCategoria: string;
    /** Estado en Meta: APPROVED, PENDING, REJECTED… o `null` si nunca se cargó. */
    estado: string | null;
  };
  corridas: number;
  ultimaCorrida: string | null;
}

/** Lo que la regla guardada dice que se editó (texto, número, link). */
export function ajustesDeRegla(receta: Receta, regla: ReglaGuardada | undefined): VistaDeReceta["ajustes"] {
  const accion = regla?.actions?.[0];
  if (!accion) return { texto: receta.texto };
  if (accion.type === "notify_owner") {
    return { texto: String(accion.config?.title ?? receta.texto) };
  }
  const cfg = accion.config ?? {};
  const values = ((cfg.meta_template as { values?: Record<string, string> } | undefined)?.values ?? {}) as Record<
    string,
    string
  >;
  const posLink = esRecetaDeMensaje(receta) ? receta.plantilla.variables.indexOf("link") : -1;
  return {
    texto: typeof cfg.template === "string" ? cfg.template : receta.texto,
    channel_session_id: typeof cfg.channel_session_id === "string" ? cfg.channel_session_id : undefined,
    link: posLink >= 0 ? values[String(posLink + 1)] : undefined,
  };
}

export function vistaDeRecetas(reglas: ReglaGuardada[], plantillas: PlantillaEnMeta[]): VistaDeReceta[] {
  const porClave = new Map(reglas.filter((r) => r.recipe_key).map((r) => [r.recipe_key as string, r]));
  const estadoDe = new Map(plantillas.map((p) => [p.name, p.status]));
  return RECETAS.map((receta) => {
    const regla = porClave.get(receta.id);
    return {
      id: receta.id,
      nombre: receta.nombre,
      descripcion: receta.descripcion,
      trigger: receta.trigger,
      accion: receta.accion,
      activa: regla?.is_active === true,
      ajustes: ajustesDeRegla(receta, regla),
      textoSugerido: receta.texto,
      plantilla: esRecetaDeMensaje(receta)
        ? {
            nombre: receta.plantilla.nombre,
            categoria: receta.plantilla.categoria,
            cuerpo: receta.plantilla.cuerpo,
            idioma: receta.plantilla.idioma,
            variables: receta.plantilla.variables,
            porQueCategoria: receta.plantilla.porQueCategoria,
            estado: estadoDe.get(receta.plantilla.nombre) ?? null,
          }
        : null,
      corridas: regla?.run_count ?? 0,
      ultimaCorrida: regla?.last_run_at ?? null,
    };
  });
}
