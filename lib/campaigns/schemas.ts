import { z } from "zod";

import { filtrosDeListaSchema } from "@/lib/smart-lists/resolver";

export const createSmartListSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    filters: filtrosDeListaSchema,
  })
  .strict();

export const updateSmartListSchema = createSmartListSchema
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." });

export const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    list_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    template_name: z.string().trim().min(1).max(512),
    template_language: z.string().trim().min(2).max(20),
    template_values: z.record(z.string(), z.string().max(1024)).default({}),
    scheduled_at: z.string().datetime().nullable().optional(),
  })
  .strict();

/** Solo el borrador se edita; la sesión y el mensaje se eligen de nuevo juntos. */
export const updateCampaignSchema = createCampaignSchema
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." });

export const paginaSchema = z.object({
  despues: z.string().uuid().optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});
