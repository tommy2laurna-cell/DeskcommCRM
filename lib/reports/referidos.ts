/**
 * «Quién trae más clientes»: por cada contacto que recomendó a otros, cuántos
 * recomendó y cuántos de ellos tienen un negocio ganado. Todo filtrado por
 * `organization_id` (la RLS no alcanza con service role).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FilaDeReferidos {
  contact_id: string;
  nombre: string;
  referidos: number;
  ganaron: number;
}

const TOPE_DE_CONTACTOS = 5000;

/** Agregación pura: separada de la consulta para probarla sin banco. */
export function agruparReferidos(
  recomendados: { id: string; referred_by_contact_id: string }[],
  ganadosPorContacto: Set<string>,
  nombres: Map<string, string>,
): FilaDeReferidos[] {
  const por = new Map<string, FilaDeReferidos>();
  for (const r of recomendados) {
    const fila = por.get(r.referred_by_contact_id) ?? {
      contact_id: r.referred_by_contact_id,
      nombre: nombres.get(r.referred_by_contact_id) ?? "",
      referidos: 0,
      ganaron: 0,
    };
    fila.referidos += 1;
    if (ganadosPorContacto.has(r.id)) fila.ganaron += 1;
    por.set(r.referred_by_contact_id, fila);
  }
  return [...por.values()].sort((a, b) => b.ganaron - a.ganaron || b.referidos - a.referidos);
}

export async function cargarReferidos(
  db: SupabaseClient,
  organizationId: string,
): Promise<{ filas: FilaDeReferidos[]; truncado: boolean }> {
  const { data: rec, error } = await db
    .from("contacts")
    .select("id, referred_by_contact_id")
    .eq("organization_id", organizationId)
    .not("referred_by_contact_id", "is", null)
    .limit(TOPE_DE_CONTACTOS);
  if (error) throw new Error(error.message);
  const recomendados = (rec ?? []) as { id: string; referred_by_contact_id: string }[];
  if (recomendados.length === 0) return { filas: [], truncado: false };

  const ganadores = new Set<string>();
  const nombres = new Map<string, string>();
  const LOTE = 100;
  for (let i = 0; i < recomendados.length; i += LOTE) {
    const ids = recomendados.slice(i, i + LOTE).map((r) => r.id);
    const { data } = await db
      .from("crm_leads")
      .select("contact_id")
      .eq("organization_id", organizationId)
      .eq("status", "won")
      .in("contact_id", ids);
    for (const l of data ?? []) ganadores.add(l.contact_id as string);
  }
  const referentes = [...new Set(recomendados.map((r) => r.referred_by_contact_id))];
  for (let i = 0; i < referentes.length; i += LOTE) {
    const { data } = await db
      .from("contacts")
      .select("id, name, display_name, phone_number")
      .eq("organization_id", organizationId)
      .in("id", referentes.slice(i, i + LOTE));
    for (const c of data ?? []) {
      nombres.set(c.id as string, (c.name || c.display_name || c.phone_number || "") as string);
    }
  }
  return {
    filas: agruparReferidos(recomendados, ganadores, nombres),
    truncado: recomendados.length >= TOPE_DE_CONTACTOS,
  };
}
