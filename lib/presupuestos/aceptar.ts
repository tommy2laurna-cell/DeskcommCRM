import type { SupabaseClient } from "@supabase/supabase-js";

import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { midpoint } from "@/lib/kanban/fractional-indexing";

import { estaVencido, hoyEnZona } from "./calculo";

/**
 * ACEPTAR UN PRESUPUESTO.
 *
 * Quien atiende lo marca cuando el cliente dice que sí (por WhatsApp, por
 * teléfono, en persona): el presupuesto es solo PDF, sin link público (decisión
 * del 12/11), así que la aceptación la registra una persona, no el cliente.
 *
 * Tres cosas pasan, y las tres dejan rastro:
 *  1. el presupuesto queda `aceptado` (una sola vez: aceptar dos veces no hace
 *     nada de más);
 *  2. el negocio avanza a la etapa siguiente del embudo — si la hay y no es una
 *     etapa de pérdida —, así el tablero cuenta lo que se prometió;
 *  3. se le crea una tarea al responsable del negocio («Presupuesto aceptado:
 *     coordinar con el cliente»). El CRM no tiene avisos del lado del servidor
 *     (las notificaciones del navegador son locales), y una tarea asignada es el
 *     aviso que sobrevive a que la persona no estuviera mirando la pantalla.
 *
 * La lógica habla con un `Repo` mínimo y no con Supabase directo: así la
 * decisión (qué etapa, qué se rechaza, qué es idempotente) se prueba sin base.
 */

export interface PresupuestoFila {
  id: string;
  lead_id: string;
  numero: number;
  estado: "emitido" | "aceptado" | "rechazado";
  valido_hasta: string;
  total_cents: number;
}

export interface LeadFila {
  id: string;
  title: string;
  status: "open" | "won" | "lost";
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  owner_user_id: string | null;
}

export interface EtapaFila {
  id: string;
  name: string;
  position: number;
  is_lost: boolean;
}

