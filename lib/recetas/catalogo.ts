/**
 * RECETAS: automatizaciones típicas, apagadas por defecto, que se prenden con un
 * clic y se editan. NO son un motor nuevo: cada receta es una fila de
 * `automation_rules` (trigger + condiciones + acciones) que el motor de
 * `lib/automation/engine.ts` ya ejecuta, con sus guardas de siempre —
 * opt-out/consentimiento, ventana horaria del número y espaciado anti-ban.
 *
 * Las recetas de tiempo (48 h sin respuesta, 3 días quieto, turno 24 h/2 h,
 * 90 días dormido) necesitan alguien que mire el reloj: eso lo hace
 * `app/api/v1/cron/recetas`, que SOLO emite eventos; el envío sigue siendo del motor.
 *
 * Fuera de la ventana de 24 h de Meta solo salen plantillas aprobadas, así que
 * toda receta que manda texto lleva `plantilla`: el texto sugerido (en español),
 * su categoría y las variables ({{1}}, {{2}}) que el motor completa al enviar.
 * Está pensado para copiarse tal cual a /settings/templates y mandar a aprobar.
 */
import type { GatilhoDeAutomacao } from "@/lib/schemas/webhooks";

export type CategoriaDePlantilla = "UTILITY" | "MARKETING";

/** Variables que el motor sabe resolver desde el contexto de la regla. */
export type VariableDeReceta = "nombre" | "turno" | "link";

export interface PlantillaSugerida {
  /** Nombre en Meta: minúsculas y guion bajo. */
  nombre: string;
  idioma: "es_AR";
  categoria: CategoriaDePlantilla;
  /** Cuerpo con {{1}}, {{2}}... en orden. Nunca empieza ni termina con variable. */
  cuerpo: string;
  /** Qué va en cada {{n}}, en orden. */
  variables: VariableDeReceta[];
  /** Por qué esa categoría (Meta decide y puede reclasificar). */
  porQueCategoria: string;
}

export interface CondicionDeReceta {
  field: string;
  op: "eq" | "neq" | "contains";
  value: string;
}

interface RecetaBase {
  id: string;
  nombre: string;
  descripcion: string;
  trigger: GatilhoDeAutomacao;
  condiciones: CondicionDeReceta[];
}

export interface RecetaDeMensaje extends RecetaBase {
  accion: "mensaje";
  /** Texto libre (dentro de la ventana de 24 h). Se edita desde la pantalla. */
  texto: string;
  plantilla: PlantillaSugerida;
}

export interface RecetaDeAviso extends RecetaBase {
  accion: "aviso_al_responsable";
  /** Título de la tarea que se le crea al responsable. */
  texto: string;
}

export type Receta = RecetaDeMensaje | RecetaDeAviso;

