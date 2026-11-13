/**
 * EL ENVÍO ESCALONADO DE UNA CAMPAÑA — un lote chico por tick del cron.
 *
 * Por qué es seguro volver a correr:
 *   - `unique (campaign_id, contact_id)` impide dos filas por contacto;
 *   - una fila `enviado` jamás vuelve a la cola: solo se toman `pendiente` y los
 *     `error` con intentos restantes;
 *   - cada fila se TOMA con un UPDATE condicional (arriendo `claimed_at`), así dos
 *     ticks solapados no envían al mismo destinatario.
 *
 * Qué NO garantiza (y se anota): si Meta acepta el mensaje y el proceso muere
 * antes de grabar `enviado`, el arriendo vence y la fila se reintenta — el mismo
 * límite de todo envío sin id propio del lado de Meta.
 *
 * El opt-out se REVALÚA acá, con el contacto leído en este instante, justo antes
 * de cada envío: quien pidió la baja entre la confirmación y el tick sale como
 * `excluido_optout` y no recibe nada.
 *
 * Los efectos (espera, límite diario, transporte) entran por `deps`: la ruta
 * pasa los de producción y los tests pasan dobles. La campaña solo sale por la
 * API oficial de Meta (la ruta rechaza cualquier otra sesión).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { clasificarContacto, telefonoParaMeta } from "./destinatarios";

export const TAMANO_DE_LOTE = 15;
export const MAX_INTENTOS = 3;
const ARRIENDO_MS = 5 * 60_000;

export interface CampanaEnCurso {
  id: string;
  organization_id: string;
  channel_session_id: string;
  /** `channel_sessions.meta_phone_number_id`: el número de Meta por el que sale. */
  session_ref: string;
  template_name: string;
  template_language: string;
  template_values: Record<string, string>;
}

export interface DepsDeEnvio {
  ahora: () => Date;
  /** Espaciamiento anti-ban entre envíos del mismo número. */
  esperar: (sessionId: string) => Promise<void>;
  /** `false` = tope diario alcanzado: el lote se corta y sigue mañana. */
  puedeEnviar: (organizationId: string, sessionId: string) => Promise<boolean>;
  /** Devuelve el id externo del envío o lanza con el motivo. */
  enviar: (input: { campana: CampanaEnCurso; para: string }) => Promise<string | null>;
}

export interface ResultadoDeLote {
  enviados: number;
  excluidos: number;
  errores: number;
  /** El lote se cortó antes de tiempo (tope diario o fallo de la campaña entera). */
  cortado: "tope_diario" | "fallo_de_campana" | "cancelada" | null;
  completada: boolean;
}

interface FilaDestinatario {
  id: string;
  contact_id: string;
  status: string;
  attempts: number;
}

/** Fallos que no son de UN contacto sino de toda la campaña: seguir sería repetirlos. */
function esFalloDeCampana(mensaje: string): boolean {
  return /^(template_|meta_not_configured)/.test(mensaje);
}

