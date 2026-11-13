/**
 * Lecturas compartidas por las rutas de campañas: la sesión (que DEBE ser de
 * Meta — jamás WAHA) y el mensaje aprobado del espejo `meta_templates`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { MensajeAprobado } from "./vista-previa";

export const CAMPAIGN_COLS =
  "id, organization_id, name, list_id, channel_session_id, template_name, template_language, template_category, template_values, status, scheduled_at, confirmed_at, total_recipients, total_sent, total_excluded, total_error, created_at, updated_at";

export async function sesionDeMeta(
  db: SupabaseClient,
  organizationId: string,
  sessionId: string,
): Promise<{ id: string; meta_phone_number_id: string } | null> {
  const { data } = await db
    .from("channel_sessions")
    .select("id, provider, meta_phone_number_id")
    .eq("id", sessionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const s = data as { id: string; provider: string; meta_phone_number_id: string | null } | null;
  if (!s || s.provider !== "meta_cloud" || !s.meta_phone_number_id) return null;
  return { id: s.id, meta_phone_number_id: s.meta_phone_number_id };
}

export async function mensajeAprobado(
  db: SupabaseClient,
  organizationId: string,
  name: string,
  language: string,
): Promise<MensajeAprobado | null> {
  const { data } = await db
    .from("meta_templates")
    .select("name, language, status, category, components, parameter_format")
    .eq("organization_id", organizationId)
    .eq("name", name)
    .eq("language", language)
    .maybeSingle();
  return (data as MensajeAprobado | null) ?? null;
}
