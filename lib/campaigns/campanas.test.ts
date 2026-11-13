import { describe, expect, it, vi } from "vitest";

import { tieneBotonDeBaja } from "./boton-de-baja";
import {
  estimarCosto,
  leerTarifa,
  MENSAJE_SIN_TARIFA,
  tarifaSchema,
  type Tarifa,
} from "./costo";
import { clasificarContacto, resumirDestinatarios, telefonoParaMeta } from "./destinatarios";
import { procesarLote, type CampanaEnCurso, type DepsDeEnvio } from "./procesar";
import { traduzir } from "@/lib/i18n/dicionario";

const TARIFA: Tarifa = {
  marketing: 0.05,
  utility: 0.02,
  moneda: "USD",
  fuente_url: "https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing",
  vigente_desde: "2026-11-01",
};

describe("clasificarContacto / resumirDestinatarios", () => {
  const ok = { id: "1", phone_number: "+5491100000001", is_blocked: false, consent: null };

  it("recibe quien tiene teléfono y no pidió la baja", () => {
    expect(clasificarContacto(ok)).toEqual({ estado: "pendiente", telefono: "+5491100000001" });
  });

  it("excluye por consent.marketing.declined_at, aunque no esté bloqueado", () => {
    const c = { ...ok, consent: { marketing: { granted_at: null, declined_at: "2026-11-01T00:00:00Z" } } };
    expect(clasificarContacto(c)).toEqual({ estado: "excluido_optout", motivo: "consent_declined" });
  });

  it("excluye al bloqueado (el opt-out por palabra deja is_blocked) y al sin teléfono", () => {
    expect(clasificarContacto({ ...ok, is_blocked: true }).estado).toBe("excluido_optout");
    expect(clasificarContacto({ ...ok, phone_number: null }).estado).toBe("excluido_sin_telefono");
  });

  it("el default de la columna (granted_at null, sin declined_at) NO es una baja", () => {
    const c = { ...ok, consent: { marketing: { granted_at: null, source: null, version: null } } };
    expect(clasificarContacto(c).estado).toBe("pendiente");
  });

  it("cuenta efectivos y exclusiones", () => {
    const r = resumirDestinatarios([
      ok,
      { ...ok, id: "2", is_blocked: true },
      { ...ok, id: "3", phone_number: null },
      { ...ok, id: "4", consent: { marketing: { declined_at: "2026-01-01" } } },
    ]);
    expect(r).toEqual({ total: 4, efectivos: 1, excluidos_optout: 2, excluidos_sin_telefono: 1 });
  });

  it("el teléfono va a Meta solo con dígitos", () => {
    expect(telefonoParaMeta("+54 9 11-0000-0001")).toBe("5491100000001");
  });
});

describe("costo estimado", () => {
  it("sin tarifa no hay número: solo el texto de cargar la tarifa (en español, el pedido)", () => {
    const c = estimarCosto(100, "marketing", null);
    expect(c).toEqual({ disponible: false, mensaje: MENSAJE_SIN_TARIFA });
    expect(JSON.stringify(c)).not.toMatch(/monto/);
    expect(traduzir(MENSAJE_SIN_TARIFA, "es")).toBe("Cargá la tarifa vigente de Meta para ver el costo");
  });

  it("con tarifa: destinatarios efectivos × tarifa de la categoría, con su fuente", () => {
    const c = estimarCosto(120, "marketing", TARIFA);
    expect(c).toMatchObject({ disponible: true, monto: 6, moneda: "USD", por_mensaje: 0.05, fuente_url: TARIFA.fuente_url });
    expect(estimarCosto(100, "utility", TARIFA)).toMatchObject({ monto: 2 });
  });

  it("categoría sin tarifa cargada (authentication) tampoco inventa cifra", () => {
    expect(estimarCosto(10, "authentication", TARIFA).disponible).toBe(false);
  });

  it("leerTarifa ignora lo inválido y tarifaSchema rechaza lo incompleto", () => {
    expect(leerTarifa(undefined)).toBeNull();
    expect(leerTarifa({ campaigns: { tarifa: { marketing: 0.05 } } })).toBeNull();
    expect(leerTarifa({ campaigns: { tarifa: TARIFA } })).toEqual(TARIFA);
    expect(tarifaSchema.safeParse({ ...TARIFA, marketing: 0 }).success).toBe(false);
    expect(tarifaSchema.safeParse({ ...TARIFA, fuente_url: "no-url" }).success).toBe(false);
  });
});

