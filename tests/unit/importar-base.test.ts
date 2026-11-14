// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { crearFixture } from "../../lrn/scripts/fixture-base";
import { aplicar, informe, leerBase, planificar, slugify } from "../../lrn/scripts/importar-base";

const MIGRACIONES = join(process.cwd(), "lrn/fixtures/base-migraciones");

/** Un Supabase de memoria: lo justo que usa el script (select/insert/upsert, eq/is/limit, maybeSingle/single, `a->>b`). */
function bancoDeMemoria() {
  const tablas: Record<string, Record<string, unknown>[]> = {};
  let n = 0;
  const valor = (f: Record<string, unknown>, col: string) => {
    const [c, k] = col.split("->>");
    return k ? (f[c!] as Record<string, unknown> | null)?.[k] : f[c!];
  };
  const tabla = (nombre: string) => {
    const filas = (tablas[nombre] ??= []);
    const filtros: Array<(f: Record<string, unknown>) => boolean> = [];
    let modo: "select" | "insert" | "upsert" = "select";
    let upd = false;
    let payload: Record<string, unknown> = {};
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Record<string, unknown>) => ((modo = "insert"), (payload = p), b),
      upsert: (p: Record<string, unknown>) => ((modo = "upsert"), (payload = p), b),
      eq: (c: string, v: unknown) => (filtros.push((f) => valor(f, c) === v), b),
      is: (c: string, v: unknown) => (filtros.push((f) => (valor(f, c) ?? null) === v), b),
      update: (p: Record<string, unknown>) => ((modo = "upsert"), (payload = p), (upd = true), b),
      limit: () => b,
      maybeSingle: async () => ({ data: filas.find((f) => filtros.every((p) => p(f))) ?? null, error: null }),
      single: async () => {
        const fila = { id: `id-${++n}`, ...payload };
        filas.push(fila);
        return { data: fila, error: null };
      },
      then: (ok: (v: unknown) => unknown) => {
        if (modo === "upsert") {
          const ex = filas.find((f) => f.id === payload.id);
          if (ex) Object.assign(ex, payload);
          else filas.push({ ...payload });
          return ok({ data: null, error: null });
        }
        return ok({ data: filas.filter((f) => filtros.every((p) => p(f))), error: null });
      },
    };
    return b;
  };
  return { db: { from: tabla } as unknown as SupabaseClient, tablas };
}

describe("importar-base", () => {
  let dir: string;
  let archivo: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "importar-base-"));
    archivo = join(dir, "base.sqlite");
    crearFixture(archivo, MIGRACIONES);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("planifica sin perder nada en silencio", () => {
    const p = planificar(leerBase(archivo));
    expect(p.embudos.map((e) => e.slug)).toEqual(["base-ventas", "base-postventa"]);
    // dos etapas «ganada» en el mismo embudo: la segunda se fusiona en la primera
    const ventas = p.embudos[0]!.etapas;
    expect(ventas.filter((e) => e.won)).toHaveLength(1);
    expect(ventas.find((e) => e.nombre === "Cerrada con seña")?.fusionadaEn).toBe(3);
    expect(p.contactos.map((c) => c.baseId)).toEqual([1, 2, 3, 5]); // el 4 está borrado y sin oportunidades
    expect(p.omitidos.map((o) => `${o.tipo}:${o.id}`).sort()).toEqual(["contacto:4", "oportunidad:7"]);
    const ana = p.contactos[0]!;
    expect(ana.telefono).toBe("+5491123456789");
    expect(ana.tags.sort()).toEqual(["referido", "vip"]);
    expect(ana.nota).toContain("Cuenta: Panadería Ñandú SRL");
    expect(ana.nota).toContain("zona: Palermo");
    expect(ana.nota).toContain("Cumpleaños: 03-14");
    expect(p.contactos.find((c) => c.baseId === 3)!.nota).toContain("Teléfono (no se pudo normalizar): interno 22");
    expect(p.leads).toHaveLength(6);
    expect(p.leads.find((l) => l.baseId === 2)).toMatchObject({ estado: "won", etapaBaseId: 3 });
    expect(p.leads.find((l) => l.baseId === 6)).toMatchObject({ estado: "lost", motivoPerdida: "Precio" });
    expect(p.leads.find((l) => l.baseId === 3)!.meta).toMatchObject({ base_moneda: "pesos" });
    expect(p.tareas.map((q) => [q.idExt, q.hecha])).toEqual([["t6", false], ["t7", true]]);
    expect(p.notas.filter((n) => n.idExt.startsWith("t"))).toHaveLength(5);
    expect(p.sinLugar.listas).toHaveLength(1);
  });

  it("importar dos veces deja los mismos conteos y sin duplicados", async () => {
    const plan = planificar(leerBase(archivo));
    const { db, tablas } = bancoDeMemoria();
    tablas.organizations = [{ id: "org-1" }];
    const op = { simular: false, pisarMarca: false, marca: { negocio: "Cliente SA", colores: { acento: "#710014" } } };
    const sim = await aplicar(db, "org-1", plan, { ...op, simular: true });
    expect(Object.values(tablas).flat().filter((f) => f.id !== "org-1")).toEqual([]); // simular no escribe
    const r1 = await aplicar(db, "org-1", plan, op);
    const medio = Object.fromEntries(Object.entries(tablas).map(([k, v]) => [k, v.length]));
    const r2 = await aplicar(db, "org-1", plan, op);
    expect(Object.fromEntries(Object.entries(tablas).map(([k, v]) => [k, v.length]))).toEqual(medio);
    expect(sim.leads.creados).toBe(r1.leads.creados);
    expect(r1.leads).toEqual({ creados: 6, existentes: 0 });
    expect(r2.leads).toEqual({ creados: 0, existentes: 6 });
    for (const k of ["embudos", "etapas", "contactos", "notas", "tareas"] as const) {
      expect(r2[k].creados, k).toBe(0);
      expect(r2[k].existentes, k).toBe(r1[k].creados);
    }
    expect(medio.crm_leads).toBe(6);
    expect(tablas.platform_branding).toHaveLength(1);
    expect(informe(plan, r2, false)).toContain("Ya estaban");
  });

  it("slugify respeta el formato del Conectado", () => {
    expect(slugify("Cerrada con seña")).toBe("cerrada-con-sena");
    expect(slugify("¿?")).toMatch(/^[a-z0-9_-]{2,40}$/);
  });
});
