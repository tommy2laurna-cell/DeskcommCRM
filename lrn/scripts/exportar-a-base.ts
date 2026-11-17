/**
 * Baja el CRM Conectado de una organización al CRM Base: arma una base SQLite del Base (crm.db) en su
 * última migración, con marca, contactos, oportunidades, etiquetas, notas y tareas.
 *
 *   npx tsx lrn/scripts/exportar-a-base.ts --org <slug|uuid> --salida <carpeta> [--migraciones <carpeta>] [--simular]
 *   npx tsx lrn/scripts/exportar-a-base.ts --verificar <crm.db> [--migraciones <carpeta>]
 *
 * Credenciales (env o .env/.env.local): NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. Nunca se imprimen.
 *
 * Solo lee del Conectado. Idempotente: el resultado depende solo de los datos (ids del Base asignados por
 * orden de creación), así que correrlo dos veces produce el mismo archivo lógico (mismo `huella`).
 * Nada se descarta en silencio: lo que no tiene lugar en el Base va a `no-exportado.csv`.
 * La tabla campo por campo es el inverso de lrn/importar-base/MAPEO.md y está en lrn/exportar-a-base/MAPEO.md.
 *
 * Las migraciones del Base viven en lrn/fixtures/base-migraciones (copia exacta de src-tauri/migrations del
 * Base: al sacar una versión nueva hay que copiar la migración nueva ahí). El archivo queda como lo deja la
 * app: `_sqlx_migrations` con el checksum SHA-384 de cada migración, para que el Base lo abra sin re-migrar.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync as BaseDeDatos } from "node:sqlite";

// getBuiltinModule: vitest/vite no sabe empaquetar `node:sqlite` con un import estático.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
type DatabaseSync = BaseDeDatos;

export const MIGRACIONES = path.join(process.cwd(), "lrn/fixtures/base-migraciones");
export const SIN_CONTACTO = "(Sin contacto)";

/** Lo que el Base no recibe, en palabras del cliente (se copia a OFERTA cl. 8). */
export const NO_VIAJA: readonly string[] = [
  "Conversaciones y mensajes de WhatsApp (el Base no tiene canal; quedan en el backup del Conectado).",
  "El agente de IA, sus prompts y las automatizaciones (n8n, webhooks, envío de correos).",
  "Usuarios, roles y la doble verificación: el Base es de una sola persona y se abre con su propia contraseña.",
  "Responsable de cada oportunidad, fecha prevista de cierre, descripción de la oportunidad y prioridad o responsable de las tareas.",
  "Consentimientos, CPF/documentos cifrados y contactos bloqueados; los contactos anonimizados (irreversible).",
  "Contactos fusionados como duplicados: sus oportunidades y tareas pasan al contacto que quedó.",
  "Tareas canceladas y el vocabulario, los campos propios y los motivos de pérdida definidos en cada embudo (la marca lleva los motivos).",
  "Los colores de las etiquetas (el Conectado no los guarda: en el Base quedan con el tono por defecto).",
  "Lo que solo existe en el Base (presupuestos, recibos, cuentas) no se crea: nace vacío.",
];

// ───────────────────────────── 1. Lectura del Conectado ─────────────────────────────

type Fila = Record<string, unknown>;

export interface Origen {
  pipelines: Fila[];
  stages: Fila[];
  contacts: Fila[];
  leads: Fila[];
  notes: Fila[];
  tasks: Fila[];
  branding: Fila | null;
  logo: Uint8Array | null;
}

const ok = <T>(r: { data: T; error: { message: string } | null }, ctx: string): T => {
  if (r.error) throw new Error(`${ctx}: ${r.error.message}`);
  return r.data;
};

/** PostgREST corta en 1000 filas: se pagina con orden estable. */
async function todo(db: SupabaseClient, tabla: string, org: string, columnas: string): Promise<Fila[]> {
  const out: Fila[] = [];
  for (let desde = 0; ; desde += 1000) {
    const r = ok(await db.from(tabla).select(columnas).eq("organization_id", org).order("created_at").order("id").range(desde, desde + 999), tabla) as unknown as Fila[];
    out.push(...r);
    if (r.length < 1000) return out;
  }
}

