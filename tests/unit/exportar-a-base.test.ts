import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  MIGRACIONES,
  SIN_CONTACTO,
  construir,
  csvNoExportado,
  informe,
  leerMigraciones,
  planificar,
  verificarComoBase,
  type Origen,
} from "../../lrn/scripts/exportar-a-base";

const T = (d: string) => `2026-10-${d}:00+00:00`;

/** Un Conectado con todos los casos del mapeo inverso. */
function origen(): Origen {
  return {
    pipelines: [
      { id: "p1", name: "Ventas", slug: "base-ventas", position: 1000, is_archived: false, is_default: true, settings: { lost_reasons: ["Precio", "Otro motivo"] }, created_at: T("01T10:00") },
      { id: "p2", name: "Postventa", slug: "base-postventa", position: 2000, is_archived: true, is_default: false, settings: {}, created_at: T("01T10:01") },
    ],
    stages: [
      { id: "s1", pipeline_id: "p1", name: "Nuevo", position: 1000, color: "#3366cc", is_won: false, is_lost: false, is_archived: false, expected_duration_hours: 120, created_at: T("01T10:00") },
      { id: "s2", pipeline_id: "p1", name: "Ganada", position: 2000, color: null, is_won: true, is_lost: false, is_archived: false, expected_duration_hours: null, created_at: T("01T10:00") },
      { id: "s3", pipeline_id: "p1", name: "Perdida", position: 3000, color: null, is_won: false, is_lost: true, is_archived: false, expected_duration_hours: null, created_at: T("01T10:00") },
      // mismo nombre en otro embudo: el Base no admite dos etapas con el mismo nombre
      { id: "s4", pipeline_id: "p2", name: "nuevo", position: 1000, color: null, is_won: false, is_lost: false, is_archived: true, expected_duration_hours: 12, created_at: T("01T10:01") },
    ],
    contacts: [
      { id: "c1", name: "Ana", display_name: "Ana Álvarez", email: "ana@ejemplo.com", phone_number: "+5491123456789", birthdate: "1990-03-14", is_blocked: false, is_anonymized: false, is_merged_into: null, tags: ["vip", "VIP", "referido"], source: "importar-base", created_at: T("02T10:00"), updated_at: T("03T10:00") },
      { id: "c2", name: null, display_name: null, email: null, phone_number: "+5493515550101", birthdate: null, is_blocked: true, is_anonymized: false, is_merged_into: null, tags: ["referido"], source: "whatsapp", created_at: T("02T11:00"), updated_at: T("02T11:00") },
      { id: "c3", name: "Duplicado de Ana", display_name: null, email: null, phone_number: null, birthdate: null, is_blocked: false, is_anonymized: false, is_merged_into: "c1", tags: [], source: "manual", created_at: T("02T12:00"), updated_at: T("02T12:00") },
      { id: "c4", name: "Borrado RGPD", display_name: null, email: null, phone_number: null, birthdate: null, is_blocked: false, is_anonymized: true, is_merged_into: null, tags: [], source: "manual", created_at: T("02T13:00"), updated_at: T("02T13:00") },
    ],
    leads: [
      { id: "l1", pipeline_id: "p1", stage_id: "s1", contact_id: "c1", title: "Web institucional", status: "open", lost_reason: null, value_cents: 12000000, currency: "ARS", closed_at: null, custom_fields: { origen: "Instagram" }, tags: ["vip"], source: "importar-base", external_id: "o1", source_metadata: { base_en_etapa_desde: "2026-10-01T09:00:00Z" }, created_at: T("03T10:00"), updated_at: T("04T10:00") },
      { id: "l2", pipeline_id: "p1", stage_id: "s2", contact_id: "c3", title: "Mantenimiento", status: "won", lost_reason: null, value_cents: 4500000, currency: "USD", closed_at: T("05T10:00"), custom_fields: {}, tags: [], source: "manual", external_id: null, source_metadata: {}, created_at: T("03T11:00"), updated_at: T("05T10:00") },
      { id: "l3", pipeline_id: "p1", stage_id: "s3", contact_id: null, title: "Sin contacto", status: "lost", lost_reason: null, value_cents: null, currency: null, closed_at: null, custom_fields: {}, tags: [], source: "manual", external_id: null, source_metadata: {}, created_at: T("03T12:00"), updated_at: T("06T10:00") },
      // ganada pero en una etapa abierta: el Base deriva el cierre de la etapa
      { id: "l4", pipeline_id: "p1", stage_id: "s1", contact_id: "c2", title: "Cerrada en etapa abierta", status: "won", lost_reason: null, value_cents: -5, currency: "ARS", closed_at: null, custom_fields: {}, tags: [], source: "manual", external_id: null, source_metadata: {}, created_at: T("03T13:00"), updated_at: T("07T10:00") },
    ],
    notes: [
      { id: "n1", contact_id: "c1", headline: "Base t1 · llamada · Llamó para confirmar", body: "Llamó para confirmar la reunión\n(Oportunidad n.º 1 del Base.)", created_at: T("04T10:00") },
      { id: "n2", contact_id: "c2", headline: "Pidió presupuesto", body: "Con dominio incluido", created_at: T("04T11:00") },
    ],
    tasks: [
      { id: "t1", title: "Mandar propuesta v2", description: "base:t6", due_date: "2026-11-20T12:00:00+00:00", status: "pending", lead_id: "l1", contact_id: "c1", created_at: T("05T10:00"), updated_at: T("05T10:00") },
      { id: "t2", title: "Cobrar la seña", description: "Transferencia", due_date: "2026-10-30T12:00:00+00:00", status: "done", lead_id: null, contact_id: "c2", created_at: T("05T11:00"), updated_at: T("31T09:00") },
      { id: "t3", title: "Tarea suelta", description: null, due_date: null, status: "in_progress", lead_id: "l3", contact_id: null, created_at: T("05T12:00"), updated_at: T("05T12:00") },
      { id: "t4", title: "Cancelada", description: null, due_date: "2026-11-01T12:00:00+00:00", status: "cancelled", lead_id: null, contact_id: "c1", created_at: T("05T13:00"), updated_at: T("05T13:00") },
    ],
    branding: { app_name: "Panadería Ñandú", accent_hex: "#AA3300", logo_path: null },
    logo: null,
  };
}

