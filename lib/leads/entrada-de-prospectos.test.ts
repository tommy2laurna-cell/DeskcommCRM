import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: vi.fn(),
  moveLeadHandler: vi.fn(),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: vi.fn(),
}));
vi.mock("./nascimento-do-lead", () => ({ funilDeEntrada: vi.fn() }));

const { createLeadHandler, moveLeadHandler } = await import("@/app/api/v1/leads/_handler");
const { encontrarContatoPorTelefoneComNome } = await import("@/lib/channels/contato-por-telefone");
const { funilDeEntrada } = await import("./nascimento-do-lead");
const { ingresarProspecto } = await import("./entrada-de-prospectos");

const ORG = "22222222-2222-4222-8222-222222222222";
const ctx = { organization_id: ORG, actor: { type: "api_token", id: "tok", role: "agent" } as never, requestId: "r1" };

type Respuesta = { data?: unknown; error?: { code?: string; message: string } | null };

/**
 * Supabase de mentira: cada tabla tiene una cola de respuestas que se consumen
 * en orden, y registra lo que se le escribe. Cualquier cadena de filtros
 * devuelve la misma cadena; se resuelve con `await` o con `maybeSingle()`.
 */
function fakeDb(respuestas: Record<string, Respuesta[]>) {
  const escrituras: Array<{ tabla: string; op: "insert" | "update"; valores: unknown }> = [];
  const db = {
    from(tabla: string) {
      const siguiente = (): Respuesta => respuestas[tabla]?.shift() ?? { data: null, error: null };
      const cadena: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "ilike"]) cadena[m] = () => cadena;
      cadena.insert = (valores: unknown) => (escrituras.push({ tabla, op: "insert", valores }), cadena);
      cadena.update = (valores: unknown) => (escrituras.push({ tabla, op: "update", valores }), cadena);
      cadena.maybeSingle = async () => siguiente();
      cadena.then = (res: (v: Respuesta) => unknown) => Promise.resolve(siguiente()).then(res);
      return cadena;
    },
  };
  return { db: db as never, escrituras };
}

const ENTRADA = { pipelineId: "p1", stageId: "s1" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(funilDeEntrada).mockResolvedValue(ENTRADA);
  vi.mocked(encontrarContatoPorTelefoneComNome).mockResolvedValue(null);
  vi.mocked(createLeadHandler).mockResolvedValue({ id: "lead-1" });
});