export const RECETAS: readonly Receta[] = [
  {
    id: "bienvenida",
    nombre: "Bienvenida al prospecto",
    descripcion: "Saluda apenas entra un prospecto nuevo.",
    trigger: "lead.created",
    condiciones: [],
    accion: "mensaje",
    texto: "¡Hola {{nombre}}! Gracias por escribirnos. En breve te respondemos. ¿Qué estás buscando?",
    plantilla: {
      nombre: "bienvenida_prospecto",
      idioma: "es_AR",
      categoria: "UTILITY",
      cuerpo:
        "¡Hola {{1}}! Recibimos tu consulta y en breve te respondemos. Si querés ir adelantando, contanos qué estás buscando.",
      variables: ["nombre"],
      porQueCategoria: "Responde a una consulta que la persona inició.",
    },
  },
  {
    id: "recordatorio_24h",
    nombre: "Recordatorio de turno, 24 h antes",
    descripcion: "Avisa el día anterior y pide confirmar.",
    trigger: "appointment.reminder",
    condiciones: [{ field: "event.offset_minutes", op: "eq", value: "1440" }],
    accion: "mensaje",
    texto: "Hola {{nombre}}, te recordamos tu turno: {{turno}}. Si no podés venir, avisanos por acá y lo reprogramamos.",
    plantilla: {
      nombre: "recordatorio_turno_24h",
      idioma: "es_AR",
      categoria: "UTILITY",
      cuerpo:
        "Hola {{1}}, te recordamos tu turno: {{2}}. Si no podés venir, avisanos por acá y lo reprogramamos.",
      variables: ["nombre", "turno"],
      porQueCategoria: "Recordatorio de un turno que la persona ya sacó.",
    },
  },
  {
    id: "recordatorio_2h",
    nombre: "Recordatorio de turno, 2 h antes",
    descripcion: "Último aviso, dos horas antes del turno.",
    trigger: "appointment.reminder",
    condiciones: [{ field: "event.offset_minutes", op: "eq", value: "120" }],
    accion: "mensaje",
    texto: "{{nombre}}, tu turno es en 2 horas: {{turno}}. ¡Te esperamos!",
    plantilla: {
      nombre: "recordatorio_turno_2h",
      idioma: "es_AR",
      categoria: "UTILITY",
      cuerpo: "Hola {{1}}, tu turno es en 2 horas: {{2}}. ¡Te esperamos!",
      variables: ["nombre", "turno"],
      porQueCategoria: "Recordatorio de un turno que la persona ya sacó.",
    },
  },
  {
    id: "seguimiento_48h",
    nombre: "Seguimiento si no responde en 48 h",
    descripcion: "Un solo mensaje si el prospecto no contestó en dos días.",
    trigger: "contact.silent",
    condiciones: [],
    accion: "mensaje",
    texto: "Hola {{nombre}}, ¿pudiste ver lo que te mandamos? Si querés, lo vemos juntos.",
    plantilla: {
      nombre: "seguimiento_sin_respuesta",
      idioma: "es_AR",
      categoria: "MARKETING",
      cuerpo: "Hola {{1}}, ¿pudiste ver lo que te mandamos? Si querés, lo vemos juntos y te ayudamos a avanzar.",
      variables: ["nombre"],
      porQueCategoria: "Insiste sin que la persona haya pedido nada nuevo: Meta lo trata como promocional.",
    },
  },
  {
    id: "lead_quieto_3d",
    nombre: "Aviso al responsable: 3 días sin movimiento",
    descripcion: "Crea una tarea para el responsable cuando un prospecto abierto lleva 3 días sin actividad.",
    trigger: "lead.idle",
    condiciones: [],
    accion: "aviso_al_responsable",
    texto: "Prospecto sin movimiento hace 3 días: {{nombre}}",
  },
  {
    id: "reactivacion_90d",
    nombre: "Reactivación a los 90 días",
    descripcion: "Retoma el contacto con quien no habla con vos hace 90 días.",
    trigger: "contact.dormant",
    condiciones: [],
    accion: "mensaje",
    texto: "Hola {{nombre}}, hace un tiempo que no hablamos. ¿Te puedo ayudar con algo?",
    plantilla: {
      nombre: "reactivacion_90_dias",
      idioma: "es_AR",
      categoria: "MARKETING",
      cuerpo: "Hola {{1}}, hace un tiempo que no hablamos. ¿Te puedo ayudar con algo? Escribinos cuando quieras.",
      variables: ["nombre"],
      porQueCategoria: "Retoma un contacto dormido por iniciativa del negocio.",
    },
  },
  {
    id: "cumpleanos",
    nombre: "Saludo de cumpleaños",
    descripcion: "Un saludo el día del cumpleaños, a las 9.",
    trigger: "contact.birthday",
    condiciones: [],
    accion: "mensaje",
    texto: "¡Feliz cumpleaños, {{nombre}}! Que tengas un día hermoso. Un abrazo de todo el equipo.",
    plantilla: {
      nombre: "saludo_cumpleanos",
      idioma: "es_AR",
      categoria: "MARKETING",
      cuerpo: "¡Feliz cumpleaños, {{1}}! Que tengas un día hermoso. Un abrazo de todo el equipo.",
      variables: ["nombre"],
      porQueCategoria: "Saludo de relación comercial, no responde a un pedido.",
    },
  },
  {
    id: "resena",
    nombre: "Pedido de reseña al cerrar",
    descripcion: "Manda el link de Google al pasar un prospecto a ganado. Sin IA.",
    trigger: "lead.stage_changed",
    condiciones: [{ field: "lead.status", op: "eq", value: "won" }],
    accion: "mensaje",
    // El link va en el texto: lo pega quien prende la receta (ver TEXTO_CON_LINK).
    texto: "¡Gracias por elegirnos, {{nombre}}! Si te gustó la atención, nos ayuda mucho una reseña: [pegá acá el link de Google]",
    plantilla: {
      nombre: "pedido_resena",
      idioma: "es_AR",
      categoria: "UTILITY",
      cuerpo: "¡Gracias por elegirnos, {{1}}! Si te gustó la atención, tu opinión nos ayuda mucho. Podés dejarla en este enlace: {{2}} ¡Gracias!",
      variables: ["nombre", "link"],
      porQueCategoria: "Encuesta posterior a una compra ya hecha. Meta puede reclasificarla como marketing.",
    },
  },
] as const;

/** La receta de reseña lleva un marcador que hay que reemplazar por el link real. */
export const MARCADOR_DE_LINK = "[pegá acá el link de Google]";

export function recetaPorId(id: string): Receta | undefined {
  return RECETAS.find((r) => r.id === id);
}

export function esRecetaDeMensaje(r: Receta): r is RecetaDeMensaje {
  return r.accion === "mensaje";
}

/** Un texto con el marcador sin reemplazar nunca debe salir al cliente. */
export function textoListoParaEnviar(texto: string): boolean {
  return texto.trim().length > 0 && !texto.includes(MARCADOR_DE_LINK);
}
