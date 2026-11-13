import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { campoSchema, CONSENTIMIENTO_POR_DEFECTO } from "@/lib/captar/formulario";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioPublico, type TextosDelFormulario } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * La página pública de un formulario o encuesta (`/f/[slug]`). Sin sesión: lee
 * con el admin client por `slug` y solo expone lo que el visitante necesita —
 * nunca el `organization_id`, la etapa ni las etiquetas de destino.
 */
export default async function PaginaDelFormulario({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9]{8,32}$/.test(slug)) notFound();

  const admin = createAdminClient();
  const { data: form } = await admin
    .from("capture_forms")
    .select("slug, name, fields, consent_text, is_active, organization_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!form || !form.is_active) notFound();

  const campos = campoSchema.array().safeParse(form.fields);
  if (!campos.success) notFound();

  const { data: org } = await admin
    .from("organizations")
    .select("locale")
    .eq("id", form.organization_id)
    .maybeSingle();
  const idioma = await idiomaDoVisitante((org?.locale as string | null) ?? null);
  const t = (texto: string) => traduzir(texto, idioma);

  const textos: TextosDelFormulario = {
    enviar: t("Enviar"),
    enviando: t("Enviando…"),
    obligatorio: t("Campo obrigatório"),
    telefonoInvalido: t("Telefone inválido"),
    emailInvalido: t("E-mail inválido"),
    opcionInvalida: t("Opção inválida"),
    fechaInvalida: t("Data inválida"),
    elegi: t("Escolha uma opção"),
    si: t("Sim"),
    no: t("Não"),
    aceptar: t("Aceite para continuar"),
    errorGeneral: t("Não foi possível enviar. Tente de novo."),
    demasiados: t("Muitos envios seguidos. Espere um minuto."),
  };

  return (
    <main className="mx-auto w-full max-w-md px-4 py-6">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">{form.name as string}</h1>
      <FormularioPublico
        slug={form.slug as string}
        campos={campos.data}
        consentimiento={(form.consent_text as string) || CONSENTIMIENTO_POR_DEFECTO}
        textos={textos}
      />
    </main>
  );
}
