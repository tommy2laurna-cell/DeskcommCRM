"use client";
import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { apiClient } from "@/lib/api/client";
import type { VistaDeReceta } from "@/lib/recetas/estado";

const CLAVE = ["recetas"] as const;

interface Cambio {
  activa?: boolean;
  texto?: string;
  channel_session_id?: string;
  link?: string;
}

export function RecetasClient() {
  const t = useT();
  const qc = useQueryClient();
  const { data: numeros } = useChannelSessions();
  const { data, isLoading, isError } = useQuery({
    queryKey: CLAVE,
    queryFn: async () => (await apiClient.get<{ data: VistaDeReceta[] }>("/api/v1/recetas")).data,
  });
  const guardar = useMutation({
    mutationFn: ({ id, cambio }: { id: string; cambio: Cambio }) =>
      apiClient.put(`/api/v1/recetas/${id}`, cambio),
    onSuccess: () => qc.invalidateQueries({ queryKey: CLAVE }),
    onError: (err) => showApiError(err),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (isError || !data) return <p className="text-sm text-destructive">{t("Não foi possível carregar as receitas.")}</p>;

  return (
    <ul className="flex flex-col gap-4" data-testid="recetas-lista">
      {data.map((receta) => (
        <TarjetaDeReceta
          key={receta.id}
          receta={receta}
          numeros={(numeros ?? []).map((n) => ({ id: n.id, etiqueta: channelLabel(n, t) }))}
          ocupada={guardar.isPending && guardar.variables?.id === receta.id}
          onCambio={(cambio) => guardar.mutate({ id: receta.id, cambio })}
        />
      ))}
    </ul>
  );
}

function TarjetaDeReceta({
  receta,
  numeros,
  ocupada,
  onCambio,
}: {
  receta: VistaDeReceta;
  numeros: Array<{ id: string; etiqueta: string }>;
  ocupada: boolean;
  onCambio: (c: Cambio) => void;
}) {
  const t = useT();
  const [abierta, setAbierta] = React.useState(false);
  const [texto, setTexto] = React.useState(receta.ajustes.texto);
  const [numero, setNumero] = React.useState(receta.ajustes.channel_session_id ?? numeros[0]?.id ?? "");
  const [link, setLink] = React.useState(receta.ajustes.link ?? "");
  // Los números llegan después del primer render: mientras tanto vale el primero.
  const numeroEfectivo = numero || numeros[0]?.id || "";
  const mandaMensaje = receta.accion === "mensaje";
  const pideLink = !!receta.plantilla?.variables.includes("link");

  React.useEffect(() => {
    setTexto(receta.ajustes.texto);
    setLink(receta.ajustes.link ?? "");
    if (receta.ajustes.channel_session_id) setNumero(receta.ajustes.channel_session_id);
  }, [receta.ajustes.texto, receta.ajustes.link, receta.ajustes.channel_session_id]);

  // Prender manda TODO lo editado: una receta que se prende sin número no puede salir.
  const ajustes: Cambio = {
    texto,
    ...(mandaMensaje && numeroEfectivo ? { channel_session_id: numeroEfectivo } : {}),
    ...(pideLink && link ? { link } : {}),
  };

  return (
    <li className="rounded-lg border border-border bg-card p-4" data-testid={`receta-${receta.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-medium">{receta.nombre}</h2>
          <p className="text-sm text-muted-foreground">{receta.descripcion}</p>
          {receta.activa && receta.corridas > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Ejecuciones")}: {receta.corridas}
            </p>
          )}
        </div>
        <Switch
          checked={receta.activa}
          disabled={ocupada}
          aria-label={`${t("Ligar receita")}: ${receta.nombre}`}
          data-testid={`receta-switch-${receta.id}`}
          onCheckedChange={(on) => onCambio(on ? { activa: true, ...ajustes } : { activa: false })}
        />
      </div>

      <Button variant="ghost" size="sm" className="mt-2 px-0" onClick={() => setAbierta((v) => !v)}>
        {abierta ? t("Ocultar texto e modelo") : t("Editar texto e modelo")}
      </Button>

      {abierta && (
        <div className="mt-3 flex flex-col gap-4 border-t border-border pt-4">
          <label className="flex flex-col gap-1 text-sm">
            {mandaMensaje ? t("Texto da mensagem (dentro das 24 h)") : t("Título da tarefa")}
            <Textarea value={texto} rows={3} onChange={(e) => setTexto(e.target.value)} data-testid={`receta-texto-${receta.id}`} />
          </label>

          {mandaMensaje && (
            <label className="flex flex-col gap-1 text-sm">
              {t("Número de WhatsApp")}
              <select
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={numeroEfectivo}
                onChange={(e) => setNumero(e.target.value)}
                data-testid={`receta-numero-${receta.id}`}
              >
                {numeros.length === 0 && <option value="">{t("Nenhum número conectado")}</option>}
                {numeros.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.etiqueta}
                  </option>
                ))}
              </select>
            </label>
          )}

          {pideLink && (
            <label className="flex flex-col gap-1 text-sm">
              {t("Link de avaliação do Google")}
              <Input value={link} placeholder="https://g.page/r/…" onChange={(e) => setLink(e.target.value)} />
            </label>
          )}

          {receta.plantilla && <BloqueDePlantilla plantilla={receta.plantilla} />}

          <div>
            <Button
              size="sm"
              disabled={ocupada}
              data-testid={`receta-guardar-${receta.id}`}
              onClick={() => onCambio(ajustes)}
            >
              {t("Salvar")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function BloqueDePlantilla({ plantilla }: { plantilla: NonNullable<VistaDeReceta["plantilla"]> }) {
  const t = useT();
  const [copiado, setCopiado] = React.useState(false);
  const estado = plantilla.estado ?? t("Ainda não criado");
  return (
    <div className="rounded-md bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t("Fora das 24 h só saem plantillas de Meta aprovadas")}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("Nome")}</dt>
        <dd className="font-mono text-xs">{plantilla.nombre}</dd>
        <dt className="text-muted-foreground">{t("Categoria")}</dt>
        <dd>
          <Badge variant="secondary">{plantilla.categoria === "UTILITY" ? "Utility" : "Marketing"}</Badge>{" "}
          <span className="text-xs text-muted-foreground">{plantilla.porQueCategoria}</span>
        </dd>
        <dt className="text-muted-foreground">{t("Idioma")}</dt>
        <dd>{plantilla.idioma}</dd>
        <dt className="text-muted-foreground">{t("Estado na Meta")}</dt>
        <dd data-testid={`plantilla-estado-${plantilla.nombre}`}>{estado}</dd>
      </dl>
      <pre className="mt-2 whitespace-pre-wrap rounded border border-border bg-background p-2 text-xs">{plantilla.cuerpo}</pre>
      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(plantilla.cuerpo);
              setCopiado(true);
            } catch {
              setCopiado(false);
            }
          }}
        >
          {copiado ? t("Copiado") : t("Copiar texto")}
        </Button>
        <Link className="text-xs text-primary underline underline-offset-4" href="/app/settings/templates">
          {t("Criar e aprovar em Modelos")}
        </Link>
      </div>
    </div>
  );
}
