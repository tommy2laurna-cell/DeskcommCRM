import { describe, expect, it } from "vitest";

import { evaluateConditions } from "@/lib/automation/conditions";
import { montarMensajeDeReceta } from "@/lib/automation/mensaje-de-receta";
import { renderTemplate } from "@/lib/automation/template";
import {
  AVISOS_DE_TURNO,
  correspondeAvisoDeTurno,
  estaDormido,
  estaQuieto,
  estaSinRespuesta,
} from "@/lib/recetas/barrido";
import { RECETAS, esRecetaDeMensaje, recetaPorId } from "@/lib/recetas/catalogo";
import { vistaDeRecetas } from "@/lib/recetas/estado";
import { reglaDeReceta } from "@/lib/recetas/regla";
import { ENTIDADE_ESPERADA_POR_GATILHO, actionSchema } from "@/lib/schemas/webhooks";
import { interpolateTemplate, proximoTurno, usaTurno } from "@/lib/inbox/template-vars";

const NUMERO = "11111111-1111-4111-8111-111111111111";
const H = 3_600_000;
const D = 24 * H;
const AHORA = new Date("2026-11-13T12:00:00Z");
const hace = (ms: number) => new Date(AHORA.getTime() - ms).toISOString();
const dentro = (ms: number) => new Date(AHORA.getTime() + ms).toISOString();

