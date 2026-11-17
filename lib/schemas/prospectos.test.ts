import { describe, expect, it } from "vitest";

import { normalizePhoneBR } from "@/lib/webhooks/inbound";

import { prospectoSchema, slugDeOrigen } from "./prospectos";

describe("prospectoSchema", () => {
  it("acepta el contrato completo", () => {
    const r = prospectoSchema.safeParse({
      nombre: "Ana",
      telefono: "011 15 1234-5678",
      email: "ana@example.com",
      origen: "Instagram",
      campana: "Verano",
      mensaje: "Hola",
      etapa: "Nuevo",
      id_externo: "ig-1",
    });
    expect(r.success).toBe(true);
  });

  it("exige id_externo", () => {
    expect(prospectoSchema.safeParse({ telefono: "+5491112345678" }).success).toBe(false);
  });

  it("exige telefono o email", () => {
    const r = prospectoSchema.safeParse({ nombre: "Ana", id_externo: "x" });
    expect(r.success).toBe(false);
  });

  it("recusa un teléfono que no se puede normalizar", () => {
    expect(prospectoSchema.safeParse({ telefono: "123", id_externo: "x" }).success).toBe(false);
  });

  it("trata \"\" como ausente (n8n manda vacío)", () => {
    const r = prospectoSchema.safeParse({ telefono: "+5491112345678", email: "", campana: "", id_externo: "x" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBeUndefined();
      expect(r.data.campana).toBeUndefined();
    }
  });

  it("acepta «campaña» con ñ como alias de campana", () => {
    const r = prospectoSchema.safeParse({ telefono: "+5491112345678", "campaña": "Verano", id_externo: "x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.campana).toBe("Verano");
  });
});

describe("teléfono argentino", () => {
  it.each([
    ["011 15 1234-5678", "+5491112345678"],
    ["11 1234-5678", "+5491112345678"],
    ["+54 9 11 1234-5678", "+5491112345678"],
    ["+54 11 1234-5678", "+5491112345678"],
    ["0351 15 123-4567", "+5493511234567"],
  ])("%s → %s", (crudo, esperado) => {
    expect(normalizePhoneBR(crudo)).toBe(esperado);
  });
});

describe("slugDeOrigen", () => {
  it("normaliza a un slug estable", () => {
    expect(slugDeOrigen("Instagram Ads")).toBe("instagram_ads");
    expect(slugDeOrigen("Formulário Web!")).toBe("formulario_web");
    expect(slugDeOrigen("  ")).toBeNull();
    expect(slugDeOrigen(undefined)).toBeNull();
  });
});
