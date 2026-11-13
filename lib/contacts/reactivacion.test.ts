import { describe, expect, it, vi } from "vitest";

import { diasMDDeLaSemana } from "./cumpleanos";
import { contactosDormidos, limiteDeDormidos } from "./dormidos";

describe("diasMDDeLaSemana", () => {
  it("devuelve 7 días seguidos", () => {
    expect(diasMDDeLaSemana({ ano: 2026, mes: 11, dia: 13 })).toEqual([1113, 1114, 1115, 1116, 1117, 1118, 1119]);
  });

  it("cruza el fin de año", () => {
    expect(diasMDDeLaSemana({ ano: 2026, mes: 12, dia: 29 })).toEqual([1229, 1230, 1231, 101, 102, 103, 104]);
  });

  it("29/feb: en año no bisiesto se suma al 28", () => {
    expect(diasMDDeLaSemana({ ano: 2027, mes: 2, dia: 26 })).toContain(229);
  });

  it("29/feb: en año bisiesto no duplica y existe el 29 real", () => {
    const d = diasMDDeLaSemana({ ano: 2028, mes: 2, dia: 26 });
    expect(d).toEqual([226, 227, 228, 229, 301, 302, 303]);
  });
});

describe("dormidos", () => {
  it("el límite es agora menos N días", () => {
    expect(limiteDeDormidos(new Date("2026-11-13T00:00:00.000Z"), 60)).toBe("2026-09-14T00:00:00.000Z");
  });

  it("consulta filtrando organización, bloqueados y anonimizados", async () => {
    const calls: string[] = [];
    const q: Record<string, unknown> = {};
    const chain = (n: string) =>
      vi.fn((...a: unknown[]) => {
        calls.push(`${n}:${a.join(",")}`);
        return q;
      });
    for (const m of ["select", "eq", "not", "lt", "order"]) q[m] = chain(m);
    q.limit = vi.fn(async () => ({
      data: [{ id: "c1", name: "Ana", display_name: null, phone_number: "1", last_activity_at: "2026-01-01T00:00:00Z" }],
      error: null,
    }));
    const db = { from: () => q } as never;
    const r = await contactosDormidos(db, "org1", { agora: new Date("2026-11-13T00:00:00Z") });
    expect(r).toEqual([{ id: "c1", nombre: "Ana", last_activity_at: "2026-01-01T00:00:00Z" }]);
    expect(calls).toContain("eq:organization_id,org1");
    expect(calls).toContain("eq:is_blocked,false");
    expect(calls).toContain("eq:is_anonymized,false");
  });
});