describe("catálogo de recetas", () => {
  it("tiene las 8 recetas, ids únicos y disparadores que el motor conoce", () => {
    expect(RECETAS.map((r) => r.id)).toEqual([
      "bienvenida", "recordatorio_24h", "recordatorio_2h", "seguimiento_48h",
      "lead_quieto_3d", "reactivacion_90d", "cumpleanos", "resena",
    ]);
    for (const r of RECETAS) expect(Object.keys(ENTIDADE_ESPERADA_POR_GATILHO)).toContain(r.trigger);
  });

  it("cada receta arma una regla que pasa el esquema de acciones del motor", () => {
    for (const r of RECETAS) {
      const armada = reglaDeReceta(r, { channel_session_id: NUMERO, link: "https://g.page/r/abc" });
      expect(armada.ok, r.id).toBe(true);
      if (!armada.ok) continue;
      for (const a of armada.regla.actions) expect(actionSchema.safeParse(a).success, r.id).toBe(true);
    }
  });

  it("cada plantilla de Meta es válida: variables en orden, sin empezar ni terminar con variable", () => {
    for (const r of RECETAS.filter(esRecetaDeMensaje)) {
      const p = r.plantilla;
      expect(p.nombre).toMatch(/^[a-z0-9_]+$/);
      expect(["UTILITY", "MARKETING"]).toContain(p.categoria);
      const slots = [...p.cuerpo.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(slots).toEqual(p.variables.map((_, i) => i + 1));
      expect(p.cuerpo.trim()).not.toMatch(/^\{\{/);
      expect(p.cuerpo.trim()).not.toMatch(/\}\}$/);
    }
  });

  it("recordatorios: la condición separa 24 h de 2 h", () => {
    const c24 = recetaPorId("recordatorio_24h")!.condiciones;
    const c2 = recetaPorId("recordatorio_2h")!.condiciones;
    const ev = (m: number) => ({ event: { offset_minutes: m } });
    expect(evaluateConditions(c24, ev(1440))).toBe(true);
    expect(evaluateConditions(c24, ev(120))).toBe(false);
    expect(evaluateConditions(c2, ev(120))).toBe(true);
  });

  it("reseña: solo dispara con el lead ganado y no sale con el marcador del link", () => {
    const r = recetaPorId("resena")!;
    expect(evaluateConditions(r.condiciones, { lead: { status: "won" } })).toBe(true);
    expect(evaluateConditions(r.condiciones, { lead: { status: "open" } })).toBe(false);
    expect(reglaDeReceta(r, { channel_session_id: NUMERO })).toEqual({ ok: false, error: "falta_link" });
    const ok = reglaDeReceta(r, { channel_session_id: NUMERO, link: "https://g.page/r/abc" });
    expect(ok.ok && JSON.stringify(ok.regla.actions)).toContain("https://g.page/r/abc");
    expect(ok.ok && JSON.stringify(ok.regla.actions)).not.toContain("pegá acá");
  });

  it("sin número no se prende una receta de mensaje; la de aviso no lo necesita", () => {
    expect(reglaDeReceta(recetaPorId("bienvenida")!, {})).toEqual({ ok: false, error: "falta_numero" });
    const aviso = reglaDeReceta(recetaPorId("lead_quieto_3d")!, {});
    expect(aviso.ok && aviso.regla.actions[0]?.type).toBe("notify_owner");
  });

  it("el texto editado se respeta y las variables salen del contexto", () => {
    const a = reglaDeReceta(recetaPorId("recordatorio_24h")!, { channel_session_id: NUMERO, texto: "Turno {{turno}} para {{nombre}}" });
    const cfg = a.ok ? (a.regla.actions[0]!.config as { template: string }) : null;
    expect(renderTemplate(cfg!.template, { contact: { name: "Ana" }, turno: { texto: "jueves 14/11 a las 15:30" } })).toBe(
      "Turno jueves 14/11 a las 15:30 para Ana",
    );
  });

  it("la vista marca apagadas por defecto y trae lo guardado", () => {
    const vacia = vistaDeRecetas([], []);
    expect(vacia.every((v) => !v.activa)).toBe(true);
    const guardada = reglaDeReceta(recetaPorId("bienvenida")!, { channel_session_id: NUMERO, texto: "Hola {{nombre}}!" });
    if (!guardada.ok) throw new Error("no armó");
    const v = vistaDeRecetas(
      [{ id: "r1", recipe_key: "bienvenida", is_active: true, run_count: 3, last_run_at: null, actions: guardada.regla.actions }],
      [{ name: "bienvenida_prospecto", status: "APPROVED" }],
    ).find((x) => x.id === "bienvenida")!;
    expect(v).toMatchObject({ activa: true, corridas: 3 });
    expect(v.ajustes).toMatchObject({ texto: "Hola {{nombre}}!", channel_session_id: NUMERO });
    expect(v.plantilla?.estado).toBe("APPROVED");
  });
});

describe("reloj de las recetas", () => {
  it("aviso de turno: llega a la hora, una vez por escalón, y no para turnos sacados dentro del escalón", () => {
    expect(AVISOS_DE_TURNO).toEqual([1440, 120]);
    const base = { agora: AHORA, creado: hace(3 * D) };
    expect(correspondeAvisoDeTurno({ ...base, comienzo: dentro(23 * H), offsetMin: 1440 })).toBe(true);
    expect(correspondeAvisoDeTurno({ ...base, comienzo: dentro(30 * H), offsetMin: 1440 })).toBe(false);
    expect(correspondeAvisoDeTurno({ ...base, comienzo: dentro(90 * 60_000), offsetMin: 120 })).toBe(true);
    expect(correspondeAvisoDeTurno({ ...base, comienzo: hace(H), offsetMin: 120 })).toBe(false);
    // sacado hace 1 h para dentro de 23 h: el aviso de 24 h ya no tiene sentido
    expect(correspondeAvisoDeTurno({ agora: AHORA, creado: hace(30 * 60_000), comienzo: dentro(23 * H), offsetMin: 1440 })).toBe(false);
  });

  it("sin respuesta: nuestro último mensaje entre 48 y 96 h y nadie contestó después", () => {
    const f = (out: string | null, inn: string | null) => estaSinRespuesta({ agora: AHORA, ultimoSaliente: out, ultimoEntrante: inn });
    expect(f(hace(49 * H), null)).toBe(true);
    expect(f(hace(47 * H), null)).toBe(false);
    expect(f(hace(100 * H), null)).toBe(false);
    expect(f(hace(49 * H), hace(10 * H))).toBe(false);
    expect(f(hace(49 * H), hace(60 * H))).toBe(true);
    expect(f(null, null)).toBe(false);
  });

  it("quieto 3 días y dormido 90 días: solo dentro de la banda, nunca contra lo viejo", () => {
    expect(estaQuieto(AHORA, hace(3 * D + H))).toBe(true);
    expect(estaQuieto(AHORA, hace(2 * D))).toBe(false);
    expect(estaQuieto(AHORA, hace(10 * D))).toBe(false);
    expect(estaDormido(AHORA, hace(91 * D))).toBe(true);
    expect(estaDormido(AHORA, hace(89 * D))).toBe(false);
    expect(estaDormido(AHORA, hace(400 * D))).toBe(false);
    expect(estaDormido(AHORA, null)).toBe(false);
  });
});

describe("salida: ventana de 24 h", () => {
  const meta = { name: "recordatorio_turno_24h", language: "es_AR", values: { "1": "{{nombre}}", "2": "{{turno}}" } };
  const ctx = { contact: { name: "Ana" }, turno: { texto: "jueves 14/11 a las 15:30" } };

  it("ventana abierta o canal sin restricción: texto libre", () => {
    expect(montarMensajeDeReceta({ tipo: "aberta", restanteMs: 1 }, "hola", meta, ctx)).toEqual({ type: "text", body: "hola" });
    expect(montarMensajeDeReceta({ tipo: "sem_restricao" }, "hola", meta, ctx).type).toBe("text");
  });

  it("ventana cerrada: plantilla con las variables resueltas", () => {
    expect(montarMensajeDeReceta({ tipo: "fechada", fechadaHaMs: 5 }, "hola", meta, ctx)).toEqual({
      type: "template",
      template_name: "recordatorio_turno_24h",
      template_language: "es_AR",
      template_values: { "1": "Ana", "2": "jueves 14/11 a las 15:30" },
    });
  });

  it("ventana cerrada sin plantilla, o con una variable vacía: no sale nada", () => {
    expect(montarMensajeDeReceta({ tipo: "fechada", fechadaHaMs: null }, "hola", null, ctx)).toEqual({
      type: "skip", reason: "fuera_de_ventana_sin_plantilla",
    });
    expect(montarMensajeDeReceta({ tipo: "fechada", fechadaHaMs: 1 }, "hola", meta, { contact: {} })).toEqual({
      type: "skip", reason: "plantilla_con_valores_vacios",
    });
  });
});

describe("respuestas rápidas con variables", () => {
  it("{nombre}, {{nombre}} y {turno}; lo desconocido o vacío queda literal", () => {
    const c = { name: "Ana Pérez", turno: "jueves 14/11 a las 15:30" };
    expect(interpolateTemplate("Hola {nombre}, tu turno: {turno}", c)).toBe("Hola Ana Pérez, tu turno: jueves 14/11 a las 15:30");
    expect(interpolateTemplate("Hola {{nombre}}", c)).toBe("Hola Ana Pérez");
    expect(interpolateTemplate("Hola {primer_nombre}", c)).toBe("Hola Ana");
    expect(interpolateTemplate("Turno {turno} {otra}", { name: "Ana" })).toBe("Turno {turno} {otra}");
    expect(usaTurno("ver {turno}")).toBe(true);
    expect(usaTurno("hola {nombre}")).toBe(false);
  });

  it("proximoTurno elige el primero futuro", () => {
    const d = proximoTurno([{ starts_at: dentro(5 * H) }, { starts_at: dentro(H) }, { starts_at: hace(H) }], AHORA);
    expect(d?.toISOString()).toBe(dentro(H));
    expect(proximoTurno([], AHORA)).toBeNull();
  });
});
