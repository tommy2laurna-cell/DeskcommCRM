/**
 * Lectura compartida por las rutas de campañas: el mensaje aprobado del espejo `meta_templates`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { MensajeAprobado } from "./vista-previa";

export const CAMPAIGN_COLS =
  "id, organization_id, name, list_id, channel_session_id, template_name, template_language, template_category, template_values, status, scheduled_at, confirmed_at, total_recipients, total_sent, total_excluded, total_error, created_at, updated_at";

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
