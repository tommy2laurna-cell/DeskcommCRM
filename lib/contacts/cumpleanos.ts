/**
 * Cumpleaños de los próximos N días (default 7, hoy incluido).
 *
 * `contacts.birthday_md` es mes*100+día de `birthdate`. Aritmética de calendario
 * con `Date.UTC` (sin zona): resuelve el fin de año (31/dic -> 1/ene) solo. 29/feb
 * sigue la convención del cron `contact-birthdays`: en año no bisiesto responde el 28.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const esBisiesto = (a: number) => (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;

/** Los `mes*100+dia` a buscar entre `hoy` y `hoy + dias - 1` (hoy = fecha de calendario local). */
export function diasMDDeLaSemana(hoy: { ano: number; mes: number; dia: number }, dias = 7): number[] {
  const out = new Set<number>();
  for (let i = 0; i < dias; i++) {
    const d = new Date(Date.UTC(hoy.ano, hoy.mes - 1, hoy.dia + i));
    const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    out.add(md);
    // 28/feb de año no bisiesto también celebra a los nacidos el 29/feb.
    if (md === 228 && !esBisiesto(d.getUTCFullYear())) out.add(229);
  }
  return [...out];
}

export interface ContactoCumple {
  id: string;
  nombre: string;
  birthday_md: number;
}

export async function cumpleanosDeLaSemana(
  db: SupabaseClient,
  organizationId: string,
  hoy: { ano: number; mes: number; dia: number },
  limite = 50,
): Promise<ContactoCumple[]> {
  const { data, error } = await db
    .from("contacts")
    .select("id, name, display_name, phone_number, birthday_md")
    .eq("organization_id", organizationId)
    .in("birthday_md", diasMDDeLaSemana(hoy))
    .eq("is_blocked", false)
    .eq("is_anonymized", false)
    .limit(limite);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((c) => ({
      id: c.id as string,
      nombre: (c.name || c.display_name || c.phone_number || "") as string,
      birthday_md: c.birthday_md as number,
    }))
    .sort((a, b) => a.birthday_md - b.birthday_md);
}
