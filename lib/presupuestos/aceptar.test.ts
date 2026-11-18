import { describe, expect, it } from "vitest";

import {
  aceptarPresupuesto,
  etapaDeDestinoAlAceptar,
  type EtapaFila,
  type LeadFila,
  type PresupuestoFila,
  type Repo,
} from "./aceptar";

const ETAPAS: EtapaFila[] = [
  { id: "e3", name: "Cierre", position: 3, is_lost: false },
  { id: "e1", name: "Nuevo", position: 1, is_lost: false },
  { id: "e2", name: "Presupuesto enviado", position: 2, is_lost: false },
  { id: "e4", name: "Perdido", position: 4, is_lost: true },
];

function repoEnMemoria(over: {
  presupuesto?: Partial<PresupuestoFila> | null;
  lead?: Partial<LeadFila> | null;
}) {
  const estado = {
    presupuesto:
      over.presupuesto === null
        ? null
        : ({
            id: "p1",
            lead_id: "l1",
            numero: 7,
            estado: "emitido",
            valido_hasta: "2026-12-01",
            total_cents: 36_000_000,
            ...over.presupuesto,
          } as PresupuestoFila),
    lead:
      over.lead === null
        ? null
        : ({
            id: "l1",
            title: "Lucía Fernández",
            status: "open",
            pipeline_id: "pl1",
            stage_id: "e2",
            contact_id: "c1",
            owner_user_id: "u-resp",
            ...over.lead,
          } as LeadFila),
    movidos: [] as Array<{ leadId: string; stageId: string; position: number }>,
    tareas: [] as Array<{ titulo: string; asignadoA: string; leadId: string }>,
    actividades: [] as Array<{ tipo: string; razon: string }>,
    aceptaciones: 0,
  };
  const repo: Repo = {
    zonaDeLaOrganizacion: async () => "America/Argentina/Buenos_Aires",
    presupuesto: async () => estado.presupuesto,
    marcarAceptado: async () => {
      // Solo la primera llamada "gana": simula el `where estado = 'emitido'`.
      if (estado.presupuesto?.estado !== "emitido") return false;
      estado.presupuesto.estado = "aceptado";
      estado.aceptaciones += 1;
      return true;
    },
    lead: async () => estado.lead,
    etapasDelEmbudo: async () => ETAPAS,
    primeraPosicionEn: async () => 2000,
    moverLead: async (leadId, stageId, position) => {
      estado.movidos.push({ leadId, stageId, position });
    },
    crearTarea: async (t) => {
      estado.tareas.push(t);
    },
    registrarActividad: async (a) => {
      estado.actividades.push({ tipo: a.tipo, razon: a.razon });
    },
  };
  return { repo, estado };
}

const AHORA = new Date("2026-11-13T15:00:00Z");
const args = { presupuestoId: "p1", userId: "u-vend", ahora: AHORA };

describe("aceptarPresupuesto", () => {
  it("acepta, mueve el negocio a la etapa siguiente y le crea una tarea al responsable", async () => {
    const { repo, estado } = repoEnMemoria({});
    const r = await aceptarPresupuesto(repo, args);

    expect(r).toEqual({ ok: true, yaAceptado: false, movioAEtapa: "Cierre", tareaPara: "u-resp" });
    expect(estado.presupuesto?.estado).toBe("aceptado");
    expect(estado.movidos).toEqual([{ leadId: "l1", stageId: "e3", position: 1000 }]);
    expect(estado.tareas).toHaveLength(1);
    expect(estado.tareas[0]).toMatchObject({ asignadoA: "u-resp", leadId: "l1" });
    expect(estado.tareas[0]!.titulo).toContain("N° 0007");
    expect(estado.actividades.map((a) => a.tipo)).toEqual(["stage_changed", "note"]);
  });

  it("aceptar dos veces no mueve ni avisa dos veces", async () => {
    const { repo, estado } = repoEnMemoria({});
    await aceptarPresupuesto(repo, args);
    const segunda = await aceptarPresupuesto(repo, args);

    expect(segunda).toMatchObject({ ok: true, yaAceptado: true, movioAEtapa: null, tareaPara: null });
    expect(estado.aceptaciones).toBe(1);
    expect(estado.movidos).toHaveLength(1);
    expect(estado.tareas).toHaveLength(1);
  });

  it("no mueve si la etapa siguiente es de pérdida, pero igual acepta y avisa", async () => {
    const { repo, estado } = repoEnMemoria({ lead: { stage_id: "e3" } });
    const r = await aceptarPresupuesto(repo, args);
    expect(r).toMatchObject({ ok: true, movioAEtapa: null, tareaPara: "u-resp" });
    expect(estado.movidos).toHaveLength(0);
  });

  it("sin responsable no inventa una tarea para nadie", async () => {
    const { repo, estado } = repoEnMemoria({ lead: { owner_user_id: null } });
    const r = await aceptarPresupuesto(repo, args);
    expect(r).toMatchObject({ ok: true, tareaPara: null });
    expect(estado.tareas).toHaveLength(0);
  });

  it("un negocio ya cerrado no se mueve de etapa", async () => {
    const { repo, estado } = repoEnMemoria({ lead: { status: "won" } });
    const r = await aceptarPresupuesto(repo, args);
    expect(r).toMatchObject({ ok: true, movioAEtapa: null });
    expect(estado.movidos).toHaveLength(0);
  });

  it("rechaza un presupuesto vencido y no toca nada", async () => {
    const { repo, estado } = repoEnMemoria({ presupuesto: { valido_hasta: "2026-11-12" } });
    const r = await aceptarPresupuesto(repo, args);
    expect(r).toEqual({ ok: false, codigo: "vencido", status: 409 });
    expect(estado.presupuesto?.estado).toBe("emitido");
    expect(estado.movidos).toHaveLength(0);
    expect(estado.tareas).toHaveLength(0);
  });

  it("el último día de validez todavía se puede aceptar (en la hora de Buenos Aires)", async () => {
    // 02:00 UTC del 14 = 23:00 del 13 en Buenos Aires.
    const { repo } = repoEnMemoria({ presupuesto: { valido_hasta: "2026-11-13" } });
    const r = await aceptarPresupuesto(repo, { ...args, ahora: new Date("2026-11-14T02:00:00Z") });
    expect(r).toMatchObject({ ok: true, yaAceptado: false });
  });

  it("404 si no existe y 409 si fue rechazado", async () => {
    expect(await aceptarPresupuesto(repoEnMemoria({ presupuesto: null }).repo, args)).toEqual({
      ok: false,
      codigo: "no_encontrado",
      status: 404,
    });
    expect(
      await aceptarPresupuesto(repoEnMemoria({ presupuesto: { estado: "rechazado" } }).repo, args),
    ).toEqual({ ok: false, codigo: "rechazado", status: 409 });
  });
});

describe("etapaDeDestinoAlAceptar", () => {
  it("toma la siguiente por posición, no por orden del arreglo", () => {
    expect(etapaDeDestinoAlAceptar(ETAPAS, "e1")?.id).toBe("e2");
  });
  it("devuelve null en la última etapa y con una etapa desconocida", () => {
    expect(etapaDeDestinoAlAceptar(ETAPAS, "e3")).toBeNull();
    expect(etapaDeDestinoAlAceptar(ETAPAS, "nada")).toBeNull();
  });
});
