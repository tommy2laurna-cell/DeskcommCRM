import { describe, expect, it } from "vitest";

import { senueloCompleto } from "@/lib/captar/antispam";
import {
  camposIniciales,
  definicionSchema,
  limpiarUtm,
  nuevoSlug,
  payloadDelEnvio,
  validarEnvio,
  type Campo,
} from "@/lib/captar/formulario";
import { detallesDeOrigen } from "@/lib/captar/origen";
import { linkDeFormulario, linkDeWhatsApp, qrComoSvg } from "@/lib/captar/qr";

const UUID = "0b9d6a4e-6b2f-4f3a-9b1c-2d5f8a7c1e10";

const base = {
  name: "Contacto web",
  fields: camposIniciales(),
  pipeline_id: UUID,
  stage_id: UUID,
};

describe("definición del formulario", () => {
  it("acepta la definición mínima y completa los defaults", () => {
    const d = definicionSchema.parse(base);
    expect(d.kind).toBe("formulario");
    expect(d.tags).toEqual([]);
    expect(d.is_active).toBe(true);
  });

  it("exige un teléfono obligatorio: sin teléfono no nace el contacto", () => {
    const sinTel = definicionSchema.safeParse({ ...base, fields: camposIniciales().filter((c) => c.id !== "telefono") });
    expect(sinTel.success).toBe(false);
    const opcional = camposIniciales().map((c) => (c.id === "telefono" ? { ...c, requerido: false } : c));
    expect(definicionSchema.safeParse({ ...base, fields: opcional }).success).toBe(false);
  });

  it("rechaza ids y rótulos repetidos y opciones insuficientes", () => {
    const extra: Campo = { id: "x", label: "Nombre", tipo: "texto", requerido: false };
    expect(definicionSchema.safeParse({ ...base, fields: [...camposIniciales(), extra] }).success).toBe(false);
    const op: Campo = { id: "tam", label: "Tamaño", tipo: "opcion", requerido: false, opciones: ["Solo uno"] };
    expect(definicionSchema.safeParse({ ...base, fields: [...camposIniciales(), op] }).success).toBe(false);
  });

  it("el slug es de 12 caracteres a-z0-9 y no se repite", () => {
    const a = nuevoSlug();
    expect(a).toMatch(/^[a-z0-9]{12}$/);
    expect(nuevoSlug()).not.toBe(a);
  });
});

