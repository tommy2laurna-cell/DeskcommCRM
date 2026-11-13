/**
 * GET|POST /api/v1/cron/recetas — el reloj de las recetas (lib/recetas).
 *
 * Solo EMITE eventos (`appointment.reminder`, `contact.silent`, `lead.idle`,
 * `contact.dormant`) para las organizaciones que tienen una receta prendida con
 * ese disparador; el motor de automatización decide y envía, con sus guardas de
 * siempre (opt-out, ventana del número, espaciado). Cada caso se emite una sola
 * vez: se mira `event_log` antes.
 *
 * `?ahora=<ISO>` mueve el reloj: sirve a la prueba de recorrido ("avanzar el
 * reloj") y requiere el mismo secreto de cron que todo lo demás de acá.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  AVISOS_DE_TURNO,
  BANDA,
  correspondeAvisoDeTurno,
  estaDormido,
  estaQuieto,
  estaSinRespuesta,
} from "@/lib/recetas/barrido";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Tope de casos por organización, tipo y corrida: nunca una ráfaga. */
const TOPE = 50;
const DIA = 86_400_000;

type Tipo = "appointment.reminder" | "contact.silent" | "lead.idle" | "contact.dormant";
interface Emision {
  org: string;
  tipo: Tipo;
  entityKind: "calendar_appointment" | "contact" | "crm_lead";
  entityId: string;
  payload: Record<string, unknown>;
}
type Previos = Map<string, Array<{ created_at: string; payload: Record<string, unknown> }>>;

async function yaEmitidos(
  admin: SupabaseClient,
  org: string,
  tipo: Tipo,
  ids: string[],
  desde: Date,
): Promise<Previos> {
  const mapa: Previos = new Map();
  if (ids.length === 0) return mapa;
  const { data } = await admin
    .from("event_log")
    .select("entity_id, created_at, payload")
    .eq("organization_id", org)
    .eq("event_type", tipo)
    .in("entity_id", ids)
    .gte("created_at", desde.toISOString());
  for (const e of data ?? []) {
    const lista = mapa.get(e.entity_id as string) ?? [];
    lista.push({ created_at: e.created_at as string, payload: (e.payload ?? {}) as Record<string, unknown> });
    mapa.set(e.entity_id as string, lista);
  }
  return mapa;
}

async function turnos(admin: SupabaseClient, org: string, agora: Date): Promise<Emision[]> {
  const maximo = Math.max(...AVISOS_DE_TURNO);
  // Los tipos con recordatorio propio (`reminder_enabled`) ya avisan por
  // `cron/agenda-reminder`: acá se saltean para no mandar dos veces.
  const { data } = await admin
    .from("calendar_appointments")
    .select("id, starts_at, created_at, calendar_event_types!inner(reminder_enabled)")
    .eq("organization_id", org)
    .eq("status", "confirmed")
    .eq("calendar_event_types.reminder_enabled", false)
    .not("contact_id", "is", null)
    .gt("starts_at", agora.toISOString())
    .lte("starts_at", new Date(agora.getTime() + (maximo + 60) * 60_000).toISOString())
    .order("starts_at", { ascending: true })
    .limit(TOPE);
  const filas = data ?? [];
  const previos = await yaEmitidos(
    admin,
    org,
    "appointment.reminder",
    filas.map((f) => f.id as string),
    new Date(agora.getTime() - 2 * DIA),
  );
  const salida: Emision[] = [];
  for (const f of filas) {
    for (const offsetMin of AVISOS_DE_TURNO) {
      const corresponde = correspondeAvisoDeTurno({
        agora,
        comienzo: f.starts_at as string,
        creado: f.created_at as string,
        offsetMin,
      });
      if (!corresponde) continue;
      if ((previos.get(f.id as string) ?? []).some((p) => p.payload.offset_minutes === offsetMin)) continue;
      salida.push({
        org,
        tipo: "appointment.reminder",
        entityKind: "calendar_appointment",
        entityId: f.id as string,
        payload: { offset_minutes: offsetMin, starts_at: f.starts_at },
      });
    }
  }
  return salida;
}

async function sinRespuesta(admin: SupabaseClient, org: string, agora: Date): Promise<Emision[]> {
  const desde = new Date(agora.getTime() - BANDA.silencioTopeHoras * 3_600_000).toISOString();
  const hasta = new Date(agora.getTime() - BANDA.silencioHoras * 3_600_000).toISOString();
  const { data } = await admin
    .from("conversations")
    .select("contact_id, last_inbound_at, last_outbound_at, contacts:contact_id (is_blocked, phone_number)")
    .eq("organization_id", org)
    .eq("is_group", false)
    .gte("last_outbound_at", desde)
    .lte("last_outbound_at", hasta)
    .limit(TOPE * 4);
  const candidatas = (data ?? []).filter((c) => {
    const contacto = (Array.isArray(c.contacts) ? c.contacts[0] : c.contacts) as
      | { is_blocked?: boolean; phone_number?: string | null }
      | null;
    return (
      !!c.contact_id &&
      !!contacto &&
      !contacto.is_blocked &&
      !!contacto.phone_number &&
      estaSinRespuesta({
        agora,
        ultimoSaliente: c.last_outbound_at as string,
        ultimoEntrante: c.last_inbound_at as string | null,
      })
    );
  });
  const ids = [...new Set(candidatas.map((c) => c.contact_id as string))];
  // Solo prospectos: contactos con un negocio abierto. Clientes y conocidos no.
  const { data: abiertos } = ids.length
    ? await admin.from("crm_leads").select("contact_id").eq("organization_id", org).eq("status", "open").in("contact_id", ids)
    : { data: [] };
  const conLead = new Set((abiertos ?? []).map((l) => l.contact_id as string));
  const previos = await yaEmitidos(admin, org, "contact.silent", ids, new Date(agora.getTime() - 6 * DIA));
  const salida: Emision[] = [];
  for (const c of candidatas) {
    const id = c.contact_id as string;
    if (!conLead.has(id)) continue;
    const saliente = new Date(c.last_outbound_at as string).getTime();
    // Una sola vez por mensaje nuestro sin respuesta.
    if ((previos.get(id) ?? []).some((p) => new Date(p.created_at).getTime() >= saliente)) continue;
    salida.push({ org, tipo: "contact.silent", entityKind: "contact", entityId: id, payload: { hours: BANDA.silencioHoras } });
    if (salida.length >= TOPE) break;
  }
  return salida;
}

