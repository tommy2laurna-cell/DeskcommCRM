import type { Metadata } from "next";
import Link from "next/link";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { pesos, type TipoDeLista } from "@/lib/reports/tablero";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Lista" };

const UUID = /^[0-9a-f-]{36}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
const una = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * La lista detrás de un número del tablero: aplica EXACTAMENTE el mismo filtro
 * (tipo, ventana, origen, usuario, etapa) sobre crm_leads, con el cliente del
 * usuario — la RLS decide qué ve cada rol. Hasta 200 filas.
 */
export default async function ListaDelTablero({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  const t = (s: string) => traduzir(s, user.idioma);
  const sp = await searchParams;
  const tipo = (["nuevos", "ganados", "perdidos"].includes(una(sp.tipo) ?? "") ? una(sp.tipo) : "nuevos") as TipoDeLista;
  const from = una(sp.from);
  const to = una(sp.to);
  const source = una(sp.source);
  const owner = una(sp.owner);
  const stage = una(sp.stage);
  const valido = !!org && !!from && !!to && ISO.test(from) && ISO.test(to) && (!owner || UUID.test(owner)) && (!stage || UUID.test(stage));

  let filas: { id: string; title: string; source: string; status: string; value_cents: number | null; currency: string | null }[] = [];
  if (valido) {
    const supabase = await createClient();
    let q = supabase
      .from("crm_leads")
      .select("id,title,source,status,value_cents,currency")
      .eq("organization_id", org!.orgId)
      .gte(tipo === "nuevos" ? "created_at" : "closed_at", from)
      .lt(tipo === "nuevos" ? "created_at" : "closed_at", to)
      .order("created_at", { ascending: false })
      .limit(200);
    if (tipo !== "nuevos") q = q.eq("status", tipo === "ganados" ? "won" : "lost");
    if (source) q = q.eq("source", source);
    // Igual que el tablero: un vendedor solo cuenta lo suyo (la RLS le permitiría ver también los sin asignar).
    const dueño = roleAtLeast(org!.role, "manager") ? owner : user.id;
    if (dueño) q = q.eq("owner_user_id", dueño);
    if (stage) {
      const { data: e } = await supabase.from("crm_stages").select("pipeline_id,position").eq("organization_id", org!.orgId).eq("id", stage).single();
      if (e) {
        const { data: ids } = await supabase
          .from("crm_stages")
          .select("id")
          .eq("organization_id", org!.orgId)
          .eq("pipeline_id", e.pipeline_id)
          .gte("position", e.position);
        q = q
          .eq("pipeline_id", e.pipeline_id)
          .or(`status.eq.won,stage_id.in.(${(ids ?? []).map((r) => r.id).join(",")})`);
      }
    }
    filas = (await q).data ?? [];
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <header>
        <Link href="/app/metrics" className="text-sm underline">
          ← {t("Desempenho")}
        </Link>
        <h1 className="mt-2 text-xl font-semibold" data-testid="lista-titulo">
          {tipo === "nuevos" ? t("Novos prospectos") : tipo === "ganados" ? t("Vendas ganhas") : t("Vendas perdidas")}
          {" · "}
          <span data-testid="lista-total">{filas.length}</span>
        </h1>
      </header>
      {!valido ? (
        <p className="text-sm text-destructive">{t("Filtro inválido.")}</p>
      ) : filas.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Sem atividade no período.")}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border" data-testid="lista-leads">
          {filas.map((l) => (
            <li key={l.id}>
              <Link href={`/app/leads/${l.id}`} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="truncate">{l.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {l.source}
                  {l.value_cents != null && l.currency === "ARS" ? ` · ${pesos(l.value_cents)}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