export async function leerOrigen(db: SupabaseClient, org: string): Promise<Origen> {
  const [pipelines, stages, contacts, leads, notes, tasks] = [
    await todo(db, "crm_pipelines", org, "id, name, slug, position, is_archived, is_default, settings, created_at"),
    await todo(db, "crm_stages", org, "id, pipeline_id, name, position, color, is_won, is_lost, is_archived, expected_duration_hours, created_at"),
    await todo(db, "contacts", org, "id, name, display_name, email, phone_number, birthdate, is_blocked, is_anonymized, is_merged_into, tags, source, created_at, updated_at"),
    await todo(db, "crm_leads", org, "id, pipeline_id, stage_id, contact_id, title, status, lost_reason, value_cents, currency, closed_at, custom_fields, tags, source, external_id, source_metadata, created_at, updated_at"),
    await todo(db, "lead_notes", org, "id, contact_id, headline, body, created_at"),
    await todo(db, "crm_tasks", org, "id, title, description, due_date, status, lead_id, contact_id, created_at, updated_at"),
  ];
  const branding = ok(await db.from("platform_branding").select("app_name, accent_hex, logo_path").eq("id", 1).maybeSingle(), "branding") as Fila | null;
  let logo: Uint8Array | null = null;
  if (typeof branding?.logo_path === "string" && branding.logo_path) {
    const d = await db.storage.from("brand-logos").download(branding.logo_path);
    if (!d.error && d.data) logo = new Uint8Array(await d.data.arrayBuffer());
  }
  return { pipelines, stages, contacts, leads, notes, tasks, branding, logo };
}

// ───────────────────────────── 2. Plan (puro, sin red) ─────────────────────────────

export interface NoExportado { tabla: string; id: string; motivo: string; detalle: string }
export interface MarcaBase {
  negocio: string;
  logo: string;
  colores: { primario: string; acento: string };
  palabras: Record<"oportunidad" | "contacto" | "cuenta" | "toque" | "tarea", string>;
  etapas: { nombre: string; dias_estancada: number; cierre?: "ganada" | "perdida"; color?: string }[];
  campos_extra: Record<string, never>;
  moneda: string;
  motivos_perdida: string[];
}
interface PEmbudo { id: number; nombre: string; orden: number; activo: number }
interface PEtapa { id: number; embudo: number; nombre: string; orden: number; color: string | null; dias: number; cierre: "ganada" | "perdida" | null; activa: number }
interface PContacto { id: number; nombre: string; telefono: string | null; email: string | null; nacimiento: string | null; origen: string | null; creado: string; actualizado: string; etiquetas: string[] }
interface POportunidad {
  id: number; contacto: number; titulo: string; etapa: number; desde: string; monto: number | null; moneda: string;
  motivo: string | null; cerrada: string | null; extra: string; creada: string; actualizada: string; etiquetas: string[];
}
interface PToque { contacto: number; oportunidad: number | null; tipo: string; texto: string; vence: string | null; hecho: string | null; creado: string }

export interface Plan {
  embudos: PEmbudo[];
  etapas: PEtapa[];
  contactos: PContacto[];
  oportunidades: POportunidad[];
  toques: PToque[];
  etiquetas: string[];
  noExportado: NoExportado[];
  avisos: string[];
  marca: MarcaBase | null;
  /** Filas de origen por tabla, para la tabla «origen | destino». */
  origen: Record<string, number>;
}