export interface Repo {
  zonaDeLaOrganizacion(): Promise<string>;
  presupuesto(id: string): Promise<PresupuestoFila | null>;
  /** `false` si ya no estaba `emitido` (otra persona lo aceptó antes). */
  marcarAceptado(id: string, userId: string, ahoraIso: string): Promise<boolean>;
  lead(id: string): Promise<LeadFila | null>;
  etapasDelEmbudo(pipelineId: string): Promise<EtapaFila[]>;
  primeraPosicionEn(stageId: string): Promise<number | null>;
  moverLead(leadId: string, stageId: string, position: number): Promise<void>;
  crearTarea(t: { titulo: string; leadId: string; asignadoA: string; creadoPor: string }): Promise<void>;
  registrarActividad(a: {
    leadId: string;
    contactId: string | null;
    tipo: "stage_changed" | "note";
    razon: string;
    userId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export type ResultadoAceptar =
  | {
      ok: true;
      yaAceptado: boolean;
      movioAEtapa: string | null;
      tareaPara: string | null;
    }
  | { ok: false; codigo: "no_encontrado" | "rechazado" | "vencido"; status: 404 | 409 };

/** La etapa siguiente del embudo, salvo que no haya o sea de pérdida. */
export function etapaDeDestinoAlAceptar(
  etapas: EtapaFila[],
  etapaActualId: string,
): EtapaFila | null {
  const orden = [...etapas].sort((a, b) => a.position - b.position);
  const i = orden.findIndex((e) => e.id === etapaActualId);
  if (i < 0) return null;
  const siguiente = orden[i + 1];
  return siguiente && !siguiente.is_lost ? siguiente : null;
}

export async function aceptarPresupuesto(
  repo: Repo,
  args: { presupuestoId: string; userId: string; ahora?: Date },
): Promise<ResultadoAceptar> {
  const ahora = args.ahora ?? new Date();
  const p = await repo.presupuesto(args.presupuestoId);
  if (!p) return { ok: false, codigo: "no_encontrado", status: 404 };

  // Idempotente: aceptar de nuevo no mueve ni avisa otra vez.
  if (p.estado === "aceptado") {
    return { ok: true, yaAceptado: true, movioAEtapa: null, tareaPara: null };
  }
  if (p.estado === "rechazado") return { ok: false, codigo: "rechazado", status: 409 };

  const hoy = hoyEnZona(await repo.zonaDeLaOrganizacion(), ahora);
  if (estaVencido(p.valido_hasta, hoy)) return { ok: false, codigo: "vencido", status: 409 };

  const gano = await repo.marcarAceptado(p.id, args.userId, ahora.toISOString());
  if (!gano) return { ok: true, yaAceptado: true, movioAEtapa: null, tareaPara: null };

  const lead = await repo.lead(p.lead_id);
  let movioAEtapa: string | null = null;
  let tareaPara: string | null = null;

  if (lead) {
    const etapas = await repo.etapasDelEmbudo(lead.pipeline_id);
    const destino = lead.status === "open" ? etapaDeDestinoAlAceptar(etapas, lead.stage_id) : null;
    if (destino) {
      const primera = await repo.primeraPosicionEn(destino.id);
      const position = midpoint(null, primera);
      await repo.moverLead(lead.id, destino.id, position);
      const origen = etapas.find((e) => e.id === lead.stage_id);
      await repo.registrarActividad({
        leadId: lead.id,
        contactId: lead.contact_id,
        tipo: "stage_changed",
        razon: stageChangeReason(origen?.name ?? null, destino.name),
        userId: args.userId,
        payload: {
          from_stage_id: lead.stage_id,
          to_stage_id: destino.id,
          pipeline_id: lead.pipeline_id,
          presupuesto_id: p.id,
        },
      });
      movioAEtapa = destino.name;
    }

    await repo.registrarActividad({
      leadId: lead.id,
      contactId: lead.contact_id,
      tipo: "note",
      razon: `Presupuesto N° ${String(p.numero).padStart(4, "0")} aceptado`,
      userId: args.userId,
      payload: { presupuesto_id: p.id, total_cents: p.total_cents },
    });

    if (lead.owner_user_id) {
      await repo.crearTarea({
        titulo: `Presupuesto N° ${String(p.numero).padStart(4, "0")} aceptado: coordinar con el cliente (${lead.title})`,
        leadId: lead.id,
        asignadoA: lead.owner_user_id,
        creadoPor: args.userId,
      });
      tareaPara = lead.owner_user_id;
    }
  }

  return { ok: true, yaAceptado: false, movioAEtapa, tareaPara };
}

/** El `Repo` real, sobre el cliente de sesión (la RLS sigue mandando). */
export function repoSupabase(supabase: SupabaseClient, organizationId: string): Repo {
  return {
    async zonaDeLaOrganizacion() {
      const { data } = await supabase
        .from("organizations")
        .select("timezone")
        .eq("id", organizationId)
        .maybeSingle();
      return (data as { timezone?: string | null } | null)?.timezone ?? "America/Argentina/Buenos_Aires";
    },
    async presupuesto(id) {
      const { data } = await supabase
        .from("presupuestos")
        .select("id, lead_id, numero, estado, valido_hasta, total_cents")
        .eq("id", id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      return (data as PresupuestoFila | null) ?? null;
    },
    async marcarAceptado(id, userId, ahoraIso) {
      const { data, error } = await supabase
        .from("presupuestos")
        .update({ estado: "aceptado", accepted_at: ahoraIso, accepted_by: userId })
        .eq("id", id)
        .eq("organization_id", organizationId)
        .eq("estado", "emitido")
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data !== null;
    },
    async lead(id) {
      const { data } = await supabase
        .from("crm_leads")
        .select("id, title, status, pipeline_id, stage_id, contact_id, owner_user_id")
        .eq("id", id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      return (data as LeadFila | null) ?? null;
    },
    async etapasDelEmbudo(pipelineId) {
      const { data } = await supabase
        .from("crm_stages")
        .select("id, name, position, is_lost")
        .eq("pipeline_id", pipelineId);
      return (data as EtapaFila[] | null) ?? [];
    },
    async primeraPosicionEn(stageId) {
      const { data } = await supabase
        .from("crm_leads")
        .select("position_in_stage")
        .eq("stage_id", stageId)
        .order("position_in_stage", { ascending: true })
        .limit(1)
        .maybeSingle();
      return (data as { position_in_stage: number } | null)?.position_in_stage ?? null;
    },
    async moverLead(leadId, stageId, position) {
      const { error } = await supabase
        .from("crm_leads")
        .update({ stage_id: stageId, position_in_stage: position, updated_at: new Date().toISOString() })
        .eq("id", leadId)
        .eq("organization_id", organizationId);
      if (error) throw new Error(error.message);
    },
    async crearTarea(t) {
      const { error } = await supabase.from("crm_tasks").insert({
        organization_id: organizationId,
        title: t.titulo,
        lead_id: t.leadId,
        assigned_to: t.asignadoA,
        created_by: t.creadoPor,
        priority: "high",
      });
      if (error) throw new Error(error.message);
    },
    async registrarActividad(a) {
      // Fire-and-forget como en el resto del repo: la línea de tiempo no puede
      // tirar abajo la operación que describe.
      await emitLeadActivity(supabase, {
        organizationId,
        leadId: a.leadId,
        contactId: a.contactId,
        type: a.tipo,
        sourceModule: "presupuestos",
        sourceId: a.leadId,
        actor: { type: "user", id: a.userId },
        reason: a.razon,
        payload: a.payload,
      });
    },
  };
}
