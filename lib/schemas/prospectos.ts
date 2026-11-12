/**
 * prospectoSchema → POST /api/v1/prospectos (entrada de prospectos por token).
 *
 * Los nombres de campo van en español porque quien arma la llamada es una
 * automatización de n8n escrita por una persona, no un cliente tipado.
 * n8n manda "" para lo que viene vacío: eso se trata como ausente.
 */
import { z } from "zod";

import { normalizePhoneBR } from "@/lib/webhooks/inbound";

const vacioAUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const texto = (max: number) => z.preprocess(vacioAUndefined, z.string().trim().max(max).optional());

export const prospectoSchema = z
  .preprocess(
    // Alias: «campaña» con ñ es lo que escribe una persona; `campana` es lo canónico.
    (raw) => {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const o = raw as Record<string, unknown>;
        if (o["campaña"] !== undefined && o["campana"] === undefined) {
          const { ["campaña"]: c, ...resto } = o;
          return { ...resto, campana: c };
        }
      }
      return raw;
    },
    z
      .object({
        nombre: texto(200),
        telefono: texto(40),
        email: z.preprocess(vacioAUndefined, z.string().trim().email().max(254).optional()),
        origen: texto(60),
        campana: texto(120),
        mensaje: texto(2000),
        etapa: texto(120),
        id_externo: z.string().trim().min(1).max(255),
      })
      .superRefine((v, ctx) => {
        if (!v.telefono && !v.email) {
          ctx.addIssue({
            code: "custom",
            path: ["telefono"],
            message: "Hace falta telefono o email para identificar al prospecto.",
          });
        }
        if (v.telefono && !normalizePhoneBR(v.telefono)) {
          ctx.addIssue({ code: "custom", path: ["telefono"], message: "Teléfono inválido." });
        }
      }),
  );

export type ProspectoInput = z.output<typeof prospectoSchema>;

/** «Instagram Ads» → «instagram_ads». Vacío → null. */
export function slugDeOrigen(origen: string | undefined): string | null {
  if (!origen) return null;
  const s = origen
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || null;
}
