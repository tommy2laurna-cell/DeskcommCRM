/**
 * Quem traz mais clientes — mesma consulta de GET /api/v1/reports/referrals
 * (`cargarReferidos`), renderizada no servidor. Gate manager+.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { cargarReferidos } from "@/lib/reports/referidos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Quem traz mais clientes" };

export default async function ReferidosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { filas, truncado } = await cargarReferidos(await createClient(), activeOrg.orgId);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Quem traz mais clientes")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("Quem mais indicou clientes e quantos deles fecharam negócio.")}
        </p>
      </header>
      <Card className="max-w-3xl p-4" data-testid="tabla-referidos">
        {filas.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("Ainda não há indicações. Preencha \"Quem indicou\" na ficha do contato.")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th className="py-1">{t("Contato")}</th>
                <th className="py-1">{t("Indicou")}</th>
                <th className="py-1">{t("Fecharam")}</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={f.contact_id} className="border-t">
                  <td className="py-1">
                    <Link className="underline-offset-2 hover:underline" href={`/app/contacts/${f.contact_id}`}>
                      {f.nombre || "—"}
                    </Link>
                  </td>
                  <td className="py-1">{f.referidos}</td>
                  <td className="py-1">{f.ganaron}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {truncado && (
          <p className="mt-2 text-xs text-muted-foreground">{t("Mostrando só as primeiras indicações.")}</p>
        )}
      </Card>
    </div>
  );
}