/** ISO sin milisegundos, como los escribe el Base (`%Y-%m-%dT%H:%M:%SZ`). */
export function iso(v: unknown, respaldo?: string): string {
  const d = typeof v === "string" || v instanceof Date ? new Date(v) : null;
  if (d && !Number.isNaN(d.getTime())) return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (respaldo) return respaldo;
  throw new Error(`Fecha inválida: ${String(v)}`);
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const objeto = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
const recorte = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Nombre único sin distinguir mayúsculas (el Base lo exige en embudos y etapas). */
function unico(nombre: string, usados: Set<string>, sufijo: string, avisos: string[], que: string): string {
  let n = nombre;
  if (usados.has(n.toLowerCase())) n = `${nombre} (${sufijo})`;
  for (let i = 2; usados.has(n.toLowerCase()); i++) n = `${nombre} (${sufijo} ${i})`;
  if (n !== nombre) avisos.push(`${que} «${nombre}» ya existía en el Base (los nombres no se repiten): queda como «${n}».`);
  usados.add(n.toLowerCase());
  return n;
}

export function planificar(o: Origen): Plan {
  const noExportado: NoExportado[] = [];
  const avisos: string[] = [];
  const nx = (tabla: string, id: unknown, motivo: string, detalle = "") => noExportado.push({ tabla, id: String(id), motivo, detalle });
  const origen = { crm_pipelines: o.pipelines.length, crm_stages: o.stages.length, contacts: o.contacts.length, crm_leads: o.leads.length, lead_notes: o.notes.length, crm_tasks: o.tasks.length };

  // — Embudos y etapas —
  const pipelines = [...o.pipelines].sort((a, b) => Number(a.position) - Number(b.position));
  const nombresEmbudo = new Set<string>();
  const embudos: PEmbudo[] = pipelines.map((p, i) => ({
    id: i + 1,
    nombre: unico(String(p.name).trim(), nombresEmbudo, "2", avisos, "Embudo"),
    orden: i + 1,
    activo: p.is_archived ? 0 : 1,
  }));
  const embudoDe = new Map(pipelines.map((p, i) => [String(p.id), embudos[i]!]));
  const nombresEtapa = new Set<string>();
  const etapas: PEtapa[] = [];
  const etapaDe = new Map<string, PEtapa>();
  const ordenEmbudo = (s: Fila) => embudoDe.get(String(s.pipeline_id))?.orden ?? 999;
  for (const s of [...o.stages].sort((a, b) => ordenEmbudo(a) - ordenEmbudo(b) || Number(a.position) - Number(b.position))) {
    const emb = embudoDe.get(String(s.pipeline_id));
    if (!emb) {
      nx("crm_stages", s.id, "su embudo no existe", String(s.name));
      continue;
    }
    const horas = num(s.expected_duration_hours);
    const e: PEtapa = {
      id: etapas.length + 1,
      embudo: emb.id,
      nombre: unico(String(s.name).trim(), nombresEtapa, emb.nombre, avisos, "Etapa"),
      orden: etapas.filter((x) => x.embudo === emb.id).length + 1,
      color: typeof s.color === "string" && /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : null,
      dias: horas && horas > 0 ? Math.max(1, Math.ceil(horas / 24)) : 7,
      cierre: s.is_won ? "ganada" : s.is_lost ? "perdida" : null,
      activa: s.is_archived ? 0 : 1,
    };
    etapas.push(e);
    etapaDe.set(String(s.id), e);
  }

  // — Contactos —
  const porId = new Map(o.contacts.map((c) => [String(c.id), c]));
  const resolver = (id: unknown): string | null => {
    let actual = id === null || id === undefined ? null : String(id);
    for (let i = 0; i < 8 && actual; i++) {
      const c = porId.get(actual);
      if (!c) return null;
      if (c.is_merged_into) actual = String(c.is_merged_into);
      else return c.is_anonymized ? null : actual;
    }
    return null;
  };
  const contactos: PContacto[] = [];
  const contactoBase = new Map<string, number>();
  for (const c of [...o.contacts].sort((a, b) => iso(a.created_at).localeCompare(iso(b.created_at)) || String(a.id).localeCompare(String(b.id)))) {
    const id = String(c.id);
    if (c.is_merged_into) {
      nx("contacts", id, "fusionado en otro contacto", `sus datos quedan en ${c.is_merged_into}`);
      continue;
    }
    if (c.is_anonymized) {
      nx("contacts", id, "anonimizado (irreversible)", "");
      continue;
    }
    const nacimiento = typeof c.birthdate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.birthdate) ? c.birthdate : null;
    if (c.is_blocked) nx("contacts", id, "estaba bloqueado en el Conectado (el Base no bloquea)", "el contacto sí viaja");
    const creado = iso(c.created_at);
    contactos.push({
      id: contactos.length + 1,
      nombre: str(c.display_name) ?? str(c.name) ?? str(c.phone_number) ?? str(c.email) ?? "Sin nombre",
      telefono: str(c.phone_number),
      email: str(c.email),
      nacimiento,
      origen: str(c.source),
      creado,
      actualizado: iso(c.updated_at, creado),
      etiquetas: lista(c.tags),
    });
    contactoBase.set(id, contactos.length);
  }
  // El Base exige contacto en cada oportunidad y toque: lo huérfano cuelga de uno explícito.
  let sinContacto: number | null = null;
  const contactoDe = (...ids: unknown[]): number => {
    for (const x of ids) {
      const r = resolver(x);
      const b = r ? contactoBase.get(r) : undefined;
      if (b) return b;
    }
    if (sinContacto === null) {
      const t = contactos.length ? iso(contactos[0]!.creado) : iso(new Date());
      contactos.push({ id: contactos.length + 1, nombre: SIN_CONTACTO, telefono: null, email: null, nacimiento: null, origen: "exportar-a-base", creado: t, actualizado: t, etiquetas: [] });
      sinContacto = contactos.length;
    }
    return sinContacto;
  };

  // — Oportunidades —
  const oportunidades: POportunidad[] = [];
  const oportunidadBase = new Map<string, number>();
  const porExterno = new Map<string, number>();
  const motivos = new Set<string>();
  for (const l of [...o.leads].sort((a, b) => iso(a.created_at).localeCompare(iso(b.created_at)) || String(a.id).localeCompare(String(b.id)))) {
    const id = String(l.id);
    let et = etapaDe.get(String(l.stage_id));
    if (!et) {
      nx("crm_leads", id, "su etapa no existe", String(l.title));
      continue;
    }
    const estado = String(l.status);
    const quiere = estado === "won" ? "ganada" : estado === "lost" ? "perdida" : null;
    if (quiere && et.cierre !== quiere) {
      const alt = etapas.find((x) => x.embudo === et!.embudo && x.cierre === quiere && x.activa === 1) ?? etapas.find((x) => x.embudo === et!.embudo && x.cierre === quiere);
      if (alt) {
        avisos.push(`Oportunidad «${l.title}»: estaba ${quiere} fuera de una etapa de cierre; pasa a «${alt.nombre}».`);
        et = alt;
      } else avisos.push(`Oportunidad «${l.title}»: estaba ${quiere} pero su embudo no tiene etapa de ${quiere}; queda abierta en «${et.nombre}».`);
    }
    const monto = num(l.value_cents);
    if (monto !== null && monto < 0) avisos.push(`Oportunidad «${l.title}»: monto negativo; viaja sin monto.`);
    const creada = iso(l.created_at);
    const actualizada = iso(l.updated_at, creada);
    const meta = objeto(l.source_metadata);
    const motivo = et.cierre === "perdida" ? str(l.lost_reason) ?? "Sin motivo" : null;
    if (motivo) motivos.add(motivo);
    const op: POportunidad = {
      id: oportunidades.length + 1,
      contacto: contactoDe(l.contact_id),
      titulo: str(l.title) ?? "Sin título",
      etapa: et.id,
      desde: iso(meta.base_en_etapa_desde, actualizada),
      monto: monto !== null && monto >= 0 ? monto : null,
      moneda: str(l.currency) ?? "ARS",
      motivo,
      cerrada: et.cierre ? iso(l.closed_at, actualizada) : null,
      extra: JSON.stringify(objeto(l.custom_fields)),
      creada,
      actualizada,
      etiquetas: lista(l.tags),
    };
    oportunidades.push(op);
    oportunidadBase.set(id, op.id);
    if (l.source === "importar-base" && typeof l.external_id === "string") porExterno.set(l.external_id, op.id);
  }

  // — Notas y tareas → toques —
  const pendientes: { ord: string; toque: PToque }[] = [];
  for (const n of o.notes) {
    const headline = String(n.headline);
    const body = String(n.body);
    const m = /^Base t\d+ · (nota|llamada|whatsapp|mail|reunion) · /.exec(headline);
    const ref = /\(Oportunidad n\.º (\d+) del Base\.\)/.exec(body);
    const texto = m
      ? body.replace(/\n?\(Oportunidad[^\n]*\)\s*$/g, "").trim()
      : body.trim().startsWith(headline.trim()) ? body.trim() : `${headline.trim()}\n${body.trim()}`;
    const creado = iso(n.created_at);
    pendientes.push({
      ord: `${creado}|n|${n.id}`,
      toque: { contacto: contactoDe(n.contact_id), oportunidad: ref ? porExterno.get(`o${ref[1]}`) ?? null : null, tipo: m ? m[1]! : "nota", texto: texto || headline, vence: null, hecho: null, creado },
    });
  }
  const leadPorId = new Map(o.leads.map((l) => [String(l.id), l]));
  let sinVence = 0;
  for (const t of o.tasks) {
    const id = String(t.id);
    if (t.status === "cancelled") {
      nx("crm_tasks", id, "tarea cancelada", recorte(String(t.title), 80));
      continue;
    }
    const creado = iso(t.created_at);
    const vence = typeof t.due_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(t.due_date) ? iso(t.due_date).slice(0, 10) : null;
    if (!vence) sinVence++;
    const lead = t.lead_id ? leadPorId.get(String(t.lead_id)) : undefined;
    const desc = str(t.description);
    pendientes.push({
      ord: `${creado}|t|${id}`,
      toque: {
        contacto: contactoDe(t.contact_id, lead?.contact_id),
        oportunidad: t.lead_id ? oportunidadBase.get(String(t.lead_id)) ?? null : null,
        tipo: "tarea",
        texto: desc && !/^base:t\d+$/.test(desc) ? `${str(t.title)}\n${desc}` : str(t.title) ?? "Tarea",
        vence: vence ?? creado.slice(0, 10),
        hecho: t.status === "done" ? iso(t.updated_at, creado) : null,
        creado,
      },
    });
  }
  if (sinVence) avisos.push(`${sinVence} tarea(s) sin fecha: el Base exige una; quedan con la fecha en que se crearon.`);
  pendientes.sort((a, b) => a.ord.localeCompare(b.ord));
  const toques = pendientes.map((p) => p.toque);
  if (sinContacto !== null) avisos.push(`Había oportunidades, notas o tareas sin contacto (o con contacto que no viaja): cuelgan de «${SIN_CONTACTO}».`);

  // — Etiquetas (únicas sin distinguir mayúsculas) —
  const etiquetas: string[] = [];
  const vistas = new Set<string>();
  for (const e of [...contactos.flatMap((c) => c.etiquetas), ...oportunidades.flatMap((x) => x.etiquetas)]) {
    if (!vistas.has(e.toLowerCase())) {
      vistas.add(e.toLowerCase());
      etiquetas.push(e);
    }
  }
  if (etiquetas.length) avisos.push(`${etiquetas.length} etiqueta(s): viajan con el tono por defecto (el Conectado no guarda colores).`);

  // — Marca (marca.json del Base) —
  const b = o.branding;
  const negocio = str(b?.app_name);
  const acento = typeof b?.accent_hex === "string" && /^#[0-9a-fA-F]{6}$/.test(b.accent_hex) ? b.accent_hex.toLowerCase() : null;
  const png = o.logo && o.logo[0] === 0x89 && o.logo[1] === 0x50;
  if (o.logo && !png) avisos.push("El logo del Conectado no es PNG: el Base solo acepta PNG; la marca viaja sin logo.");
  const monedas = new Map<string, number>();
  for (const x of oportunidades) monedas.set(x.moneda, (monedas.get(x.moneda) ?? 0) + 1);
  const moneda = [...monedas.entries()].sort((a, b2) => b2[1] - a[1] || a[0].localeCompare(b2[0]))[0]?.[0] ?? "ARS";
  const principal = pipelines.find((p) => p.is_default) ?? pipelines.find((p) => !p.is_archived) ?? pipelines[0];
  for (const p of pipelines) for (const r of lista(objeto(p.settings).lost_reasons)) motivos.add(r);
  const marca: MarcaBase | null = negocio
    ? {
        negocio,
        logo: "logo.png",
        colores: { primario: "#161616", acento: acento ?? "#710014" },
        palabras: { oportunidad: "Oportunidad", contacto: "Contacto", cuenta: "Cuenta", toque: "Toque", tarea: "Tarea" },
        etapas: etapas.filter((e) => principal && embudoDe.get(String(principal.id))?.id === e.embudo && e.activa === 1).map((e) => ({ nombre: e.nombre, dias_estancada: e.dias, ...(e.cierre ? { cierre: e.cierre } : {}), ...(e.color ? { color: e.color } : {}) })),
        campos_extra: {},
        moneda: /^[A-Z]{3}$/.test(moneda) ? moneda : "ARS",
        motivos_perdida: [...motivos],
      }
    : null;
  if (!marca) avisos.push("El Conectado no tiene nombre de marca cargado: no se genera marca.json.");

  return { embudos, etapas, contactos, oportunidades, toques, etiquetas, noExportado, avisos, marca, origen };
}

