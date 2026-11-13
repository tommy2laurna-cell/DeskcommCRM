/**
 * Contactos dormidos: sin movimiento hace N días (`contacts.last_activity_at`).
 * Excluye bloqueados y anonimizados. Sin actividad registrada (null) NO cuenta
 * como dormido: no hay desde cuándo medir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const DIAS_DORMIDO_PADRAO = 60;

export function limiteDeDormidos(agora: Date, dias: number): string {
  return new Date(agora.getTime() - dias * 86_400_000).toISOString();
}

export interface ContactoDormido {
  id: string;
  nombre: string;
  last_activity_at: string;
}

export async function contactosDormidos(
  db: SupabaseClient,
  organizationId: string,
  opts: { agora?: Date; dias?: number; limite?: number } = {},
): Promise<ContactoDormido[]> {
  const { agora = new Date(), dias = DIAS_DORMIDO_PADRAO, limite = 50 } = opts;
  const { data, error } = await db
    .from("contacts")
    .select("id, name, display_name, phone_number, last_activity_at")
    .eq("organization_id", organizationId)
    .not("last_activity_at", "is", null)
    .lt("last_activity_at", limiteDeDormidos(agora, dias))
    .eq("is_blocked", false)
    .eq("is_anonymized", false)
    .order("last_activity_at", { ascending: false })
    .limit(limite);
  if (error) throw new Error(error.message);
  return (data ?? []).map((c) => ({
    id: c.id as string,
    nombre: (c.name || c.display_name || c.phone_number || "") as string,
    last_activity_at: c.last_activity_at as string,
  }));
}
