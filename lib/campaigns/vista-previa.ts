/**
 * Vista previa de una campaña: el mensaje tal como lo leerá el contacto, a
 * cuántos llega, a cuántos se excluye y — solo si hay tarifa cargada — cuánto
 * cuesta. Misma regla de exclusión que usa el envío (`clasificarContacto`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { renderTemplateBody } from "@/lib/channels/meta/render-template";
import {
  leerPaginaDeLista,
  type ContactoDeLista,
  type FiltrosDeLista,
  type PaginaDeContactos,
} from "@/lib/smart-lists/resolver";

import { tieneBotonDeBaja } from "./boton-de-baja";
import { estimarCosto, type CategoriaDeMensaje, type CostoEstimado, type Tarifa } from "./costo";
import { resumirDestinatarios, type ResumenDeDestinatarios } from "./destinatarios";

/** Tope de seguridad: una lista más grande que esto no entra en una campaña. */
export const MAX_DESTINATARIOS = 20_000;
const PAGINA = 500;

export class ListaDemasiadoGrande extends Error {
  constructor() {
    super("lista_demasiado_grande");
  }
}

/** Recorre TODA la lista por keyset, página a página. */
export async function recorrerLista(
  db: SupabaseClient,
  organizationId: string,
  filtros: FiltrosDeLista,
  porPagina: (contactos: ContactoDeLista[]) => Promise<void>,
): Promise<number> {
  let despues: string | null = null;
  let vistos = 0;
  do {
    const p: PaginaDeContactos = await leerPaginaDeLista(db, organizationId, filtros, { despues, limite: PAGINA });
    vistos += p.contactos.length;
    if (vistos > MAX_DESTINATARIOS) throw new ListaDemasiadoGrande();
    if (p.contactos.length > 0) await porPagina(p.contactos);
    despues = p.siguiente;
  } while (despues);
  return vistos;
}

export interface MensajeAprobado {
  name: string;
  language: string;
  status: string;
  category: string | null;
  components: unknown;
  parameter_format?: string | null;
}

export interface VistaPrevia {
  mensaje: { texto: string; categoria: CategoriaDeMensaje; tiene_boton_de_baja: boolean };
  destinatarios: ResumenDeDestinatarios;
  costo: CostoEstimado;
}

export function categoriaDelMensaje(category: string | null): CategoriaDeMensaje {
  const c = (category ?? "").toLowerCase();
  return c === "utility" || c === "authentication" ? c : "marketing";
}

export async function calcularVistaPrevia(
  db: SupabaseClient,
  input: {
    organizationId: string;
    filtros: FiltrosDeLista;
    mensaje: MensajeAprobado;
    valores: Record<string, string>;
    tarifa: Tarifa | null;
  },
): Promise<VistaPrevia> {
  const resumen: ResumenDeDestinatarios = {
    total: 0,
    efectivos: 0,
    excluidos_optout: 0,
    excluidos_sin_telefono: 0,
  };
  await recorrerLista(db, input.organizationId, input.filtros, async (contactos) => {
    const r = resumirDestinatarios(contactos);
    resumen.total += r.total;
    resumen.efectivos += r.efectivos;
    resumen.excluidos_optout += r.excluidos_optout;
    resumen.excluidos_sin_telefono += r.excluidos_sin_telefono;
  });

  const categoria = categoriaDelMensaje(input.mensaje.category);
  return {
    mensaje: {
      texto: renderTemplateBody(input.mensaje.components, input.valores, {
        name: input.mensaje.name,
        language: input.mensaje.language,
        ...(input.mensaje.parameter_format ? { parameterFormat: input.mensaje.parameter_format } : {}),
      }),
      categoria,
      tiene_boton_de_baja: tieneBotonDeBaja(input.mensaje.components),
    },
    destinatarios: resumen,
    costo: estimarCosto(resumen.efectivos, categoria, input.tarifa),
  };
}
