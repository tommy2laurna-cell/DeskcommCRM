import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { clasificarContacto, telefonoParaMeta } from "@/lib/campaigns/destinatarios";
import { procesarLote, type CampanaEnCurso, type DepsDeEnvio } from "@/lib/campaigns/procesar";
import { recorrerLista } from "@/lib/campaigns/vista-previa";
import { filtrosDeListaSchema } from "@/lib/smart-lists/resolver";
import { sql } from "./gov-helpers";

/**
 * Jornada de campañas contra un Postgres REAL (el del job `invariants-majors`):
 * lista inteligente -> confirmar -> envío escalonado. Lo que se prueba es la
 * promesa del producto: quien registró la baja NO recibe, ni por haberla
 * registrado antes de confirmar, ni por haberla registrado DESPUÉS.
 *
 * Lo que corre de verdad: `fn_smart_list_contacts`, las tablas y constraints de
 * 0278/0279, `recorrerLista`, `clasificarContacto` (las mismas funciones que usa la
 * ruta `confirm`) y `procesarLote`. Lo único falso es (a) el envío, que anota los
 * teléfonos en vez de llamar a Meta, y (b) el cliente, un traductor mínimo de la
 * API de PostgREST a SQL (mismo método que `webhooks-bulk-events.test.ts`).
 *
 * Org propia ('abababab-'), semilla idempotente.
 */

