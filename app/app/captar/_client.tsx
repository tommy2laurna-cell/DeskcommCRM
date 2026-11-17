"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePipelines, usePipelineStages } from "@/hooks/webhooks/useWebhookSources";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import {
  camposIniciales,
  CONSENTIMIENTO_POR_DEFECTO,
  ID_EMAIL,
  ID_NOMBRE,
  ID_TELEFONO,
  TIPOS_DE_CAMPO,
  type Campo,
  type TipoDeCampo,
} from "@/lib/captar/formulario";
import { linkDeFormulario, linkDeWhatsApp, qrComoPngDataUrl, qrComoSvg } from "@/lib/captar/qr";

interface Formulario {
  id: string;
  slug: string;
  kind: "formulario" | "encuesta";
  name: string;
  fields: Campo[];
  pipeline_id: string;
  stage_id: string;
  tags: string[];
  thanks_message: string;
  consent_text: string;
  is_active: boolean;
}

const CLAVE = ["captar-formularios"];

function useFormularios() {
  return useQuery({
    queryKey: CLAVE,
    queryFn: async () => apiClient.get<{ data: Formulario[] }>("/api/v1/captar/formularios"),
  });
}

const select =
  "h-10 w-full rounded-sm border border-border bg-bg px-3 text-sm";

export function CaptarClient() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useFormularios();
  const [editando, setEditando] = React.useState<Formulario | "nuevo" | null>(null);
  const [publicando, setPublicando] = React.useState<Formulario | null>(null);

  const borrar = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/captar/formularios/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: CLAVE }),
    onError: () => toast.error(t("Não foi possível apagar.")),
  });

  const formularios = data?.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button onClick={() => setEditando("nuevo")} data-testid="captar-nuevo">
          {t("Novo formulário")}
        </Button>
      </div>

      {isLoading ? null : formularios.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Você ainda não criou nenhum formulário.")}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="captar-lista">
          {formularios.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.name}</p>
                <p className="text-xs text-muted-foreground">
                  {f.kind === "encuesta" ? t("Pesquisa") : t("Formulário")}
                  {f.is_active ? "" : ` · ${t("Desativado")}`}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setPublicando(f)}>
                {t("Publicar e QR")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditando(f)}>
                {t("Editar")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (window.confirm(t("Apagar este formulário? O link deixa de funcionar."))) borrar.mutate(f.id);
                }}
              >
                {t("Apagar")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editando ? (
        <ConstructorDialog
          inicial={editando === "nuevo" ? null : editando}
          onClose={() => setEditando(null)}
        />
      ) : null}
      {publicando ? <PublicarDialog formulario={publicando} onClose={() => setPublicando(null)} /> : null}
    </div>
  );
}

// ─── Constructor ────────────────────────────────────────────────────────────

