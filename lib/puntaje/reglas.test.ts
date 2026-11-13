import { describe, expect, it } from "vitest";

import {
  calcularPuntaje,
  conSigno,
  REGLAS_POR_DEFECTO,
  reglasDeLaOrganizacion,
  type EntradaDePuntaje,
  type ReglasDePuntaje,
} from "./reglas";

const AHORA = new Date("2026-11-13T12:00:00Z");
const hace = (dias: number) => new Date(AHORA.getTime() - dias * 86_400_000).toISOString();

const base: EntradaDePuntaje = {
  stageId: "e1",
  valueCents: null,
  source: null,
  ultimoContactoEn: hace(0),
  clienteEscribio: false,
};

const reglas: ReglasDePuntaje = {
  respondio: { puntos: 30 },
  diasSinContacto: {
    tramos: [
      { desdeDias: 3, puntos: -10 },
      { desdeDias: 7, puntos: -25 },
    ],
  },
  etapa: { e1: 5, e2: 20 },
  valor: {
    tramos: [
      { desdePesos: 100_000, puntos: 10 },
      { desdePesos: 1_000_000, puntos: 25 },
    ],
  },
  origen: { referido: 15, "meta ads": -5 },
};

describe("calcularPuntaje", () => {
  it("suma solo las reglas que mueven el número y las explica", () => {
    const r = calcularPuntaje(
      { ...base, clienteEscribio: true, valueCents: 25_000_000, source: "Referido", stageId: "e2" },
      reglas,
      AHORA,
      (id) => (id === "e2" ? "Negociación" : id),
    );
    expect(r.total).toBe(30 + 20 + 10 + 15);
    expect(r.factores.map((f) => f.regla)).toEqual(["respondio", "etapa", "valor", "origen"]);
    expect(r.factores.find((f) => f.regla === "etapa")!.texto).toBe("Está en Negociación");
  });

  it("aplica el tramo de días más alto alcanzado, no todos", () => {
    const r = calcularPuntaje({ ...base, ultimoContactoEn: hace(9) }, reglas, AHORA);
    expect(r.factores.find((f) => f.regla === "diasSinContacto")).toMatchObject({
      puntos: -25,
      texto: "9 días sin contacto",
    });
  });

  it("no inventa puntos: sin datos y sin reglas aplicables da 0 y sin factores", () => {
    const r = calcularPuntaje({ ...base, stageId: "otra", ultimoContactoEn: null }, reglas, AHORA);
    expect(r).toEqual({ total: 0, factores: [] });
  });

  it("un valor en el borde del tramo entra al tramo", () => {
    const r = calcularPuntaje({ ...base, valueCents: 100_000_000 }, reglas, AHORA);
    expect(r.factores.find((f) => f.regla === "valor")!.puntos).toBe(25);
  });

  it("el total puede ser negativo y la suma de factores siempre cierra con él", () => {
    const r = calcularPuntaje({ ...base, ultimoContactoEn: hace(20) }, reglas, AHORA);
    expect(r.total).toBeLessThan(0);
    expect(r.factores.reduce((s, f) => s + f.puntos, 0)).toBe(r.total);
  });
});

describe("reglasDeLaOrganizacion", () => {
  it("cae al defecto si lo guardado está roto o no existe", () => {
    expect(reglasDeLaOrganizacion(null)).toBe(REGLAS_POR_DEFECTO);
    expect(reglasDeLaOrganizacion({ puntaje: { respondio: "mucho" } })).toBe(REGLAS_POR_DEFECTO);
  });
  it("lee lo guardado cuando es válido", () => {
    expect(reglasDeLaOrganizacion({ puntaje: reglas })).toEqual(reglas);
  });
});

describe("conSigno", () => {
  it("usa el menos tipográfico", () => {
    expect(conSigno(5)).toBe("+5");
    expect(conSigno(-5)).toBe("−5");
  });
});