describe("ingresarProspecto", () => {
  it("alta: contacto nuevo + lead con source=api, id_externo y teléfono normalizado", async () => {
    const { db, escrituras } = fakeDb({
      crm_leads: [{ data: null }],
      contacts: [{ data: { id: "c1" } }],
    });
    const r = await ingresarProspecto(db, ctx, {
      nombre: "Ana",
      telefono: "011 15 1234-5678",
      origen: "Instagram",
      campana: "Verano",
      id_externo: "ig-1",
    });
    expect(r).toMatchObject({ accion: "alta", contacto_id: "c1", lead_id: "lead-1", telefono: "+5491112345678" });

    const contacto = escrituras.find((e) => e.tabla === "contacts" && e.op === "insert")!.valores as Record<string, unknown>;
    expect(contacto).toMatchObject({ phone_number: "+5491112345678", source: "instagram", name: "Ana" });
    expect(contacto.source_metadata).toMatchObject({ origen: "Instagram", campana: "Verano" });

    const lead = vi.mocked(createLeadHandler).mock.calls[0]![2];
    expect(lead).toMatchObject({ source: "api", external_id: "ig-1", contact_id: "c1", stage_id: "s1" });
    expect(lead.source_metadata).toMatchObject({ origen: "Instagram", campana: "Verano" });
  });

  it("actualización: si el id_externo ya tiene lead no crea otro ni otro contacto", async () => {
    const { db, escrituras } = fakeDb({
      crm_leads: [
        { data: { id: "lead-1", contact_id: "c1", stage_id: "s1", pipeline_id: "p1", source_metadata: { x: 1 } } },
      ],
    });
    const r = await ingresarProspecto(db, ctx, { telefono: "+5491112345678", mensaje: "Hola de nuevo", id_externo: "ig-1" });
    expect(r).toMatchObject({ accion: "actualizacion", lead_id: "lead-1", contacto_id: "c1" });
    expect(createLeadHandler).not.toHaveBeenCalled();
    expect(escrituras.some((e) => e.op === "insert")).toBe(false);
    const upd = escrituras.find((e) => e.tabla === "crm_leads" && e.op === "update")!.valores as Record<string, unknown>;
    expect(upd.description).toBe("Hola de nuevo");
    expect(upd.source_metadata).toMatchObject({ x: 1, via: "api" });
  });

  it("reusa el contacto que ya existe por teléfono", async () => {
    vi.mocked(encontrarContatoPorTelefoneComNome).mockResolvedValue({ id: "c9", phone_number: "+5491112345678", name: "Ana" });
    const { db, escrituras } = fakeDb({ crm_leads: [{ data: null }] });
    const r = await ingresarProspecto(db, ctx, { telefono: "11 1234 5678", id_externo: "a" });
    expect(r.contacto_id).toBe("c9");
    expect(escrituras.some((e) => e.tabla === "contacts" && e.op === "insert")).toBe(false);
  });

  it("carrera: el índice único hace perder a la segunda llamada, que cae en actualización", async () => {
    vi.mocked(createLeadHandler).mockRejectedValue(
      new ApiError(500, "internal_error", undefined, "r1", 'duplicate key value violates unique constraint "uniq_crm_leads_org_source_external"'),
    );
    const { db } = fakeDb({
      crm_leads: [
        { data: null },
        { data: { id: "lead-ganador", contact_id: "c1", stage_id: "s1", pipeline_id: "p1", source_metadata: {} } },
      ],
      contacts: [{ data: { id: "c1" } }],
    });
    const r = await ingresarProspecto(db, ctx, { telefono: "+5491112345678", id_externo: "a" });
    expect(r).toMatchObject({ accion: "actualizacion", lead_id: "lead-ganador" });
  });

  it("etapa pedida por nombre dentro del embudo de entrada", async () => {
    const { db } = fakeDb({
      crm_leads: [{ data: null }],
      crm_stages: [{ data: [{ id: "s7", name: "Contactado", pipeline_id: "p1" }] }],
      contacts: [{ data: { id: "c1" } }],
    });
    await ingresarProspecto(db, ctx, { telefono: "+5491112345678", etapa: "contactado", id_externo: "a" });
    expect(vi.mocked(createLeadHandler).mock.calls[0]![2]).toMatchObject({ stage_id: "s7", pipeline_id: "p1" });
  });

  it("etapa inexistente → 422 con las etapas válidas", async () => {
    const { db } = fakeDb({
      crm_leads: [{ data: null }],
      crm_stages: [{ data: [{ id: "s1", name: "Nuevo", pipeline_id: "p1" }] }],
    });
    await expect(
      ingresarProspecto(db, ctx, { telefono: "+5491112345678", etapa: "Nada", id_externo: "a" }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Nuevo") });
  });

  it("actualización con etapa distinta mueve el lead", async () => {
    const { db } = fakeDb({
      crm_leads: [{ data: { id: "lead-1", contact_id: "c1", stage_id: "s1", pipeline_id: "p1", source_metadata: {} } }],
      crm_stages: [{ data: [{ id: "s2", name: "Calificado", pipeline_id: "p1" }] }],
    });
    const r = await ingresarProspecto(db, ctx, { telefono: "+5491112345678", etapa: "Calificado", id_externo: "a" });
    expect(moveLeadHandler).toHaveBeenCalledWith(db, ctx, "lead-1", { to_stage_id: "s2" });
    expect(r.etapa_id).toBe("s2");
  });

  it("sin embudo de entrada → 422", async () => {
    vi.mocked(funilDeEntrada).mockResolvedValue({ erro: "sem_funil_de_entrada" });
    const { db } = fakeDb({ crm_leads: [{ data: null }] });
    await expect(ingresarProspecto(db, ctx, { telefono: "+5491112345678", id_externo: "a" })).rejects.toMatchObject({
      status: 422,
    });
  });
});
