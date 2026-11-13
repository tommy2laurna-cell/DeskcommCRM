"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { CLAVE_PUNTAJE_REGLAS } from "@/hooks/puntaje/usePuntajeReglas";
import { apiClient } from "@/lib/api/client";
import { reglasDePuntajeSchema, type ReglasDePuntaje } from "@/lib/puntaje/reglas";

export interface EtapaParaReglas {
  id: string;
  nombre: string;
  funel: string;
}

const num = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? 0 : Number(v));

export function PuntajeForm({
  inicial,
  etapas,
}: {
  inicial: ReglasDePuntaje;
  etapas: EtapaParaReglas[];
}) {
  const t = useT();
  const qc = useQueryClient();
  const [reglas, setReglas] = useState<ReglasDePuntaje>(inicial);
  const [pendiente, startTransition] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    // Tramos vacíos (sin puntos) y huecos del arreglo no se guardan.
    const limpias: ReglasDePuntaje = {
      ...reglas,
      diasSinContacto: {
        tramos: reglas.diasSinContacto.tramos.filter((tr) => tr && tr.puntos !== 0),
      },
      valor: { tramos: reglas.valor.tramos.filter((tr) => tr && tr.puntos !== 0) },
    };
    const ok = reglasDePuntajeSchema.safeParse(limpias);
    if (!ok.success) {
      toast.error(t("Revisá los números: los puntos van de −100 a 100."));
      return;
    }
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/puntaje", ok.data);
        await qc.invalidateQueries({ queryKey: CLAVE_PUNTAJE_REGLAS });
        toast.success(t("Puntaje guardado."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("No pudimos guardar."));
      }
    });
  }

  const campo = (id: string, etiqueta: string, valor: number, onChange: (n: number) => void) => (
    <div className="space-y-1">
      <Label htmlFor={id}>{etiqueta}</Label>
      <Input
        id={id}
        type="number"
        value={valor}
        disabled={pendiente}
        onChange={(e) => onChange(num(e.target.value))}
      />
    </div>
  );

  // Siempre mostramos 3 tramos editables: sin días = el tramo no se aplica.
  const tramosDias = [0, 1, 2].map((i) => reglas.diasSinContacto.tramos[i] ?? null);
  const tramosValor = [0, 1, 2].map((i) => reglas.valor.tramos[i] ?? null);
  const origenes = Object.entries(reglas.origen);

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-6" data-testid="form-puntaje">
      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t("El cliente escribió")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Puntos si el cliente mandó un mensaje y todavía nadie lo atendió.")}
        </p>
        {campo("p-respondio", t("Puntos"), reglas.respondio.puntos, (n) =>
          setReglas((r) => ({ ...r, respondio: { puntos: n } })),
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t("Días sin contacto")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Se aplica el tramo más alto alcanzado. Dejá en 0 los puntos de un tramo que no quieras usar.")}
        </p>
        {tramosDias.map((tr, i) => (
          <div key={i} className="grid gap-4 sm:grid-cols-2">
            {campo(`dias-${i}`, t("Desde (días)"), tr?.desdeDias ?? 0, (n) =>
              setReglas((r) => {
                const tramos = [...r.diasSinContacto.tramos];
                tramos[i] = { desdeDias: n, puntos: tramos[i]?.puntos ?? 0 };
                return { ...r, diasSinContacto: { tramos } };
              }),
            )}
            {campo(`dias-p-${i}`, t("Puntos"), tr?.puntos ?? 0, (n) =>
              setReglas((r) => {
                const tramos = [...r.diasSinContacto.tramos];
                tramos[i] = { desdeDias: tramos[i]?.desdeDias ?? 0, puntos: n };
                return { ...r, diasSinContacto: { tramos } };
              }),
            )}
          </div>
        ))}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t("Etapa")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Puntos por estar en cada etapa. Vacío o 0 = no suma.")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {etapas.map((e) =>
            campo(`etapa-${e.id}`, `${e.funel} · ${e.nombre}`, reglas.etapa[e.id] ?? 0, (n) =>
              setReglas((r) => ({ ...r, etapa: { ...r.etapa, [e.id]: n } })),
            ),
          )}
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t("Valor del negocio")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Puntos según el monto, en la moneda de la organización.")}
        </p>
        {tramosValor.map((tr, i) => (
          <div key={i} className="grid gap-4 sm:grid-cols-2">
            {campo(`valor-${i}`, t("Desde (monto)"), tr?.desdePesos ?? 0, (n) =>
              setReglas((r) => {
                const tramos = [...r.valor.tramos];
                tramos[i] = { desdePesos: n, puntos: tramos[i]?.puntos ?? 0 };
                return { ...r, valor: { tramos } };
              }),
            )}
            {campo(`valor-p-${i}`, t("Puntos"), tr?.puntos ?? 0, (n) =>
              setReglas((r) => {
                const tramos = [...r.valor.tramos];
                tramos[i] = { desdePesos: tramos[i]?.desdePesos ?? 0, puntos: n };
                return { ...r, valor: { tramos } };
              }),
            )}
          </div>
        ))}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t("Origen")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Puntos según de dónde llegó el contacto (por ejemplo: referido, web, meta ads).")}
        </p>
        {origenes.map(([nombre, pts]) => (
          <div key={nombre} className="grid items-end gap-4 sm:grid-cols-[1fr_8rem_auto]">
            <div className="space-y-1">
              <Label htmlFor={`o-${nombre}`}>{t("Origen")}</Label>
              <Input id={`o-${nombre}`} value={nombre} disabled readOnly />
            </div>
            {campo(`o-p-${nombre}`, t("Puntos"), pts, (n) =>
              setReglas((r) => ({ ...r, origen: { ...r.origen, [nombre]: n } })),
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={pendiente}
              onClick={() =>
                setReglas((r) => ({
                  ...r,
                  origen: Object.fromEntries(Object.entries(r.origen).filter(([k]) => k !== nombre)),
                }))
              }
            >
              {t("Quitar")}
            </Button>
          </div>
        ))}
        <NuevoOrigen
          deshabilitado={pendiente || origenes.length >= 8}
          onAgregar={(nombre) =>
            setReglas((r) => ({ ...r, origen: { ...r.origen, [nombre]: r.origen[nombre] ?? 10 } }))
          }
        />
      </Card>

      <div>
        <Button type="submit" disabled={pendiente}>
          {t("Guardar")}
        </Button>
      </div>
    </form>
  );
}

function NuevoOrigen({
  onAgregar,
  deshabilitado,
}: {
  onAgregar: (nombre: string) => void;
  deshabilitado: boolean;
}) {
  const t = useT();
  const [nombre, setNombre] = useState("");
  return (
    <div className="flex items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor="origen-nuevo">{t("Agregar origen")}</Label>
        <Input
          id="origen-nuevo"
          value={nombre}
          disabled={deshabilitado}
          onChange={(e) => setNombre(e.target.value)}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={deshabilitado || nombre.trim() === ""}
        onClick={() => {
          onAgregar(nombre.trim().toLowerCase());
          setNombre("");
        }}
      >
        {t("Agregar")}
      </Button>
    </div>
  );
}
