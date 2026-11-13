/**
 * GET /api/v1/campaigns/opciones (agent+) — lo que el formulario de campañas
 * puede elegir: sesiones de Meta, mensajes aprobados (con aviso de botón de baja)
 * y listas. Solo sesiones `meta_cloud`: las campañas no salen por WAHA.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { tieneBotonDeBaja } from "@/lib/campaigns/boton-de-baja";
import { clienteDeUsuario } from "@/lib/campaigns/http";
import { categoriaDelMensaje } from "@/lib/campaigns/vista-previa";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const org = authz.org.orgId;

  const db = await clienteDeUsuario();
  const [sesiones, mensajes, listas] = await Promise.all([
    db
      .from("channel_sessions")
      .select("id, display_name, phone_number")
      .eq("organization_id", org)
      .eq("provider", "meta_cloud"),
    db
      .from("meta_templates")
      .select("name, language, category, components")
      .eq("organization_id", org)
      .eq("status", "APPROVED")
      .order("name"),
    db.from("smart_lists").select("id, name").eq("organization_id", org).order("name"),
  ]);
  if (sesiones.error || mensajes.error || listas.error) {
    return fail("internal_error", "Erro ao carregar opções.", 500, { requestId });
  }
  return ok(
    {
      sesiones: sesiones.data ?? [],
      mensajes: ((mensajes.data ?? []) as { name: string; language: string; category: string | null; components: unknown }[]).map(
        (m) => ({
          name: m.name,
          language: m.language,
          categoria: categoriaDelMensaje(m.category),
          tiene_boton_de_baja: tieneBotonDeBaja(m.components),
        }),
      ),
      listas: listas.data ?? [],
    },
    { requestId },
  );
}
