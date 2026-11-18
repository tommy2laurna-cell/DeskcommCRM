/**
 * Semilla y barrido del gate de aislamiento entre organizaciones
 * (auditoría 2026-11-14, seguridad.md § 3; workflow .github/workflows/aislamiento.yml).
 *
 *   pnpm exec tsx scripts/seed-aislamiento.ts          → siembra y escribe aislamiento-out/seed.json
 *   pnpm exec tsx scripts/seed-aislamiento.ts barrido  → canario + conteo de filas de B + tabla.md
 *
 * Solo contra un Supabase LOCAL (credenciaisSupabaseDeTeste + anunciarDestino lo exigen).
 *
 * Actores:
 *   ORG_A: OA (admin con TOTP), AA (admin), VA (agent), WA (viewer)
 *   ORG_B: OB (admin con TOTP)            ← la víctima
 *   ORG_S: US (admin), suspendida          ← org suspendida con sesión y con token
 *   PS:    platform admin support_readonly, sin org
 *
 * Todo texto de B lleva `CANARIO-B-<uuid>`. Si un body que recibió un actor de
 * A/S/PS lo contiene, el barrido falla. Las contraseñas y tokens se generan acá
 * y salen en `secretos` para que el workflow los enmascare.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const OUT = process.env.AISLAMIENTO_OUT ?? "aislamiento-out";
const SEED = path.join(OUT, "seed.json");
const CANARIO = `CANARIO-B-${randomUUID()}`;

const cred = credenciaisSupabaseDeTeste();
anunciarDestino("seed-aislamiento", cred);
const admin = createClient(cred.url, cred.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Tablas de B que se cuentan antes y después. Ninguna puede cambiar. */
export const TABLAS_DE_B = [
  "contacts",
  "conversations",
  "messages",
  "crm_leads",
  "crm_lead_links",
  "crm_stages",
  "crm_pipelines",
  "channel_sessions",
  "webhook_sources",
  "user_organizations",
  "api_tokens",
] as const;

function totp(secretBase32: string, offset = 0): string {
  const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "").toUpperCase()) {
    const i = alfabeto.indexOf(c);
    if (i >= 0) bits += i.toString(2).padStart(5, "0");
  }
  const clave = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeUInt32BE(Math.floor(Date.now() / 1000 / 30) + offset, 4);
  const h = createHmac("sha1", clave).update(contador).digest();
  const o = h[h.length - 1]! & 0x0f;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

function must(
  r: { data: unknown; error: { message: string } | null },
  que: string,
): { id: string } {
  if (r.error || r.data === null || r.data === undefined)
    throw new Error(`${que}: ${r.error?.message ?? "sin datos"}`);
  return r.data as { id: string };
}

async function org(
  slug: string,
  nombre: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const previa = await admin.from("organizations").select("id").eq("slug", slug).maybeSingle();
  if (previa.data)
    throw new Error(`la org ${slug} ya existe: la semilla corre sobre una base recién creada`);
  const r = await admin
    .from("organizations")
    .insert({
      slug,
      display_name: nombre,
      legal_name: nombre,
      onboarded_at: new Date().toISOString(),
      ...extra,
    } as never)
    .select("id")
    .single();
  return must(r, `org ${slug}`).id as string;
}

async function usuario(email: string, password: string): Promise<string> {
  const r = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: email },
  });
  if (r.error || !r.data.user) throw new Error(`usuario ${email}: ${r.error?.message}`);
  return r.data.user.id;
}

async function miembro(userId: string, orgId: string, role: string): Promise<void> {
  const r = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role,
    accepted_at: new Date().toISOString(),
  } as never);
  if (r.error) throw new Error(`membresía ${role}: ${r.error.message}`);
}