// ───────────────────────────── 3. El archivo del Base ─────────────────────────────

export interface Migracion { version: number; descripcion: string; sql: string; checksum: Buffer }

export function leerMigraciones(carpeta: string): Migracion[] {
  const archivos = fs.readdirSync(carpeta).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  if (archivos.length === 0) throw new Error(`Sin migraciones en ${carpeta}`);
  return archivos.map((f, i) => {
    const bytes = fs.readFileSync(path.join(carpeta, f));
    if (Number(f.slice(0, 4)) !== i + 1) throw new Error(`Las migraciones deben ser correlativas desde 0001: ${f}`);
    return { version: i + 1, descripcion: f.slice(5, -4).replace(/_/g, " "), sql: bytes.toString("utf8"), checksum: createHash("sha384").update(bytes).digest() };
  });
}

/** Misma tabla que crea sqlx (lo que usa tauri-plugin-sql); sin ella el Base intentaría migrar de cero. */
const SQLX = `CREATE TABLE _sqlx_migrations (
  version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL);`;

/** Tablas de datos, para el conteo y la huella (sin _sqlx_migrations: lleva la hora de la migración). */
export const TABLAS = ["embudo", "etapa", "contacto", "etiqueta", "contacto_etiqueta", "oportunidad", "oportunidad_etiqueta", "toque", "etapa_paso"] as const;