const ORG = "abababab-0000-4000-8000-000000000001";
const LISTA = "abababab-0000-4000-8000-0000000000a1";
const CAMP = "abababab-0000-4000-8000-0000000000c1";
const ETIQUETA = "camp-inv";
const C = (n: number) => `abababab-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const TEL = (n: number) => `+5491177700${String(n).padStart(2, "0")}`;

// 1 y 2 normales; 3 con baja registrada; 4 bloqueado; 5 normal que pide la baja
// DESPUÉS de confirmar; 6 sin teléfono.
const N1 = 1, N2 = 2, BAJA = 3, BLOQ = 4, TARDE = 5, SIN_TEL = 6;

function lit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    const uuid = v.every((x) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x));
    return `ARRAY[${v.map((x) => lit(x)).join(",")}]::${uuid ? "uuid" : "text"}[]`;
  }
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** `a.eq.x,and(b.eq.y,c.lt.3)` -> SQL. Cubre lo que usa `procesarLote`. */
function orASql(expr: string): string {
  const partes: string[] = [];
  let prof = 0;
  let ini = 0;
  for (let i = 0; i <= expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") prof++;
    if (ch === ")") prof--;
    if ((ch === "," && prof === 0) || i === expr.length) {
      partes.push(expr.slice(ini, i));
      ini = i + 1;
    }
  }
  const sqls = partes.map((p) => {
    const and = /^and\((.*)\)$/.exec(p);
    if (and) return `(${orASql(and[1]!).split(" or ").join(" and ")})`;
    const [col, op, ...resto] = p.split(".");
    const val = resto.join(".");
    if (op === "is" && val === "null") return `${col} is null`;
    const sym = op === "eq" ? "=" : op === "lt" ? "<" : op === "gt" ? ">" : null;
    if (!sym) throw new Error(`or() no soportado: ${p}`);
    return `${col} ${sym} ${/^\d+$/.test(val) ? val : lit(val)}`;
  });
  return `(${sqls.join(" or ")})`;
}

type Res = { data: unknown; error: { message: string } | null; count?: number };

class QB implements PromiseLike<Res> {
  private modo: "select" | "update" | "upsert" = "select";
  private cols = "*";
  private contar = false;
  private filtros: string[] = [];
  private orden = "";
  private tope: number | null = null;
  private cambios: Record<string, unknown> = {};
  private filas: Record<string, unknown>[] = [];
  private conflicto = "";
  private devolver = false;
  private uno = false;

  constructor(private fuente: string) {}

  select(cols = "*", opts?: { count?: string; head?: boolean }): this {
    if (this.modo === "update") this.devolver = true;
    this.cols = cols;
    if (opts?.head) this.contar = true;
    return this;
  }
  update(c: Record<string, unknown>): this {
    this.modo = "update";
    this.cambios = c;
    return this;
  }
  upsert(f: Record<string, unknown>[], o: { onConflict: string }): this {
    this.modo = "upsert";
    this.filas = f;
    this.conflicto = o.onConflict;
    return this;
  }
  eq(c: string, v: unknown): this {
    this.filtros.push(`${c} = ${lit(v)}`);
    return this;
  }
  lt(c: string, v: unknown): this {
    this.filtros.push(`${c} < ${lit(v)}`);
    return this;
  }
  gt(c: string, v: unknown): this {
    this.filtros.push(`${c} > ${lit(v)}`);
    return this;
  }
  in(c: string, v: unknown[]): this {
    this.filtros.push(`${c} = ANY(${lit(v)})`);
    return this;
  }
  or(e: string): this {
    this.filtros.push(orASql(e));
    return this;
  }
  order(c: string, o: { ascending: boolean }): this {
    this.orden = ` order by ${c} ${o.ascending ? "asc" : "desc"}`;
    return this;
  }
  limit(n: number): this {
    this.tope = n;
    return this;
  }
  maybeSingle(): this {
    this.uno = true;
    return this;
  }

  private where(): string {
    return this.filtros.length ? ` where ${this.filtros.join(" and ")}` : "";
  }

  private async ejecutar(): Promise<Res> {
    try {
      const w = this.where();
      if (this.modo === "upsert") {
        const cols = Object.keys(this.filas[0]!);
        const vals = this.filas.map((f) => `(${cols.map((c) => lit(f[c])).join(",")})`).join(",");
        sql(
          `insert into ${this.fuente} (${cols.join(",")}) values ${vals} on conflict (${this.conflicto}) do nothing;`,
        );
        return { data: null, error: null };
      }
      if (this.modo === "update") {
        const set = Object.entries(this.cambios).map(([k, v]) => `${k} = ${lit(v)}`).join(", ");
        if (!this.devolver) {
          sql(`update ${this.fuente} set ${set}${w};`);
          return { data: null, error: null };
        }
        const out = sql(
          `with u as (update ${this.fuente} set ${set}${w} returning ${this.cols}) select coalesce(json_agg(u),'[]') from u;`,
        );
        const filas = JSON.parse(out || "[]") as unknown[];
        return { data: this.uno ? (filas[0] ?? null) : filas, error: null };
      }
      if (this.contar) {
        const out = sql(`select count(*) from ${this.fuente}${w};`);
        return { data: null, error: null, count: Number(out) };
      }
      const lim = this.tope !== null ? ` limit ${this.tope}` : "";
      const out = sql(
        `select coalesce(json_agg(t),'[]') from (select ${this.cols} from ${this.fuente} c${w}${this.orden}${lim}) t;`,
      );
      const filas = JSON.parse(out || "[]") as unknown[];
      return { data: this.uno ? (filas[0] ?? null) : filas, error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  then<A = Res, B = never>(
    ok?: ((v: Res) => A | PromiseLike<A>) | null,
    ko?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.ejecutar().then(ok, ko);
  }
}

const admin = {
  from: (tabla: string) => new QB(`public.${tabla}`),
  rpc: (nombre: string, args: Record<string, unknown>) => {
    const named = Object.entries(args)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k} => ${lit(v)}`)
      .join(", ");
    return new QB(`public.${nombre}(${named})`);
  },
} as unknown as SupabaseClient;

const enviados: string[] = [];
const deps: DepsDeEnvio = {
  ahora: () => new Date(),
  esperar: async () => {},
  puedeEnviar: async () => true,
  enviar: async ({ para }) => {
    enviados.push(para);
    return `sim:${para}`;
  },
};

const CAMPANA: CampanaEnCurso = {
  id: CAMP,
  organization_id: ORG,
  channel_session_id: "sesion-de-prueba",
  session_ref: "123456",
  template_name: "promo_inv",
  template_language: "es_AR",
  template_values: {},
};