async function enrolarTotp(email: string, password: string): Promise<string> {
  const c = createClient(cred.url, cred.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const s = await c.auth.signInWithPassword({ email, password });
  if (s.error) throw new Error(`login para TOTP ${email}: ${s.error.message}`);
  const e = await c.auth.mfa.enroll({ factorType: "totp", friendlyName: `aisl-${email}` });
  if (e.error || !e.data) throw new Error(`enroll ${email}: ${e.error?.message}`);
  const ch = await c.auth.mfa.challenge({ factorId: e.data.id });
  if (ch.error || !ch.data) throw new Error(`challenge ${email}: ${ch.error?.message}`);
  const v = await c.auth.mfa.verify({
    factorId: e.data.id,
    challengeId: ch.data.id,
    code: totp(e.data.totp.secret),
  });
  if (v.error) throw new Error(`verify ${email}: ${v.error.message}`);
  await c.auth.signOut();
  return e.data.totp.secret;
}

async function embudo(
  orgId: string,
  etiqueta: string,
): Promise<{ pipeline: string; stage: string }> {
  let p = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (!p.data) {
    p = await admin
      .from("crm_pipelines")
      .insert({ organization_id: orgId, name: `Embudo ${etiqueta}`, is_default: true } as never)
      .select("id")
      .single();
  }
  const pipeline = must(p, `embudo ${etiqueta}`).id as string;
  let s = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", pipeline)
    .order("position")
    .limit(1)
    .maybeSingle();
  if (!s.data) {
    s = await admin
      .from("crm_stages")
      .insert({
        organization_id: orgId,
        pipeline_id: pipeline,
        name: `Nuevo ${etiqueta}`,
        slug: "nuevo",
        position: 1,
      } as never)
      .select("id")
      .single();
  }
  return { pipeline, stage: must(s, `etapa ${etiqueta}`).id as string };
}

async function token(
  orgId: string,
  creador: string,
  scopes: string[],
): Promise<{ id: string; bearer: string }> {
  const prefix = `dsk_ais${randomBytes(3).toString("hex")}`;
  const bearer = `${prefix}_${randomBytes(32).toString("base64url")}`;
  const r = await admin
    .from("api_tokens")
    .insert({
      organization_id: orgId,
      created_by: creador,
      name: `aislamiento-${prefix}`,
      prefix,
      token_hash: `\\x${createHash("sha256").update(bearer).digest("hex")}`,
      scopes,
      expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
    } as never)
    .select("id")
    .single();
  return { id: must(r, "token").id as string, bearer };
}

/** Datos de una org: contacto, sesión de WhatsApp, conversación, mensaje con media, lead y webhook_source. */
async function datos(orgId: string, etiqueta: string, marca: string, dueno: string | null) {
  const { pipeline, stage } = await embudo(orgId, etiqueta);
  const tel = `+54911${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const contacto = must(
    await admin
      .from("contacts")
      .insert({
        organization_id: orgId,
        name: `Contacto ${marca}`,
        display_name: `Contacto ${marca}`,
        phone_number: tel,
        email: `${etiqueta.toLowerCase()}-${randomBytes(3).toString("hex")}@aisl.test`,
        source: "manual",
      } as never)
      .select("id")
      .single(),
    `contacto ${etiqueta}`,
  ).id as string;
  const contacto2 = must(
    await admin
      .from("contacts")
      .insert({ organization_id: orgId, name: `Duplicado ${marca}`, source: "manual" } as never)
      .select("id")
      .single(),
    `contacto2 ${etiqueta}`,
  ).id as string;
  const sesionNombre = `aisl_${etiqueta.toLowerCase()}_${randomBytes(4).toString("hex")}`;
  const sesion = must(
    await admin
      .from("channel_sessions")
      .insert({
        organization_id: orgId,
        waha_session_name: sesionNombre,
        webhook_secret_encrypted: "\\x00",
        display_name: `Sesión ${marca}`,
        status: "WORKING",
      } as never)
      .select("id")
      .single(),
    `sesión ${etiqueta}`,
  ).id as string;
  const conversacion = must(
    await admin
      .from("conversations")
      .insert({
        organization_id: orgId,
        contact_id: contacto,
        channel_session_id: sesion,
        last_message_preview: `Vista ${marca}`,
      } as never)
      .select("id")
      .single(),
    `conversación ${etiqueta}`,
  ).id as string;
  const mediaPath = `${orgId}/${conversacion}/${randomUUID()}.txt`;
  const up = await admin.storage
    .from("whatsapp-media")
    .upload(mediaPath, Buffer.from(`media ${marca}`), { contentType: "text/plain" });
  const mediaOk = !up.error;
  const mensaje = must(
    await admin
      .from("messages")
      .insert({
        organization_id: orgId,
        conversation_id: conversacion,
        channel_session_id: sesion,
        contact_id: contacto,
        type: mediaOk ? "document" : "text",
        direction: "inbound",
        body: `Mensaje ${marca}`,
        media_storage_path: mediaOk ? mediaPath : null,
        media_mime: mediaOk ? "text/plain" : null,
      } as never)
      .select("id")
      .single(),
    `mensaje ${etiqueta}`,
  ).id as string;
  const lead = must(
    await admin
      .from("crm_leads")
      .insert({
        organization_id: orgId,
        pipeline_id: pipeline,
        stage_id: stage,
        contact_id: contacto,
        title: `Lead ${marca}`,
        owner_user_id: dueno,
        value_cents: 123_400,
        currency: "ARS",
        source: "manual",
      } as never)
      .select("id")
      .single(),
    `lead ${etiqueta}`,
  ).id as string;
  const pathToken = randomBytes(16).toString("hex");
  const ws = await admin
    .from("webhook_sources")
    .insert({
      organization_id: orgId,
      name: `Fuente ${marca}`,
      path_token: pathToken,
      default_pipeline_id: pipeline,
      default_stage_id: stage,
    } as never)
    .select("id")
    .single();
  const lgpd = await admin.storage
    .from("lgpd-exports")
    .upload(`${orgId}/export-${randomUUID()}.json`, Buffer.from(`{"x":"${marca}"}`), {
      contentType: "application/json",
    });
  return {
    pipeline,
    stage,
    contacto,
    contacto2,
    sesion,
    sesion_nombre: sesionNombre,
    conversacion,
    mensaje,
    media_path: mediaOk ? mediaPath : null,
    media_error: up.error?.message ?? null,
    lead,
    webhook_source: (ws.data as { id: string } | null)?.id ?? null,
    webhook_source_error: ws.error?.message ?? null,
    path_token: pathToken,
    lgpd_export_error: lgpd.error?.message ?? null,
  };
}

async function contarB(orgB: string): Promise<Record<string, number>> {
  const conteo: Record<string, number> = {};
  for (const t of TABLAS_DE_B) {
    const r = await admin
      .from(t)
      .select("*", { count: "exact", head: true })
      .eq("organization_id", orgB);
    conteo[t] = r.error ? -1 : (r.count ?? 0);
  }
  for (const bucket of ["whatsapp-media", "lgpd-exports", "ai-policy"]) {
    conteo[`storage:${bucket}`] = await contarObjetos(bucket, orgB);
  }
  return conteo;
}

async function contarObjetos(bucket: string, prefijo: string): Promise<number> {
  let n = 0;
  const pendientes = [prefijo];
  while (pendientes.length) {
    const dir = pendientes.pop()!;
    const r = await admin.storage.from(bucket).list(dir, { limit: 1000 });
    if (r.error) return -1;
    for (const o of r.data ?? []) {
      if (o.id) n++;
      else pendientes.push(`${dir}/${o.name}`);
    }
  }
  return n;
}

async function sembrar(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const secretos: string[] = [];
  const pass = () => {
    const p = `Ais!${randomBytes(12).toString("base64url")}`;
    secretos.push(p);
    return p;
  };

  const orgA = await org(`aisl-a-${randomBytes(3).toString("hex")}`, "Aislamiento A", {
    settings: { security: { mfa_required: true } },
  });
  const orgB = await org(`aisl-b-${randomBytes(3).toString("hex")}`, `Org ${CANARIO}`);
  const orgS = await org(`aisl-s-${randomBytes(3).toString("hex")}`, "Aislamiento S suspendida");

  const u: Record<string, { id: string; email: string; password: string; totp?: string }> = {};
  for (const [k, email] of [
    ["OA", "aisl-oa@aisl.test"],
    ["AA", "aisl-aa@aisl.test"],
    ["VA", "aisl-va@aisl.test"],
    ["WA", "aisl-wa@aisl.test"],
    ["OB", "aisl-ob@aisl.test"],
    ["US", "aisl-us@aisl.test"],
    ["PS", "aisl-ps@aisl.test"],
  ] as const) {
    const password = pass();
    u[k] = { id: await usuario(email, password), email, password };
  }
  await miembro(u.OA!.id, orgA, "admin");
  await miembro(u.AA!.id, orgA, "admin");
  await miembro(u.VA!.id, orgA, "agent");
  await miembro(u.WA!.id, orgA, "viewer");
  await miembro(u.OB!.id, orgB, "admin");
  await miembro(u.US!.id, orgS, "admin");
  u.OA!.totp = await enrolarTotp(u.OA!.email, u.OA!.password);
  u.OB!.totp = await enrolarTotp(u.OB!.email, u.OB!.password);
  secretos.push(u.OA!.totp, u.OB!.totp);

  const pa = await admin.from("platform_admins").insert({
    user_id: u.PS!.id,
    granted_by: u.OA!.id,
    scope: "support_readonly",
    reason: "gate de aislamiento",
    mfa_required: true,
  } as never);
  if (pa.error) throw new Error(`platform_admins: ${pa.error.message}`);

  const a = await datos(orgA, "A", "de A", u.AA!.id);
  const b = await datos(orgB, "B", CANARIO, u.OB!.id);
  const s = await datos(orgS, "S", "de S", u.US!.id);
  const lgpdB = await admin.storage
    .from("ai-policy")
    .upload(`${orgB}/politica-${randomUUID()}.txt`, Buffer.from(CANARIO), {
      contentType: "text/plain",
    });

  const tA = await token(orgA, u.OA!.id, [
    "mcp:read",
    "mcp:write",
    "prospectos:write",
    "role:admin",
  ]);
  const tB = await token(orgB, u.OB!.id, ["mcp:read", "mcp:write"]);
  const tS = await token(orgS, u.US!.id, ["mcp:read", "mcp:write", "prospectos:write"]);
  // Token de un admin que después se degrada a viewer: tiene que dejar de servir como admin.
  const tAA = await token(orgA, u.AA!.id, ["mcp:read", "mcp:write", "role:admin"]);
  secretos.push(tA.bearer, tB.bearer, tS.bearer, tAA.bearer);

  // Formulario público de A (captar, #21). En commits sin la tabla queda en null y la sonda dice NO MEDIDO.
  const slugA = randomBytes(6).toString("hex");
  const form = await admin
    .from("capture_forms")
    .insert({
      organization_id: orgA,
      slug: slugA,
      name: "Formulario A",
      fields: [{ id: "telefono", label: "Teléfono", tipo: "telefono", requerido: true }],
      pipeline_id: a.pipeline,
      stage_id: a.stage,
      consent_text: "Acepto",
      webhook_source_id: a.webhook_source,
    } as never)
    .select("id")
    .single();

  // Se suspende DESPUÉS de sembrar: algunos triggers rechazan escrituras en una org suspendida.
  const susp = await admin
    .from("organizations")
    .update({
      status: "suspended",
      suspended_at: new Date().toISOString(),
      suspended_reason: "gate de aislamiento",
    } as never)
    .eq("id", orgS);
  if (susp.error) throw new Error(`suspender S: ${susp.error.message}`);

  const seed = {
    canario: CANARIO,
    orgs: { A: orgA, B: orgB, S: orgS },
    usuarios: u,
    tokens: { A: tA, B: tB, S: tS, AA: tAA },
    captar_slug_a: form.error ? null : slugA,
    captar_error: form.error?.message ?? null,
    datos: { A: a, B: b, S: s },
    ai_policy_b_error: lgpdB.error?.message ?? null,
    conteo_b_antes: await contarB(orgB),
    secretos,
  };
  fs.writeFileSync(SEED, JSON.stringify(seed, null, 2));
  const avisos = [a, b, s]
    .flatMap((d) => [d.media_error, d.webhook_source_error, d.lgpd_export_error])
    .filter(Boolean);
  console.info(`[seed-aislamiento] A=${orgA} B=${orgB} S=${orgS} avisos=${JSON.stringify(avisos)}`);
}

interface Fila {
  bloque: string;
  objetivo: string;
  esperado: string;
  obtenido: string;
  ok: boolean;
}

async function barrido(): Promise<void> {
  const seed = JSON.parse(fs.readFileSync(SEED, "utf8")) as {
    canario: string;
    orgs: { B: string };
    conteo_b_antes: Record<string, number>;
  };
  const filas: Fila[] = fs.existsSync(path.join(OUT, "resultados.ndjson"))
    ? fs
        .readFileSync(path.join(OUT, "resultados.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Fila)
    : [];

  const respuestas = fs.existsSync(path.join(OUT, "respuestas.ndjson"))
    ? fs.readFileSync(path.join(OUT, "respuestas.ndjson"), "utf8").split("\n").filter(Boolean)
    : [];
  const conCanario = respuestas.filter((l) => l.includes("CANARIO-B-"));
  filas.push({
    bloque: "barrido",
    objetivo: `canario en ${respuestas.length} respuestas a actores de A/S/PS`,
    esperado: "0",
    obtenido:
      String(conCanario.length) +
      (conCanario.length
        ? ` (${conCanario
            .map((l) => (JSON.parse(l) as { objetivo: string }).objetivo)
            .slice(0, 8)
            .join("; ")})`
        : ""),
    ok: respuestas.length > 0 && conCanario.length === 0,
  });

  const despues = await contarB(seed.orgs.B);
  for (const [t, antes] of Object.entries(seed.conteo_b_antes)) {
    filas.push({
      bloque: "barrido",
      objetivo: `filas de B en ${t}`,
      esperado: String(antes),
      obtenido: String(despues[t]),
      ok: antes === despues[t],
    });
  }

  const sinSpec = filas.filter((f) => f.bloque !== "barrido").length === 0;
  const tabla = [
    `### Aislamiento entre orgs (${process.env.PROXY ?? "?"}) · ${process.env.OBJETIVO_SHA?.slice(0, 7) ?? process.env.GITHUB_SHA?.slice(0, 7) ?? "local"}`,
    "",
    sinSpec ? "**La spec no dejó resultados: NO MEDIDO.**\n" : "",
    "| bloque | objetivo | esperado | obtenido | |",
    "|---|---|---|---|---|",
    ...filas.map(
      (f) =>
        `| ${f.bloque} | ${f.objetivo} | ${f.esperado} | ${f.obtenido.replace(/\|/g, "\\|").slice(0, 160)} | ${f.ok ? "✅" : "❌"} |`,
    ),
    "",
    `Rojos: ${filas.filter((f) => !f.ok).length} de ${filas.length}.`,
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "tabla.md"), tabla);
  console.info(tabla);

  const malas = filas.filter((f) => f.bloque === "barrido" && !f.ok);
  if (malas.length || sinSpec) process.exit(1);
}

void (process.argv[2] === "barrido" ? barrido() : sembrar()).catch((err) => {
  console.error(err);
  process.exit(1);
});

export type { SupabaseClient };
