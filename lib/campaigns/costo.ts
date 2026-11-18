/**
 * COSTO ESTIMADO DE UNA CAMPAÑA — sin inventar ninguna tarifa.
 *
 * La cifra solo existe si la organización cargó la tarifa vigente de Meta
 * (`organizations.settings.campaigns.tarifa`, editable por admin). Sin tarifa no
 * hay número: ni cero, ni un valor por defecto. Un costo inventado que parece
 * dato es peor que no mostrar nada.
 *
 * Fuente oficial a citar (las tarifas por país, Argentina incluida, están en las
 * rate cards descargables de esa página):
 */
import { z } from "zod";

export const FUENTE_OFICIAL_DE_TARIFAS =
  "https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing";

export type CategoriaDeMensaje = "marketing" | "utility" | "authentication";

const precio = z.number().positive().max(1000);

export const tarifaSchema = z
  .object({
    marketing: precio,
    utility: precio,
    authentication: precio.optional(),
    moneda: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Moneda ISO-4217 de 3 letras."),
    fuente_url: z.string().trim().url().max(500),
    vigente_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha AAAA-MM-DD."),
  })
  .strict();

export type Tarifa = z.infer<typeof tarifaSchema>;

/** Lee la tarifa de `organizations.settings`; inválida o ausente = `null`. */
export function leerTarifa(settings: unknown): Tarifa | null {
  if (!settings || typeof settings !== "object") return null;
  const campaigns = (settings as Record<string, unknown>).campaigns;
  if (!campaigns || typeof campaigns !== "object") return null;
  const parsed = tarifaSchema.safeParse((campaigns as Record<string, unknown>).tarifa);
  return parsed.success ? parsed.data : null;
}

export type CostoEstimado =
  | { disponible: false; mensaje: string }
  | {
      disponible: true;
      monto: number;
      moneda: string;
      por_mensaje: number;
      fuente_url: string;
      vigente_desde: string;
    };

/** Clave en portugués del diccionario; en español: «Cargá la tarifa vigente de Meta para ver el costo». */
export const MENSAJE_SIN_TARIFA = "Carregue a tarifa vigente da Meta para ver o custo";

export function estimarCosto(
  destinatariosEfectivos: number,
  categoria: CategoriaDeMensaje,
  tarifa: Tarifa | null,
): CostoEstimado {
  const porMensaje = tarifa ? tarifa[categoria] : undefined;
  if (!tarifa || porMensaje === undefined) {
    return { disponible: false, mensaje: MENSAJE_SIN_TARIFA };
  }
  return {
    disponible: true,
    // 6 decimales: tarifas de centavos de dólar por miles de mensajes no deben
    // acumular ruido de coma flotante.
    monto: Math.round(destinatariosEfectivos * porMensaje * 1e6) / 1e6,
    moneda: tarifa.moneda,
    por_mensaje: porMensaje,
    fuente_url: tarifa.fuente_url,
    vigente_desde: tarifa.vigente_desde,
  };
}