function estado(n: number): string {
  return sql(
    `select status from public.campaign_recipients where campaign_id = '${CAMP}' and contact_id = '${C(n)}';`,
  );
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'gov-inv-campanas', 'Gov Invariant Campanas', 'Gov Inv Campanas')
      on conflict do nothing;
    insert into public.contacts (id, organization_id, name, phone_number, tags, consent, is_blocked)
      values
        ('${C(N1)}', '${ORG}', 'Normal 1', '${TEL(N1)}', ARRAY['${ETIQUETA}'], default, false),
        ('${C(N2)}', '${ORG}', 'Normal 2', '${TEL(N2)}', ARRAY['${ETIQUETA}'], default, false),
        ('${C(BAJA)}', '${ORG}', 'Con baja', '${TEL(BAJA)}', ARRAY['${ETIQUETA}'],
           '{"marketing":{"granted_at":null,"declined_at":"2026-11-01T00:00:00Z"}}'::jsonb, false),
        ('${C(BLOQ)}', '${ORG}', 'Bloqueado', '${TEL(BLOQ)}', ARRAY['${ETIQUETA}'], default, true),
        ('${C(TARDE)}', '${ORG}', 'Baja tardía', '${TEL(TARDE)}', ARRAY['${ETIQUETA}'], default, false),
        ('${C(SIN_TEL)}', '${ORG}', 'Sin teléfono', null, ARRAY['${ETIQUETA}'], default, false)
      on conflict do nothing;
    insert into public.smart_lists (id, organization_id, name, filters)
      values ('${LISTA}', '${ORG}', 'Inv campañas', '{"etiquetas":["${ETIQUETA}"]}'::jsonb)
      on conflict do nothing;
    delete from public.campaigns where id = '${CAMP}';
    insert into public.campaigns
      (id, organization_id, list_id, name, template_name, template_language,
       template_category, status)
      values ('${CAMP}', '${ORG}', '${LISTA}', 'Inv campaña', 'promo_inv', 'es_AR',
              'marketing', 'confirmada');
  `);
});

describe("campañas: la baja registrada deja al contacto afuera (Postgres real)", () => {
  it("la lista inteligente resuelve los 6 contactos por etiqueta", async () => {
    const filtros = filtrosDeListaSchema.parse({ etiquetas: [ETIQUETA] });
    const vistos: string[] = [];
    await recorrerLista(admin, ORG, filtros, async (cs) => void vistos.push(...cs.map((c) => c.id)));
    expect(vistos.sort()).toEqual([N1, N2, BAJA, BLOQ, TARDE, SIN_TEL].map(C).sort());
  });

  it("al confirmar, la baja y el bloqueado nacen excluidos y el resto pendiente", async () => {
    const filtros = filtrosDeListaSchema.parse({ etiquetas: [ETIQUETA] });
    await recorrerLista(admin, ORG, filtros, async (contactos) => {
      const filas = contactos.map((ct) => {
        const v = clasificarContacto(ct);
        return {
          campaign_id: CAMP,
          organization_id: ORG,
          contact_id: ct.id,
          status: v.estado,
          reason: v.estado === "pendiente" ? null : v.motivo,
        };
      });
      const { error } = await admin
        .from("campaign_recipients")
        .upsert(filas, { onConflict: "campaign_id,contact_id" });
      expect(error).toBeNull();
    });
    expect(estado(BAJA)).toBe("excluido_optout");
    expect(estado(BLOQ)).toBe("excluido_optout");
    expect(estado(SIN_TEL)).toBe("excluido_sin_telefono");
    expect([estado(N1), estado(N2), estado(TARDE)]).toEqual(["pendiente", "pendiente", "pendiente"]);
  });

  it("quien pide la baja DESPUÉS de confirmar tampoco recibe (se revalúa antes de enviar)", async () => {
    sql(`
      update public.contacts
         set consent = '{"marketing":{"granted_at":null,"declined_at":"2026-11-13T00:00:00Z"}}'::jsonb
       where id = '${C(TARDE)}';
    `);
    const r = await procesarLote(admin, CAMPANA, deps);

    expect(r.enviados).toBe(2);
    expect(enviados.sort()).toEqual([N1, N2].map((n) => telefonoParaMeta(TEL(n))).sort());
    for (const n of [BAJA, BLOQ, TARDE, SIN_TEL]) {
      expect(enviados).not.toContain(telefonoParaMeta(TEL(n)));
    }
    expect(estado(N1)).toBe("enviado");
    expect(estado(N2)).toBe("enviado");
    expect(estado(TARDE)).toBe("excluido_optout");
    expect(estado(BAJA)).toBe("excluido_optout");
  });

  it("la campaña queda completada con sus totales", () => {
    expect(
      sql(`select status || ',' || total_sent || ',' || total_excluded from public.campaigns where id = '${CAMP}';`),
    ).toBe("completada,2,4");
  });

  it("reintento idempotente: un segundo lote no reenvía a nadie", async () => {
    const antes = enviados.length;
    await procesarLote(admin, CAMPANA, deps);
    expect(enviados).toHaveLength(antes);
    expect(
      sql(`select count(*) from public.campaign_recipients where campaign_id = '${CAMP}' and status = 'enviado';`),
    ).toBe("2");
  });
});
