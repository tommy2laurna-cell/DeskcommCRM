"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { FUENTE_OFICIAL_DE_TARIFAS, MENSAJE_SIN_TARIFA } from "@/lib/campaigns/costo";
import { useT } from "@/lib/i18n/IdiomaProvider";

interface Campana {
  id: string;
  name: string;
  status: string;
  template_name: string;
  total_recipients: number;
  total_sent: number;
  total_excluded: number;
  total_error: number;
}
interface Opciones {
  sesiones: { id: string; display_name: string | null; phone_number: string | null }[];
  mensajes: { name: string; language: string; categoria: string; tiene_boton_de_baja: boolean }[];
  listas: { id: string; name: string }[];
}
interface Vista {
  mensaje: { texto: string; categoria: string; tiene_boton_de_baja: boolean };
  destinatarios: { total: number; efectivos: number; excluidos_optout: number; excluidos_sin_telefono: number };
  costo:
    | { disponible: false; mensaje: string }
    | { disponible: true; monto: number; moneda: string; por_mensaje: number; fuente_url: string; vigente_desde: string };
}

export function CampanasClient({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [campanas, setCampanas] = React.useState<Campana[]>([]);
  const [op, setOp] = React.useState<Opciones | null>(null);
  const [nome, setNome] = React.useState("");
  const [lista, setLista] = React.useState("");
  const [sesion, setSesion] = React.useState("");
  const [mensaje, setMensaje] = React.useState("");
  const [vista, setVista] = React.useState<{ id: string; v: Vista } | null>(null);
  const [tarifa, setTarifa] = React.useState({ marketing: "", utility: "", moneda: "", fuente_url: "", vigente_desde: "" });

  const carregar = React.useCallback(async () => {
    try {
      const [c, o, tf] = await Promise.all([
        apiClient.get<{ data: Campana[] }>("/api/v1/campaigns"),
        apiClient.get<{ data: Opciones }>("/api/v1/campaigns/opciones"),
        apiClient.get<{ data: { tarifa: Record<string, unknown> | null } }>("/api/v1/campaigns/tarifa"),
      ]);
      setCampanas(c.data);
      setOp(o.data);
      const x = tf.data.tarifa;
      if (x) {
        setTarifa({
          marketing: String(x.marketing ?? ""),
          utility: String(x.utility ?? ""),
          moneda: String(x.moneda ?? ""),
          fuente_url: String(x.fuente_url ?? ""),
          vigente_desde: String(x.vigente_desde ?? ""),
        });
      }
    } catch (e) {
      showApiError(e);
    }
  }, []);
  React.useEffect(() => {
    void carregar();
  }, [carregar]);

  async function criar(e: React.FormEvent) {
    e.preventDefault();
    const [name, language] = mensaje.split("|");
    try {
      await apiClient.post("/api/v1/campaigns", {
        name: nome,
        list_id: lista,
        channel_session_id: sesion,
        template_name: name,
        template_language: language,
      });
      setNome("");
      await carregar();
    } catch (err) {
      showApiError(err);
    }
  }

  async function previa(id: string) {
    try {
      const r = await apiClient.get<{ data: Vista }>(`/api/v1/campaigns/${id}/preview`);
      setVista({ id, v: r.data });
    } catch (err) {
      showApiError(err);
    }
  }

  async function accion(id: string, que: "confirm" | "cancel") {
    try {
      await apiClient.post(`/api/v1/campaigns/${id}/${que}`, {});
      toast.success(que === "confirm" ? t("Campanha confirmada.") : t("Campanha cancelada."));
      setVista(null);
      await carregar();
    } catch (err) {
      showApiError(err);
    }
  }

  async function guardarTarifa(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiClient.put("/api/v1/campaigns/tarifa", {
        tarifa: {
          marketing: Number(tarifa.marketing),
          utility: Number(tarifa.utility),
          moneda: tarifa.moneda,
          fuente_url: tarifa.fuente_url,
          vigente_desde: tarifa.vigente_desde,
        },
      });
      toast.success(t("Tarifa guardada."));
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="campanas-root">
      <div className="flex flex-col gap-6">
        <form onSubmit={criar} className="flex flex-col gap-3 rounded-lg border p-4">
          <div>
            <Label htmlFor="camp-nome">{t("Nome da campanha")}</Label>
            <Input id="camp-nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="camp-lista">{t("Lista")}</Label>
            <select id="camp-lista" className="w-full rounded-md border p-2" value={lista} onChange={(e) => setLista(e.target.value)} required>
              <option value="" />
              {op?.listas.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="camp-sesion">{t("Número oficial da Meta")}</Label>
            <select id="camp-sesion" className="w-full rounded-md border p-2" value={sesion} onChange={(e) => setSesion(e.target.value)} required>
              <option value="" />
              {op?.sesiones.map((s) => (
                <option key={s.id} value={s.id}>{s.display_name ?? s.phone_number ?? s.id}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="camp-mensaje">{t("Mensagem aprovada")}</Label>
            <select id="camp-mensaje" className="w-full rounded-md border p-2" value={mensaje} onChange={(e) => setMensaje(e.target.value)} required>
              <option value="" />
              {op?.mensajes.map((m) => (
                <option key={`${m.name}|${m.language}`} value={`${m.name}|${m.language}`}>
                  {m.name} ({m.language}, {m.categoria})
                </option>
              ))}
            </select>
          </div>
          <Button type="submit">{t("Criar rascunho")}</Button>
        </form>

        {isAdmin && (
          <form onSubmit={guardarTarifa} className="flex flex-col gap-3 rounded-lg border p-4" data-testid="tarifa-form">
            <strong>{t("Tarifa vigente da Meta")}</strong>
            <p className="text-sm text-muted-foreground">
              {t("Cada país tem a sua tarifa nas rate cards descarregáveis de")}{" "}
              <a className="underline" href={FUENTE_OFICIAL_DE_TARIFAS} target="_blank" rel="noreferrer">
                {FUENTE_OFICIAL_DE_TARIFAS}
              </a>
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="tf-mkt">{t("Preço por mensagem de marketing")}</Label>
                <Input id="tf-mkt" type="number" step="any" min="0" value={tarifa.marketing} onChange={(e) => setTarifa({ ...tarifa, marketing: e.target.value })} required />
              </div>
              <div>
                <Label htmlFor="tf-util">{t("Preço por mensagem de utilidade")}</Label>
                <Input id="tf-util" type="number" step="any" min="0" value={tarifa.utility} onChange={(e) => setTarifa({ ...tarifa, utility: e.target.value })} required />
              </div>
              <div>
                <Label htmlFor="tf-moneda">{t("Moeda (ex.: USD)")}</Label>
                <Input id="tf-moneda" value={tarifa.moneda} onChange={(e) => setTarifa({ ...tarifa, moneda: e.target.value })} required />
              </div>
              <div>
                <Label htmlFor="tf-desde">{t("Vigente desde")}</Label>
                <Input id="tf-desde" type="date" value={tarifa.vigente_desde} onChange={(e) => setTarifa({ ...tarifa, vigente_desde: e.target.value })} required />
              </div>
            </div>
            <div>
              <Label htmlFor="tf-fuente">{t("Fonte (URL)")}</Label>
              <Input id="tf-fuente" type="url" value={tarifa.fuente_url} onChange={(e) => setTarifa({ ...tarifa, fuente_url: e.target.value })} required />
            </div>
            <Button type="submit">{t("Guardar tarifa")}</Button>
          </form>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {campanas.length === 0 && <p className="text-sm text-muted-foreground">{t("Nenhuma campanha ainda.")}</p>}
        {campanas.map((c) => (
          <div key={c.id} className="rounded-lg border p-3" data-testid="campana-item">
            <div className="flex items-center justify-between gap-2">
              <strong>{c.name}</strong>
              <span className="text-xs uppercase text-muted-foreground">{c.status}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("Enviadas")}: {c.total_sent} / {c.total_recipients} · {t("Excluídas")}: {c.total_excluded} · {t("Erros")}: {c.total_error}
            </p>
            <div className="mt-2 flex gap-2">
              {c.status === "borrador" && (
                <Button size="sm" variant="outline" onClick={() => void previa(c.id)}>
                  {t("Prévia")}
                </Button>
              )}
              {["borrador", "confirmada", "enviando"].includes(c.status) && (
                <Button size="sm" variant="outline" onClick={() => void accion(c.id, "cancel")}>
                  {t("Cancelar")}
                </Button>
              )}
            </div>
            {vista?.id === c.id && (
              <div className="mt-3 flex flex-col gap-2 text-sm" data-testid="campana-previa">
                <pre className="whitespace-pre-wrap rounded bg-muted p-2">{vista.v.mensaje.texto}</pre>
                <p>
                  {t("Destinatários efetivos")}: {vista.v.destinatarios.efectivos} / {vista.v.destinatarios.total} ·{" "}
                  {t("Excluídos por saída")}: {vista.v.destinatarios.excluidos_optout} ·{" "}
                  {t("Sem telefone")}: {vista.v.destinatarios.excluidos_sin_telefono}
                </p>
                {vista.v.costo.disponible ? (
                  <p>
                    {t("Custo estimado")}: {vista.v.costo.monto} {vista.v.costo.moneda} ·{" "}
                    <a className="underline" href={vista.v.costo.fuente_url} target="_blank" rel="noreferrer">
                      {t("Fonte")}
                    </a>{" "}
                    ({t("vigente desde")} {vista.v.costo.vigente_desde})
                  </p>
                ) : (
                  <p className="text-muted-foreground">{t(MENSAJE_SIN_TARIFA)}</p>
                )}
                <Button size="sm" onClick={() => void accion(c.id, "confirm")}>
                  {t("Confirmar envio")}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