const carpeta = () => fs.mkdtempSync(path.join(os.tmpdir(), "exportar-base-"));
const migraciones = leerMigraciones(MIGRACIONES);

describe("exportar-a-base: plan", () => {
  const plan = planificar(origen());

  it("las etapas y embudos no repiten nombre (el Base los tiene UNIQUE sin distinguir mayúsculas)", () => {
    const nombres = plan.etapas.map((e) => e.nombre.toLowerCase());
    expect(new Set(nombres).size).toBe(nombres.length);
    expect(plan.etapas.find((e) => e.id === 4)?.nombre).toBe("nuevo (Postventa)");
    expect(plan.embudos.map((e) => [e.nombre, e.activo])).toEqual([["Ventas", 1], ["Postventa", 0]]);
  });

  it("días estancada = horas / 24 redondeado hacia arriba (mínimo 1; 7 si no había)", () => {
    expect(plan.etapas.map((e) => e.dias)).toEqual([5, 7, 7, 1]);
  });

  it("fusionados y anonimizados no viajan; lo que apuntaba a un fusionado pasa al contacto que quedó", () => {
    expect(plan.noExportado.map((x) => `${x.tabla}:${x.motivo}`)).toEqual(
      expect.arrayContaining(["contacts:fusionado en otro contacto", "contacts:anonimizado (irreversible)", "crm_tasks:tarea cancelada"]),
    );
    const mantenimiento = plan.oportunidades.find((o) => o.titulo === "Mantenimiento")!;
    expect(plan.contactos[mantenimiento.contacto - 1]!.nombre).toBe("Ana Álvarez");
  });

  it("lo que no tiene contacto cuelga de «(Sin contacto)»", () => {
    expect(plan.contactos.filter((c) => c.nombre === SIN_CONTACTO)).toHaveLength(1);
    expect(plan.oportunidades.find((o) => o.titulo === "Sin contacto")!.contacto).toBe(plan.contactos.find((c) => c.nombre === SIN_CONTACTO)!.id);
  });

  it("perdida sin motivo recibe uno; ganada fuera de etapa de cierre pasa a la etapa ganada; monto negativo se descarta", () => {
    expect(plan.oportunidades.find((o) => o.titulo === "Sin contacto")!.motivo).toBe("Sin motivo");
    const c = plan.oportunidades.find((o) => o.titulo === "Cerrada en etapa abierta")!;
    expect(plan.etapas.find((e) => e.id === c.etapa)!.cierre).toBe("ganada");
    expect(c.monto).toBeNull();
    expect(plan.avisos.join("\n")).toMatch(/monto negativo/);
  });

  it("deshace el mapeo de importar-base: el toque conserva su tipo y vuelve a su oportunidad", () => {
    const llamada = plan.toques.find((t) => t.tipo === "llamada")!;
    expect(llamada.texto).toBe("Llamó para confirmar la reunión");
    expect(llamada.oportunidad).toBe(plan.oportunidades.find((o) => o.titulo === "Web institucional")!.id);
  });

  it("tareas: el marcador base:t<id> no se exporta, una tarea sin fecha usa la de creación y la hecha queda hecha", () => {
    const tareas = plan.toques.filter((t) => t.tipo === "tarea");
    expect(tareas.map((t) => t.texto)).toEqual(["Mandar propuesta v2", "Cobrar la seña\nTransferencia", "Tarea suelta"]);
    expect(tareas.map((t) => t.vence)).toEqual(["2026-11-20", "2026-10-30", "2026-10-05"]);
    expect(tareas.map((t) => t.hecho !== null)).toEqual([false, true, false]);
  });

  it("marca.json cumple lo que el Base valida (logo .png, #RRGGBB, moneda ISO)", () => {
    const m = plan.marca!;
    expect(m).toMatchObject({ negocio: "Panadería Ñandú", logo: "logo.png", colores: { acento: "#aa3300" }, moneda: "ARS" });
    expect(m.motivos_perdida).toEqual(expect.arrayContaining(["Precio", "Otro motivo", "Sin motivo"]));
    expect(m.etapas.map((e) => e.nombre)).toEqual(["Nuevo", "Ganada", "Perdida"]);
  });
});

