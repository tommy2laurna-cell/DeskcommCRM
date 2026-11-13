"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  conversiones,
  pesos,
  urlDeLista,
  type FiltroDeLista,
  type TableroDatos,
} from "@/lib/reports/tablero";

type Resp = { data: TableroDatos & { window: { from: string; to: string; periodo: string } } };
const PERIODOS = ["7", "30", "90"] as const;

function seg(s: number | null): string {
  if (s == null) return "—";
  const m = Math.round(s / 60);
  return m < 1 ? `${Math.round(s)}s` : m < 120 ? `${m} min` : `${(m / 60).toFixed(1).replace(".", ",")} h`;
}

/** Tablero del dueño. Cada número es un link a la lista que lo produjo (misma ventana y mismo filtro). */
export function TableroPanel({ verTodo, currentUserId }: { verTodo: boolean; currentUserId: string }) {
  const t = useT();
  const [periodo, setPeriodo] = useState<(typeof PERIODOS)[number]>("30");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["metrics", "tablero", periodo],
    queryFn: () => apiClient.get<Resp>(`/api/v1/metrics/tablero?periodo=${periodo}`),
    staleTime: 30_000,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (isError || !data) return <p className="text-sm text-destructive">{t("Erro ao carregar métricas.")}</p>;

  const d = data.data;
  const base = { from: d.window.from, to: d.window.to };
  const L = (f: Omit<FiltroDeLista, "from" | "to">) => urlDeLista({ ...base, ...f });
  const conv = conversiones(d.etapas);
  const totalNuevos = d.por_origen.reduce((a, o) => a + o.count, 0);

  const Num = ({ href, children, label }: { href: string; children: React.ReactNode; label: string }) => (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex min-h-11 items-center rounded px-1 font-semibold tabular-nums underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2"
    >
      {children}
    </Link>
  );

  return (
    <section aria-label={t("Painel")} data-testid="tablero" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t("Período")} className="flex gap-1">
          {PERIODOS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriodo(p)}
              aria-pressed={p === periodo}
              data-testid={`periodo-${p}`}
              className={`min-h-11 rounded-md border px-3 text-sm ${p === periodo ? "bg-primary text-primary-foreground" : ""}`}
            >
              {p} {t("dias")}
            </button>
          ))}
        </div>
        <a
          href={`/api/v1/metrics/tablero/export?periodo=${periodo}`}
          className="ml-auto inline-flex min-h-11 items-center rounded-md border px-3 text-sm"
          data-testid="exportar-csv"
        >
          {t("Exportar CSV")}
        </a>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("Novos prospectos")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl" data-testid="tablero-nuevos">
            <Num href={L({ tipo: "nuevos" })} label={t("Ver novos prospectos")}>
              {totalNuevos}
            </Num>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("Vendas ganhas")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl">
            <span data-testid="tablero-ganados">
              <Num href={L({ tipo: "ganados" })} label={t("Ver vendas ganhas")}>
                {d.ventas.ganados}
              </Num>
            </span>{" "}
            <span className="text-base text-muted-foreground" data-testid="tablero-monto">
              {pesos(d.ventas.monto_ars_cents)}
            </span>
            {d.ventas.ganados_otra_moneda > 0 ? (
              <p className="text-xs text-muted-foreground">
                {d.ventas.ganados_otra_moneda} {t("em outra moeda, fora do valor")}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("1ª resposta (média)")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl tabular-nums" data-testid="tablero-respuesta">
            {seg(d.primera_respuesta_segundos)}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Novos prospectos por origem")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {d.por_origen.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Sem atividade no período.")}</p>
          ) : (
            d.por_origen.map((o) => (
              <div key={o.source} className="flex items-center justify-between text-sm">
                <span>{o.source}</span>
                <Num href={L({ tipo: "nuevos", source: o.source })} label={`${t("Ver")} ${o.source}`}>
                  {o.count}
                </Num>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Conversão entre etapas")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {d.etapas.map((e, i) => (
            <div key={e.stage_id} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{e.stage_name}</span>
              <span className="flex items-center gap-3">
                <span className="text-muted-foreground tabular-nums">
                  {conv[i] == null ? "—" : `${Math.round((conv[i] as number) * 100)}%`}
                </span>
                <Num href={L({ tipo: "nuevos", stage: e.stage_id })} label={`${t("Ver")} ${e.stage_name}`}>
                  {e.alcanzaron}
                </Num>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{verTodo ? t("Por usuário") : t("Sua performance")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="tablero-por-usuario">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2">{t("Atendente")}</th>
                <th className="px-2 text-right">{t("Novos")}</th>
                <th className="px-2 text-right">{t("Ganhos")}</th>
                <th className="px-2 text-right">{t("Vendido (ARS)")}</th>
                <th className="px-2 text-right">{t("1ª resposta (média)")}</th>
              </tr>
            </thead>
            <tbody>
              {d.por_usuario.map((u) => (
                <tr key={u.user_id}>
                  <td className="py-1 pr-2">
                    {u.name ?? u.email ?? u.user_id.slice(0, 8)}
                    {u.user_id === currentUserId ? ` ${t("(você)")}` : ""}
                  </td>
                  <td className="px-2 text-right">
                    <Num href={L({ tipo: "nuevos", owner: u.user_id })} label={t("Ver novos prospectos")}>
                      {u.nuevos}
                    </Num>
                  </td>
                  <td className="px-2 text-right">
                    <Num href={L({ tipo: "ganados", owner: u.user_id })} label={t("Ver vendas ganhas")}>
                      {u.ganados}
                    </Num>
                  </td>
                  <td className="px-2 text-right tabular-nums">{pesos(u.monto_ars_cents)}</td>
                  <td className="px-2 text-right tabular-nums">{seg(u.primera_respuesta_segundos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </section>
  );
}