describe("tieneBotonDeBaja", () => {
  const con = (text: string, type = "QUICK_REPLY") => [
    { type: "BODY", text: "Hola" },
    { type: "BUTTONS", buttons: [{ type, text }] },
  ];
  it("exige un QUICK_REPLY cuyo texto sea un pedido de baja", () => {
    expect(tieneBotonDeBaja(con("Baja"))).toBe(true);
    expect(tieneBotonDeBaja(con("STOP"))).toBe(true);
    expect(tieneBotonDeBaja(con("Dar de baja"))).toBe(true);
    // Los verbos genéricos no son una baja inequívoca por botón.
    expect(tieneBotonDeBaja(con("Cancelar"))).toBe(false);
    expect(tieneBotonDeBaja(con("Parar"))).toBe(false);
    expect(tieneBotonDeBaja(con("Quiero info"))).toBe(false);
    expect(tieneBotonDeBaja(con("Baja", "URL"))).toBe(false);
    expect(tieneBotonDeBaja([{ type: "BODY", text: "Hola" }])).toBe(false);
    expect(tieneBotonDeBaja(null)).toBe(false);
  });
});

/** Base en memoria con el subconjunto del builder de PostgREST que usa `procesarLote`. */
function baseFalsa(
  recipients: Record<string, unknown>[],
  contacts: Record<string, unknown>[],
) {
  const tablas: Record<string, Record<string, unknown>[]> = {
    campaign_recipients: recipients,
    contacts,
    campaigns: [{ id: "camp", organization_id: "org", status: "enviando" }],
  };
  const from = (tabla: string) => {
    const filtros: ((r: Record<string, unknown>) => boolean)[] = [];
    let cambios: Record<string, unknown> | null = null;
    let head = false;
    let tope = Infinity;
    let uno = false;
    const q: Record<string, unknown> = {};
    const chain = (n: string, f: (...a: never[]) => void) => {
      q[n] = (...a: never[]) => {
        f(...a);
        return q;
      };
    };
    chain("select", ((_c: string, o?: { head?: boolean }) => {
      head = !!o?.head;
    }) as never);
    chain("eq", ((c: string, v: unknown) => void filtros.push((r) => r[c] === v)) as never);
    chain("lt", ((c: string, v: number) => void filtros.push((r) => (r[c] as number) < v)) as never);
    chain("in", ((c: string, v: unknown[]) => void filtros.push((r) => v.includes(r[c]))) as never);
    chain("or", ((e: string) => {
      if (e.startsWith("status.eq.pendiente")) {
        filtros.push((r) => r.status === "pendiente" || (r.status === "error" && (r.attempts as number) < 3));
      }
    }) as never);
    chain("order", (() => {}) as never);
    chain("limit", ((n: number) => void (tope = n)) as never);
    chain("update", ((c: Record<string, unknown>) => void (cambios = c)) as never);
    q.maybeSingle = () => {
      uno = true;
      return q;
    };
    q.then = (res: (v: unknown) => unknown) => {
      const filas = tablas[tabla]!.filter((r) => filtros.every((f) => f(r)));
      if (cambios) {
        const afectadas = filas.slice(0, 1 + (tabla === "campaigns" ? 0 : 0));
        for (const r of tabla === "campaigns" ? filas : afectadas) Object.assign(r, cambios);
        return res({ data: uno ? (afectadas[0] ?? null) : afectadas, error: null });
      }
      const data = filas.slice(0, tope);
      return res({ data: uno ? (data[0] ?? null) : data, error: null, count: filas.length, ...(head ? { data: null } : {}) });
    };
    return q;
  };
  return { admin: { from } as never, recipients, contacts, campanas: tablas.campaigns! };
}

const CAMPANA: CampanaEnCurso = {
  id: "camp",
  organization_id: "org",
  channel_session_id: "ses",
  session_ref: "123",
  template_name: "promo",
  template_language: "es_AR",
  template_values: {},
};

function deps(over: Partial<DepsDeEnvio> = {}) {
  const enviar = vi.fn(async ({ para }: { para: string }) => `sim:${para}`);
  const d: DepsDeEnvio = {
    ahora: () => new Date("2026-11-13T12:00:00Z"),
    esperar: async () => {},
    puedeEnviar: async () => true,
    enviar,
    ...over,
  };
  return { d, enviar };
}

