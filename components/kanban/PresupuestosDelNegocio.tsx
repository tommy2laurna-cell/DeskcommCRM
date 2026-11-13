"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { apiClient } from "@/lib/api/client";
import { formatCents } from "@/lib/money";
import { calcularTotales } from "@/lib/presupuestos/calculo";

interface Item {
  descripcion: string;
  cantidad: number;
}
interface Presupuesto {
  id: string;
  numero: number;
  estado: "emitido" | "aceptado" | "rechazado";
  moneda: string;
  total_cents: number;
  valido_hasta: string;
  recibo_emitido_at: string | null;
  presupuesto_items: Item[];
}
interface Producto {
  id: string;
  nome: string;
  preco_cents: number;
  moeda: string;
  ativo: boolean;
}

const sumarDias = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(4, "0");

/** Presupuestos de un negocio: emitir (PDF con la marca), aceptar, registrar cobro y recibo. */
export function PresupuestosDelNegocio({ leadId, pipelineId }: { leadId: string; pipelineId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const clave = ["presupuestos", leadId] as const;
  const [creando, setCreando] = useState(false);
  const [lineas, setLineas] = useState<Array<{ producto_id: string; cantidad: number }>>([]);
  const [descuento, setDescuento] = useState(0);
  const [validoHasta, setValidoHasta] = useState(sumarDias(15));
  const [notas, setNotas] = useState("");

  const lista = useQuery({
    queryKey: clave,
    queryFn: async () =>
      ((await apiClient.get<{ data: Presupuesto[] }>(`/api/v1/leads/${leadId}/presupuestos`)) as { data?: Presupuesto[] })
        .data ?? [],
  });
  const catalogo = useQuery({
    queryKey: ["catalogo-para-presupuesto"],
    enabled: creando,
    queryFn: async () =>
      ((await apiClient.get<{ data: Producto[] }>("/api/v1/products")) as { data?: Producto[] }).data ?? [],
  });
  const productos = (catalogo.data ?? []).filter((p) => p.ativo);

  const previa = calcularTotales(
    lineas.flatMap((l) => {
      const p = productos.find((x) => x.id === l.producto_id);
      return p ? [{ cantidad: l.cantidad, precioUnitCents: p.preco_cents }] : [];
    }),
    descuento,
  );
  const moneda = productos[0]?.moeda ?? "ARS";

  const refrescar = async () => {
    await qc.invalidateQueries({ queryKey: clave });
    await qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
  };
  const errorDe = (e: unknown) => toast.error(e instanceof Error ? t(e.message) : t("No pudimos completar la acción."));

  const crear = useMutation({
    mutationFn: () =>
      apiClient.post(`/api/v1/leads/${leadId}/presupuestos`, {
        items: lineas,
        descuento_pct: descuento,
        valido_hasta: validoHasta,
        notas: notas.trim() || undefined,
      }),
    onSuccess: async () => {
      toast.success(t("Presupuesto emitido."));
      setCreando(false);
      setLineas([]);
      setDescuento(0);
      setNotas("");
      await refrescar();
    },
    onError: errorDe,
  });
  const aceptar = useMutation({
    mutationFn: (id: string) => apiClient.post(`/api/v1/presupuestos/${id}/aceptar`, {}),
    onSuccess: async () => {
      toast.success(t("Presupuesto aceptado. Avisamos al responsable."));
      await refrescar();
    },
    onError: errorDe,
  });
  const cobrar = useMutation({
    mutationFn: ({ id, medio }: { id: string; medio: string }) =>
      apiClient.post(`/api/v1/presupuestos/${id}/recibo`, { medio }),
    onSuccess: async () => {
      toast.success(t("Cobro registrado. Ya podés bajar el recibo."));
      await refrescar();
    },
    onError: errorDe,
  });

  return (
    <section className="border-t border-border py-3" data-testid="presupuestos">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Presupuestos")}</h3>
        {!creando && (
          <Button type="button" size="sm" variant="outline" onClick={() => setCreando(true)}>
            {t("Nuevo presupuesto")}
          </Button>
        )}
      </div>

      {creando && (
        <div className="mb-3 space-y-2 rounded-md border border-border p-3 text-sm">
          {lineas.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                aria-label={t("Producto")}
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1"
                value={l.producto_id}
                onChange={(e) =>
                  setLineas((ls) => ls.map((x, j) => (j === i ? { ...x, producto_id: e.target.value } : x)))
                }
              >
                <option value="">{t("Elegí un producto")}</option>
                {productos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nome} · {formatCents(p.preco_cents, p.moeda)}
                  </option>
                ))}
              </select>
              <Input
                aria-label={t("Cantidad")}
                type="number"
                min={1}
                className="w-20"
                value={l.cantidad}
                onChange={(e) =>
                  setLineas((ls) =>
                    ls.map((x, j) => (j === i ? { ...x, cantidad: Math.max(1, Number(e.target.value) || 1) } : x)),
                  )
                }
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}>
                {t("Quitar")}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLineas((ls) => [...ls, { producto_id: "", cantidad: 1 }])}
          >
            {t("Agregar producto")}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="pr-desc">{t("Descuento (%)")}</Label>
              <Input
                id="pr-desc"
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={descuento}
                onChange={(e) => setDescuento(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              />
            </div>
            <div>
              <Label htmlFor="pr-valido">{t("Válido hasta")}</Label>
              <Input id="pr-valido" type="date" value={validoHasta} onChange={(e) => setValidoHasta(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="pr-notas">{t("Notas")}</Label>
            <Input id="pr-notas" value={notas} onChange={(e) => setNotas(e.target.value)} />
          </div>
          <p className="tabular-nums">
            {t("Total")}: <strong>{formatCents(previa.totalCents, moneda)}</strong>
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={crear.isPending || lineas.length === 0 || lineas.some((l) => !l.producto_id)}
              onClick={() => crear.mutate()}
            >
              {t("Emitir presupuesto")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCreando(false)}>
              {t("Cancelar")}
            </Button>
          </div>
        </div>
      )}

      {(lista.data ?? []).length === 0 && !creando && (
        <p className="text-xs text-text-muted">{t("Todavía no hay presupuestos para este negocio.")}</p>
      )}
      <ul className="space-y-2">
        {(lista.data ?? []).map((p) => (
          <li key={p.id} className="rounded-md border border-border p-2 text-sm" data-testid="presupuesto-fila">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">N° {pad(p.numero)}</span>
              <span className="tabular-nums">{formatCents(p.total_cents, p.moneda)}</span>
            </div>
            <p className="text-xs text-text-muted">
              {p.estado === "aceptado" ? t("Aceptado") : t("Emitido")} · {t("válido hasta")} {p.valido_hasta}
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              <a className="text-xs underline" href={`/api/v1/presupuestos/${p.id}/pdf`} target="_blank" rel="noreferrer">
                {t("Bajar PDF")}
              </a>
              {p.estado === "emitido" && (
                <Button type="button" size="sm" variant="outline" disabled={aceptar.isPending} onClick={() => aceptar.mutate(p.id)}>
                  {t("Marcar aceptado")}
                </Button>
              )}
              {p.estado === "aceptado" && !p.recibo_emitido_at && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={cobrar.isPending}
                  onClick={() => {
                    const medio = window.prompt(t("¿Cómo pagó? (efectivo, transferencia…)"));
                    if (medio?.trim()) cobrar.mutate({ id: p.id, medio: medio.trim() });
                  }}
                >
                  {t("Registrar cobro")}
                </Button>
              )}
              {p.recibo_emitido_at && (
                <a className="text-xs underline" href={`/api/v1/presupuestos/${p.id}/pdf?tipo=recibo`} target="_blank" rel="noreferrer">
                  {t("Bajar recibo")}
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
