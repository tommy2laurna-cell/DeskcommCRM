import { describe, expect, it } from "vitest";

import { agruparReferidos } from "./referidos";

describe("agruparReferidos", () => {
  it("cuenta referidos y cuántos ganaron, ordenado por ganados", () => {
    const filas = agruparReferidos(
      [
        { id: "c1", referred_by_contact_id: "A" },
        { id: "c2", referred_by_contact_id: "A" },
        { id: "c3", referred_by_contact_id: "B" },
        { id: "c4", referred_by_contact_id: "B" },
        { id: "c5", referred_by_contact_id: "B" },
      ],
      new Set(["c1", "c2"]),
      new Map([["A", "Ana"]]),
    );
    expect(filas).toEqual([
      { contact_id: "A", nombre: "Ana", referidos: 2, ganaron: 2 },
      { contact_id: "B", nombre: "", referidos: 3, ganaron: 0 },
    ]);
  });

  it("sin referidos devuelve vacío", () => {
    expect(agruparReferidos([], new Set(), new Map())).toEqual([]);
  });
});
