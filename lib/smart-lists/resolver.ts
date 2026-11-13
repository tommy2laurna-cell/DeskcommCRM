/**
 * LISTAS INTELIGENTES — traduce los filtros guardados a la consulta de Supabase.
 *
 * La lista guarda FILTROS, no contactos: la membresía se recalcula en cada
 * lectura con `fn_smart_list_contacts` (migración 0278). Este módulo es la parte
 * pura — validar el jsonb y convertirlo en los argumentos de la función — más un
 * lector paginado por keyset (`id > cursor`), que mantiene la URL del request del
 * mismo tamaño aunque la lista tenga miles de contactos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { partesNoFuso } from "@/lib/agenda/fuso";

const DIA_MS = 86_400_000;
export const FUSO_PADRAO = "America/Argentina/Buenos_Aires";

export const filtrosDeListaSchema = z
  .object({
    /** El contacto tiene AL MENOS una de estas etiquetas. */
    etiquetas: z.array(z.string().trim().min(1).max(60)).min(1).max(20).optional(),
    /** Tiene un negocio abierto en alguna de estas etapas. */
    etapas: z.array(z.string().uuid()).min(1).max(50).optional(),
    /** `contacts.source` es alguno de estos. */
    origenes: z.array(z.string().trim().min(1).max(60)).min(1).max(20).optional(),
    /** Puntaje de lead (0–100) de su negocio abierto. */
    puntaje_min: z.number().min(0).max(100).optional(),
    puntaje_max: z.number().min(0).max(100).optional(),
    /** Último contacto hace MÁS de N días (quien nunca tuvo actividad cuenta). */
    dias_sin_contacto: z.number().int().min(1).max(3650).optional(),
    /** "actual" = mes en curso, o 1–12. */
    cumpleanos_mes: z.union([z.literal("actual"), z.number().int().min(1).max(12)]).optional(),
  })
  .strict()
  .refine((f) => Object.values(f).some((v) => v !== undefined), {
    message: "Elegí al menos un filtro.",
  })
  .refine(
    (f) => f.puntaje_min === undefined || f.puntaje_max === undefined || f.puntaje_min <= f.puntaje_max,
    { message: "El puntaje mínimo no puede superar al máximo.", path: ["puntaje_min"] },
  );

export type FiltrosDeLista = z.infer<typeof filtrosDeListaSchema>;

/** Argumentos de `fn_smart_list_contacts`; `null` = sin ese filtro. */
export interface ArgsDeLista {
  p_org: string;
  p_tags: string[] | null;
  p_stage_ids: string[] | null;
  p_sources: string[] | null;
  p_score_min: number | null;
  p_score_max: number | null;
  p_inactive_before: string | null;
  p_birthday_month: number | null;
}

/** Pura: mismo filtro + mismo instante = mismos argumentos. */
export function filtrosAArgumentos(
  organizationId: string,
  filtros: FiltrosDeLista,
  ahora: Date = new Date(),
  fuso: string = FUSO_PADRAO,
): ArgsDeLista {
  const mes =
    filtros.cumpleanos_mes === undefined
      ? null
      : filtros.cumpleanos_mes === "actual"
        ? partesNoFuso(ahora, fuso).mes
        : filtros.cumpleanos_mes;
  return {
    p_org: organizationId,
    p_tags: filtros.etiquetas ?? null,
    p_stage_ids: filtros.etapas ?? null,
    p_sources: filtros.origenes ?? null,
    p_score_min: filtros.puntaje_min ?? null,
    p_score_max: filtros.puntaje_max ?? null,
    p_inactive_before:
      filtros.dias_sin_contacto === undefined
        ? null
        : new Date(ahora.getTime() - filtros.dias_sin_contacto * DIA_MS).toISOString(),
    p_birthday_month: mes,
  };
}

export interface ContactoDeLista {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  is_blocked: boolean;
  consent: unknown;
}

export const COLUNAS_DE_CONTACTO = "id, name, display_name, phone_number, is_blocked, consent";

export interface OpcionesDePagina {
  /** Último `id` de la página anterior (keyset). */
  despues?: string | null;
  limite?: number;
  ahora?: Date;
  fuso?: string;
  /** Pide el total exacto (una consulta más cara: solo para la primera página). */
  contar?: boolean;
}

export interface PaginaDeContactos {
  contactos: ContactoDeLista[];
  total: number | null;
  siguiente: string | null;
}

/**
 * Una página de la lista. Paginar por `id` (y no por offset) es lo que permite
 * recorrer la lista entera sin una URL que crezca y sin saltarse ni repetir
 * contactos si la membresía cambia en el medio.
 */
export async function leerPaginaDeLista(
  db: SupabaseClient,
  organizationId: string,
  filtros: FiltrosDeLista,
  opciones: OpcionesDePagina = {},
): Promise<PaginaDeContactos> {
  const limite = Math.min(Math.max(opciones.limite ?? 50, 1), 500);
  const args = filtrosAArgumentos(organizationId, filtros, opciones.ahora, opciones.fuso);

  let consulta = db
    .rpc("fn_smart_list_contacts", args, opciones.contar ? { count: "exact" } : undefined)
    .select(COLUNAS_DE_CONTACTO)
    .order("id", { ascending: true })
    .limit(limite + 1);
  if (opciones.despues) consulta = consulta.gt("id", opciones.despues);

  const { data, error, count } = await consulta;
  if (error) throw new Error(`smart_list_query_failed: ${error.message}`);

  const filas = (data ?? []) as unknown as ContactoDeLista[];
  const hayMas = filas.length > limite;
  const contactos = hayMas ? filas.slice(0, limite) : filas;
  return {
    contactos,
    total: count ?? null,
    siguiente: hayMas ? contactos[contactos.length - 1]!.id : null,
  };
}
