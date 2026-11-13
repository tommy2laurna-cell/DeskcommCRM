/**
 * Quién recibe una campaña y quién queda afuera — UNA sola regla para la vista
 * previa, la confirmación y el envío.
 *
 * La decisión la toma `checarGuardasDeContato` (la misma guarda de toda acción
 * que manda mensajes), no una copia: si mañana la guarda aprende un motivo nuevo,
 * las campañas lo heredan. Esta función solo traduce su veredicto al estado del
 * destinatario.
 *
 * El opt-out se revalúa con ESTA función justo antes de cada envío: un contacto
 * que pidió la baja entre la confirmación y el envío sale como `excluido_optout`.
 */
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import type { ActionCtx } from "@/lib/automation/types";

export type EstadoDeDestinatario =
  | "pendiente"
  | "enviado"
  | "excluido_optout"
  | "excluido_sin_telefono"
  | "error";

export interface ContactoParaCampana {
  id: string;
  phone_number?: string | null;
  is_blocked?: boolean | null;
  consent?: unknown;
}

export type Clasificacion =
  | { estado: "pendiente"; telefono: string }
  | { estado: "excluido_optout" | "excluido_sin_telefono" | "error"; motivo: string };

export function clasificarContacto(contacto: ContactoParaCampana): Clasificacion {
  const veredicto = checarGuardasDeContato({
    context: {
      contact: {
        id: contacto.id,
        is_blocked: contacto.is_blocked === true,
        phone_number: contacto.phone_number ?? null,
        consent: contacto.consent ?? null,
      },
    },
  } as unknown as ActionCtx);

  if (veredicto.ok) return { estado: "pendiente", telefono: veredicto.contact.phone_number };
  switch (veredicto.reason) {
    case "consent_declined":
    case "contact_blocked":
      return { estado: "excluido_optout", motivo: veredicto.reason };
    case "no_phone":
      return { estado: "excluido_sin_telefono", motivo: veredicto.reason };
    case "no_contact":
      return { estado: "error", motivo: veredicto.reason };
  }
}

export interface ResumenDeDestinatarios {
  total: number;
  efectivos: number;
  excluidos_optout: number;
  excluidos_sin_telefono: number;
}

export function resumirDestinatarios(contactos: ContactoParaCampana[]): ResumenDeDestinatarios {
  const r: ResumenDeDestinatarios = {
    total: contactos.length,
    efectivos: 0,
    excluidos_optout: 0,
    excluidos_sin_telefono: 0,
  };
  for (const c of contactos) {
    const v = clasificarContacto(c);
    if (v.estado === "pendiente") r.efectivos += 1;
    else if (v.estado === "excluido_optout") r.excluidos_optout += 1;
    else if (v.estado === "excluido_sin_telefono") r.excluidos_sin_telefono += 1;
  }
  return r;
}

/** Teléfono E.164 con `+` -> solo dígitos, que es lo que acepta la Graph API. */
export function telefonoParaMeta(telefono: string): string {
  return telefono.replace(/\D/g, "");
}
