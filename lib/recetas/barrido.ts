/**
 * El reloj de las recetas: predicados PUROS que dicen "este caso ya cruzó la línea".
 * `app/api/v1/cron/recetas` los aplica sobre filas leídas de la base y emite el
 * evento; el envío (con opt-out, ventana y espaciado) es del motor, no de acá.
 *
 * Cada predicado mira una BANDA, no un umbral abierto: "quieto hace 3 días" es
 * entre 3 y 4 días. Sin banda, prender la receta dispararía contra todo lo viejo
 * de la base de una sola vez — el patrón que hace banear un número.
 */
const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

/** Los avisos de turno que ofrecen las recetas, en minutos antes del turno. */
export const AVISOS_DE_TURNO = [1440, 120] as const;

export const BANDA = {
  silencioHoras: 48,
  /** Pasadas 96 h sin respuesta el momento de insistir ya pasó. */
  silencioTopeHoras: 96,
  quietoDias: 3,
  dormidoDias: 90,
  /** Ancho de banda en días para quieto y dormido. */
  anchoDias: 1,
  anchoDormidoDias: 7,
} as const;

function ms(valor: string | Date | null | undefined): number | null {
  if (!valor) return null;
  const t = new Date(valor).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Corresponde avisar del turno `offsetMin` minutos antes.
 * Un turno sacado DENTRO de esa antelación no recibe el aviso: pedirle a alguien
 * que confirme "mañana" un turno que acaba de sacar para mañana es ruido.
 */
export function correspondeAvisoDeTurno(input: {
  agora: Date;
  comienzo: string | Date;
  creado: string | Date | null;
  offsetMin: number;
}): boolean {
  const c = ms(input.comienzo);
  if (c === null) return false;
  const ahora = input.agora.getTime();
  if (c <= ahora) return false;
  const momentoDelAviso = c - input.offsetMin * MIN;
  if (momentoDelAviso > ahora) return false;
  const creado = ms(input.creado);
  return creado === null || creado <= momentoDelAviso;
}

/** Le escribimos y no contestó: último mensaje nuestro entre 48 y 96 h atrás. */
export function estaSinRespuesta(input: {
  agora: Date;
  ultimoSaliente: string | Date | null;
  ultimoEntrante: string | Date | null;
}): boolean {
  const saliente = ms(input.ultimoSaliente);
  if (saliente === null) return false;
  const edad = input.agora.getTime() - saliente;
  if (edad < BANDA.silencioHoras * HORA || edad > BANDA.silencioTopeHoras * HORA) return false;
  const entrante = ms(input.ultimoEntrante);
  return entrante === null || entrante < saliente;
}

/** Cruzó `dias` sin actividad hace menos de `ancho` días. */
export function cruzoLaLinea(input: {
  agora: Date;
  ultimaActividad: string | Date | null;
  dias: number;
  anchoDias: number;
}): boolean {
  const ultima = ms(input.ultimaActividad);
  if (ultima === null) return false;
  const edad = input.agora.getTime() - ultima;
  return edad >= input.dias * DIA && edad < (input.dias + input.anchoDias) * DIA;
}

export const estaQuieto = (agora: Date, ultimaActividad: string | Date | null) =>
  cruzoLaLinea({ agora, ultimaActividad, dias: BANDA.quietoDias, anchoDias: BANDA.anchoDias });

export const estaDormido = (agora: Date, ultimaActividad: string | Date | null) =>
  cruzoLaLinea({ agora, ultimaActividad, dias: BANDA.dormidoDias, anchoDias: BANDA.anchoDormidoDias });
