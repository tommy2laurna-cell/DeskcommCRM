import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { TableroDatos } from "./tablero";

/** Llama a fn_tablero_metrics con el cliente del usuario (la RLS decide el alcance) y le pone nombre a cada usuario. */
export async function cargarTablero(
  orgId: string,
  from: Date,
  to: Date,
  owner: string | null,
): Promise<{ ok: true; datos: TableroDatos } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_tablero_metrics", {
    p_org: orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_owner: owner ?? undefined,
  });
  if (error) return { ok: false, error: error.message };
  const datos = data as unknown as TableroDatos;
  if (isServiceRoleConfigured() && datos.por_usuario.length > 0) {
    const admin = createAdminClient();
    await Promise.all(
      datos.por_usuario.map(async (u) => {
        const { data: r } = await admin.auth.admin.getUserById(u.user_id);
        u.name = (r?.user?.user_metadata?.full_name as string | undefined) ?? null;
        u.email = r?.user?.email ?? null;
      }),
    );
  }
  return { ok: true, datos };
}
