"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { REGLAS_POR_DEFECTO, type ReglasDePuntaje } from "@/lib/puntaje/reglas";

export const CLAVE_PUNTAJE_REGLAS = ["puntaje-reglas"] as const;

/**
 * Las reglas del puntaje de la organización, para el tablero.
 *
 * Si la lectura falla, el tablero sigue con las reglas por defecto: un número
 * aproximado es mejor que una columna sin orden, y la pantalla de configuración
 * (que sí muestra el error) es donde se arregla.
 */
export function usePuntajeReglas(): ReglasDePuntaje {
  const { data } = useQuery({
    queryKey: CLAVE_PUNTAJE_REGLAS,
    queryFn: async () => {
      const res = await apiClient.get<{ data: ReglasDePuntaje }>("/api/v1/settings/puntaje");
      return (res as { data?: ReglasDePuntaje }).data ?? REGLAS_POR_DEFECTO;
    },
    staleTime: 60_000,
  });
  return data ?? REGLAS_POR_DEFECTO;
}
