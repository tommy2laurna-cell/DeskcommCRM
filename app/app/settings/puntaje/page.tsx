/**
 * Configuración → Puntaje de prioridad.
 *
 * Las reglas con las que el tablero ordena «a quién llamo primero». Leer es de
 * todo el equipo (el tablero las usa); cambiarlas es de manager+, porque cambia
 * el orden para todos.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { reglasDeLaOrganizacion } from "@/lib/puntaje/reglas";
import { createClient } from "@/lib/supabase/server";

import { PuntajeForm, type EtapaParaReglas } from "./_form";

export const dynamic = "force-dynamic";

export default async function PuntajeSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const [{ data: org }, { data: etapas }] = await Promise.all([
    supabase.from("organizations").select("settings").eq("id", activeOrg.orgId).maybeSingle(),
    supabase
      .from("crm_stages")
      .select("id, name, position, crm_pipelines!inner(name, is_archived, organization_id)")
      .eq("crm_pipelines.organization_id", activeOrg.orgId)
      .eq("crm_pipelines.is_archived", false)
      .order("position"),
  ]);

  const lista: EtapaParaReglas[] = (
    (etapas ?? []) as unknown as Array<{
      id: string;
      name: string;
      crm_pipelines: { name: string };
    }>
  ).map((e) => ({ id: e.id, nombre: e.name, funel: e.crm_pipelines.name }));

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Puntaje de prioridad")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t(
            "Cada negocio suma o resta puntos según estas reglas. En el tablero podés ordenar por puntaje, y al pasar el mouse por el número ves por qué tiene ese valor.",
          )}
        </p>
      </header>
      <PuntajeForm inicial={reglasDeLaOrganizacion(org?.settings)} etapas={lista} />
    </div>
  );
}
