/**
 * Utilidades del gate de aislamiento: sesiones reales (cookie de @supabase/ssr,
 * la misma que lee el app), JWT para PostgREST, llamadas a server actions por
 * su id y registro de cada sonda.
 */
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const OUT = process.env.AISLAMIENTO_OUT ?? "aislamiento-out";
export const BASE = process.env.AISLAMIENTO_BASE_URL ?? "http://localhost:3000";
export const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export interface Usuario {
  id: string;
  email: string;
  password: string;
  totp?: string;
}
export interface Datos {
  pipeline: string;
  stage: string;
  contacto: string;
  contacto2: string;
  sesion: string;
  sesion_nombre: string;
  conversacion: string;
  mensaje: string;
  media_path: string | null;
  lead: string;
  webhook_source: string | null;
  path_token: string;
}
export interface Seed {
  canario: string;
  orgs: { A: string; B: string; S: string };
  usuarios: Record<"OA" | "AA" | "VA" | "WA" | "OB" | "US" | "PS", Usuario>;
  tokens: Record<"A" | "B" | "S" | "AA", { id: string; bearer: string }>;
  captar_slug_a: string | null;
  datos: Record<"A" | "B" | "S", Datos>;
}

export function leerSeed(): Seed {
  return JSON.parse(fs.readFileSync(path.join(OUT, "seed.json"), "utf8")) as Seed;
}

export const service = (): SupabaseClient =>
  createClient(SUPA_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

/** Una fila de la tabla «objetivo | esperado | obtenido». */
export interface Resultado {
  bloque: string;
  objetivo: string;
  esperado: string;
  obtenido: string;
  ok: boolean;
}

export function registrar(r: Resultado, body?: unknown): Resultado {
  fs.mkdirSync(OUT, { recursive: true });
  fs.appendFileSync(path.join(OUT, "resultados.ndjson"), JSON.stringify(r) + "\n");
  if (body !== undefined) {
    const texto = typeof body === "string" ? body : JSON.stringify(body);
    fs.appendFileSync(
      path.join(OUT, "respuestas.ndjson"),
      JSON.stringify({ objetivo: `${r.bloque}: ${r.objetivo}`, body: texto.slice(0, 20_000) }) +
        "\n",
    );
  }
  return r;
}

export function totp(secretBase32: string): string {
  const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "").toUpperCase()) {
    const i = alfabeto.indexOf(c);
    if (i >= 0) bits += i.toString(2).padStart(5, "0");
  }
  const clave = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeUInt32BE(Math.floor(Date.now() / 1000 / 30), 4);
  const h = createHmac("sha1", clave).update(contador).digest();
  const o = h[h.length - 1]! & 0x0f;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

/** Sesión real: JWT (para PostgREST) y el header Cookie que manda el navegador. */
export interface Sesion {
  jwt: string;
  cookie: string;
  db: SupabaseClient;
}

export async function entrar(
  u: Usuario,
  opciones: { aal2?: boolean; activeOrg?: string } = {},
): Promise<Sesion> {
  const jar = new Map<string, string>();
  const ssr = createServerClient(SUPA_URL, ANON, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cs) =>
        cs.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
    cookieOptions: { name: "sb-deskcomm-auth", path: "/" },
  });
  const r = await ssr.auth.signInWithPassword({ email: u.email, password: u.password });
  if (r.error) throw new Error(`login ${u.email}: ${r.error.message}`);
  if (opciones.aal2) {
    if (!u.totp) throw new Error(`${u.email} no tiene TOTP`);
    const f = await ssr.auth.mfa.listFactors();
    const factor = f.data?.totp?.[0];
    if (!factor) throw new Error(`${u.email}: sin factor`);
    const v = await ssr.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(u.totp) });
    if (v.error) throw new Error(`aal2 ${u.email}: ${v.error.message}`);
  }
  const s = await ssr.auth.getSession();
  const jwt = s.data.session?.access_token ?? "";
  if (opciones.activeOrg) jar.set("active_org", opciones.activeOrg);
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const db = createClient(SUPA_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  return { jwt, cookie, db };
}

export const anonDb = (): SupabaseClient =>
  createClient(SUPA_URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

export interface Http {
  status: number;
  location: string | null;
  texto: string;
}

export async function http(
  metodo: string,
  ruta: string,
  op: { cookie?: string; bearer?: string; json?: unknown; headers?: Record<string, string> } = {},
): Promise<Http> {
  const headers: Record<string, string> = { ...(op.headers ?? {}) };
  if (op.cookie) headers.cookie = op.cookie;
  if (op.bearer) headers.authorization = `Bearer ${op.bearer}`;
  if (op.json !== undefined) headers["content-type"] = "application/json";
  if (metodo !== "GET") headers.origin = BASE;
  const res = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers,
    body: op.json !== undefined ? JSON.stringify(op.json) : undefined,
    redirect: "manual",
  });
  return {
    status: res.status,
    location: res.headers.get("location"),
    texto: await res.text().catch(() => ""),
  };
}

/** Ids de las server actions: del manifest de la imagen, con respaldo en los chunks del cliente. */
let idsCache: Map<string, string> | null = null;
export function idDeAccion(nombre: string, archivo: string): string | null {
  if (!idsCache) {
    idsCache = new Map();
    const manifest = path.join(OUT, "server-actions.json");
    if (fs.existsSync(manifest)) {
      const m = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
        node?: Record<string, { exportedName?: string; filename?: string }>;
      };
      for (const [id, e] of Object.entries(m.node ?? {})) {
        if (e.exportedName) idsCache.set(`${e.filename ?? ""}#${e.exportedName}`, id);
      }
    }
    const chunks = process.env.NEXT_CHUNKS_DIR;
    if (chunks && fs.existsSync(chunks)) {
      const re = /createServerReference\)?\(\s*"([0-9a-f]{40,})"[^)]*?"([A-Za-z0-9_$]+)"\s*\)/g;
      const pila = [chunks];
      while (pila.length) {
        const d = pila.pop()!;
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) pila.push(p);
          else if (f.name.endsWith(".js")) {
            for (const m of fs.readFileSync(p, "utf8").matchAll(re))
              idsCache.set(`?#${m[2]}`, m[1]!);
          }
        }
      }
    }
  }
  for (const [k, id] of idsCache) {
    const [f, n] = k.split("#");
    if (n === nombre && (f === "?" || f!.includes(archivo))) return id;
  }
  return null;
}

/** Llama una server action como lo hace el navegador (POST con Next-Action). */
export async function accion(
  cookie: string,
  id: string,
  args: unknown[],
  pagina = "/app",
): Promise<Http> {
  const res = await fetch(`${BASE}${pagina}`, {
    method: "POST",
    headers: {
      cookie,
      origin: BASE,
      accept: "text/x-component",
      "next-action": id,
      "content-type": "text/plain;charset=UTF-8",
    },
    body: JSON.stringify(args),
    redirect: "manual",
  });
  return {
    status: res.status,
    location: res.headers.get("location"),
    texto: await res.text().catch(() => ""),
  };
}

/** JSON-RPC al MCP HTTP. Devuelve el texto crudo (JSON o SSE) y el resultado parseado. */
export async function mcp(
  bearer: string,
  method: string,
  params: unknown,
): Promise<{ status: number; texto: string; json: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const texto = await res.text();
  const linea = texto.split("\n").find((l) => l.startsWith("data:"));
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(linea ? linea.slice(5).trim() : texto) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, texto, json };
}

export const resumen = (s: string, n = 120) => s.replace(/\s+/g, " ").slice(0, n);
