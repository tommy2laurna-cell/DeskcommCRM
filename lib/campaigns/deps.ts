/**
 * Los efectos REALES del envío de campañas: espera anti-ban, tope diario y el
 * transporte de Meta. Separados de `procesar.ts` para que éste se pruebe con
 * dobles.
 *
 * `CAMPAIGNS_TRANSPORT=simulado` reemplaza SOLO el último paso (la llamada a la
 * Graph API) por un id `sim:<teléfono>`; todo lo demás — guardas, revaluación del
 * opt-out, tope, estados — corre de verdad. Es lo que usa la jornada de prueba.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { checkDailyLimit, espacarEnvio } from "@/lib/automation/throttle";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";
import { env } from "@/lib/env";

import type { DepsDeEnvio } from "./procesar";

const LIMITE_DIARIO_PADRAO = 300;

export function depsDeProduccion(admin: SupabaseClient): DepsDeEnvio {
  return {
    ahora: () => new Date(),
    esperar: espacarEnvio,
    puedeEnviar: async (organizationId, sessionId) => {
      // 1) el tope que ya usa la automatización...
      if (!(await checkDailyLimit(admin, organizationId, sessionId)).allowed) return false;

      // 2) ...y el conteo REAL de lo enviado hoy por campañas por esta sesión:
      // `channel_session_warmup` no tiene escritor, así que el tope de arriba hoy
      // nunca corta; este conteo sí.
      const { data: sesion } = await admin
        .from("channel_sessions")
        .select("daily_message_limit")
        .eq("id", sessionId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      const limite =
        (sesion as { daily_message_limit?: number } | null)?.daily_message_limit ??
        LIMITE_DIARIO_PADRAO;
      const hoy = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
      const { count } = await admin
        .from("campaign_recipients")
        .select("id, campaigns!inner(channel_session_id)", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("status", "enviado")
        .gte("sent_at", hoy)
        .eq("campaigns.channel_session_id", sessionId);
      return (count ?? 0) < limite;
    },
    enviar: async ({ campana, para }) => {
      if (env.CAMPAIGNS_TRANSPORT === "simulado") return `sim:${para}`;
      return sendTemplateForSession(admin, {
        organizationId: campana.organization_id,
        sessionRef: campana.session_ref,
        to: para,
        name: campana.template_name,
        language: campana.template_language,
        values: campana.template_values,
      });
    },
  };
}
