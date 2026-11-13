"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { ReviewsSettings } from "@/lib/schemas/settings";

export function ResenasForm({ initial }: { initial: ReviewsSettings }) {
  const t = useT();
  const [form, setForm] = useState<ReviewsSettings>(initial);
  const [isPending, startTransition] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/reviews", form);
        toast.success(t("Avaliações salvas."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-resenas">
      <Card className="space-y-4 p-4">
        <div className="space-y-1">
          <Label htmlFor="google_review_url">{t("Link de avaliações do Google")}</Label>
          <Input
            id="google_review_url"
            type="url"
            placeholder="https://..."
            value={form.google_review_url}
            disabled={isPending}
            onChange={(e) => setForm((f) => ({ ...f, google_review_url: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="dias_despues">{t("Dias depois de ganhar")}</Label>
          <Input
            id="dias_despues"
            type="number"
            min={0}
            max={30}
            value={form.dias_despues}
            disabled={isPending}
            onChange={(e) => setForm((f) => ({ ...f, dias_despues: Number(e.target.value) }))}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="mensaje_nombre">{t("Mensagem aprovada (nome)")}</Label>
            <Input
              id="mensaje_nombre"
              value={form.mensaje_aprobado_nombre}
              disabled={isPending}
              onChange={(e) => setForm((f) => ({ ...f, mensaje_aprobado_nombre: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mensaje_idioma">{t("Mensagem aprovada (idioma)")}</Label>
            <Input
              id="mensaje_idioma"
              placeholder="es_AR"
              value={form.mensaje_aprobado_idioma}
              disabled={isPending}
              onChange={(e) => setForm((f) => ({ ...f, mensaje_aprobado_idioma: e.target.value }))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            "Na mensagem aprovada, {{1}} é o nome do cliente e {{2}} o link. Sem link ou sem mensagem, nada é enviado.",
          )}
        </p>
      </Card>
      <div>
        <Button type="submit" disabled={isPending}>
          {t("Salvar avaliações")}
        </Button>
      </div>
    </form>
  );
}
