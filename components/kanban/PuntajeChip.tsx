"use client";
import { useState, type MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { conSigno, type PuntajeCalculado } from "@/lib/puntaje/reglas";

/**
 * El puntaje de prioridad en la tarjeta, con el «por qué» a un gesto.
 *
 * Mismo comportamiento que `ScoreSlot`: el mouse encima abre, el clic o el toque
 * también (en tablet no hay hover). El texto de cada fila sale de los factores
 * que armaron el número, no de una frase aparte, así que no puede discrepar.
 */
export function PuntajeChip({ puntaje }: { puntaje: PuntajeCalculado }) {
  const t = useT();
  const [abierto, setAbierto] = useState(false);
  const detener = (e: MouseEvent) => e.stopPropagation();

  return (
    <Popover open={abierto} onOpenChange={setAbierto}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="puntaje-chip"
          onClick={(e) => {
            detener(e);
            setAbierto((v) => !v);
          }}
          onMouseEnter={() => setAbierto(true)}
          onMouseLeave={() => setAbierto(false)}
          aria-label={`${t("Puntaje de prioridad")} ${puntaje.total}. ${t("Ver por qué.")}`}
          className={cn(
            "shrink-0 rounded-full border border-border px-2 text-[11px] font-medium leading-5 tabular-nums",
            puntaje.total > 0 && "text-text",
            puntaje.total <= 0 && "text-text-muted",
          )}
        >
          {puntaje.total}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3 text-xs" onClick={detener}>
        <p className="mb-2 font-medium text-text">
          {t("Puntaje de prioridad")}: {puntaje.total}
        </p>
        {puntaje.factores.length === 0 ? (
          <p className="text-text-muted">{t("Ninguna regla suma ni resta puntos a este negocio.")}</p>
        ) : (
          <ul className="space-y-1">
            {puntaje.factores.map((f) => (
              <li key={f.regla} className="flex justify-between gap-3">
                <span className="text-text-muted">{f.texto}</span>
                <span className="shrink-0 tabular-nums text-text">{conSigno(f.puntos)}</span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
