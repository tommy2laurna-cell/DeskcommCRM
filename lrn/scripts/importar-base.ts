/**
 * Importa una copia .sqlite del CRM Base de un cliente a su CRM Conectado.
 *
 *   npx tsx lrn/scripts/importar-base.ts <base.sqlite> --org <slug|uuid> [--marca <marca.json>]
 *       [--salida <carpeta>] [--simular] [--pisar-marca]
 *
 * Credenciales (env o .env/.env.local): NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.
 * Nunca se imprimen.
 *
 * Idempotente: cada fila del Base se guarda con su id (`id_externo`: contacto `c<id>`, oportunidad
 * `o<id>`, toque `t<id>`); correrlo dos veces deja los mismos conteos. Nada se descarta en silencio:
 * lo que no tiene lugar en el Conectado va a una nota del contacto o al informe (`no-importado.json`).
 * La tabla campo por campo está en lrn/importar-base/MAPEO.md.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizePhoneBR } from "@/lib/webhooks/inbound";

export const SOURCE = "importar-base";

// ───────────────────────────── 1. Lectura del Base ─────────────────────────────

type Fila = Record<string, string | number | null>;

export interface Base {
  embudos: Fila[];
  etapas: Fila[];
  cuentas: Fila[];
  contactos: Fila[];
  oportunidades: Fila[];
  toques: Fila[];
  etiquetas: Fila[];
  contactoEtiqueta: Fila[];
  oportunidadEtiqueta: Fila[];
  listas: Fila[];
}

export interface Marca {
  negocio?: string;
  logo?: string;
  colores?: { primario?: string; acento?: string };
  palabras?: Record<string, string>;
  campos_extra?: Record<string, unknown>;
  motivos_perdida?: string[];
}

export function leerBase(archivo: string): Base {
  const db = new DatabaseSync(archivo, { readOnly: true });
  try {
    const hay = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) !== undefined;
    const todas = (sql: string) => db.prepare(sql).all() as Fila[];
    const opt = (t: string, sql = `SELECT * FROM ${t} ORDER BY id`) => (hay(t) ? todas(sql) : []);
    if (!hay("contacto") || !hay("oportunidad") || !hay("etapa")) throw new Error("El archivo no parece una base del CRM Base (faltan contacto, oportunidad o etapa).");
    const etapas = todas("SELECT * FROM etapa ORDER BY orden, id").map((e) => ({ embudo_id: 1, ...e }));
    return {
      // 0.1.0 todavía no tenía embudos: todo vive en uno solo.
      embudos: hay("embudo") ? todas("SELECT * FROM embudo ORDER BY orden, id") : [{ id: 1, nombre: "Ventas", orden: 1, activo: 1 }],
      etapas,
      cuentas: opt("cuenta"),
      contactos: todas("SELECT * FROM contacto ORDER BY id").map((c) => ({ cumple: null, ...c })),
      oportunidades: todas("SELECT * FROM oportunidad ORDER BY id"),
      toques: todas("SELECT * FROM toque ORDER BY id"),
      etiquetas: opt("etiqueta"),
      contactoEtiqueta: opt("contacto_etiqueta", "SELECT * FROM contacto_etiqueta"),
      oportunidadEtiqueta: opt("oportunidad_etiqueta", "SELECT * FROM oportunidad_etiqueta"),
      listas: opt("lista"),
    };
  } finally {
    db.close();
  }
}

// ───────────────────────────── 2. Plan (puro, sin red) ─────────────────────────────

export interface PlanEtapa {
  baseId: number;
  nombre: string;
  slug: string;
  posicion: number;
  color: string | null;
  won: boolean;
  lost: boolean;
  archivada: boolean;
  horas: number;
  /** Otra etapa de cierre del mismo tipo en el embudo: el Conectado admite una sola ganada y una sola perdida. */
  fusionadaEn: number | null;
}
export interface PlanEmbudo { baseId: number; nombre: string; slug: string; posicion: number; archivado: boolean; etapas: PlanEtapa[] }
export interface PlanContacto {
  idExt: string;
  baseId: number;
  nombre: string;
  telefono: string | null;
  email: string | null;
  tags: string[];
  creado: string | null;
  nota: string | null;
  /** Se importa solo porque una oportunidad viva depende de él. */
  borradoConOportunidades: boolean;
}
export interface PlanLead {
  idExt: string;
  baseId: number;
  contactoBaseId: number;
  etapaBaseId: number;
  titulo: string;
  estado: "open" | "won" | "lost";
  motivoPerdida: string | null;
  monto: number | null;
  moneda: string | null;
  cerrada: string | null;
  creada: string | null;
  tags: string[];
  customFields: Record<string, unknown>;
  meta: Record<string, unknown>;
}
export interface PlanNota { idExt: string; contactoBaseId: number; titular: string; cuerpo: string; creada: string | null }
export interface PlanTarea { idExt: string; contactoBaseId: number; leadBaseId: number | null; titulo: string; vence: string; hecha: boolean; creada: string | null }
export interface Omitido { tipo: string; id: number; motivo: string }
export interface Plan {
  embudos: PlanEmbudo[];
  contactos: PlanContacto[];
  leads: PlanLead[];
  notas: PlanNota[];
  tareas: PlanTarea[];
  omitidos: Omitido[];
  /** Avisos que el informe muestra, aunque ninguna fila se pierda. */
  avisos: string[];
  /** Datos sin lugar en el Conectado: se vuelcan a no-importado.json. */
  sinLugar: { listas: Fila[]; tonosDeEtiqueta: Record<string, number> };
}

