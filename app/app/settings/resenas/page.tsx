/**
 * Configuración → Reseñas. Link de Google y mensaje aprobado con que el cron
 * `cron/review-requests` pide la reseña unos días después de ganar un negocio.
 * Gate manager+, el mismo de `settings/atendimento`.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { reviewsSettingsLeituraSchema } from "@/lib/schemas/settings";
import { createClient } from "@/lib/supabase/server";
import { ResenasForm } from "./_form";

export const dynamic = "force-dynamic";

export default async function ResenasSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const settings = (data?.settings as Record<string, unknown> | null) ?? {};
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Avaliações", idioma)}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Alguns dias depois de ganhar um negócio, o sistema envia ao cliente o link para deixar uma avaliação no Google, com uma mensagem aprovada da Meta.",
            idioma,
          )}
        </p>
      </header>
      <ResenasForm initial={reviewsSettingsLeituraSchema.parse(settings.reviews ?? {})} />
    </div>
  );
}