function ConstructorDialog({ inicial, onClose }: { inicial: Formulario | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [nombre, setNombre] = React.useState(inicial?.name ?? "");
  const [kind, setKind] = React.useState<"formulario" | "encuesta">(inicial?.kind ?? "formulario");
  const [campos, setCampos] = React.useState<Campo[]>(inicial?.fields ?? camposIniciales());
  const [pipelineId, setPipelineId] = React.useState(inicial?.pipeline_id ?? "");
  const [stageId, setStageId] = React.useState(inicial?.stage_id ?? "");
  const [tags, setTags] = React.useState((inicial?.tags ?? []).join(", "));
  const [gracias, setGracias] = React.useState(inicial?.thanks_message ?? "");
  const [consent, setConsent] = React.useState(inicial?.consent_text ?? "");
  const [activo, setActivo] = React.useState(inicial?.is_active ?? true);

  const { data: funnels } = usePipelines();
  const { data: board } = usePipelineStages(pipelineId || null);
  const pipelines = funnels?.data ?? [];
  const stages = board?.data?.stages ?? [];

  React.useEffect(() => {
    if (!pipelineId && pipelines[0]) setPipelineId(pipelines[0].id);
  }, [pipelineId, pipelines]);
  React.useEffect(() => {
    if (pipelineId && stages.length > 0 && !stages.some((s) => s.id === stageId)) setStageId(stages[0]!.id);
  }, [pipelineId, stages, stageId]);

  const guardar = useMutation({
    mutationFn: async () => {
      const cuerpo = {
        kind,
        name: nombre.trim(),
        fields: campos,
        pipeline_id: pipelineId,
        stage_id: stageId,
        tags: tags
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        thanks_message: gracias.trim(),
        consent_text: consent.trim(),
        is_active: activo,
      };
      return inicial
        ? apiClient.put(`/api/v1/captar/formularios/${inicial.id}`, cuerpo)
        : apiClient.post("/api/v1/captar/formularios", cuerpo);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CLAVE });
      onClose();
    },
    onError: () => toast.error(t("Não foi possível salvar. Confira os campos.")),
  });

  const cambiar = (i: number, parche: Partial<Campo>) =>
    setCampos((p) => p.map((c, j) => (j === i ? { ...c, ...parche } : c)));
  const fijo = (c: Campo) => c.id === ID_NOMBRE || c.id === ID_TELEFONO || c.id === ID_EMAIL;
  const agregar = () =>
    setCampos((p) => {
      let n = p.length + 1;
      while (p.some((c) => c.id === `campo_${n}`)) n += 1;
      return [...p, { id: `campo_${n}`, label: "", tipo: "texto", requerido: false }];
    });

  const valido = nombre.trim() && pipelineId && stageId && campos.every((c) => c.label.trim());

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{inicial ? t("Editar formulário") : t("Novo formulário")}</DialogTitle>
          <DialogDescription>
            {t("O nome e o telefone são sempre pedidos: sem telefone não nasce o contato.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cap-nombre">{t("Nome do formulário")}</Label>
              <Input id="cap-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cap-kind">{t("Tipo")}</Label>
              <select id="cap-kind" className={select} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="formulario">{t("Formulário")}</option>
                <option value="encuesta">{t("Pesquisa")}</option>
              </select>
            </div>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t("Campos")}</legend>
            {campos.map((c, i) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                <Input
                  aria-label={t("Rótulo do campo")}
                  className="min-w-40 flex-1"
                  value={c.label}
                  onChange={(e) => cambiar(i, { label: e.target.value })}
                />
                {fijo(c) ? (
                  <span className="w-28 text-xs text-muted-foreground">{etiquetaDeTipo(c.tipo, t)}</span>
                ) : (
                  <select
                    aria-label={t("Tipo de campo")}
                    className={`${select} w-32`}
                    value={c.tipo}
                    onChange={(e) => cambiar(i, { tipo: e.target.value as TipoDeCampo, opciones: undefined })}
                  >
                    {TIPOS_DE_CAMPO.map((tp) => (
                      <option key={tp} value={tp}>
                        {etiquetaDeTipo(tp, t)}
                      </option>
                    ))}
                  </select>
                )}
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={c.requerido}
                    disabled={c.id === ID_NOMBRE || c.id === ID_TELEFONO}
                    onChange={(e) => cambiar(i, { requerido: e.target.checked })}
                  />
                  {t("Obrigatório")}
                </label>
                {fijo(c) ? null : (
                  <Button size="sm" variant="outline" onClick={() => setCampos((p) => p.filter((_, j) => j !== i))}>
                    {t("Remover")}
                  </Button>
                )}
                {c.tipo === "opcion" ? (
                  <Input
                    aria-label={t("Opções, separadas por vírgula")}
                    placeholder={t("Opções, separadas por vírgula")}
                    className="w-full"
                    value={(c.opciones ?? []).join(", ")}
                    onChange={(e) =>
                      cambiar(i, {
                        opciones: e.target.value
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                ) : null}
              </div>
            ))}
            <div>
              <Button size="sm" variant="outline" onClick={agregar}>
                {t("Adicionar campo")}
              </Button>
            </div>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cap-funnel">{t("Funil de destino")}</Label>
              <select
                id="cap-funnel"
                className={select}
                value={pipelineId}
                onChange={(e) => {
                  setPipelineId(e.target.value);
                  setStageId("");
                }}
              >
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cap-stage">{t("Etapa de destino")}</Label>
              <select id="cap-stage" className={select} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cap-tags">{t("Etiquetas (separadas por vírgula)")}</Label>
            <Input id="cap-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cap-gracias">{t("Mensagem de agradecimento")}</Label>
            <Textarea id="cap-gracias" rows={2} value={gracias} onChange={(e) => setGracias(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cap-consent">{t("Texto de consentimento (Lei 25.326)")}</Label>
            <Textarea
              id="cap-consent"
              rows={3}
              placeholder={CONSENTIMIENTO_POR_DEFECTO}
              value={consent}
              onChange={(e) => setConsent(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("A caixa de consentimento é obrigatória e a data em que a pessoa aceitou fica guardada.")}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
            {t("Ativo (recebendo envios)")}
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancelar")}
          </Button>
          <Button disabled={!valido || guardar.isPending} onClick={() => guardar.mutate()} data-testid="captar-guardar">
            {t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function etiquetaDeTipo(tipo: TipoDeCampo, t: (s: string) => string): string {
  switch (tipo) {
    case "texto":
      return t("Texto");
    case "telefono":
      return t("Telefone");
    case "email":
      return t("E-mail");
    case "opcion":
      return t("Opção");
    case "si_no":
      return t("Sim ou não");
    case "fecha":
      return t("Data");
  }
}

// ─── Publicar: link, snippet y QR ───────────────────────────────────────────

function PublicarDialog({ formulario, onClose }: { formulario: Formulario; onClose: () => void }) {
  const t = useT();
  const origen = typeof window !== "undefined" ? window.location.origin : "";
  const link = `${origen}/f/${formulario.slug}`;
  const iframe = `<iframe src="${link}?embed=1" title="${formulario.name.replace(/"/g, "&quot;")}" style="width:100%;border:0;min-height:520px"></iframe>`;
  const script = `<script src="${origen}/embed/formulario.js" data-formulario="${formulario.slug}" async></script>`;

  const [destino, setDestino] = React.useState<"formulario" | "whatsapp">("formulario");
  const [campana, setCampana] = React.useState("");
  const [telefono, setTelefono] = React.useState("");
  const [texto, setTexto] = React.useState("");

  const contenido = destino === "formulario" ? linkDeFormulario(origen, formulario.slug, campana) : linkDeWhatsApp(telefono, texto);
  const [svg, setSvg] = React.useState("");
  React.useEffect(() => {
    let vivo = true;
    if (!contenido) {
      setSvg("");
      return;
    }
    void qrComoSvg(contenido).then((s) => {
      if (vivo) setSvg(s);
    });
    return () => {
      vivo = false;
    };
  }, [contenido]);

  const copiar = async (s: string) => {
    if (await copyToClipboard(s)) toast.success(t("Copiado."));
  };
  const bajar = (href: string, nombre: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = nombre;
    a.click();
  };
  const bajarSvg = () => bajar(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, `qr-${formulario.slug}.svg`);
  const bajarPng = async () => {
    if (contenido) bajar(await qrComoPngDataUrl(contenido), `qr-${formulario.slug}.png`);
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{formulario.name}</DialogTitle>
          <DialogDescription>{t("Link, código para pegar na sua web e QR.")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Bloque titulo={t("Link próprio")} valor={link} onCopiar={copiar} copiar={t("Copiar")} />
          <Bloque titulo={t("Script para a sua web (recomendado)")} valor={script} onCopiar={copiar} copiar={t("Copiar")} />
          <Bloque titulo={t("Ou um iframe")} valor={iframe} onCopiar={copiar} copiar={t("Copiar")} />

          <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium">{t("Código QR")}</legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={destino === "formulario"} onChange={() => setDestino("formulario")} />
                {t("Abre o formulário")}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={destino === "whatsapp"} onChange={() => setDestino("whatsapp")} />
                {t("Abre o WhatsApp")}
              </label>
            </div>
            {destino === "formulario" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="qr-campana">{t("Campanha (opcional)")}</Label>
                <Input id="qr-campana" value={campana} onChange={(e) => setCampana(e.target.value)} />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="qr-tel">{t("Número de WhatsApp")}</Label>
                  <Input id="qr-tel" inputMode="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="qr-texto">{t("Texto inicial da conversa")}</Label>
                  <Input id="qr-texto" value={texto} onChange={(e) => setTexto(e.target.value)} />
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-4">
              {svg ? (
                <div
                  role="img"
                  aria-label={t("Código QR")}
                  data-testid="captar-qr"
                  className="h-44 w-44 bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
                  // SVG generado por la librería de QR a partir de un link que armamos nosotros.
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              ) : (
                <p className="text-xs text-muted-foreground">{t("Informe um número de WhatsApp válido.")}</p>
              )}
              <div className="flex flex-col gap-2">
                <Button size="sm" variant="outline" disabled={!svg} onClick={() => void bajarPng()}>
                  {t("Baixar PNG")}
                </Button>
                <Button size="sm" variant="outline" disabled={!svg} onClick={bajarSvg}>
                  {t("Baixar SVG")}
                </Button>
              </div>
            </div>
          </fieldset>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Bloque(props: { titulo: string; valor: string; copiar: string; onCopiar: (s: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">{props.titulo}</p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-sm bg-muted p-2 text-xs">{props.valor}</code>
        <Button size="sm" variant="outline" onClick={() => props.onCopiar(props.valor)}>
          {props.copiar}
        </Button>
      </div>
    </div>
  );
}
