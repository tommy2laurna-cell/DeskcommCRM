/**
 * «Esta sesión es de la API oficial de Meta» — la pregunta que las campañas hacen,
 * respondida AQUÍ para que ninguna feature nombre un provider (invariante 1 de
 * `docs/doctrine/restricao-de-canal.md`).
 *
 * Las campañas solo salen por la API oficial: una sesión de otro tipo se rechaza.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANNEL_PROVIDER_META } from "./capabilities";

export interface SesionOficial {
  id: string;
  /** El número de la Meta por el que sale la campaña (`sessionRef` del canal). */
  meta_phone_number_id: string;
}

export async function sesionOficialDeMeta(
  db: SupabaseClient,
  organizationId: string,
  sessionId: string,
): Promise<SesionOficial | null> {
  const { data } = await db
    .from("channel_sessions")
    .select("id, provider, meta_phone_number_id")
    .eq("id", sessionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const s = data as { id: string; provider: string; meta_phone_number_id: string | null } | null;
  if (!s || s.provider !== CHANNEL_PROVIDER_META || !s.meta_phone_number_id) return null;
  return { id: s.id, meta_phone_number_id: s.meta_phone_number_id };
}

/** Las sesiones de la organización que pueden enviar campañas. */
export async function sesionesOficialesDeMeta(
  db: SupabaseClient,
  organizationId: string,
): Promise<{ id: string; display_name: string | null; phone_number: string | null }[] | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, display_name, phone_number")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_META);
  return error ? null : ((data ?? []) as { id: string; display_name: string | null; phone_number: string | null }[]);
}
