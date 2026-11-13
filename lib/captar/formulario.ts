/**
 * FORMULARIOS Y ENCUESTAS PÚBLICOS — la definición y la validación del envío.
 *
 * El envío NO se guarda acá: `payloadDelEnvio` arma el cuerpo que la captación
 * de siempre (`/api/v1/webhooks/in/[token]`) ya sabe convertir en contacto +
 * lead + historial. Este archivo solo decide qué es un envío válido.
 *
 * Tres campos son fijos y tienen id reservado (`nombre`, `telefono`, `email`):
 * son los que la captación reconoce como nombre, teléfono y e-mail. Un contacto
 * no nace sin teléfono, así que `telefono` es obligatorio en toda definición.
 * El resto son campos libres; su respuesta se guarda bajo el rótulo del campo.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { normalizePhoneBR } from "@/lib/webhooks/inbound";

export const TIPOS_DE_CAMPO = ["texto", "telefono", "email", "opcion", "si_no", "fecha"] as const;
export type TipoDeCampo = (typeof TIPOS_DE_CAMPO)[number];

export const ID_NOMBRE = "nombre";
export const ID_TELEFONO = "telefono";
export const ID_EMAIL = "email";

/** El señuelo: un humano no lo ve; un bot que rellena todo, sí lo completa. */
export const CAMPO_SENUELO = "sitio_web";
/** Valores de «sí/no» tal como se muestran y se guardan. */
export const RESPUESTAS_SI_NO = ["Sí", "No"] as const;
/** Utm que el link o la web pasan al formulario. */
export const CLAVES_UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

const MAX_TEXTO = 500;

export const campoSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    label: z.string().trim().min(1).max(120),
    tipo: z.enum(TIPOS_DE_CAMPO),
    requerido: z.boolean().default(false),
    opciones: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.tipo === "opcion" && (!c.opciones || c.opciones.length < 2)) {
      ctx.addIssue({ code: "custom", message: "opcion_necesita_2_opciones", path: ["opciones"] });
    }
  });
export type Campo = z.infer<typeof campoSchema>;

export const definicionSchema = z
  .object({
    kind: z.enum(["formulario", "encuesta"]).default("formulario"),
    name: z.string().trim().min(1).max(120),
    fields: z.array(campoSchema).min(1).max(30),
    pipeline_id: z.string().uuid(),
    stage_id: z.string().uuid(),
    tags: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
    thanks_message: z.string().trim().max(500).default(""),
    consent_text: z.string().trim().max(1000).default(""),
    is_active: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    const ids = new Set<string>();
    const rotulos = new Set<string>();
    for (const [i, c] of d.fields.entries()) {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: "id_repetido", path: ["fields", i, "id"] });
      ids.add(c.id);
      const r = c.label.toLowerCase();
      if (rotulos.has(r)) ctx.addIssue({ code: "custom", message: "rotulo_repetido", path: ["fields", i, "label"] });
      rotulos.add(r);
    }
    const tel = d.fields.find((c) => c.id === ID_TELEFONO);
    if (!tel || tel.tipo !== "telefono" || !tel.requerido) {
      ctx.addIssue({ code: "custom", message: "falta_telefono", path: ["fields"] });
    }
  });
export type DefinicionDeFormulario = z.infer<typeof definicionSchema>;

/** Los campos con los que nace un formulario nuevo. */
export function camposIniciales(): Campo[] {
  return [
    { id: ID_NOMBRE, label: "Nombre", tipo: "texto", requerido: true },
    { id: ID_TELEFONO, label: "WhatsApp", tipo: "telefono", requerido: true },
    { id: ID_EMAIL, label: "Email", tipo: "email", requerido: false },
  ];
}

/** Identidad pública del link. 12 caracteres a-z0-9: no adivinable por barrido. */
export function nuevoSlug(): string {
  const alfabeto = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (const b of randomBytes(12)) s += alfabeto[b % alfabeto.length];
  return s;
}

/** Lo que el navegador manda al enviar. */
export interface EnvioCrudo {
  respuestas?: Record<string, unknown>;
  consentimiento?: unknown;
  utm?: Record<string, unknown>;
}

export type ErroresDelEnvio = Record<string, string>;

export type ResultadoDeValidar =
  | { ok: true; respuestas: Record<string, string>; utm: Record<string, string> }
  | { ok: false; errores: ErroresDelEnvio };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function comoTexto(v: unknown): string {
  if (typeof v === "string") return v.trim().slice(0, MAX_TEXTO);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

export function limpiarUtm(utm: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!utm || typeof utm !== "object") return out;
  for (const k of CLAVES_UTM) {
    const v = comoTexto(utm[k]).slice(0, 200);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Valida un envío contra la definición. El consentimiento (Ley 25.326) es
 * obligatorio en TODO formulario: sin la casilla marcada no hay envío.
 */
export function validarEnvio(campos: Campo[], envio: EnvioCrudo): ResultadoDeValidar {
  const errores: ErroresDelEnvio = {};
  const respuestas: Record<string, string> = {};
  const crudas = envio.respuestas && typeof envio.respuestas === "object" ? envio.respuestas : {};

  for (const c of campos) {
    const v = comoTexto(crudas[c.id]);
    if (!v) {
      if (c.requerido) errores[c.id] = "requerido";
      continue;
    }
    if (c.tipo === "telefono" && !normalizePhoneBR(v)) errores[c.id] = "telefono_invalido";
    else if (c.tipo === "email" && !EMAIL_RE.test(v)) errores[c.id] = "email_invalido";
    else if (c.tipo === "opcion" && !(c.opciones ?? []).includes(v)) errores[c.id] = "opcion_invalida";
    else if (c.tipo === "si_no" && !(RESPUESTAS_SI_NO as readonly string[]).includes(v)) errores[c.id] = "opcion_invalida";
    else if (c.tipo === "fecha" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errores[c.id] = "fecha_invalida";
    else respuestas[c.id] = v;
  }

  if (envio.consentimiento !== true) errores.consentimiento = "requerido";
  if (Object.keys(errores).length > 0) return { ok: false, errores };
  return { ok: true, respuestas, utm: limpiarUtm(envio.utm) };
}

/**
 * El cuerpo que recibe la captación de siempre. Los tres campos fijos van con
 * las claves que ella reconoce (`name`, `phone`, `email`); el resto, bajo el
 * rótulo del campo. El consentimiento viaja con fecha y texto: queda en el
 * historial de la captación y en la ficha del lead.
 */
export function payloadDelEnvio(
  def: { name: string; fields: Campo[]; consent_text: string },
  respuestas: Record<string, string>,
  utm: Record<string, string>,
  ahora: Date,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const c of def.fields) {
    const v = respuestas[c.id];
    if (v === undefined) continue;
    if (c.id === ID_NOMBRE) payload.name = v;
    else if (c.id === ID_TELEFONO) payload.phone = v;
    else if (c.id === ID_EMAIL) payload.email = v;
    else payload[c.label] = v;
  }
  payload.consentimiento_datos = "aceptado";
  payload.consentimiento_datos_fecha = ahora.toISOString();
  if (def.consent_text) payload.consentimiento_datos_texto = def.consent_text.slice(0, 500);
  payload.formulario = def.name;
  return { ...payload, ...utm };
}

/** Texto de la casilla cuando la persona no escribió uno propio. */
export const CONSENTIMIENTO_POR_DEFECTO =
  "Acepto que se guarden mis datos personales para que me contacten, según la Ley 25.326 de Protección de Datos Personales. Puedo pedir que los corrijan o los borren cuando quiera.";