export function escribir(plan: Plan, archivo: string, migraciones: Migracion[]): DatabaseSync {
  const db = new DatabaseSync(archivo);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SQLX);
  for (const m of migraciones) {
    db.exec(m.sql);
    db.prepare("INSERT INTO _sqlx_migrations(version, description, success, checksum, execution_time) VALUES (?, ?, 1, ?, 0)").run(m.version, m.descripcion, m.checksum);
  }
  db.exec("BEGIN");
  try {
    // La migración 0002 deja un embudo «Ventas» de arranque: el del cliente lo reemplaza.
    db.exec("DELETE FROM embudo");
    const ins = (sql: string) => db.prepare(sql);
    const emb = ins("INSERT INTO embudo(id, nombre, orden, activo) VALUES (?, ?, ?, ?)");
    for (const e of plan.embudos) emb.run(e.id, e.nombre, e.orden, e.activo);
    const eta = ins("INSERT INTO etapa(id, nombre, orden, color, dias_estancada, cierre, activa, embudo_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const e of plan.etapas) eta.run(e.id, e.nombre, e.orden, e.color, e.dias, e.cierre, e.activa, e.embudo);
    const con = ins("INSERT INTO contacto(id, nombre, telefono, email, nacimiento, origen, creado, actualizado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const c of plan.contactos) con.run(c.id, c.nombre, c.telefono, c.email, c.nacimiento, c.origen, c.creado, c.actualizado);
    const idEtiqueta = new Map<string, number>();
    const eti = ins("INSERT INTO etiqueta(id, nombre) VALUES (?, ?)");
    plan.etiquetas.forEach((n, i) => {
      eti.run(i + 1, n);
      idEtiqueta.set(n.toLowerCase(), i + 1);
    });
    const ce = ins("INSERT OR IGNORE INTO contacto_etiqueta(contacto_id, etiqueta_id) VALUES (?, ?)");
    for (const c of plan.contactos) for (const e of c.etiquetas) ce.run(c.id, idEtiqueta.get(e.toLowerCase())!);
    const opo = ins("INSERT INTO oportunidad(id, contacto_id, titulo, etapa_id, en_etapa_desde, monto_centavos, moneda, motivo_perdida, cerrada, extra, creada, actualizada) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const x of plan.oportunidades) opo.run(x.id, x.contacto, x.titulo, x.etapa, x.desde, x.monto, x.moneda, x.motivo, x.cerrada, x.extra, x.creada, x.actualizada);
    const oe = ins("INSERT OR IGNORE INTO oportunidad_etiqueta(oportunidad_id, etiqueta_id) VALUES (?, ?)");
    for (const x of plan.oportunidades) for (const e of x.etiquetas) oe.run(x.id, idEtiqueta.get(e.toLowerCase())!);
    const toq = ins("INSERT INTO toque(contacto_id, oportunidad_id, tipo, texto, vence, hecho, creado) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const t of plan.toques) toq.run(t.contacto, t.oportunidad, t.tipo, t.texto, t.vence, t.hecho, t.creado);
    // El trigger de alta anota el paso de etapa con la hora de hoy: se lleva a la fecha real para que el archivo no dependa del reloj.
    db.exec("UPDATE etapa_paso SET desde = (SELECT en_etapa_desde FROM oportunidad WHERE id = etapa_paso.oportunidad_id)");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.close();
    throw e;
  }
  return db;
}

export function contar(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(TABLAS.map((t) => [t, Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)]));
}

/** Hash del contenido de las tablas de datos, ordenado: dos corridas sobre los mismos datos dan la misma huella. */
export function huella(db: DatabaseSync): string {
  const h = createHash("sha256");
  for (const t of TABLAS) {
    h.update(`#${t}\n`);
    for (const f of db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()) h.update(`${JSON.stringify(f)}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

export interface Verificacion { ok: boolean; version: number; quick: string; integrity: string; fkRotas: number; problemas: string[] }

/**
 * Abre el archivo con el mismo contrato que `src-tauri/src/migraciones.rs` del Base: `_sqlx_migrations` con el
 * checksum SHA-384 de cada migración que la app trae, ninguna versión que la app no conozca (VERSION_FUTURA),
 * `quick_check` en «ok». Es una reproducción en TypeScript: el runner real es Rust (sqlx) y no corre en este CI.
 */
export function verificarComoBase(archivo: string, migraciones: Migracion[]): Verificacion {
  // Sin readOnly: un archivo en modo WAL abierto solo para leer deja -wal/-shm sueltos; abierto normal los limpia al cerrar.
  const db = new DatabaseSync(archivo);
  try {
    const problemas: string[] = [];
    const hay = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'").get() !== undefined;
    const aplicadas = hay ? (db.prepare("SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version").all() as { version: number; checksum: Uint8Array; success: number }[]) : [];
    if (!hay) problemas.push("sin _sqlx_migrations: la app intentaría migrar de cero");
    const version = Math.max(0, ...aplicadas.filter((a) => a.success === 1).map((a) => a.version));
    if (version > migraciones.length) problemas.push(`VERSION_FUTURA: el archivo está en la ${version} y la app trae hasta la ${migraciones.length}`);
    for (const m of migraciones) {
      const a = aplicadas.find((x) => x.version === m.version);
      if (!a || a.success !== 1) problemas.push(`migración ${m.version} sin aplicar`);
      else if (!m.checksum.equals(Buffer.from(a.checksum))) problemas.push(`migración ${m.version}: el checksum no coincide`);
    }
    const quickFilas = (db.prepare("PRAGMA quick_check").all() as { quick_check: string }[]).map((f) => f.quick_check);
    const quick = quickFilas.length === 1 ? quickFilas[0]! : quickFilas[0] ?? "sin respuesta";
    const intFilas = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((f) => f.integrity_check);
    const integrity = intFilas.length === 1 ? intFilas[0]! : intFilas[0] ?? "sin respuesta";
    const fkRotas = db.prepare("PRAGMA foreign_key_check").all().length;
    if (quick !== "ok") problemas.push(`quick_check: ${quick}`);
    if (integrity !== "ok") problemas.push(`integrity_check: ${integrity}`);
    if (fkRotas) problemas.push(`${fkRotas} clave(s) foránea(s) rota(s)`);
    return { ok: problemas.length === 0, version, quick, integrity, fkRotas, problemas };
  } finally {
    db.close();
  }
}

// ───────────────────────────── 4. Informe y CLI ─────────────────────────────

export interface Resultado { destino: Record<string, number>; huella: string; verificacion: Verificacion | null; descuadres: string[] }

/** Origen = destino + lo que fue al CSV (+ el contacto «(Sin contacto)» si hizo falta). Devuelve lo que no cierra. */
export function cuadrar(plan: Plan, destino: Record<string, number>): string[] {
  const csv = (tabla: string) => plan.noExportado.filter((x) => x.tabla === tabla && !x.motivo.startsWith("estaba bloqueado")).length;
  const sinContacto = plan.contactos.filter((c) => c.nombre === SIN_CONTACTO && c.origen === "exportar-a-base").length;
  const o = plan.origen;
  const pares: [string, number, number][] = [
    ["embudo", o.crm_pipelines!, destino.embudo!],
    ["etapa", o.crm_stages! - csv("crm_stages"), destino.etapa!],
    ["contacto", o.contacts! - csv("contacts"), destino.contacto! - sinContacto],
    ["oportunidad", o.crm_leads! - csv("crm_leads"), destino.oportunidad!],
    ["toque", o.lead_notes! + o.crm_tasks! - csv("crm_tasks"), destino.toque!],
  ];
  return pares.filter(([, esperado, real]) => esperado !== real).map(([t, esperado, real]) => `${t}: origen − CSV = ${esperado}, destino = ${real}`);
}

const agrupar = (xs: NoExportado[]) => xs.reduce((m, x) => m.set(`${x.tabla}: ${x.motivo}`, (m.get(`${x.tabla}: ${x.motivo}`) ?? 0) + 1), new Map<string, number>());

export function informe(plan: Plan, r: Resultado, simular: boolean): string {
  const csv = (tabla: string) => plan.noExportado.filter((x) => x.tabla === tabla && !x.motivo.startsWith("estaba bloqueado")).length;
  const sinContacto = plan.contactos.filter((c) => c.nombre === SIN_CONTACTO && c.origen === "exportar-a-base").length;
  const notas = plan.toques.filter((t) => t.tipo !== "tarea").length;
  const tareas = plan.toques.length - notas;
  const tagsC = plan.contactos.reduce((n, c) => n + new Set(c.etiquetas.map((e) => e.toLowerCase())).size, 0);
  const tagsO = plan.oportunidades.reduce((n, c) => n + new Set(c.etiquetas.map((e) => e.toLowerCase())).size, 0);
  const d = r.destino;
  const fila = (nombre: string, origen: number, destino: number, csvN: number, nota = "") => `| ${nombre} | ${origen} | ${destino} | ${csvN} | ${nota} |`;
  const v = r.verificacion;
  return [
    `# Exportación del CRM Conectado al Base — ${simular ? "SIMULACIÓN (no se escribió nada)" : "REAL"}`,
    "",
    "| tabla | filas origen | filas destino | al CSV | nota |",
    "|---|---|---|---|---|",
    fila("crm_pipelines → embudo", plan.origen.crm_pipelines!, d.embudo!, 0),
    fila("crm_stages → etapa", plan.origen.crm_stages!, d.etapa!, csv("crm_stages")),
    fila("contacts → contacto", plan.origen.contacts!, d.contacto! - sinContacto, csv("contacts"), sinContacto ? `+${sinContacto} «${SIN_CONTACTO}» creado` : ""),
    fila("tags → etiqueta", plan.etiquetas.length, d.etiqueta!, 0, "únicas, sin distinguir mayúsculas"),
    fila("contacts.tags → contacto_etiqueta", tagsC, d.contacto_etiqueta!, 0),
    fila("crm_leads → oportunidad", plan.origen.crm_leads!, d.oportunidad!, csv("crm_leads")),
    fila("crm_leads.tags → oportunidad_etiqueta", tagsO, d.oportunidad_etiqueta!, 0),
    fila("lead_notes → toque (nota/llamada/…)", plan.origen.lead_notes!, notas, 0),
    fila("crm_tasks → toque (tarea)", plan.origen.crm_tasks!, tareas, csv("crm_tasks")),
    "",
    `Filas de \`toque\` en el archivo: ${d.toque} · pasos de etapa: ${d.etapa_paso} · huella del contenido: \`${r.huella}\``,
    "",
    r.descuadres.length ? `✗ NO CUADRA: ${r.descuadres.join("; ")}` : "✓ Cuadra: origen = destino + lo que va al CSV, tabla por tabla.",
    "",
    "## Integridad",
    ...(v
      ? [`- integrity_check: ${v.integrity} · quick_check: ${v.quick} · foreign_key_check: ${v.fkRotas} rota(s)`, `- migraciones: aplicadas hasta la ${v.version}, checksum SHA-384 verificado contra lrn/fixtures/base-migraciones`, ...(v.problemas.length ? v.problemas.map((p) => `- ✗ ${p}`) : ["- ✓ abre sin problemas"]), "- Runner: reproducción en TypeScript del contrato de `migraciones.rs`; abrirlo con la app Tauri real queda NO MEDIDO."]
      : ["- (simulación: no hay archivo que verificar)"]),
    "",
    "## No viaja (al CSV)",
    ...(plan.noExportado.length ? [...agrupar(plan.noExportado)].map(([k, n]) => `- ${n} × ${k}`) : ["- nada"]),
    "",
    "## Avisos",
    ...(plan.avisos.length ? plan.avisos.map((x) => `- ${x}`) : ["- ninguno"]),
    "",
    "## Qué no viaja (OFERTA cl. 8)",
    ...NO_VIAJA.map((x) => `- ${x}`),
  ].join("\n");
}

const celdaCsv = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const csvNoExportado = (xs: NoExportado[]): string =>
  ["tabla,id,motivo,detalle", ...xs.map((x) => [x.tabla, x.id, x.motivo, x.detalle].map(celdaCsv).join(","))].join("\n") + "\n";

/** Arma todo en memoria o en `archivo`. Con `archivo` null (simular) mide igual, pero no deja nada en disco. */
export function construir(plan: Plan, archivo: string | null, migraciones: Migracion[]): Resultado {
  const tmp = archivo ? `${archivo}.tmp` : ":memory:";
  if (archivo) for (const s of ["", "-wal", "-shm"]) fs.rmSync(tmp + s, { force: true });
  const db = escribir(plan, tmp, migraciones);
  const destino = contar(db);
  const h = huella(db);
  if (!archivo) {
    db.close();
    return { destino, huella: h, verificacion: null, descuadres: cuadrar(plan, destino) };
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const s of ["-wal", "-shm"]) fs.rmSync(tmp + s, { force: true });
  fs.renameSync(tmp, archivo);
  return { destino, huella: h, verificacion: verificarComoBase(archivo, migraciones), descuadres: cuadrar(plan, destino) };
}

function argumentos(argv: string[]) {
  const a = { org: "", salida: "", migraciones: MIGRACIONES, verificar: "", simular: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "--simular") a.simular = true;
    else if (x === "--org" || x === "--salida" || x === "--migraciones" || x === "--verificar") a[x.slice(2) as "org" | "salida" | "migraciones" | "verificar"] = argv[++i] ?? "";
    else throw new Error(`Opción desconocida: ${x}`);
  }
  if (!a.verificar && !a.org) throw new Error("Uso: exportar-a-base.ts --org <slug|uuid> --salida <carpeta> [--migraciones <carpeta>] [--simular] | --verificar <crm.db>");
  if (a.org && !a.salida) throw new Error("Falta --salida <carpeta> (ahí quedan crm.db, marca.json, no-exportado.csv y el informe).");
  return a;
}

function cargarEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const file of [".env.local", ".env"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]!]) out[m[1]!] = (m[2] ?? "").replace(/^"(.*)"$/, "$1");
    }
  }
  return out;
}