const fila = (id: string, contact_id: string, extra = {}) => ({
  id,
  campaign_id: "camp",
  organization_id: "org",
  contact_id,
  status: "pendiente",
  attempts: 0,
  claimed_at: null,
  ...extra,
});
const contacto = (id: string, extra = {}) => ({
  id,
  organization_id: "org",
  phone_number: `+54911000000${id}`,
  is_blocked: false,
  consent: null,
  ...extra,
});

describe("procesarLote", () => {
  it("revalúa el opt-out justo antes de enviar: quien se dio de baja DESPUÉS de confirmar no recibe", async () => {
    const { admin, recipients } = baseFalsa(
      [fila("r1", "1"), fila("r2", "2"), fila("r3", "3")],
      [
        contacto("1"),
        contacto("2", { consent: { marketing: { declined_at: "2026-11-13T11:00:00Z" } } }),
        contacto("3", { is_blocked: true }),
      ],
    );
    const { d, enviar } = deps();
    const r = await procesarLote(admin, CAMPANA, d);

    expect(r).toMatchObject({ enviados: 1, excluidos: 2, errores: 0 });
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]![0].para).toBe("54911000000" + "1");
    expect(recipients.find((x) => x.id === "r2")).toMatchObject({ status: "excluido_optout", reason: "consent_declined" });
    expect(recipients.find((x) => x.id === "r3")).toMatchObject({ status: "excluido_optout" });
    expect(recipients.find((x) => x.id === "r1")).toMatchObject({ status: "enviado", external_id: "sim:549110000001" });
  });

  it("reintento idempotente: lo enviado no se reenvía al correr de nuevo", async () => {
    const { admin } = baseFalsa([fila("r1", "1")], [contacto("1")]);
    const { d, enviar } = deps();
    await procesarLote(admin, CAMPANA, d);
    await procesarLote(admin, CAMPANA, d);
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("un arriendo vigente de otro tick impide tomar la fila", async () => {
    const { admin } = baseFalsa(
      [fila("r1", "1", { claimed_at: "2026-11-13T11:59:00Z" })],
      [contacto("1")],
    );
    const { d, enviar } = deps();
    const r = await procesarLote(admin, CAMPANA, d);
    expect(enviar).not.toHaveBeenCalled();
    expect(r.enviados).toBe(0);
  });

  it("tope diario: corta el lote y deja lo pendiente para mañana", async () => {
    const { admin, recipients } = baseFalsa(
      [fila("r1", "1"), fila("r2", "2")],
      [contacto("1"), contacto("2")],
    );
    const { d, enviar } = deps({ puedeEnviar: async () => false });
    const r = await procesarLote(admin, CAMPANA, d);
    expect(r.cortado).toBe("tope_diario");
    expect(enviar).not.toHaveBeenCalled();
    expect(recipients.every((x) => x.status === "pendiente")).toBe(true);
  });

  it("un fallo del transporte queda en error con motivo y se reintenta hasta 3 veces", async () => {
    const { admin, recipients } = baseFalsa([fila("r1", "1")], [contacto("1")]);
    const enviar = vi.fn(async () => { throw new Error("meta_131026: undeliverable"); });
    const { d } = deps({ enviar });
    for (let i = 0; i < 5; i++) await procesarLote(admin, CAMPANA, d);
    expect(enviar).toHaveBeenCalledTimes(3);
    expect(recipients[0]).toMatchObject({ status: "error", attempts: 3 });
  });

  it("cancelar en pleno lote frena los envíos que faltan y no se pisa el estado", async () => {
    const { admin, recipients, campanas } = baseFalsa(
      [fila("r1", "1"), fila("r2", "2")],
      [contacto("1"), contacto("2")],
    );
    const enviar = vi.fn(async ({ para }: { para: string }) => {
      campanas[0]!.status = "cancelada"; // alguien cancela durante el primer envío
      return `sim:${para}`;
    });
    const r = await procesarLote(admin, CAMPANA, deps({ enviar }).d);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(r.cortado).toBe("cancelada");
    expect(campanas[0]!.status).toBe("cancelada");
    expect(recipients.find((x) => x.id === "r2")).toMatchObject({ status: "pendiente" });
  });

  it("un fallo de la campaña entera (plantilla no aprobada) corta el lote", async () => {
    const { admin } = baseFalsa([fila("r1", "1"), fila("r2", "2")], [contacto("1"), contacto("2")]);
    const enviar = vi.fn(async () => { throw new Error("template_not_approved: promo"); });
    const r = await procesarLote(admin, CAMPANA, deps({ enviar }).d);
    expect(r.cortado).toBe("fallo_de_campana");
    expect(enviar).toHaveBeenCalledTimes(1);
  });
});