async function leadsQuietos(admin: SupabaseClient, org: string, agora: Date): Promise<Emision[]> {
  const { data } = await admin
    .from("crm_leads")
    .select("id, last_activity_at")
    .eq("organization_id", org)
    .eq("status", "open")
    .gte("last_activity_at", new Date(agora.getTime() - (BANDA.quietoDias + BANDA.anchoDias) * DIA).toISOString())
    .lte("last_activity_at", new Date(agora.getTime() - BANDA.quietoDias * DIA).toISOString())
    .limit(TOPE * 2);
  const filas = (data ?? []).filter((l) => estaQuieto(agora, l.last_activity_at as string));
  const previos = await yaEmitidos(admin, org, "lead.idle", filas.map((l) => l.id as string), new Date(agora.getTime() - 5 * DIA));
  return filas
    .filter((l) => !previos.has(l.id as string))
    .slice(0, TOPE)
    .map((l) => ({
      org,
      tipo: "lead.idle" as const,
      entityKind: "crm_lead" as const,
      entityId: l.id as string,
      payload: { days: BANDA.quietoDias },
    }));
}

async function dormidos(admin: SupabaseClient, org: string, agora: Date): Promise<Emision[]> {
  const { data } = await admin
    .from("contacts")
    .select("id, last_activity_at")
    .eq("organization_id", org)
    .eq("is_blocked", false)
    .not("phone_number", "is", null)
    .gte("last_activity_at", new Date(agora.getTime() - (BANDA.dormidoDias + BANDA.anchoDormidoDias) * DIA).toISOString())
    .lte("last_activity_at", new Date(agora.getTime() - BANDA.dormidoDias * DIA).toISOString())
    .limit(TOPE * 2);
  const filas = (data ?? []).filter((c) => estaDormido(agora, c.last_activity_at as string));
  const previos = await yaEmitidos(admin, org, "contact.dormant", filas.map((c) => c.id as string), new Date(agora.getTime() - 100 * DIA));
  return filas
    .filter((c) => !previos.has(c.id as string))
    .slice(0, TOPE)
    .map((c) => ({
      org,
      tipo: "contact.dormant" as const,
      entityKind: "contact" as const,
      entityId: c.id as string,
      payload: { days: BANDA.dormidoDias },
    }));
}

const BUSCADORES: Record<Tipo, (a: SupabaseClient, org: string, agora: Date) => Promise<Emision[]>> = {
  "appointment.reminder": turnos,
  "contact.silent": sinRespuesta,
  "lead.idle": leadsQuietos,
  "contact.dormant": dormidos,
};

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const fornecido = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (aceitos.length === 0 || !fornecido || !aceitos.includes(fornecido)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const ahoraParam = new URL(req.url).searchParams.get("ahora");
  const agora = ahoraParam ? new Date(ahoraParam) : new Date();
  if (Number.isNaN(agora.getTime())) return fail("invalid_request", "ahora inválido.", 400, { requestId });

  const admin = createAdminClient();
  const tipos = Object.keys(BUSCADORES) as Tipo[];
  const { data: reglas, error } = await admin
    .from("automation_rules")
    .select("organization_id, trigger_event")
    .in("trigger_event", tipos)
    .eq("is_active", true);
  if (error) {
    logger.error("[cron/recetas] consulta de reglas falló", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar regras.", 500, { requestId });
  }

  const pares = new Set((reglas ?? []).map((r) => `${r.organization_id}|${r.trigger_event}`));
  const emitidos: Record<string, number> = {};
  let fallos = 0;
  for (const par of pares) {
    const [org, tipo] = par.split("|") as [string, Tipo];
    let emisiones: Emision[];
    try {
      emisiones = await BUSCADORES[tipo](admin, org, agora);
    } catch (err) {
      fallos += 1;
      logger.error("[cron/recetas] barrido falló", {
        org,
        tipo,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      continue;
    }
    for (const e of emisiones) {
      const { error: errorEvento } = await admin.rpc("emit_event" as never, {
        p_event_type: e.tipo,
        p_entity_kind: e.entityKind,
        p_entity_id: e.entityId,
        p_payload: e.payload,
        p_metadata: { actor_kind: "system", source: "cron/recetas" },
        p_organization_id: e.org,
      });
      if (errorEvento) {
        fallos += 1;
        logger.error("[cron/recetas] emit_event falló", { org, tipo, error: errorEvento.message, requestId });
        continue;
      }
      emitidos[e.tipo] = (emitidos[e.tipo] ?? 0) + 1;
    }
  }
  return ok({ pares: pares.size, emitidos, fallos }, { requestId });
}

export const GET = handle;
export const POST = handle;