describe("validación del envío", () => {
  const campos: Campo[] = [
    ...camposIniciales(),
    { id: "tam", label: "Tamaño", tipo: "opcion", requerido: true, opciones: ["Chico", "Grande"] },
    { id: "cliente", label: "¿Ya sos cliente?", tipo: "si_no", requerido: false },
    { id: "cuando", label: "Cuándo", tipo: "fecha", requerido: false },
  ];
  const bueno = { nombre: "Ana", telefono: "011 15 1234-5678", tam: "Grande" };

  it("sin la casilla de consentimiento no hay envío (Ley 25.326)", () => {
    const r = validarEnvio(campos, { respuestas: bueno, consentimiento: false });
    expect(r).toEqual({ ok: false, errores: { consentimiento: "requerido" } });
    expect(validarEnvio(campos, { respuestas: bueno }).ok).toBe(false);
  });

  it("acepta un envío completo y descarta lo que no está en la definición", () => {
    const r = validarEnvio(campos, {
      respuestas: { ...bueno, cliente: "Sí", cuando: "2026-12-01", otro: "x" },
      consentimiento: true,
      utm: { utm_campaign: "verano", basura: "x" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.respuestas.otro).toBeUndefined();
      expect(r.respuestas.cliente).toBe("Sí");
      expect(r.utm).toEqual({ utm_campaign: "verano" });
    }
  });

  it("marca cada campo malo con su motivo", () => {
    const r = validarEnvio(campos, {
      respuestas: { nombre: "", telefono: "abc", email: "no-es-mail", tam: "Mediano", cliente: "Quizás", cuando: "ayer" },
      consentimiento: true,
    });
    expect(r).toEqual({
      ok: false,
      errores: {
        nombre: "requerido",
        telefono: "telefono_invalido",
        email: "email_invalido",
        tam: "opcion_invalida",
        cliente: "opcion_invalida",
        cuando: "fecha_invalida",
      },
    });
  });

  it("el payload usa las claves de la captación y lleva el consentimiento con fecha", () => {
    const r = validarEnvio(campos, { respuestas: bueno, consentimiento: true, utm: { utm_source: "qr" } });
    if (!r.ok) throw new Error("debía ser válido");
    const p = payloadDelEnvio(
      { name: "Contacto web", fields: campos, consent_text: "Acepto" },
      r.respuestas,
      r.utm,
      new Date("2026-11-13T12:00:00Z"),
    );
    expect(p).toMatchObject({
      name: "Ana",
      phone: "011 15 1234-5678",
      Tamaño: "Grande",
      utm_source: "qr",
      formulario: "Contacto web",
      consentimiento_datos: "aceptado",
      consentimiento_datos_fecha: "2026-11-13T12:00:00.000Z",
      consentimiento_datos_texto: "Acepto",
    });
    expect(p).not.toHaveProperty("email");
  });

  it("limpiarUtm solo deja las cinco claves utm y recorta largos", () => {
    const u = limpiarUtm({ utm_source: "a".repeat(500), utm_x: "1", utm_medium: 3 });
    expect(Object.keys(u).sort()).toEqual(["utm_medium", "utm_source"]);
    expect(u.utm_source).toHaveLength(200);
  });
});

describe("antispam", () => {
  it("el señuelo con cualquier contenido delata al bot", () => {
    expect(senueloCompleto({ sitio_web: "http://spam.example" })).toBe(true);
    expect(senueloCompleto({ sitio_web: "  " })).toBe(false);
    expect(senueloCompleto({ sitio_web: "" })).toBe(false);
    expect(senueloCompleto({})).toBe(false);
    expect(senueloCompleto(null)).toBe(false);
  });
});

describe("QR", () => {
  it("el link del formulario marca utm_source=qr y la campaña", () => {
    const u = new URL(linkDeFormulario("https://crm.example/", "abc12345xyz0", "Verano 26"));
    expect(u.pathname).toBe("/f/abc12345xyz0");
    expect(u.searchParams.get("utm_source")).toBe("qr");
    expect(u.searchParams.get("utm_campaign")).toBe("Verano 26");
    expect(new URL(linkDeFormulario("https://crm.example", "abc12345xyz0", " ")).searchParams.has("utm_campaign")).toBe(false);
  });

  it("el link de WhatsApp lleva el texto inicial y rechaza números inválidos", () => {
    expect(linkDeWhatsApp("+54 9 11 5555-1234", "Hola, quiero info")).toBe(
      "https://wa.me/5491155551234?text=Hola%2C%20quiero%20info",
    );
    expect(linkDeWhatsApp("+54 9 11 5555-1234", "")).toBe("https://wa.me/5491155551234");
    expect(linkDeWhatsApp("123", "hola")).toBeNull();
  });

  it("dibuja un SVG", async () => {
    const svg = await qrComoSvg("https://crm.example/f/abc12345xyz0");
    expect(svg).toContain("<svg");
  });
});

describe("origen en la ficha", () => {
  it("muestra formulario, campaña, fuente y medio, y nada más", () => {
    expect(
      detallesDeOrigen({ formulario_nombre: "Contacto web", utm_campaign: "verano", utm_source: "qr", webhook_source_id: "x" }),
    ).toEqual([
      ["Formulário", "Contacto web"],
      ["Campanha", "verano"],
      ["Fonte", "qr"],
    ]);
    expect(detallesDeOrigen(null)).toEqual([]);
    expect(detallesDeOrigen({ utm_campaign: 5 })).toEqual([]);
  });
});
