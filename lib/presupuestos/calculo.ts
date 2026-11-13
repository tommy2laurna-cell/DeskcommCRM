import { z } from "zod";

/**
 * La cuenta de un presupuesto, en centavos enteros.
 *
 * Todo el dinero del repo viaja en `_cents` (regla del CLAUDE.md): sin
 * flotantes, así que `0,1 + 0,2` no existe. El descuento es un porcentaje con
 * hasta dos decimales y se redondea UNA vez, sobre el subtotal — no por línea —
 * para que el PDF cierre con lo que el cliente calcula con la calculadora.
 */

export const RECIBO_LEYENDA = "Comprobante no válido como factura";

export const lineaDePresupuestoSchema = z.object({
  producto_id: z.string().uuid(),
  cantidad: z.number().int().min(1).max(100_000),
});

export const presupuestoCreateSchema = z.object({
  items: z.array(lineaDePresupuestoSchema).min(1).max(100),
  /** 0–100, hasta dos decimales. */
  descuento_pct: z.number().min(0).max(100).default(0),
  /** `YYYY-MM-DD`; la API exige que no sea una fecha pasada. */
  valido_hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notas: z.string().max(2000).optional(),
});

export type PresupuestoCreate = z.infer<typeof presupuestoCreateSchema>;

export interface LineaCalculada {
  cantidad: number;
  precioUnitCents: number;
  totalCents: number;
}

export interface TotalesDePresupuesto {
  lineas: LineaCalculada[];
  subtotalCents: number;
  descuentoCents: number;
  totalCents: number;
}

export function calcularTotales(
  lineas: Array<{ cantidad: number; precioUnitCents: number }>,
  descuentoPct: number,
): TotalesDePresupuesto {
  const calculadas = lineas.map((l) => ({
    cantidad: l.cantidad,
    precioUnitCents: l.precioUnitCents,
    totalCents: l.cantidad * l.precioUnitCents,
  }));
  const subtotalCents = calculadas.reduce((s, l) => s + l.totalCents, 0);
  // pct con 2 decimales → basis points enteros, para no multiplicar flotantes.
  const bp = Math.round(descuentoPct * 100);
  const descuentoCents = Math.round((subtotalCents * bp) / 10_000);
  return {
    lineas: calculadas,
    subtotalCents,
    descuentoCents,
    totalCents: subtotalCents - descuentoCents,
  };
}

/** `YYYY-MM-DD` de hoy en la zona dada (la de la organización). */
export function hoyEnZona(zona: string, ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zona,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ahora);
}

/** Vencido = la fecha de validez ya pasó (el último día todavía vale). */
export function estaVencido(validoHasta: string, hoy: string): boolean {
  return validoHasta < hoy;
}
