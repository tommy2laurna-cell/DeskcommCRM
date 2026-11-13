/**
 * ANTISPAM DE LA CAPTACIÓN PÚBLICA — sin captcha de terceros.
 *
 * Dos capas, las dos del lado del servidor:
 *  1. Señuelo (honeypot): un campo que el formulario esconde con CSS. Una persona
 *     no lo ve ni lo completa; un bot que rellena todo, sí. Se contesta como si
 *     el envío hubiera salido bien para no darle al bot una señal de que falló.
 *  2. Límite por IP: pocos envíos por minuto desde la misma dirección.
 *
 * Ninguna de las dos decide nada sobre la persona: no bloquean cuentas ni
 * guardan la IP más allá de lo que la captación ya registra.
 */
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { CAMPO_SENUELO } from "@/lib/captar/formulario";

/** Envíos por minuto y por IP, sumando todos los formularios. */
export const LIMITE_POR_IP_POR_MINUTO = 6;

/** ¿El señuelo vino con algo? Cualquier valor no vacío es un bot. */
export function senueloCompleto(cuerpo: unknown): boolean {
  if (!cuerpo || typeof cuerpo !== "object") return false;
  const v = (cuerpo as Record<string, unknown>)[CAMPO_SENUELO];
  if (typeof v === "string") return v.trim().length > 0;
  return v !== undefined && v !== null && v !== false;
}

/** true = pasa. Sin IP legible comparten un cubo, que es más estricto, no más laxo. */
export async function pasaElLimitePorIp(headers: Headers): Promise<boolean> {
  const ip = ipDoCliente(headers) ?? "sin-ip";
  const r = await checkRateLimit(`captar:ip:${ip}`, LIMITE_POR_IP_POR_MINUTO, 60);
  return r.allowed;
}
