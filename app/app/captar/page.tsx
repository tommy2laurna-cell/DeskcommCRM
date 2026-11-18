import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { CaptarClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Captar" };

export default async function CaptarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const canManage = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!canManage) redirect("/app/inbox");

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Captar", user.idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Formulários, pesquisas e códigos QR para trazer contatos de fora do WhatsApp, com a origem de cada um à vista.",
            user.idioma,
          )}
        </p>
      </header>
      <CaptarClient />
    </div>
  );
}
