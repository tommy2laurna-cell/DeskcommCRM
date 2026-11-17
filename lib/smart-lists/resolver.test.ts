import { describe, expect, it, vi } from "vitest";

import { filtrosAArgumentos, filtrosDeListaSchema, leerPaginaDeLista } from "./resolver";

const ORG = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";
const AHORA = new Date("2026-11-13T12:00:00.000Z");

describe("filtrosDeListaSchema", () => {
  it("exige al menos un filtro (una lista vacía sería «todos los contactos»)", () => {
    expect(filtrosDeListaSchema.safeParse({}).success).toBe(false);
  });

  it("rechaza claves desconocidas y rangos de puntaje invertidos", () => {
    expect(filtrosDeListaSchema.safeParse({ etiquetas: ["vip"], organization_id: ORG }).success).toBe(false);
    expect(filtrosDeListaSchema.safeParse({ puntaje_min: 80, puntaje_max: 20 }).success).toBe(false);
    expect(filtrosDeListaSchema.safeParse({ cumpleanos_mes: 13 }).success).toBe(false);
  });

  it("acepta los seis filtros juntos", () => {
    const r = filtrosDeListaSchema.safeParse({
      etiquetas: ["vip"],
      etapas: [ETAPA],
      origenes: ["whatsapp"],
      puntaje_min: 40,
      dias_sin_contacto: 30,
      cumpleanos_mes: "actual",
    });
    expect(r.success).toBe(true);
  });
});

describe("filtrosAArgumentos", () => {
  it("traduce cada filtro al parámetro de fn_smart_list_contacts y deja null lo ausente", () => {
    const args = filtrosAArgumentos(ORG, { etiquetas: ["vip"], puntaje_min: 70 }, AHORA);
    expect(args).toEqual({
      p_org: ORG,
      p_tags: ["vip"],
      p_stage_ids: null,
      p_sources: null,
      p_score_min: 70,
      p_score_max: null,
      p_inactive_before: null,
      p_birthday_month: null,
    });
  });

  it("«hace más de N días» es un corte exacto en el pasado", () => {
    const args = filtrosAArgumentos(ORG, { dias_sin_contacto: 10 }, AHORA);
    expect(args.p_inactive_before).toBe("2026-11-03T12:00:00.000Z");
  });

  it("cumpleaños «actual» usa el mes del fuso de la organización, no el del servidor", () => {
    // 1 de diciembre 01:00 UTC sigue siendo 30 de noviembre en Buenos Aires.
    const limite = new Date("2026-12-01T01:00:00.000Z");
    expect(filtrosAArgumentos(ORG, { cumpleanos_mes: "actual" }, limite).p_birthday_month).toBe(11);
    expect(filtrosAArgumentos(ORG, { cumpleanos_mes: "actual" }, limite, "UTC").p_birthday_month).toBe(12);
    expect(filtrosAArgumentos(ORG, { cumpleanos_mes: 3 }, AHORA).p_birthday_month).toBe(3);
  });
});

/** Doble mínimo del builder de PostgREST: registra las llamadas y responde `filas`. */
function dbFalsa(filas: { id: string }[], count: number | null = null) {
  const llamadas: { fn: string; args: unknown[] }[] = [];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit", "gt"]) {
    q[m] = (...args: unknown[]) => {
      llamadas.push({ fn: m, args });
      return q;
    };
  }
  q.then = (res: (v: unknown) => unknown) => res({ data: filas, error: null, count });
  const rpc = vi.fn((fn: string, args: unknown, opts: unknown) => {
    llamadas.push({ fn: `rpc:${fn}`, args: [args, opts] });
    return q;
  });
  return { db: { rpc } as never, llamadas, rpc };
}

describe("leerPaginaDeLista", () => {
  it("pagina por keyset: pide limite+1, corta, y devuelve el id del último como cursor", async () => {
    const filas = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { db, llamadas } = dbFalsa(filas);
    const p = await leerPaginaDeLista(db, ORG, { etiquetas: ["vip"] }, { limite: 2, despues: "0" });
    expect(p.contactos.map((c) => c.id)).toEqual(["a", "b"]);
    expect(p.siguiente).toBe("b");
    expect(llamadas.find((l) => l.fn === "limit")?.args).toEqual([3]);
    expect(llamadas.find((l) => l.fn === "gt")?.args).toEqual(["id", "0"]);
  });

  it("última página: sin cursor; el total solo se pide si se contó", async () => {
    const { db, rpc } = dbFalsa([{ id: "a" }], 1);
    const p = await leerPaginaDeLista(db, ORG, { etiquetas: ["vip"] }, { limite: 5, contar: true });
    expect(p.siguiente).toBeNull();
    expect(p.total).toBe(1);
    expect(rpc.mock.calls[0]![2]).toEqual({ count: "exact" });
  });
});
