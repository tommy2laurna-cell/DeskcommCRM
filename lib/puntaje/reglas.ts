import { z } from "zod";

/**
 * PUNTAJE DE PRIORIDAD — «a quién llamo primero».
 *
 * Es una suma de reglas que la organización configura, sin IA. No es la
 * probabilidad de cierre de `lib/leads/score-formula.ts` (esa sale de lo que dijo
 * el cliente en la conversación): esta responde otra pregunta, y por eso vive
 * aparte y no pisa nada.
 *
 * Cada regla que sumó o restó queda en `factores` con su texto, así que el
 * «por qué» de la tarjeta se arma con los mismos datos del cálculo y no puede
 * discrepar del número.
 */

const puntos = z.number().int().min(-100).max(100);

export const reglasDePuntajeSchema = z.object({
  /** Puntos si el cliente escribió y falta atenderlo. */
  respondio: z.object({ puntos }),
  diasSinContacto: z.object({
    /** Se aplica el tramo más alto alcanzado, no la suma de todos. */
    tramos: z.array(z.object({ desdeDias: z.number().int().min(0).max(365), puntos })).max(6),
  }),
  /** Puntos por etapa, por id de etapa. Sin entrada = 0. */
  etapa: z.record(z.string(), puntos),
  valor: z.object({
    tramos: z.array(z.object({ desdePesos: z.number().min(0), puntos })).max(6),
  }),
  /** Puntos por origen (`crm_leads.source`), clave en minúsculas. */
  origen: z.record(z.string(), puntos),
});

export type ReglasDePuntaje = z.infer<typeof reglasDePuntajeSchema>;

/** Lo que el puntaje lee de un negocio. Nada que no esté ya en el tablero. */
export interface EntradaDePuntaje {
  stageId: string;
  valueCents: number | null;
  source: string | null;
  /** `last_activity_at`, o `created_at` si nunca hubo actividad. */
  ultimoContactoEn: string | null;
  /** El cliente escribió y nadie lo atendió todavía. */
  clienteEscribio: boolean;
}

export interface FactorDePuntaje {
  regla: "respondio" | "diasSinContacto" | "etapa" | "valor" | "origen";
  puntos: number;
  /** Español rioplatense, listo para mostrar. */
  texto: string;
}

export interface PuntajeCalculado {
  total: number;
  factores: FactorDePuntaje[];
}

/** Con esto arranca una organización que todavía no configuró nada. */
export const REGLAS_POR_DEFECTO: ReglasDePuntaje = {
  respondio: { puntos: 25 },
  diasSinContacto: {
    tramos: [
      { desdeDias: 3, puntos: -10 },
      { desdeDias: 7, puntos: -25 },
      { desdeDias: 15, puntos: -40 },
    ],
  },
  etapa: {},
  valor: { tramos: [] },
  origen: {},
};

const MS_DIA = 86_400_000;

export function diasEntre(desdeIso: string | null, ahora: Date): number | null {
  if (!desdeIso) return null;
  const t = Date.parse(desdeIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((ahora.getTime() - t) / MS_DIA));
}

/** `+25` / `−10`, con el signo que se lee bien en una tarjeta. */
export function conSigno(n: number): string {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/**
 * Suma las reglas. Una regla que da 0 no entra en `factores`: el «por qué» solo
 * muestra lo que movió el número. Sin tope: el que ordena es el total, y un tope
 * haría empatar a dos negocios que no valen lo mismo.
 */
export function calcularPuntaje(
  entrada: EntradaDePuntaje,
  reglas: ReglasDePuntaje,
  ahora: Date = new Date(),
  nombreDeEtapa: (id: string) => string = () => "esta etapa",
): PuntajeCalculado {
  const factores: FactorDePuntaje[] = [];
  const suma = (f: FactorDePuntaje) => {
    if (f.puntos !== 0) factores.push(f);
  };

  if (entrada.clienteEscribio) {
    suma({
      regla: "respondio",
      puntos: reglas.respondio.puntos,
      texto: "El cliente escribió y falta atenderlo",
    });
  }

  const dias = diasEntre(entrada.ultimoContactoEn, ahora);
  if (dias !== null) {
    const tramo = reglas.diasSinContacto.tramos
      .filter((t) => dias >= t.desdeDias)
      .sort((a, b) => b.desdeDias - a.desdeDias)[0];
    if (tramo) {
      suma({
        regla: "diasSinContacto",
        puntos: tramo.puntos,
        texto: `${dias} ${dias === 1 ? "día" : "días"} sin contacto`,
      });
    }
  }

  const deEtapa = reglas.etapa[entrada.stageId];
  if (deEtapa !== undefined) {
    suma({ regla: "etapa", puntos: deEtapa, texto: `Está en ${nombreDeEtapa(entrada.stageId)}` });
  }

  if (entrada.valueCents !== null) {
    const pesos = entrada.valueCents / 100;
    const tramo = reglas.valor.tramos
      .filter((t) => pesos >= t.desdePesos)
      .sort((a, b) => b.desdePesos - a.desdePesos)[0];
    if (tramo) {
      suma({
        regla: "valor",
        puntos: tramo.puntos,
        texto: `Valor desde ${tramo.desdePesos.toLocaleString("es-AR")}`,
      });
    }
  }

  const origen = entrada.source?.trim().toLowerCase();
  const deOrigen = origen ? reglas.origen[origen] : undefined;
  if (origen && deOrigen !== undefined) {
    suma({ regla: "origen", puntos: deOrigen, texto: `Origen: ${origen}` });
  }

  const total = factores.reduce((s, f) => s + f.puntos, 0);
  return { total, factores };
}

/** Lee lo guardado en `organizations.settings.puntaje`; lo roto cae al defecto. */
export function reglasDeLaOrganizacion(settings: unknown): ReglasDePuntaje {
  const crudo = (settings as { puntaje?: unknown } | null)?.puntaje;
  const r = reglasDePuntajeSchema.safeParse(crudo);
  return r.success ? r.data : REGLAS_POR_DEFECTO;
}
