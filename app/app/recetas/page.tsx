import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { RecetasClient } from "./_components/RecetasClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Receitas" };

export default async function RecetasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const canManage = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!canManage) redirect("/app/inbox");
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Receitas", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Automações típicas prontas, desligadas por padrão. Ligue com um clique e edite o texto. Respeitam quem pediu para não receber mensagens.",
            idioma,
          )}
        </p>
      </header>
      <RecetasClient />
    </div>
  );
}
