"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/lib/i18n/IdiomaProvider";

interface Lista {
  id: string;
  name: string;
  filters: Record<string, unknown>;
}
interface Contato {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
}

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function ListasClient() {
  const t = useT();
  const [listas, setListas] = React.useState<Lista[]>([]);
  const [nome, setNome] = React.useState("");
  const [etiquetas, setEtiquetas] = React.useState("");
  const [origens, setOrigens] = React.useState("");
  const [dias, setDias] = React.useState("");
  const [pontuacao, setPontuacao] = React.useState("");
  const [aniversario, setAniversario] = React.useState(false);
  const [aberta, setAberta] = React.useState<{ id: string; contatos: Contato[]; total: number | null } | null>(null);

  const carregar = React.useCallback(async () => {
    try {
      const r = await apiClient.get<{ data: Lista[] }>("/api/v1/smart-lists");
      setListas(r.data);
    } catch (e) {
      showApiError(e);
    }
  }, []);
  React.useEffect(() => {
    void carregar();
  }, [carregar]);

  async function criar(e: React.FormEvent) {
    e.preventDefault();
    const filters: Record<string, unknown> = {};
    if (csv(etiquetas).length) filters.etiquetas = csv(etiquetas);
    if (csv(origens).length) filters.origenes = csv(origens);
    if (dias) filters.dias_sin_contacto = Number(dias);
    if (pontuacao) filters.puntaje_min = Number(pontuacao);
    if (aniversario) filters.cumpleanos_mes = "actual";
    try {
      await apiClient.post("/api/v1/smart-lists", { name: nome, filters });
      toast.success(t("Lista criada."));
      setNome("");
      await carregar();
    } catch (err) {
      showApiError(err);
    }
  }

  async function ver(id: string) {
    try {
      const r = await apiClient.get<{ data: Contato[]; meta?: { total?: number } }>(
        `/api/v1/smart-lists/${id}/contacts?limite=20`,
      );
      setAberta({ id, contatos: r.data, total: r.meta?.total ?? null });
    } catch (err) {
      showApiError(err);
    }
  }

  async function apagar(id: string) {
    try {
      await apiClient.delete(`/api/v1/smart-lists/${id}`);
      if (aberta?.id === id) setAberta(null);
      await carregar();
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="listas-root">
      <form onSubmit={criar} className="flex flex-col gap-3 rounded-lg border p-4">
        <div>
          <Label htmlFor="lista-nome">{t("Nome da lista")}</Label>
          <Input id="lista-nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="lista-etiquetas">{t("Etiquetas (separadas por vírgula)")}</Label>
          <Input id="lista-etiquetas" value={etiquetas} onChange={(e) => setEtiquetas(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="lista-origens">{t("Origem (separadas por vírgula)")}</Label>
          <Input id="lista-origens" value={origens} onChange={(e) => setOrigens(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="lista-dias">{t("Sem contato há mais de (dias)")}</Label>
          <Input id="lista-dias" type="number" min={1} value={dias} onChange={(e) => setDias(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="lista-pontuacao">{t("Pontuação mínima (0 a 100)")}</Label>
          <Input
            id="lista-pontuacao"
            type="number"
            min={0}
            max={100}
            value={pontuacao}
            onChange={(e) => setPontuacao(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={aniversario} onChange={(e) => setAniversario(e.target.checked)} />
          {t("Aniversariantes do mês")}
        </label>
        <Button type="submit">{t("Criar lista")}</Button>
      </form>

      <div className="flex flex-col gap-3">
        {listas.length === 0 && <p className="text-sm text-muted-foreground">{t("Nenhuma lista ainda.")}</p>}
        {listas.map((l) => (
          <div key={l.id} className="rounded-lg border p-3" data-testid="lista-item">
            <div className="flex items-center justify-between gap-2">
              <strong>{l.name}</strong>
              <span className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void ver(l.id)}>
                  {t("Ver contatos")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void apagar(l.id)}>
                  {t("Apagar")}
                </Button>
              </span>
            </div>
            {aberta?.id === l.id && (
              <div className="mt-2 text-sm">
                {aberta.total !== null && (
                  <p className="text-muted-foreground">
                    {t("Contatos agora")}: {aberta.total}
                  </p>
                )}
                <ul className="list-disc pl-5">
                  {aberta.contatos.map((c) => (
                    <li key={c.id}>{c.display_name ?? c.name ?? c.phone_number}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
