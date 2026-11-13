"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ContactPickerDialog } from "@/components/inbox/composer/ContactPickerDialog";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

interface Resposta {
  data: { referred_by: { id: string; nombre: string } | null };
}

/** «Lo recomendó» en la ficha: quién trajo a este contacto. Editable por quien puede editar. */
export function LoRecomendo({ contactId, podeEditar }: { contactId: string; podeEditar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const chave = ["contact-referred-by", contactId];
  const q = useQuery({
    queryKey: chave,
    queryFn: () => apiClient.get<Resposta>(`/api/v1/contacts/${contactId}/referred-by`),
  });

  async function salvar(referredBy: string | null) {
    try {
      await apiClient.patch(`/api/v1/contacts/${contactId}/referred-by`, {
        referred_by_contact_id: referredBy,
      });
      await qc.invalidateQueries({ queryKey: chave });
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
    }
  }

  const ref = q.data?.data.referred_by ?? null;
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{t("Quem indicou")}</dt>
      <dd className="mt-1 flex flex-wrap items-center gap-2">
        <span>{ref ? ref.nombre || "—" : "—"}</span>
        {podeEditar && (
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setAberto(true)}>
              {ref ? t("Trocar") : t("Escolher contato")}
            </Button>
            {ref && (
              <Button type="button" variant="ghost" size="sm" onClick={() => void salvar(null)}>
                {t("Remover")}
              </Button>
            )}
          </>
        )}
      </dd>
      <ContactPickerDialog
        open={aberto}
        onOpenChange={setAberto}
        excludeContactId={contactId}
        onPick={(p) => {
          setAberto(false);
          if (p.contactId) void salvar(p.contactId);
        }}
      />
    </div>
  );
}
