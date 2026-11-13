/**
 * Reativar — as duas tarjetas «Dormidos» e «Aniversários da semana».
 *
 * O produto não tem painel de início (a home é o inbox), então vivem no grupo
 * Análise. Leem com o client da SESSÃO (a RLS recorta) e filtram a organização
 * ativa explicitamente.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { partesNoFuso } from "@/lib/agenda/fuso";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { cumpleanosDeLaSemana } from "@/lib/contacts/cumpleanos";
import { contactosDormidos, DIAS_DORMIDO_PADRAO } from "@/lib/contacts/dormidos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dormidos e aniversários" };

export default async function ReativarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  const supabase = await createClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const fuso = (org?.timezone as string | null) ?? "America/Argentina/Buenos_Aires";
  let hoy;
  try {
    hoy = partesNoFuso(new Date(), fuso);
  } catch {
    hoy = partesNoFuso(new Date(), "UTC");
  }

  const [dormidos, cumples] = await Promise.all([
    contactosDormidos(supabase, activeOrg.orgId),
    cumpleanosDeLaSemana(supabase, activeOrg.orgId, hoy),
  ]);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Dormidos e aniversários")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("Quem está sem movimento há semanas e quem faz aniversário nesta semana.")}
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-4" data-testid="card-dormidos">
          <h2 className="text-sm font-semibold">{t("Dormidos")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("Sem movimento há mais de")} {DIAS_DORMIDO_PADRAO} {t("dias")}
          </p>
          {dormidos.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Ninguém por aqui.")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {dormidos.map((c) => (
                <li key={c.id}>
                  <Link className="underline-offset-2 hover:underline" href={`/app/contacts/${c.id}`}>
                    {c.nombre || "—"}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="space-y-2 p-4" data-testid="card-cumpleanos">
          <h2 className="text-sm font-semibold">{t("Aniversários da semana")}</h2>
          {cumples.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Ninguém por aqui.")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {cumples.map((c) => (
                <li key={c.id}>
                  <Link className="underline-offset-2 hover:underline" href={`/app/contacts/${c.id}`}>
                    {c.nombre || "—"}
                  </Link>{" "}
                  <span className="text-muted-foreground">
                    {String(c.birthday_md % 100).padStart(2, "0")}/{String(Math.floor(c.birthday_md / 100)).padStart(2, "0")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
