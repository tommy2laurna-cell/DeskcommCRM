/**
 * Un mensaje de marketing sin forma de salir no se envía.
 *
 * El botón es de RESPUESTA RÁPIDA (QUICK_REPLY) y su texto tiene que ser un
 * pedido de baja inequívoco (`ehBajaInequivoca`, la misma lista con que el webhook acepta una baja por botón): si el texto fuera
 * "Quiero info", tocarlo no bloquearía a nadie y el botón sería decoración.
 * Cuando la persona lo toca, el webhook lo entrega como texto y
 * `lib/channels/pos-entrada.ts` bloquea el contacto y registra
 * `consent.marketing.declined_at`.
 */
import { ehBajaInequivoca } from "@/lib/opt-out/deteccao";

interface ComponenteConBotones {
  type?: string;
  buttons?: { type?: string; text?: string }[];
}

export function tieneBotonDeBaja(components: unknown): boolean {
  if (!Array.isArray(components)) return false;
  return (components as ComponenteConBotones[]).some(
    (c) =>
      String(c.type ?? "").toUpperCase() === "BUTTONS" &&
      (c.buttons ?? []).some(
        (b) => String(b.type ?? "").toUpperCase() === "QUICK_REPLY" && ehBajaInequivoca(b.text),
      ),
  );
}
