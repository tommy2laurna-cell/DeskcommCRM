/**
 * Tablero del dueño (GC5): ventana de período, filtros que abren la lista y CSV
 * para Excel argentino (separador «;», coma decimal, BOM UTF-8).
 * Las definiciones de cada número viven en la migración 0290.
 */
export const PERIODOS = { "7": 7, "30": 30, "90": 90 } as const;
export type Periodo = keyof typeof PERIODOS;

export function ventanaDelPeriodo(
  periodo: string | null,
  ahora = new Date(),
): { from: Date; to: Date; periodo: Periodo } {
  const p: Periodo = periodo === "7" || periodo === "90" ? periodo : "30";
  return { from: new Date(ahora.getTime() - PERIODOS[p] * 86_400_000), to: ahora, periodo: p };
}

export type TipoDeLista = "nuevos" | "ganados" | "perdidos";

export interface FiltroDeLista {
  tipo: TipoDeLista;
  from: string;
  to: string;
  source?: string;
  owner?: string;
  /** «Alcanzaron la etapa»: id de la etapa. */
  stage?: string;
}

/** El filtro que produjo el número: el tablero lo pone en el link y la lista lo aplica tal cual. */
export function urlDeLista(f: FiltroDeLista): string {
  const q = new URLSearchParams({ tipo: f.tipo, from: f.from, to: f.to });
  if (f.source) q.set("source", f.source);
  if (f.owner) q.set("owner", f.owner);
  if (f.stage) q.set("stage", f.stage);
  return `/app/metrics/lista?${q.toString()}`;
}

export function celdaCsv(v: string | number | null | undefined): string {
  if (v == null) return "";
  let s = typeof v === "number" ? String(v).replace(".", ",") : v;
  // Fórmulas en Excel: una celda de texto no puede arrancar con = + - @.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function aCsv(encabezado: string[], filas: (string | number | null)[][]): string {
  const lineas = [encabezado, ...filas].map((f) => f.map(celdaCsv).join(";"));
  return "﻿" + lineas.join("\r\n") + "\r\n";
}

export const pesos = (cents: number): string =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(
    cents / 100,
  );

export interface TableroDatos {
  por_origen: { source: string; count: number }[];
  etapas: { stage_id: string; stage_name: string; pipeline_id: string; position: number; alcanzaron: number }[];
  ventas: { ganados: number; monto_ars_cents: number; ganados_otra_moneda: number };
  primera_respuesta_segundos: number | null;
  por_usuario: {
    user_id: string;
    nuevos: number;
    ganados: number;
    monto_ars_cents: number;
    perdidos: number;
    primera_respuesta_segundos: number | null;
    name?: string | null;
    email?: string | null;
  }[];
}

/** Conversión etapa a etapa (dentro de un mismo embudo): alcanzaron(i) / alcanzaron(i-1). */
export function conversiones(etapas: TableroDatos["etapas"]): (number | null)[] {
  return etapas.map((e, i) => {
    const prev = etapas[i - 1];
    if (!prev || prev.pipeline_id !== e.pipeline_id || prev.alcanzaron === 0) return null;
    return e.alcanzaron / prev.alcanzaron;
  });
}

export function tableroACsv(d: TableroDatos, periodo: string): string {
  const filas: (string | number | null)[][] = [
    ["Resumen", "Ventas ganadas", d.ventas.ganados],
    ["Resumen", "Ventas en ARS", d.ventas.monto_ars_cents / 100],
    [
      "Resumen",
      "1ª respuesta (segundos)",
      d.primera_respuesta_segundos == null ? null : Math.round(d.primera_respuesta_segundos),
    ],
    ...d.por_origen.map((o): (string | number | null)[] => ["Prospectos por origen", o.source, o.count]),
    ...d.etapas.map((e): (string | number | null)[] => ["Alcanzaron la etapa", e.stage_name, e.alcanzaron]),
    ...d.por_usuario.map((u): (string | number | null)[] => [
      "Por usuario",
      u.name ?? u.email ?? u.user_id,
      `nuevos ${u.nuevos}; ganados ${u.ganados}; perdidos ${u.perdidos}; ARS ${u.monto_ars_cents / 100}`,
    ]),
  ];
  return aCsv([`Período (${periodo} días)`, "Dato", "Valor"], filas);
}
