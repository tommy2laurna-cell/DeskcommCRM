import { describe, expect, it } from "vitest";

import { REVIEWS_SETTINGS_PADRAO } from "@/lib/schemas/settings";

import {
  resenasConfiguradas,
  textoDelCuerpo,
  valoresDelMensaje,
  vencimientoDelPedido,
} from "./pedido-de-resena";

describe("pedido de reseña", () => {
  it("sin link o sin mensaje aprobado no está configurado", () => {
    expect(resenasConfiguradas(REVIEWS_SETTINGS_PADRAO)).toBe(false);
    expect(
      resenasConfiguradas({
        ...REVIEWS_SETTINGS_PADRAO,
        google_review_url: "https://g.page/r/x",
        mensaje_aprobado_nombre: "pedido_resena",
      }),
    ).toBe(false);
    expect(
      resenasConfiguradas({
        ...REVIEWS_SETTINGS_PADRAO,
        google_review_url: "https://g.page/r/x",
        mensaje_aprobado_nombre: "pedido_resena",
        mensaje_aprobado_idioma: "es_AR",
      }),
    ).toBe(true);
  });

  it("lee el cuerpo del mensaje aprobado", () => {
    expect(textoDelCuerpo([{ type: "HEADER" }, { type: "BODY", text: "Hola {{1}}" }])).toBe("Hola {{1}}");
    expect(textoDelCuerpo(null)).toBe("");
  });

  it("arma los valores según los slots del cuerpo", () => {
    expect(valoresDelMensaje("Hola {{1}}, dejanos tu reseña: {{2}}", "Ana", "L")).toEqual({ "1": "Ana", "2": "L" });
    expect(valoresDelMensaje("Dejanos tu reseña: {{1}}", "Ana", "L")).toEqual({ "1": "L" });
    expect(valoresDelMensaje("Gracias por elegirnos", "Ana", "L")).toEqual({});
  });

  it("vence N días después de cerrar", () => {
    expect(vencimientoDelPedido("2026-11-01T12:00:00.000Z", 3)).toBe("2026-11-04T12:00:00.000Z");
  });
});
