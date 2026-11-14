import { describe, expect, it } from "vitest";

import { aCsv, celdaCsv, conversiones, urlDeLista, ventanaDelPeriodo } from "@/lib/reports/tablero";

describe("tablero: CSV para Excel argentino", () => {
  it("separa con «;», pone coma decimal y BOM", () => {
    const csv = aCsv(["a", "b"], [["x", 1234.5]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe("a;b\r\nx;1234,5\r\n");
  });
  it("escapa «;», comillas y saltos, y neutraliza fórmulas", () => {
    expect(celdaCsv('a;b')).toBe('"a;b"');
    expect(celdaCsv('di "hola"')).toBe('"di ""hola"""');
    expect(celdaCsv("=SUMA(A1)")).toBe("'=SUMA(A1)");
    expect(celdaCsv(null)).toBe("");
  });
});

describe("tablero: período y lista", () => {
  it("cae en 30 días ante un valor desconocido", () => {
    const ahora = new Date("2026-11-13T12:00:00Z");
    expect(ventanaDelPeriodo("7", ahora).from.toISOString()).toBe("2026-11-06T12:00:00.000Z");
    expect(ventanaDelPeriodo("raro", ahora).periodo).toBe("30");
  });
  it("el link de la lista lleva el filtro que produjo el número", () => {
    const u = urlDeLista({ tipo: "ganados", from: "a", to: "b", owner: "u1", source: "web" });
    expect(u).toBe("/app/metrics/lista?tipo=ganados&from=a&to=b&source=web&owner=u1");
  });
  it("la conversión se calcula dentro del mismo embudo", () => {
    const e = (pipeline_id: string, alcanzaron: number) => ({ stage_id: "s", stage_name: "n", pipeline_id, position: 0, alcanzaron });
    expect(conversiones([e("p", 10), e("p", 5), e("q", 3)])).toEqual([null, 0.5, null]);
  });
});
