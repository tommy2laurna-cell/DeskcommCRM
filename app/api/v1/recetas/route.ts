/**
 * GET /api/v1/recetas — el catálogo de recetas con el estado de la organización
 * activa (prendida o no, texto editado, número, plantilla y su estado en Meta).
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { RECETAS, esRecetaDeMensaje } from "@/lib/recetas/catalogo";
import { vistaDeRecetas, type PlantillaEnMeta, type ReglaGuardada } from "@/lib/recetas/estado";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const org = authz.org.orgId;

  const supabase = await createClient();
  const { data: reglas, error } = await supabase
    .from("automation_rules")
    .select("id, recipe_key, is_active, run_count, last_run_at, actions")
    .eq("organization_id", org)
    .not("recipe_key", "is", null);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const nombres = RECETAS.filter(esRecetaDeMensaje).map((r) => r.plantilla.nombre);
  const { data: plantillas } = await supabase
    .from("meta_templates")
    .select("name, status")
    .eq("organization_id", org)
    .in("name", nombres);

  return ok(
    vistaDeRecetas((reglas ?? []) as unknown as ReglaGuardada[], (plantillas ?? []) as PlantillaEnMeta[]),
    { requestId },
  );
}