export function slugify(texto: string, max = 40): string {
  const s = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s.length >= 2 ? s : `x${s}`.padEnd(2, "x");
}

const t = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const ymd = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const recorte = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function parseExtra(v: unknown): Record<string, unknown> {
  try {
    const j = JSON.parse(String(v ?? "{}"));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function planificar(b: Base): Plan {
  const omitidos: Omitido[] = [];
  const avisos: string[] = [];

  // — Embudos y etapas —
  const embudos: PlanEmbudo[] = b.embudos.map((e) => ({
    baseId: Number(e.id),
    nombre: String(e.nombre),
    slug: `base-${slugify(String(e.nombre), 35)}`.slice(0, 40),
    posicion: Number(e.orden) * 1000,
    archivado: e.activo === 0,
    etapas: [],
  }));
  for (const [i, a] of embudos.entries())
    if (embudos.findIndex((o) => o.slug === a.slug) !== i) a.slug = `${a.slug.slice(0, 34)}-${a.baseId}`;
  const embudoDe = new Map(embudos.map((e) => [e.baseId, e]));
  const etapaPlan = new Map<number, PlanEtapa>();
  for (const e of b.etapas) {
    const emb = embudoDe.get(Number(e.embudo_id));
    if (!emb) {
      omitidos.push({ tipo: "etapa", id: Number(e.id), motivo: `embudo ${e.embudo_id} inexistente` });
      continue;
    }
    let slug = slugify(String(e.nombre));
    if (emb.etapas.some((x) => x.slug === slug)) slug = `${slug.slice(0, 34)}-${e.id}`;
    const won = e.cierre === "ganada";
    const lost = e.cierre === "perdida";
    const archivada = e.activa === 0;
    const rep = emb.etapas.find((x) => !x.archivada && !archivada && x.fusionadaEn === null && ((won && x.won) || (lost && x.lost)));
    const p: PlanEtapa = {
      baseId: Number(e.id),
      nombre: String(e.nombre),
      slug,
      posicion: Number(e.orden) * 1000,
      color: typeof e.color === "string" ? e.color : null,
      won: won && !rep,
      lost: lost && !rep,
      archivada,
      horas: Number(e.dias_estancada ?? 7) * 24,
      fusionadaEn: rep ? rep.baseId : null,
    };
    if (rep) avisos.push(`Etapa «${p.nombre}» (cierre ${e.cierre}): el Conectado admite una sola por embudo; sus oportunidades pasan a «${rep.nombre}» y la etapa de origen queda en source_metadata.base_etapa.`);
    emb.etapas.push(p);
    etapaPlan.set(p.baseId, p);
  }

  // — Etiquetas —
  const etiqueta = new Map(b.etiquetas.map((e) => [Number(e.id), String(e.nombre).trim().toLowerCase().slice(0, 40)]));
  const tonos = Object.fromEntries(b.etiquetas.map((e) => [String(e.nombre), Number(e.tono)]));
  const tagsDe = (rel: Fila[], col: string, id: number) =>
    rel.filter((r) => Number(r[col]) === id).map((r) => etiqueta.get(Number(r.etiqueta_id))).filter((x): x is string => !!x);

  // — Contactos —
  const cuenta = new Map(b.cuentas.map((c) => [Number(c.id), c]));
  const vivas = b.oportunidades.filter((o) => !o.borrada);
  const conOportunidad = new Set(vivas.map((o) => Number(o.contacto_id)));
  const contactos: PlanContacto[] = [];
  for (const c of b.contactos) {
    const id = Number(c.id);
    if (c.borrado && !conOportunidad.has(id)) {
      omitidos.push({ tipo: "contacto", id, motivo: "borrado en el Base" });
      continue;
    }
    const tel = t(c.telefono);
    const telE164 = tel ? normalizePhoneBR(tel) : null;
    const ct = c.cuenta_id != null ? cuenta.get(Number(c.cuenta_id)) : undefined;
    const lineas: string[] = [];
    const mail = t(c.email)?.toLowerCase() ?? null;
    const mailOk = mail !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail);
    if (mail && !mailOk) lineas.push(`Email (no es válido): ${mail}`);
    if (tel && !telE164) lineas.push(`Teléfono (no se pudo normalizar): ${tel}`);
    if (t(c.cumple)) lineas.push(`Cumpleaños: ${c.cumple}`);
    if (ct) {
      const partes = [`Cuenta: ${ct.nombre}`, t(ct.cuit) && `CUIT ${ct.cuit}`, t(ct.telefono) && `tel. ${ct.telefono}`, t(ct.email) && ct.email, t(ct.notas) && `notas: ${ct.notas}`].filter(Boolean);
      lineas.push(partes.join(" · "));
      for (const [k, v] of Object.entries(parseExtra(ct.extra))) lineas.push(`Cuenta · ${k}: ${v}`);
      if (ct.borrada) avisos.push(`Contacto ${id}: su cuenta «${ct.nombre}» estaba borrada en el Base; se anota igual.`);
    }
    if (t(c.notas)) lineas.push(`Notas: ${c.notas}`);
    for (const [k, v] of Object.entries(parseExtra(c.extra))) lineas.push(`${k}: ${v}`);
    contactos.push({
      idExt: `c${id}`,
      baseId: id,
      nombre: String(c.nombre).trim(),
      telefono: telE164,
      email: mailOk ? mail : null,
      tags: [...new Set(tagsDe(b.contactoEtiqueta, "contacto_id", id))],
      creado: ymd(c.creado),
      nota: lineas.length ? `Importado del CRM Base (contacto n.º ${id}).\n${lineas.join("\n")}` : null,
      borradoConOportunidades: !!c.borrado,
    });
  }
  const contactoIds = new Set(contactos.map((c) => c.baseId));
  for (const c of contactos) if (c.borradoConOportunidades) avisos.push(`Contacto «${c.nombre}» (${c.baseId}) estaba borrado pero tiene oportunidades vivas: se importa.`);

  // — Oportunidades → leads —
  const leads: PlanLead[] = [];
  for (const o of b.oportunidades) {
    const id = Number(o.id);
    if (o.borrada) {
      omitidos.push({ tipo: "oportunidad", id, motivo: "borrada en el Base" });
      continue;
    }
    const et = etapaPlan.get(Number(o.etapa_id));
    if (!et || !contactoIds.has(Number(o.contacto_id))) {
      omitidos.push({ tipo: "oportunidad", id, motivo: !et ? "etapa sin embudo" : "contacto no importado" });
      continue;
    }
    const destino = et.fusionadaEn !== null ? etapaPlan.get(et.fusionadaEn)! : et;
    const moneda = typeof o.moneda === "string" && /^[A-Z]{3}$/.test(o.moneda) ? o.moneda : null;
    if (!moneda) avisos.push(`Oportunidad ${id}: moneda «${o.moneda}» no es ISO; queda en source_metadata.base_moneda.`);
    const estado = destino.won ? "won" : destino.lost ? "lost" : "open";
    leads.push({
      idExt: `o${id}`,
      baseId: id,
      contactoBaseId: Number(o.contacto_id),
      etapaBaseId: destino.baseId,
      titulo: String(o.titulo).trim(),
      estado,
      motivoPerdida: estado === "lost" ? t(o.motivo_perdida) ?? "Sin motivo (importado del Base)" : null,
      monto: o.monto_centavos == null ? null : Number(o.monto_centavos),
      moneda,
      cerrada: estado === "open" ? null : ymd(o.cerrada) ?? ymd(o.actualizada) ?? new Date().toISOString(),
      creada: ymd(o.creada),
      tags: [...new Set(tagsDe(b.oportunidadEtiqueta, "oportunidad_id", id))],
      customFields: parseExtra(o.extra),
      meta: {
        via: SOURCE,
        id_externo: `o${id}`,
        base_en_etapa_desde: o.en_etapa_desde,
        base_actualizada: o.actualizada,
        ...(et.fusionadaEn !== null ? { base_etapa: et.nombre } : {}),
        ...(moneda ? {} : { base_moneda: o.moneda }),
      },
    });
  }
  const leadIds = new Set(leads.map((l) => l.baseId));

  // — Toques → notas y tareas —
  const notas: PlanNota[] = [];
  const tareas: PlanTarea[] = [];
  for (const q of b.toques) {
    const id = Number(q.id);
    if (!contactoIds.has(Number(q.contacto_id))) {
      omitidos.push({ tipo: "toque", id, motivo: "contacto no importado" });
      continue;
    }
    const lead = q.oportunidad_id != null && leadIds.has(Number(q.oportunidad_id)) ? Number(q.oportunidad_id) : null;
    const texto = String(q.texto).trim();
    if (q.tipo === "tarea") {
      tareas.push({ idExt: `t${id}`, contactoBaseId: Number(q.contacto_id), leadBaseId: lead, titulo: recorte(texto, 200), vence: String(q.vence), hecha: !!q.hecho, creada: ymd(q.creado) });
    } else {
      const aviso = q.oportunidad_id != null && lead === null ? `\n(Oportunidad ${q.oportunidad_id} del Base no se importó.)` : "";
      notas.push({
        idExt: `t${id}`,
        contactoBaseId: Number(q.contacto_id),
        titular: `Base t${id} · ${q.tipo} · ${recorte(texto.replace(/\s+/g, " "), 60)}`,
        cuerpo: `${texto}${lead !== null ? `\n(Oportunidad n.º ${q.oportunidad_id} del Base.)` : ""}${aviso}`,
        creada: ymd(q.creado),
      });
    }
  }
  if (b.listas.length) avisos.push(`${b.listas.length} lista(s) guardada(s) sin equivalente en el Conectado: van a no-importado.json.`);
  if (b.etiquetas.length) avisos.push(`${b.etiquetas.length} etiqueta(s): se conserva el nombre; el tono (color) del Base no tiene lugar y va a no-importado.json.`);

  return { embudos, contactos, leads, notas, tareas, omitidos, avisos, sinLugar: { listas: b.listas, tonosDeEtiqueta: tonos } };
}

// ───────────────────────────── 3. Aplicar (Supabase) ─────────────────────────────

export type Conteo = { creados: number; existentes: number };
export type Resultado = Record<"embudos" | "etapas" | "contactos" | "leads" | "notas" | "tareas", Conteo> & { marca: string[]; avisos: string[] };

const nuevoConteo = (): Conteo => ({ creados: 0, existentes: 0 });
const ok = <T>(r: { data: T; error: { message: string } | null }, ctx: string): T => {
  if (r.error) throw new Error(`${ctx}: ${r.error.message}`);
  return r.data;
};

export interface Opciones { simular: boolean; pisarMarca: boolean; marca?: Marca; carpetaMarca?: string }

export async function aplicar(db: SupabaseClient, org: string, plan: Plan, op: Opciones): Promise<Resultado> {
  const res: Resultado = { embudos: nuevoConteo(), etapas: nuevoConteo(), contactos: nuevoConteo(), leads: nuevoConteo(), notas: nuevoConteo(), tareas: nuevoConteo(), marca: [], avisos: [] };
  const crea = async <T extends { id: string }>(c: Conteo, tabla: string, fila: Record<string, unknown>): Promise<string | null> => {
    c.creados++;
    if (op.simular) return null;
    const r = await db.from(tabla).insert(fila).select("id").single();
    return (ok(r, `insert ${tabla}`) as T).id;
  };

  // Embudos y etapas: por (org, slug) y (embudo, slug).
  const etapaId = new Map<number, string | null>();
  const embudoId = new Map<number, string | null>();
  const hayDefault = (ok(await db.from("crm_pipelines").select("id").eq("organization_id", org).eq("is_default", true).limit(1), "pipelines") as unknown[]).length > 0;
  let defaultLibre = !hayDefault;
  for (const e of plan.embudos) {
    const ya = ok(await db.from("crm_pipelines").select("id").eq("organization_id", org).eq("slug", e.slug).maybeSingle(), "pipeline");
    let id: string | null = ya ? (ya as { id: string }).id : null;
    if (ya) res.embudos.existentes++;
    else {
      id = await crea(res.embudos, "crm_pipelines", { organization_id: org, name: e.nombre, slug: e.slug, position: e.posicion, is_archived: e.archivado, is_default: defaultLibre && !e.archivado });
      if (defaultLibre && !e.archivado) defaultLibre = false;
    }
    embudoId.set(e.baseId, id);
    for (const s of e.etapas) {
      const ex = id ? ok(await db.from("crm_stages").select("id").eq("pipeline_id", id).eq("slug", s.slug).maybeSingle(), "stage") : null;
      if (ex) {
        res.etapas.existentes++;
        etapaId.set(s.baseId, (ex as { id: string }).id);
      } else {
        etapaId.set(s.baseId, await crea(res.etapas, "crm_stages", { organization_id: org, pipeline_id: id, name: s.nombre, slug: s.slug, position: s.posicion, color: s.color, is_won: s.won, is_lost: s.lost, is_archived: s.archivada, expected_duration_hours: s.horas }));
      }
    }
  }
  // Las etapas fusionadas apuntan a la etapa que las representa.
  for (const e of plan.embudos) for (const s of e.etapas) if (s.fusionadaEn !== null) etapaId.set(s.baseId, etapaId.get(s.fusionadaEn) ?? null);
  const pipelineDeEtapa = new Map<number, number>();
  for (const e of plan.embudos) for (const s of e.etapas) pipelineDeEtapa.set(s.baseId, e.baseId);

  // Contactos: primero por id_externo; si no, por teléfono o email (índices únicos del Conectado).
  const contactoId = new Map<number, string | null>();
  for (const c of plan.contactos) {
    const q = () => db.from("contacts").select("id").eq("organization_id", org).is("is_merged_into", null);
    type Hit = { id: string } | null;
    let ex = ok(await q().eq("source", SOURCE).eq("source_metadata->>id_externo", c.idExt).maybeSingle(), "contacto") as Hit;
    const porId = ex !== null;
    if (!ex && c.telefono) ex = ok(await q().eq("phone_number", c.telefono).maybeSingle(), "contacto tel") as Hit;
    if (!ex && c.email) ex = ok(await q().eq("email_normalized", c.email).maybeSingle(), "contacto email") as Hit;
    const porDato = ex !== null && !porId;
    if (ex) {
      res.contactos.existentes++;
      contactoId.set(c.baseId, ex.id);
      if (porDato) {
        res.avisos.push(`contacto «${c.nombre}» ya existía por teléfono/email: se reutiliza y no se pisa; lo del Base va a una nota`);
        await nota(c.baseId, { idExt: c.idExt, titular: `Base ${c.idExt} · contacto ya existente`, creada: c.creado, cuerpo: `En el CRM Base se llamaba «${c.nombre}»${c.email ? ` · ${c.email}` : ""}${c.telefono ? ` · ${c.telefono}` : ""}${c.tags.length ? ` · etiquetas: ${c.tags.join(", ")}` : ""}.` });
      }
    } else {
      contactoId.set(c.baseId, await crea(res.contactos, "contacts", { organization_id: org, name: c.nombre, phone_number: c.telefono, email: c.email, tags: c.tags, source: SOURCE, source_metadata: { via: SOURCE, id_externo: c.idExt }, ...(c.creado ? { created_at: c.creado } : {}) }));
    }
    if (c.nota) await nota(c.baseId, { idExt: c.idExt, titular: `Base ${c.idExt} · datos del CRM Base`, cuerpo: c.nota, creada: c.creado });
  }

  async function nota(contactoBase: number, n: { idExt: string; titular: string; cuerpo: string; creada: string | null }) {
    const cid = contactoId.get(contactoBase) ?? null;
    const ex = cid ? ok(await db.from("lead_notes").select("id").eq("organization_id", org).eq("contact_id", cid).eq("headline", n.titular).limit(1).maybeSingle(), "nota") : null;
    if (ex) return void res.notas.existentes++;
    await crea(res.notas, "lead_notes", { organization_id: org, contact_id: cid, headline: n.titular, body: n.cuerpo, ...(n.creada ? { created_at: n.creada } : {}) });
  }

  // Oportunidades → leads: (org, source, external_id) es único.
  const leadId = new Map<number, string | null>();
  const posicion = new Map<number, number>();
  for (const l of plan.leads) {
    const ex = ok(await db.from("crm_leads").select("id").eq("organization_id", org).eq("source", SOURCE).eq("external_id", l.idExt).maybeSingle(), "lead") as { id: string } | null;
    if (ex) {
      res.leads.existentes++;
      leadId.set(l.baseId, ex.id);
      continue;
    }
    const pos = (posicion.get(l.etapaBaseId) ?? 0) + 1000;
    posicion.set(l.etapaBaseId, pos);
    const pid = embudoId.get(pipelineDeEtapa.get(l.etapaBaseId)!) ?? null;
    leadId.set(l.baseId, await crea(res.leads, "crm_leads", {
      organization_id: org, pipeline_id: pid, stage_id: etapaId.get(l.etapaBaseId) ?? null, contact_id: contactoId.get(l.contactoBaseId) ?? null,
      title: l.titulo, status: l.estado, lost_reason: l.motivoPerdida, value_cents: l.monto, currency: l.moneda, closed_at: l.cerrada,
      source: SOURCE, external_id: l.idExt, source_metadata: l.meta, custom_fields: l.customFields, tags: l.tags, position_in_stage: pos,
      ...(l.creada ? { created_at: l.creada } : {}),
    }));
  }

  for (const n of plan.notas) await nota(n.contactoBaseId, n);

  // Tareas: sin columna de id externo; el marcador `base:t<id>` va en description y se busca por él.
  for (const q of plan.tareas) {
    const marcador = `base:${q.idExt}`;
    const ex = ok(await db.from("crm_tasks").select("id").eq("organization_id", org).eq("description", marcador).limit(1).maybeSingle(), "tarea");
    if (ex) {
      res.tareas.existentes++;
      continue;
    }
    await crea(res.tareas, "crm_tasks", {
      organization_id: org, title: q.titulo, description: marcador, due_date: `${q.vence}T12:00:00Z`, status: q.hecha ? "done" : "pending",
      contact_id: contactoId.get(q.contactoBaseId) ?? null, lead_id: q.leadBaseId === null ? null : leadId.get(q.leadBaseId) ?? null,
      ...(q.creada ? { created_at: q.creada } : {}),
    });
  }

  await aplicarMarca(db, plan, op, res);
  return res;
}

/** Nombre, acento y logo → platform_branding (lo que muestra /app/settings/marca). Solo llena lo vacío, salvo --pisar-marca. */
async function aplicarMarca(db: SupabaseClient, _plan: Plan, op: Opciones, res: Resultado): Promise<void> {
  const m = op.marca;
  if (!m) return void res.marca.push("sin marca.json: la marca no se toca");
  const fila = ok(await db.from("platform_branding").select("app_name, accent_hex, logo_path").eq("id", 1).maybeSingle(), "branding") as { app_name: string | null; accent_hex: string | null; logo_path: string | null } | null;
  const cambios: Record<string, unknown> = {};
  const acento = m.colores?.acento?.toLowerCase();
  if (m.negocio && (op.pisarMarca || !fila?.app_name)) cambios.app_name = m.negocio;
  if (acento && /^#[0-9a-f]{6}$/.test(acento) && (op.pisarMarca || !fila?.accent_hex)) cambios.accent_hex = acento;
  if (m.logo && op.carpetaMarca && (op.pisarMarca || !fila?.logo_path)) {
    const archivo = path.join(op.carpetaMarca, m.logo);
    const bytes = fs.existsSync(archivo) ? new Uint8Array(fs.readFileSync(archivo)) : null;
    const png = bytes && bytes[0] === 0x89 && bytes[1] === 0x50;
    const jpg = bytes && bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!bytes || (!png && !jpg)) res.marca.push(`logo «${m.logo}»: no existe o no es PNG/JPG; no se sube`);
    else if (bytes.length > 512 * 1024) res.marca.push(`logo «${m.logo}» pesa más de 512 KB; no se sube`);
    else if (!op.simular) {
      const ruta = `platform/${crypto.randomUUID()}.${png ? "png" : "jpg"}`;
      const up = await db.storage.from("brand-logos").upload(ruta, bytes, { contentType: png ? "image/png" : "image/jpeg", upsert: false });
      if (up.error) throw new Error(`logo: ${up.error.message}`);
      cambios.logo_path = ruta;
    }
    if (op.simular || cambios.logo_path) res.marca.push("logo: se sube a brand-logos");
  }
  if (Object.keys(cambios).length === 0 && !res.marca.some((x) => x.startsWith("logo:"))) res.marca.push("marca: ya estaba cargada, no se toca (usá --pisar-marca para reemplazarla)");
  else if (Object.keys(cambios).length) {
    res.marca.push(`marca: ${Object.keys(cambios).join(", ")}`);
    if (!op.simular) ok(await db.from("platform_branding").upsert({ id: 1, ...cambios, seeded_from_env: false }, { onConflict: "id" }), "branding upsert");
  }
  const sinLugar = [m.palabras && "palabras (vocabulario)", m.campos_extra && Object.keys(m.campos_extra).length && "campos_extra (definición)", m.motivos_perdida?.length && "motivos_perdida (lista)"].filter(Boolean);
  if (sinLugar.length) res.marca.push(`de marca.json no se aplica (se configura en el Conectado): ${sinLugar.join(", ")}`);
}

// ───────────────────────────── 4. Informe y CLI ─────────────────────────────

export function informe(plan: Plan, r: Resultado, simular: boolean): string {
  const f = (n: string, c: Conteo) => `| ${n} | ${c.creados} | ${c.existentes} |`;
  const omit = new Map<string, number>();
  for (const o of plan.omitidos) omit.set(`${o.tipo}: ${o.motivo}`, (omit.get(`${o.tipo}: ${o.motivo}`) ?? 0) + 1);
  return [
    `# Importación del CRM Base — ${simular ? "SIMULACIÓN (no se escribió nada)" : "REAL"}`,
    "",
    "| Qué | " + (simular ? "Se crearían" : "Creados") + " | Ya estaban |",
    "|---|---|---|",
    f("Embudos", r.embudos), f("Etapas", r.etapas), f("Contactos", r.contactos), f("Oportunidades → leads", r.leads),
    f("Notas (toques y datos del contacto)", r.notas), f("Tareas", r.tareas),
    "",
    "## Marca",
    ...r.marca.map((x) => `- ${x}`),
    "",
    "## No se importa (y por qué)",
    ...(omit.size ? [...omit].map(([k, n]) => `- ${n} × ${k}`) : ["- nada"]),
    "",
    "## Avisos",
    ...(plan.avisos.length + r.avisos.length ? [...plan.avisos, ...r.avisos].map((x) => `- ${x}`) : ["- ninguno"]),
  ].join("\n");
}

function argumentos(argv: string[]) {
  const a = { base: "", org: "", marca: "", salida: "", simular: false, pisarMarca: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "--simular") a.simular = true;
    else if (x === "--pisar-marca") a.pisarMarca = true;
    else if (x === "--org" || x === "--marca" || x === "--salida") a[x.slice(2) as "org" | "marca" | "salida"] = argv[++i] ?? "";
    else if (!x.startsWith("--")) a.base = x;
    else throw new Error(`Opción desconocida: ${x}`);
  }
  if (!a.base || !a.org) throw new Error("Uso: importar-base.ts <base.sqlite> --org <slug|uuid> [--marca marca.json] [--salida carpeta] [--simular] [--pisar-marca]");
  return a;
}

function cargarEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const file of [".env.local", ".env"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*?)?$/);
      if (m && !out[m[1]!]) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
    }
  }
  return out;
}

async function main(): Promise<void> {
  const a = argumentos(process.argv.slice(2));
  const env = cargarEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const esUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a.org);
  const org = ok(await db.from("organizations").select("id").eq(esUuid ? "id" : "slug", a.org).maybeSingle(), "organización") as { id: string } | null;
  if (!org) throw new Error(`No existe la organización «${a.org}»`);

  const marca = a.marca ? (JSON.parse(fs.readFileSync(a.marca, "utf8")) as Marca) : undefined;
  const plan = planificar(leerBase(a.base));
  const r = await aplicar(db, org.id, plan, { simular: a.simular, pisarMarca: a.pisarMarca, marca, carpetaMarca: a.marca ? path.dirname(a.marca) : undefined });
  const texto = informe(plan, r, a.simular);
  console.log(texto);
  if (a.salida) {
    fs.mkdirSync(a.salida, { recursive: true });
    const sello = a.simular ? "simulacion" : "real";
    fs.writeFileSync(path.join(a.salida, `informe-${sello}.md`), texto);
    fs.writeFileSync(path.join(a.salida, `resultado-${sello}.json`), JSON.stringify(r, null, 2));
    fs.writeFileSync(path.join(a.salida, "no-importado.json"), JSON.stringify({ omitidos: plan.omitidos, ...plan.sinLugar }, null, 2));
  }
}

if (process.argv[1]?.endsWith("importar-base.ts")) {
  main().catch((e) => {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
