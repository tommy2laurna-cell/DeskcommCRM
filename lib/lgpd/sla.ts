/**
 * Plazos del titular de los datos en Argentina (Ley 25.326) y, debajo, el
 * calculador de días hábiles de Brasil que sigue usando `store_redact`.
 *
 * Solo dos cifras salen de la ley, y son las únicas que este archivo afirma:
 *   - acceso: 10 días corridos desde la intimación (art. 14 inc. 2);
 *   - rectificación, actualización o supresión: 5 días hábiles desde que se
 *     recibe el reclamo (art. 16 inc. 2).
 *
 * Lo que la ley no dice y queda ⚖ para el abogado (ver `ABIERTO_PARA_ABOGADO`):
 * qué feriados cuentan como inhábiles, si el plazo arranca el día siguiente y
 * si un pedido cargado en el CRM vale como «intimación fehaciente».
 *
 * Mientras tanto la cuenta es la PRUDENTE: hábil = lunes a viernes, sin restar
 * feriados. Contar un feriado como hábil da un vencimiento igual o ANTERIOR al
 * legal, nunca posterior.
 */

/** Tipos de pedido que tienen plazo en la Ley 25.326. */
export type PedidoDelTitular = "data_request" | "redact";

export interface PlazoLegal {
  dias: number;
  tipo: "corridos" | "habiles";
  fuente: string;
}

export const PLAZOS_LEY_25326: Record<PedidoDelTitular, PlazoLegal> = {
  data_request: { dias: 10, tipo: "corridos", fuente: "Ley 25.326, art. 14 inc. 2" },
  redact: { dias: 5, tipo: "habiles", fuente: "Ley 25.326, art. 16 inc. 2" },
};

/** ⚖ Lo que este cálculo supone y la ley no fija. Cada una espera al abogado. */
export const ABIERTO_PARA_ABOGADO = [
  "⚖ Feriados: hoy no se restan (cuenta prudente). ¿Qué calendario de inhábiles aplica al art. 16?",
  "⚖ Inicio: se cuenta desde el día siguiente a la recepción, en hora de Buenos Aires.",
  "⚖ ¿Un pedido cargado por el admin en el CRM equivale a la «intimación fehaciente» del art. 14?",
] as const;

/** Argentina no tiene horario de verano hoy: UTC−03:00 fijo. */
const OFFSET_AR_MS = 3 * 60 * 60 * 1000;

/**
 * Vence al terminar (23:59:59.999, hora de Buenos Aires) el día N contado desde
 * el día siguiente a `recibido`. Con `habiles` se saltean sábado y domingo.
 */
export function vencimientoLegalAR(tipoDePedido: PedidoDelTitular, recibido: Date): Date {
  const { dias, tipo } = PLAZOS_LEY_25326[tipoDePedido];
  // Fecha calendario en Buenos Aires, como medianoche UTC para contar días.
  const local = new Date(recibido.getTime() - OFFSET_AR_MS);
  let cursor = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  let faltan = dias;
  while (faltan > 0) {
    cursor = addOneDay(cursor);
    const dow = cursor.getUTCDay();
    if (tipo === "corridos" || (dow !== 0 && dow !== 6)) faltan--;
  }
  // Fin de ese día en Buenos Aires = inicio del siguiente + 3 h − 1 ms (UTC).
  return new Date(addOneDay(cursor).getTime() + OFFSET_AR_MS - 1);
}

/**
 * LGPD SLA business-day calculator (Brasil). Solo `store_redact` lo usa.
 *
 * Rules (L-04):
 *  - SLA is expressed in Brazilian business days (dias úteis).
 *  - Skip Saturdays (getDay()===6) and Sundays (getDay()===0).
 *  - Skip Brazilian national holidays from HOLIDAYS_BR_ISO.
 *  - If receivedAt itself is not a business day, counting starts on the
 *    next business day (edge: weekend/holiday receipt).
 */

import { HOLIDAYS_BR_ISO } from "./holidays-br";

const _defaultHolidays = new Set(HOLIDAYS_BR_ISO);

/**
 * Format a Date to YYYY-MM-DD (UTC-based, suitable for set lookup when
 * dates are constructed as UTC midnight + 1-day increments).
 */
function toISODateStr(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns true when the given Date (treated as a UTC midnight point) is
 * a business day — not Saturday, not Sunday, not in the holidays set.
 */
function isBusinessDay(date: Date, holidays: Set<string>): boolean {
  const dow = date.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(toISODateStr(date));
}

/**
 * Advance date by one calendar day (UTC).
 */
function addOneDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

/**
 * Compute the due date for an LGPD SLA.
 *
 * @param receivedAt   Timestamp when the request was received.
 * @param businessDays Number of business days allowed (e.g. 15 for redact).
 * @param holidays     Override holiday set; defaults to HOLIDAYS_BR_ISO.
 * @returns            Date representing end of the Nth business day (00:00 UTC of that day).
 */
export function computeDueAt(
  receivedAt: Date,
  businessDays: number,
  holidays: Set<string> = _defaultHolidays,
): Date {
  // Normalise to UTC midnight of the received day
  let cursor = new Date(
    Date.UTC(receivedAt.getUTCFullYear(), receivedAt.getUTCMonth(), receivedAt.getUTCDate()),
  );

  // If receivedAt itself is not a business day, advance to the first business day
  if (!isBusinessDay(cursor, holidays)) {
    cursor = addOneDay(cursor);
    while (!isBusinessDay(cursor, holidays)) {
      cursor = addOneDay(cursor);
    }
  }

  // Count N business days starting from (and including) the first business day
  let remaining = businessDays;
  while (remaining > 0) {
    cursor = addOneDay(cursor);
    if (isBusinessDay(cursor, holidays)) {
      remaining--;
    }
  }

  return cursor;
}
