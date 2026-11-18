import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { ListasClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Listas inteligentes" };

export default async function ListasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app/inbox");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Listas inteligentes")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Grupos de contatos que se atualizam sozinhos: a lista guarda os filtros, não as pessoas.")}
        </p>
      </header>
      <ListasClient />
    </div>
  );
}