export async function procesarLote(
  admin: SupabaseClient,
  campana: CampanaEnCurso,
  deps: DepsDeEnvio,
  tamano: number = TAMANO_DE_LOTE,
): Promise<ResultadoDeLote> {
  const ahora = deps.ahora();
  const vencidoAntes = new Date(ahora.getTime() - ARRIENDO_MS).toISOString();
  const res: ResultadoDeLote = { enviados: 0, excluidos: 0, errores: 0, cortado: null, completada: false };

  const { data: candidatas, error: errCand } = await admin
    .from("campaign_recipients")
    .select("id, contact_id, status, attempts, claimed_at")
    .eq("campaign_id", campana.id)
    .eq("organization_id", campana.organization_id)
    .or(`status.eq.pendiente,and(status.eq.error,attempts.lt.${MAX_INTENTOS})`)
    .order("id", { ascending: true })
    // Margen: las filas con arriendo vigente de otro tick se descartan abajo.
    .limit(tamano * 4);
  if (errCand) throw new Error(`campaign_queue_failed: ${errCand.message}`);

  // Tomar cada fila: solo la toma quien logra el UPDATE condicional.
  const tomadas: FilaDestinatario[] = [];
  const libres = ((candidatas ?? []) as (FilaDestinatario & { claimed_at: string | null })[])
    .filter((f) => !f.claimed_at || f.claimed_at < vencidoAntes)
    .slice(0, tamano);
  for (const f of libres) {
    const { data: ganada } = await admin
      .from("campaign_recipients")
      .update({ claimed_at: ahora.toISOString(), attempts: f.attempts + 1 })
      .eq("id", f.id)
      .eq("status", f.status)
      .eq("attempts", f.attempts)
      .or(`claimed_at.is.null,claimed_at.lt.${vencidoAntes}`)
      .select("id")
      .maybeSingle();
    if (ganada) tomadas.push(f);
  }

  const idsContacto = tomadas.map((f) => f.contact_id);
  const contactos = new Map<string, Record<string, unknown>>();
  if (idsContacto.length > 0) {
    const { data } = await admin
      .from("contacts")
      .select("id, phone_number, is_blocked, consent")
      .eq("organization_id", campana.organization_id)
      .in("id", idsContacto);
    for (const c of (data ?? []) as Record<string, unknown>[]) contactos.set(c.id as string, c);
  }

  const cerrar = (id: string, cambios: Record<string, unknown>) =>
    admin
      .from("campaign_recipients")
      .update({ claimed_at: null, ...cambios })
      .eq("id", id)
      .eq("organization_id", campana.organization_id);

  /** ¿Sigue activa? Se relee ANTES de cada envío: cancelar en pleno lote frena el resto. */
  const sigueActiva = async (): Promise<boolean> => {
    const { data } = await admin
      .from("campaigns")
      .select("status")
      .eq("id", campana.id)
      .eq("organization_id", campana.organization_id)
      .maybeSingle();
    const st = (data as { status?: string } | null)?.status;
    return st === "confirmada" || st === "enviando";
  };

  for (let i = 0; i < tomadas.length; i++) {
    const fila = tomadas[i]!;
    if (!(await sigueActiva())) {
      for (const resto of tomadas.slice(i)) await cerrar(resto.id, { attempts: resto.attempts });
      res.cortado = "cancelada";
      break;
    }
    const contacto = contactos.get(fila.contact_id);
    const v = clasificarContacto(
      contacto
        ? {
            id: fila.contact_id,
            phone_number: contacto.phone_number as string | null,
            is_blocked: contacto.is_blocked as boolean | null,
            consent: contacto.consent,
          }
        : { id: "" },
    );

    if (v.estado !== "pendiente") {
      await cerrar(fila.id, { status: v.estado, reason: v.motivo });
      if (v.estado === "error") res.errores += 1;
      else res.excluidos += 1;
      continue;
    }

    if (!(await deps.puedeEnviar(campana.organization_id, campana.channel_session_id))) {
      // Devolver lo que quedó sin enviar (esta fila y las siguientes).
      for (const resto of tomadas.slice(i)) await cerrar(resto.id, { attempts: resto.attempts });
      res.cortado = "tope_diario";
      break;
    }

    try {
      await deps.esperar(campana.channel_session_id);
      const externalId = await deps.enviar({ campana, para: telefonoParaMeta(v.telefono) });
      await cerrar(fila.id, {
        status: "enviado",
        reason: null,
        external_id: externalId,
        sent_at: deps.ahora().toISOString(),
      });
      res.enviados += 1;
    } catch (err) {
      const mensaje = (err instanceof Error ? err.message : "envio_fallido").slice(0, 200);
      await cerrar(fila.id, { status: "error", reason: mensaje });
      res.errores += 1;
      if (esFalloDeCampana(mensaje)) {
        for (const resto of tomadas.slice(i + 1)) await cerrar(resto.id, { attempts: resto.attempts });
        res.cortado = "fallo_de_campana";
        break;
      }
    }
  }

  res.completada = await actualizarTotales(admin, campana, res.cortado === "fallo_de_campana");
  return res;
}

/** Recalcula los totales desde las filas; `true` si ya no queda nada por enviar. */
async function actualizarTotales(
  admin: SupabaseClient,
  campana: CampanaEnCurso,
  pausada: boolean,
): Promise<boolean> {
  const contar = async (filtrar: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const { count } = await filtrar(base());
    return count ?? 0;
  };
  const base = () =>
    admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campana.id)
      .eq("organization_id", campana.organization_id);

  const [sent, optout, sinTel, error, pendientes, reintentables] = await Promise.all([
    contar((q) => q.eq("status", "enviado")),
    contar((q) => q.eq("status", "excluido_optout")),
    contar((q) => q.eq("status", "excluido_sin_telefono")),
    contar((q) => q.eq("status", "error")),
    contar((q) => q.eq("status", "pendiente")),
    contar((q) => q.eq("status", "error").lt("attempts", MAX_INTENTOS)),
  ]);

  const completada = !pausada && pendientes + reintentables === 0;
  await admin
    .from("campaigns")
    .update({
      total_sent: sent,
      total_excluded: optout + sinTel,
      total_error: error,
      status: completada ? "completada" : "enviando",
    })
    .eq("id", campana.id)
    .eq("organization_id", campana.organization_id)
    // Sin esta condición, un `cancelada` puesto en pleno envío sería pisado.
    .in("status", ["confirmada", "enviando"]);
  return completada;
}