async function main(): Promise<void> {
  const a = argumentos(process.argv.slice(2));
  const migraciones = leerMigraciones(a.migraciones);
  if (a.verificar) {
    const v = verificarComoBase(a.verificar, migraciones);
    console.info(JSON.stringify(v, null, 2));
    process.exit(v.ok ? 0 : 1);
  }
  const env = cargarEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const esUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a.org);
  const org = ok(await db.from("organizations").select("id").eq(esUuid ? "id" : "slug", a.org).maybeSingle(), "organización") as { id: string } | null;
  if (!org) throw new Error(`No existe la organización «${a.org}»`);

  const origen = await leerOrigen(db, org.id);
  const plan = planificar(origen);
  fs.mkdirSync(a.salida, { recursive: true });
  const r = construir(plan, a.simular ? null : path.join(a.salida, "crm.db"), migraciones);
  const texto = informe(plan, r, a.simular);
  console.info(texto);
  const sello = a.simular ? "simulacion" : "real";
  fs.writeFileSync(path.join(a.salida, `informe-${sello}.md`), texto);
  fs.writeFileSync(path.join(a.salida, `resultado-${sello}.json`), JSON.stringify({ destino: r.destino, huella: r.huella, verificacion: r.verificacion, descuadres: r.descuadres, origen: plan.origen, noExportado: plan.noExportado.length }, null, 2));
  if (!a.simular) {
    fs.writeFileSync(path.join(a.salida, "no-exportado.csv"), csvNoExportado(plan.noExportado));
    if (plan.marca) {
      fs.writeFileSync(path.join(a.salida, "marca.json"), JSON.stringify(plan.marca, null, 2));
      if (origen.logo && origen.logo[0] === 0x89 && origen.logo[1] === 0x50) fs.writeFileSync(path.join(a.salida, "logo.png"), origen.logo);
    }
    if ((r.verificacion && !r.verificacion.ok) || r.descuadres.length) process.exit(1);
  }
}

if (process.argv[1]?.endsWith("exportar-a-base.ts")) {
  main().catch((e) => {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