describe("exportar-a-base: el archivo", () => {
  it("se abre como lo abre el Base: última migración, checksums, integrity_check ok", () => {
    const dir = carpeta();
    const plan = planificar(origen());
    const r = construir(plan, path.join(dir, "crm.db"), migraciones);
    expect(r.verificacion).toMatchObject({ ok: true, version: migraciones.length, integrity: "ok", quick: "ok", fkRotas: 0 });
    expect(r.destino).toMatchObject({ embudo: 2, etapa: 4, contacto: 3, etiqueta: 2, contacto_etiqueta: 3, oportunidad: 4, oportunidad_etiqueta: 1, toque: 5 });
    const db = new DatabaseSync(path.join(dir, "crm.db"));
    expect(db.prepare("SELECT count(*) AS n FROM toque WHERE tipo = 'tarea'").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT count(*) AS n FROM regla WHERE activa = 1").get()).toEqual({ n: 0 });
    db.close();
    expect(fs.readdirSync(dir)).toEqual(["crm.db"]); // sin .tmp, -wal ni -shm
  });

  it("es idempotente: dos corridas dejan el mismo contenido (misma huella) y el segundo archivo reemplaza al primero", () => {
    const dir = carpeta();
    const a = construir(planificar(origen()), path.join(dir, "crm.db"), migraciones);
    const b = construir(planificar(origen()), path.join(dir, "crm.db"), migraciones);
    expect(b.huella).toBe(a.huella);
    expect(b.destino).toEqual(a.destino);
  });

  it("--simular mide igual pero no escribe nada", () => {
    const real = construir(planificar(origen()), path.join(carpeta(), "crm.db"), migraciones);
    const sim = construir(planificar(origen()), null, migraciones);
    expect(sim.destino).toEqual(real.destino);
    expect(sim.huella).toBe(real.huella);
    expect(sim.verificacion).toBeNull();
  });

  it("detecta un archivo adulterado o de una versión más nueva", () => {
    const dir = carpeta();
    const archivo = path.join(dir, "crm.db");
    construir(planificar(origen()), archivo, migraciones);
    const db = new DatabaseSync(archivo);
    db.exec("UPDATE _sqlx_migrations SET checksum = x'00' WHERE version = 2");
    db.exec("INSERT INTO _sqlx_migrations(version, description, success, checksum, execution_time) VALUES (99, 'futura', 1, x'00', 0)");
    db.close();
    const v = verificarComoBase(archivo, migraciones);
    expect(v.ok).toBe(false);
    expect(v.problemas.join("\n")).toMatch(/migración 2: el checksum no coincide/);
    expect(v.problemas.join("\n")).toMatch(/VERSION_FUTURA/);
  });

  it("el informe trae la tabla origen | destino, la integridad y lo que no viaja", () => {
    const plan = planificar(origen());
    const texto = informe(plan, construir(plan, null, migraciones), true);
    expect(texto).toContain("| tabla | filas origen | filas destino |");
    expect(texto).toContain("| crm_leads → oportunidad | 4 | 4 | 0 |");
    expect(texto).toContain("## Qué no viaja (OFERTA cl. 8)");
  });

  it("el CSV escapa comas y comillas", () => {
    expect(csvNoExportado([{ tabla: "contacts", id: "1", motivo: "a, b", detalle: 'dijo "hola"' }])).toBe('tabla,id,motivo,detalle\ncontacts,1,"a, b","dijo ""hola"""\n');
  });
});
