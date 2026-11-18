/**
 * Gate de aislamiento entre organizaciones (auditoría 2026-11-14, seguridad.md § 3).
 *
 * Un atacante con usuarios en A (y en una org suspendida S, y un platform admin
 * de solo lectura) intenta leer y escribir datos de B por PostgREST, la API
 * HTTP del app, las server actions y el MCP HTTP. Cada sonda deja una fila
 * «objetivo | esperado | obtenido» en aislamiento-out/resultados.ndjson y cada
 * body recibido en respuestas.ndjson; el barrido (scripts/seed-aislamiento.ts
 * barrido) busca el canario de B y compara los conteos de filas de B.
 *
 * Un bloque falla si alguna de sus sondas no dio lo esperado, pero corre todas:
 * la tabla tiene que mostrar el estado completo, no el primer rojo.
 */
import { expect, test } from "@playwright/test";

import {
  BASE,
  accion,
  anonDb,
  entrar,
  http,
  idDeAccion,
  leerSeed,
  mcp,
  registrar,
  resumen,
  service,
  type Resultado,
  type Seed,
  type Sesion,
} from "./_lib";

let seed: Seed;
const PROXY = process.env.PROXY ?? "directo";

interface Salida {
  obtenido: string;
  ok: boolean;
  body?: unknown;
}

async function sondas(
  bloque: string,
  lista: [string, string, () => Promise<Salida>][],
): Promise<Resultado[]> {
  const out: Resultado[] = [];
  for (const [objetivo, esperado, fn] of lista) {
    let s: Salida;
    try {
      s = await fn();
    } catch (err) {
      s = {
        obtenido: `error de la sonda: ${resumen(err instanceof Error ? err.message : String(err))}`,
        ok: false,
      };
    }
    out.push(registrar({ bloque, objetivo, esperado, obtenido: s.obtenido, ok: s.ok }, s.body));
  }
  return out;
}

const rojos = (rs: Resultado[]) =>
  rs.filter((r) => !r.ok).map((r) => `${r.objetivo}: ${r.obtenido}`);

/** Respuesta de PostgREST: «denegado» = error o 0 filas. */
function negado(r: { data: unknown; error: { code?: string; message: string } | null }): Salida {
  const filas = Array.isArray(r.data) ? r.data.length : r.data ? 1 : 0;
  if (r.error)
    return {
      obtenido: `${r.error.code ?? "error"} ${resumen(r.error.message, 60)}`,
      ok: true,
      body: r.error,
    };
  return { obtenido: `${filas} filas`, ok: filas === 0, body: r.data };
}

/** RPC: solo vale el rechazo explícito (42501 / permission denied). */
function rpcRechazada(r: {
  data: unknown;
  error: { code?: string; message: string } | null;
}): Salida {
  if (r.error) {
    const ok =
      r.error.code === "42501" ||
      /permission|denied|forbidden|not allowed|not_authorized|negad/i.test(r.error.message);
    return {
      obtenido: `${r.error.code ?? "?"} ${resumen(r.error.message, 60)}`,
      ok,
      body: r.error,
    };
  }
  return { obtenido: `sin error: ${resumen(JSON.stringify(r.data), 80)}`, ok: false, body: r.data };
}

const status = (h: { status: number; texto: string }, permitidos: number[]): Salida => ({
  obtenido: `${h.status} ${resumen(h.texto, 80)}`,
  ok: permitidos.includes(h.status),
  body: h.texto,
});

// Sin `.serial`: un bloque rojo no puede saltear los demás (la tabla tiene que estar completa).
// workers: 1 y fullyParallel: false mantienen el orden; el último test es el único que muta roles.
test.describe.configure({ mode: "default" });
test.describe("aislamiento entre organizaciones", () => {
  let OA: Sesion, OA1: Sesion, VA: Sesion, WA: Sesion, PS: Sesion, US: Sesion;

  test.beforeAll(async () => {
    seed = leerSeed();
    const u = seed.usuarios;
    OA = await entrar(u.OA, { aal2: true });
    OA1 = await entrar(u.OA);
    VA = await entrar(u.VA);
    WA = await entrar(u.WA);
    PS = await entrar(u.PS);
    US = await entrar(u.US);
  });

  test("PostgREST (JWT de A y anon key)", async () => {
    const B = seed.datos.B;
    const A = seed.datos.A;
    const oB = seed.orgs.B;
    const sv = service();
    const rs = await sondas("postgrest", [
      // Lecturas directas de B con el JWT de A.
      ...(
        [
          "contacts",
          "conversations",
          "messages",
          "crm_leads",
          "channel_sessions",
          "webhook_sources",
          "crm_stages",
          "api_tokens",
        ] as const
      ).map(
        (t) =>
          [
            `SELECT ${t} de B como VA`,
            "0 filas",
            async () => negado(await VA.db.from(t).select("*").eq("organization_id", oB)),
          ] as [string, string, () => Promise<Salida>],
      ),
      [
        "SELECT contacts de B como anon",
        "0 filas",
        async () => negado(await anonDb().from("contacts").select("*").eq("organization_id", oB)),
      ],
      // 1-rls § 7: contacts cruzado.
      [
        "UPDATE contacts de B como VA",
        "0 filas",
        async () =>
          negado(
            await VA.db
              .from("contacts")
              .update({ name: "pisado" })
              .eq("id", B.contacto)
              .select("id"),
          ),
      ],
      [
        "INSERT contacts en B como VA",
        "denegado",
        async () =>
          negado(
            await VA.db
              .from("contacts")
              .insert({ organization_id: oB, name: "intruso" })
              .select("id"),
          ),
      ],
      // 1-rls § 3 y § 4: escrituras en padres de B.
      [
        "INSERT messages en conversación de B (F3)",
        "denegado",
        async () =>
          negado(
            await VA.db
              .from("messages")
              .insert({
                organization_id: seed.orgs.A,
                conversation_id: B.conversacion,
                channel_session_id: A.sesion,
                contact_id: A.contacto,
                type: "text",
                direction: "inbound",
                body: "probe",
              })
              .select("id"),
          ),
      ],
      [
        "INSERT crm_lead_links en lead de B (F3)",
        "denegado",
        async () =>
          negado(
            await VA.db
              .from("crm_lead_links")
              .insert({
                organization_id: seed.orgs.A,
                lead_id: B.lead,
                target_kind: "conversation",
                target_id: A.conversacion,
                link_kind: "probe",
              })
              .select("id"),
          ),
      ],
      // 1-rls § 8.
      [
        "INSERT conversations en B como VA",
        "denegado",
        async () =>
          negado(
            await VA.db
              .from("conversations")
              .insert({ organization_id: oB, contact_id: B.contacto, channel_session_id: B.sesion })
              .select("id"),
          ),
      ],
      [
        "INSERT conversations de A con contacto de B, y GET /conversations/<id>",
        "denegado, o la ficha no muestra a B",
        async () => {
          const r = await VA.db
            .from("conversations")
            .insert({
              organization_id: seed.orgs.A,
              contact_id: B.contacto,
              channel_session_id: A.sesion,
            })
            .select("id")
            .maybeSingle();
          if (r.error || !r.data)
            return { obtenido: `denegado ${r.error?.code ?? ""}`, ok: true, body: r.error };
          const id = (r.data as { id: string }).id;
          const h = await http("GET", `/api/v1/conversations/${id}`, { cookie: OA.cookie });
          await sv.from("conversations").delete().eq("id", id);
          return {
            obtenido: `aceptado (sin FK compuesta); GET ${h.status}`,
            ok: !h.texto.includes(seed.canario),
            body: h.texto,
          };
        },
      ],
      // 1-rls § 6.
      [
        "INSERT user_organizations: OA se mete en B",
        "denegado",
        async () =>
          negado(
            await OA.db
              .from("user_organizations")
              .insert({ user_id: seed.usuarios.OA.id, organization_id: oB, role: "admin" })
              .select("user_id"),
          ),
      ],
      [
        "UPDATE user_organizations: OA mueve su fila a B",
        "0 filas",
        async () =>
          negado(
            await OA.db
              .from("user_organizations")
              .update({ organization_id: oB })
              .eq("user_id", seed.usuarios.OA.id)
              .eq("organization_id", seed.orgs.A)
              .select("user_id"),
          ),
      ],
      // 1-rls § 9: RPC SECURITY DEFINER con p_org = B.
      [
        "rpc emit_event p_org=B como VA",
        "42501",
        async () =>
          rpcRechazada(
            await VA.db.rpc("emit_event", {
              p_event_type: "lead.created",
              p_entity_kind: "lead",
              p_entity_id: null,
              p_organization_id: oB,
            }),
          ),
      ],
      [
        "rpc emit_event p_org=B como anon",
        "42501",
        async () =>
          rpcRechazada(
            await anonDb().rpc("emit_event", {
              p_event_type: "lead.created",
              p_entity_kind: "lead",
              p_entity_id: null,
              p_organization_id: oB,
            }),
          ),
      ],
      [
        "rpc retrieve_top_k_chunks p_org=B como VA",
        "42501",
        async () =>
          rpcRechazada(
            await VA.db.rpc("retrieve_top_k_chunks", {
              p_organization_id: oB,
              p_kb_version_id: B.pipeline,
              p_embedding: `[${new Array(1536).fill(0).join(",")}]`,
            }),
          ),
      ],
      [
        "rpc fn_mesclar_contatos en B como VA",
        "42501",
        async () =>
          rpcRechazada(
            await VA.db.rpc("fn_mesclar_contatos", {
              p_organization_id: oB,
              p_contato_principal: B.contacto,
              p_contatos_secundarios: [B.contacto2],
            }),
          ),
      ],
      [
        "rpc fn_mesclar_contatos en B como anon",
        "42501",
        async () =>
          rpcRechazada(
            await anonDb().rpc("fn_mesclar_contatos", {
              p_organization_id: oB,
              p_contato_principal: B.contacto,
              p_contatos_secundarios: [B.contacto2],
            }),
          ),
      ],
      [
        "rpc fn_lgpd_anonymize_contact en B como OA (aal2)",
        "42501 y el contacto de B intacto",
        async () => {
          const r = await OA.db.rpc("fn_lgpd_anonymize_contact", {
            p_organization_id: oB,
            p_contact_id: B.contacto,
          });
          const c = await sv.from("contacts").select("is_anonymized").eq("id", B.contacto).single();
          const s = rpcRechazada(r);
          return {
            ...s,
            obtenido: `${s.obtenido}; is_anonymized=${(c.data as { is_anonymized: boolean } | null)?.is_anonymized}`,
            ok: s.ok && (c.data as { is_anonymized: boolean }).is_anonymized === false,
          };
        },
      ],
      [
        "rpc fn_member_role_in_org(OB, B) como VA",
        "null o 42501",
        async () => {
          const r = await VA.db.rpc("fn_member_role_in_org", {
            p_user: seed.usuarios.OB.id,
            p_org: oB,
          });
          return {
            obtenido: r.error
              ? `${r.error.code} ${resumen(r.error.message, 50)}`
              : JSON.stringify(r.data),
            ok: !!r.error || r.data === null,
            body: r.data,
          };
        },
      ],
      [
        "rpc fn_tablero_metrics(B) como VA",
        "42501 o sin datos de B",
        async () => {
          const r = await VA.db.rpc("fn_tablero_metrics", {
            p_org: oB,
            p_from: "2000-01-01",
            p_to: "2100-01-01",
            p_owner: null,
          });
          if (r.error)
            return {
              obtenido: `${r.error.code} ${resumen(r.error.message, 50)}`,
              ok: true,
              body: r.error,
            };
          const t = JSON.stringify(r.data);
          return {
            obtenido: resumen(t, 100),
            ok: !t.includes(seed.usuarios.OB.id) && !/"ganados":\s*[1-9]/.test(t),
            body: r.data,
          };
        },
      ],
      [
        "rpc fn_tablero_metrics(A, p_owner null) como VA (#25)",
        "solo lo suyo (sin el lead de AA)",
        async () => {
          const r = await VA.db.rpc("fn_tablero_metrics", {
            p_org: seed.orgs.A,
            p_from: "2000-01-01",
            p_to: "2100-01-01",
            p_owner: null,
          });
          if (r.error)
            return {
              obtenido: /does not exist|42883|PGRST202/.test(r.error.message + r.error.code)
                ? "la RPC no existe en este commit (no aplica)"
                : `${r.error.code} ${resumen(r.error.message, 50)}`,
              ok: true,
              body: r.error,
            };
          const t = JSON.stringify(r.data);
          return { obtenido: resumen(t, 100), ok: !t.includes(seed.usuarios.AA.id), body: r.data };
        },
      ],
      [
        "SELECT webhook_sources.path_token como WA",
        "42501 o 0 filas",
        async () =>
          negado(
            await WA.db
              .from("webhook_sources")
              .select("path_token")
              .eq("organization_id", seed.orgs.A),
          ),
      ],
      [
        "INSERT user_recovery_codes como OA con aal1 (H1)",
        "42501",
        async () => {
          const r = await OA1.db
            .from("user_recovery_codes")
            .insert({ user_id: seed.usuarios.OA.id, code_hash: "\\x00" })
            .select("id");
          if (!r.error && r.data?.length)
            await sv
              .from("user_recovery_codes")
              .delete()
              .eq("id", (r.data[0] as { id: string }).id);
          return negado(r);
        },
      ],
      // 1-rls § 10: Storage.
      [
        "Storage lgpd-exports: listar el prefijo de B como VA",
        "vacío",
        async () => {
          const r = await VA.db.storage.from("lgpd-exports").list(oB);
          return {
            obtenido: r.error
              ? `error ${resumen(r.error.message, 50)}`
              : `${r.data?.length ?? 0} objetos`,
            ok: !!r.error || (r.data ?? []).length === 0,
            body: r.data,
          };
        },
      ],
      [
        "Storage whatsapp-media: bajar la media de B como VA",
        "denegado",
        async () => {
          if (!B.media_path)
            return { obtenido: "NO MEDIDO: la semilla no pudo subir media", ok: false };
          const r = await VA.db.storage.from("whatsapp-media").download(B.media_path);
          const t = r.data ? await r.data.text() : "";
          return {
            obtenido: r.error ? `error ${resumen(r.error.message, 50)}` : `bajó ${t.length} bytes`,
            ok: !!r.error,
            body: t,
          };
        },
      ],
      [
        "Storage ai-policy: subir a <B>/probe.pdf como VA",
        "denegado",
        async () => {
          const r = await VA.db.storage
            .from("ai-policy")
            .upload(`${oB}/probe-${Date.now()}.pdf`, Buffer.from("%PDF-1.4"), {
              contentType: "application/pdf",
            });
          return {
            obtenido: r.error ? `error ${resumen(r.error.message, 50)}` : "subió",
            ok: !!r.error,
          };
        },
      ],
      // 1-rls § 1 y § 2: la media del mensaje de A apuntada a otro lado.
      [
        "PATCH messages.media_url de A a WAHA y GET /media (F1)",
        "42501, 0 filas o 404",
        async () => {
          const r = await VA.db
            .from("messages")
            .update({
              media_url: "http://waha:3000/api/sessions?all=true",
              media_storage_path: null,
            })
            .eq("id", A.mensaje)
            .select("id");
          if (r.error || !r.data?.length)
            return { obtenido: `PATCH denegado ${r.error?.code ?? "0 filas"}`, ok: true };
          const h = await http("GET", `/api/v1/messages/${A.mensaje}/media`, { cookie: OA.cookie });
          return {
            obtenido: `PATCH aceptado; GET ${h.status} ${resumen(h.texto, 60)}`,
            ok: h.status === 404 || h.status === 403,
            body: h.texto,
          };
        },
      ],
      [
        "PATCH messages.media_storage_path de A a la media de B y GET /media (F2)",
        "42501, 0 filas o 404",
        async () => {
          if (!B.media_path) return { obtenido: "NO MEDIDO: sin media de B", ok: false };
          const r = await VA.db
            .from("messages")
            .update({ media_storage_path: B.media_path, media_url: null })
            .eq("id", A.mensaje)
            .select("id");
          if (r.error || !r.data?.length)
            return { obtenido: `PATCH denegado ${r.error?.code ?? "0 filas"}`, ok: true };
          const h = await http("GET", `/api/v1/messages/${A.mensaje}/media`, { cookie: OA.cookie });
          let seguido = "";
          if (h.location)
            seguido = await fetch(
              h.location.startsWith("http") ? h.location : `${BASE}${h.location}`,
            )
              .then((x) => x.text())
              .catch(() => "");
          return {
            obtenido: `PATCH aceptado; GET ${h.status}${h.location ? " → redirect" : ""}`,
            ok: h.status === 404 || h.status === 403,
            body: h.texto + seguido,
          };
        },
      ],
    ]);
    expect(rojos(rs)).toEqual([]);
  });

  test("Realtime (anon y JWT de A)", async () => {
    const oB = seed.orgs.B;
    const recibidos: unknown[] = [];
    const anon = anonDb();
    const ch1 = anon
      .channel(`org:${oB}:queue`)
      .on("broadcast", { event: "*" }, (p) => recibidos.push({ canal: "broadcast", p }));
    await VA.db.realtime.setAuth(VA.jwt);
    const ch2 = VA.db
      .channel(`aisl-${Date.now()}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `organization_id=eq.${oB}` },
        (p) => recibidos.push({ canal: "postgres_changes", p }),
      );
    const suscribir = (c: ReturnType<typeof anon.channel>) =>
      new Promise<string>((res) => {
        const t = setTimeout(() => res("TIMED_OUT"), 10_000);
        c.subscribe((s) => {
          if (s !== "CLOSED") {
            clearTimeout(t);
            res(s);
          }
        });
      });
    const [s1, s2] = await Promise.all([suscribir(ch1), suscribir(ch2)]);

    const sv = service();
    const emisor = sv.channel(`org:${oB}:queue`);
    await suscribir(emisor);
    // Sin emisión sintética: un canal público lo escucha cualquiera por diseño. Lo que se mide
    // es que la APP no publique nada de B en un canal público mientras entra un mensaje de B.
    const B = seed.datos.B;
    const ins = await sv
      .from("messages")
      .insert({
        organization_id: oB,
        conversation_id: B.conversacion,
        channel_session_id: B.sesion,
        contact_id: B.contacto,
        type: "text",
        direction: "inbound",
        body: seed.canario,
      })
      .select("id")
      .single();
    await new Promise((r) => setTimeout(r, 5_000));
    if (ins.data)
      await sv
        .from("messages")
        .delete()
        .eq("id", (ins.data as { id: string }).id);
    await Promise.all([
      anon.removeAllChannels(),
      VA.db.removeAllChannels(),
      sv.removeAllChannels(),
    ]);

    const bc = recibidos.filter((r) => (r as { canal: string }).canal === "broadcast").length;
    const pc = recibidos.filter(
      (r) => (r as { canal: string }).canal === "postgres_changes",
    ).length;
    const rs = [
      registrar(
        {
          bloque: "realtime",
          objetivo: `broadcast org:<B>:queue con anon key (suscripción ${s1})`,
          esperado: "0 eventos",
          obtenido: `${bc} eventos`,
          ok: bc === 0,
        },
        recibidos,
      ),
      registrar({
        bloque: "realtime",
        objetivo: `postgres_changes messages de B como VA (suscripción ${s2})`,
        esperado: "0 eventos",
        obtenido: `${pc} eventos`,
        ok: pc === 0,
      }),
    ];
    expect(rojos(rs)).toEqual([]);
  });

  test("API HTTP con cookie de A", async () => {
    const B = seed.datos.B;
    const oB = seed.orgs.B;
    const sv = service();
    // Cookie de A con active_org forjado a B: el app tiene que ignorarlo.
    const OAenB = (await entrar(seed.usuarios.OA, { aal2: true, activeOrg: oB })).cookie;
    const lecturas: [string, string][] = [
      ["contacto", `/api/v1/contacts/${B.contacto}`],
      ["conversación", `/api/v1/conversations/${B.conversacion}`],
      ["mensajes de la conversación", `/api/v1/conversations/${B.conversacion}/messages`],
      ["lead", `/api/v1/leads/${B.lead}`],
      ["timeline del lead", `/api/v1/leads/${B.lead}/timeline`],
      ["media del mensaje", `/api/v1/messages/${B.mensaje}/media`],
      ["sesión de WhatsApp", `/api/v1/channel-sessions/${B.sesion}`],
      ["QR de la sesión", `/api/v1/channel-sessions/${B.sesion}/qr`],
      ["listado de contactos", `/api/v1/contacts`],
      ["listado de conversaciones", `/api/v1/conversations`],
      ["listado de leads", `/api/v1/leads`],
      ["embudo de B", `/api/v1/pipelines/${B.pipeline}/board`],
    ];
    const rs = await sondas("api-http", [
      ...lecturas.map(
        ([n, ruta]) =>
          [
            `GET ${n} de B como OA (active_org=B forjado)`,
            "40x y sin datos de B",
            async () => {
              const h = await http("GET", ruta, { cookie: OAenB });
              const listado =
                !ruta.includes(oB) || /\/(contacts|conversations|leads)$/.test(ruta) || /"data":\[\]/.test(h.texto);
              return {
                obtenido: `${h.status} ${resumen(h.texto, 60)}`,
                ok:
                  (listado ? h.status < 500 : h.status >= 400 && h.status < 500) &&
                  !h.texto.includes(seed.canario),
                body: h.texto,
              };
            },
          ] as [string, string, () => Promise<Salida>],
      ),
      ...lecturas.slice(0, 4).map(
        ([n, ruta]) =>
          [
            `GET ${n} de B con dsk_A`,
            "40x y sin datos de B",
            async () => {
              const h = await http("GET", ruta, { bearer: seed.tokens.A.bearer });
              return {
                obtenido: `${h.status} ${resumen(h.texto, 60)}`,
                ok: h.status >= 400 && h.status < 500 && !h.texto.includes(seed.canario),
                body: h.texto,
              };
            },
          ] as [string, string, () => Promise<Salida>],
      ),
      [
        "PATCH contacto de B como OA",
        "40x",
        async () =>
          status(
            await http("PATCH", `/api/v1/contacts/${B.contacto}`, {
              cookie: OAenB,
              json: { name: "pisado" },
            }),
            [401, 403, 404],
          ),
      ],
      [
        "POST mover lead de B como OA",
        "40x",
        async () =>
          status(
            await http("POST", `/api/v1/leads/${B.lead}/move`, {
              cookie: OAenB,
              json: { stage_id: B.stage },
            }),
            [400, 401, 403, 404, 422],
          ),
      ],
      [
        "PATCH /team/<OB> (cruzado) como OA",
        "40x y OB sigue admin de B",
        async () => {
          const h = await http("PATCH", `/api/v1/team/${seed.usuarios.OB.id}`, {
            cookie: OAenB,
            json: { role: "viewer" },
          });
          const m = await sv
            .from("user_organizations")
            .select("role")
            .eq("user_id", seed.usuarios.OB.id)
            .eq("organization_id", oB)
            .single();
          const rol = (m.data as { role: string } | null)?.role;
          return {
            obtenido: `${h.status}; rol de OB=${rol}`,
            ok: h.status >= 400 && h.status < 500 && rol === "admin",
            body: h.texto,
          };
        },
      ],
      [
        "POST /lgpd/anonymize contacto de B como PS (aal1, H4)",
        "401/403 y contacto intacto",
        async () => {
          const h = await http("POST", "/api/v1/lgpd/anonymize", {
            cookie: PS.cookie,
            json: { contact_id: B.contacto, justification: "prueba de aislamiento entre orgs" },
          });
          const c = await sv.from("contacts").select("is_anonymized").eq("id", B.contacto).single();
          const anon = (c.data as { is_anonymized: boolean }).is_anonymized;
          return {
            obtenido: `${h.status}; is_anonymized=${anon}`,
            ok: [401, 403, 404].includes(h.status) && !anon,
            body: h.texto,
          };
        },
      ],
      [
        "GET /contacts como PS (support_readonly, aal1)",
        "40x",
        async () =>
          status(await http("GET", "/api/v1/contacts", { cookie: PS.cookie }), [401, 403]),
      ],
      [
        "POST /ai/credentials como VA (H2, la regla de setup-ai)",
        "403",
        async () =>
          status(
            await http("POST", "/api/v1/ai/credentials", {
              cookie: VA.cookie,
              json: { provider: "openai", label: "intruso", api_key: "sk-aislamiento-0000000000" },
            }),
            [401, 403],
          ),
      ],
      [
        "GET QR de la sesión de A como VA (agent)",
        "40x sin QR",
        async () =>
          status(
            await http("GET", `/api/v1/channel-sessions/${seed.datos.A.sesion}/qr`, {
              cookie: VA.cookie,
            }),
            [401, 403, 422],
          ),
      ],
      [
        "GET /contacts como US (org suspendida)",
        "403",
        async () =>
          status(await http("GET", "/api/v1/contacts", { cookie: US.cookie }), [401, 403, 423]),
      ],
      [
        "POST /prospectos con dsk_A y etapa de B",
        "422 y sin fila en B",
        async () =>
          status(
            await http("POST", "/api/v1/prospectos", {
              bearer: seed.tokens.A.bearer,
              json: {
                nombre: "Intruso",
                telefono: "+5491155550000",
                etapa: B.stage,
                id_externo: `aisl-${Date.now()}`,
              },
            }),
            [400, 401, 404, 422],
          ),
      ],
      [
        "POST /prospectos con dsk_S (org suspendida)",
        "401/403",
        async () =>
          status(
            await http("POST", "/api/v1/prospectos", {
              bearer: seed.tokens.S.bearer,
              json: { telefono: "+5491155550001", id_externo: `aisl-s-${Date.now()}` },
            }),
            [401, 403, 423],
          ),
      ],
      [
        "GET /metrics/tablero como VA (#25)",
        "solo lo suyo",
        async () => {
          const h = await http("GET", "/api/v1/metrics/tablero", { cookie: VA.cookie });
          if (h.status === 404)
            return { obtenido: "404: la ruta no existe en este commit", ok: true };
          return {
            obtenido: `${h.status} ${resumen(h.texto, 60)}`,
            ok:
              h.status < 500 &&
              !h.texto.includes(seed.usuarios.AA.id) &&
              !h.texto.includes(seed.canario),
            body: h.texto,
          };
        },
      ],
      [
        "POST /captar/publico/<slug de A>: el envío cae solo en A",
        "2xx y nada en B",
        async () => {
          if (!seed.captar_slug_a)
            return { obtenido: "sin formularios en este commit (no aplica)", ok: true };
          const h = await http("POST", `/api/v1/captar/publico/${seed.captar_slug_a}`, {
            json: { respuestas: { telefono: "+5491155550002" }, consentimiento: true },
          });
          return {
            obtenido: `${h.status} ${resumen(h.texto, 60)}`,
            ok: h.status < 500 && !h.texto.includes(seed.canario),
            body: h.texto,
          };
        },
      ],
    ]);
    expect(rojos(rs)).toEqual([]);
  });

  test("Server actions con cookie de A", async () => {
    const sv = service();
    const oA = seed.orgs.A;
    const rs = await sondas("server-actions", [
      [
        "sendOnboardingInvites como VA con onboarding abierto (C1)",
        "rechazada, sin invitación firmada",
        async () => {
          const id = idDeAccion("sendOnboardingInvites", "sendOnboardingInvites");
          if (!id) return { obtenido: "NO MEDIDO: id de la action no encontrado", ok: false };
          await sv.from("organizations").update({ onboarded_at: null }).eq("id", oA);
          try {
            const h = await accion(
              VA.cookie,
              id,
              [{ invitations: [{ email: "intruso@aisl.test", role: "admin" }] }],
              "/onboarding",
            );
            const firmo =
              /accept_url|"ok":true|invite/i.test(h.texto) && !/forbidden|"ok":false/.test(h.texto);
            return { obtenido: `${h.status} ${resumen(h.texto, 80)}`, ok: !firmo, body: h.texto };
          } finally {
            await sv
              .from("organizations")
              .update({ onboarded_at: new Date().toISOString() })
              .eq("id", oA);
          }
        },
      ],
      [
        "definirExigenciaDeMfa(false) como OA con aal1 (H3)",
        "rechazada y A sigue exigiendo MFA",
        async () => {
          const id = idDeAccion("definirExigenciaDeMfa", "politicaDeMfa");
          if (!id) return { obtenido: "NO MEDIDO: id de la action no encontrado", ok: false };
          const h = await accion(OA1.cookie, id, [false], "/app/settings");
          const o = await sv.from("organizations").select("settings").eq("id", oA).single();
          const exige =
            ((o.data as { settings: { security?: { mfa_required?: boolean } } }).settings.security
              ?.mfa_required ?? null) === true;
          if (!exige)
            await sv
              .from("organizations")
              .update({ settings: { security: { mfa_required: true } } })
              .eq("id", oA);
          return { obtenido: `${h.status}; mfa_required=${exige}`, ok: exige, body: h.texto };
        },
      ],
    ]);
    expect(rojos(rs)).toEqual([]);
  });

  test("MCP HTTP con dsk_A", async () => {
    const B = seed.datos.B;
    const oB = seed.orgs.B;
    const lista = await mcp(seed.tokens.A.bearer, "tools/list", {});
    const tools =
      (
        lista.json?.result as {
          tools?: {
            name: string;
            inputSchema?: {
              properties?: Record<string, { type?: string; items?: unknown }>;
              required?: string[];
            };
          }[];
        }
      )?.tools ?? [];
    const valores: Record<string, unknown> = {
      contact_id: B.contacto,
      conversation_id: B.conversacion,
      lead_id: B.lead,
      pipeline_id: B.pipeline,
      stage_id: B.stage,
      to_stage_id: B.stage,
      target_stage_id: B.stage,
      channel_session_id: B.sesion,
      session_id: B.sesion,
      message_id: B.mensaje,
      webhook_source_id: B.webhook_source,
      source_id: B.webhook_source,
      organization_id: oB,
      id: B.lead,
      user_id: seed.usuarios.OB.id,
      contact_ids: [B.contacto, B.contacto2],
    };
    const armar = (t: (typeof tools)[number]) => {
      const args: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(t.inputSchema?.properties ?? {})) {
        if (k in valores) args[k] = valores[k];
        else if (/_id$/.test(k)) args[k] = B.lead;
        else if (t.inputSchema?.required?.includes(k))
          args[k] =
            p.type === "number" || p.type === "integer"
              ? 1
              : p.type === "boolean"
                ? false
                : p.type === "array"
                  ? []
                  : "aislamiento";
      }
      return args;
    };
    const rs: Resultado[] = [
      registrar(
        {
          bloque: "mcp",
          objetivo: "tools/list con dsk_A",
          esperado: "lista de tools",
          obtenido: `${lista.status}; ${tools.length} tools`,
          ok: tools.length > 0,
        },
        lista.texto,
      ),
    ];
    for (const t of tools) {
      rs.push(
        ...(await sondas("mcp", [
          [
            `${t.name} con ids de B`,
            "error o vacío, sin datos de B",
            async () => {
              const r = await mcp(seed.tokens.A.bearer, "tools/call", {
                name: t.name,
                arguments: armar(t),
              });
              const res = r.json?.result as
                { isError?: boolean; content?: { text?: string }[] } | undefined;
              return {
                obtenido: res?.isError
                  ? `isError ${resumen(res.content?.[0]?.text ?? "", 60)}`
                  : `ok ${resumen(res?.content?.[0]?.text ?? r.texto, 60)}`,
                ok: !r.texto.includes(seed.canario),
                body: r.texto,
              };
            },
          ],
        ])),
      );
    }
    rs.push(
      ...(await sondas("mcp", [
        [
          "tools/list con dsk_S (org suspendida)",
          "401/403",
          async () => {
            const r = await mcp(seed.tokens.S.bearer, "tools/call", {
              name: "crm_search_contacts",
              arguments: { query: "S" },
            });
            const res = r.json?.result as { isError?: boolean } | undefined;
            return {
              obtenido: `${r.status}${res?.isError ? " isError" : ""} ${resumen(r.texto, 60)}`,
              ok: r.status === 401 || r.status === 403 || res?.isError === true,
              body: r.texto,
            };
          },
        ],
      ])),
    );
    expect(rojos(rs)).toEqual([]);
  });

  test(`Entradas públicas (${PROXY})`, async () => {
    const B = seed.datos.B;
    const rs = await sondas("publicas", [
      [
        "POST /webhooks/waha global con session de B y sin firma (H5)",
        "401/403 (también sin Caddy)",
        async () =>
          status(
            await http("POST", "/api/v1/webhooks/waha", {
              json: {
                event: "message",
                session: B.sesion_nombre,
                payload: {
                  id: `probe-${Date.now()}`,
                  from: "5491155550003@c.us",
                  body: "probe",
                  fromMe: false,
                },
              },
            }),
            [401, 403],
          ),
      ],
      [
        "POST /webhooks/waha/<token inventado>",
        "404",
        async () =>
          status(
            await http("POST", "/api/v1/webhooks/waha/AAAAAAAAAAAAAAAA", {
              json: { event: "message", session: "x", payload: { id: "1" } },
            }),
            [401, 403, 404],
          ),
      ],
      [
        "POST /webhooks/meta/<token inventado>",
        "404",
        async () =>
          status(
            await http("POST", "/api/v1/webhooks/meta/AAAAAAAAAAAAAAAA", { json: {} }),
            [401, 403, 404],
          ),
      ],
      [
        "GET /webhooks/meta verify con token inventado",
        "404",
        async () =>
          status(
            await http(
              "GET",
              "/api/v1/webhooks/meta/AAAAAAAAAAAAAAAA?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1",
            ),
            [401, 403, 404],
          ),
      ],
      [
        "POST /webhooks/nuvemshop store inexistente",
        "401 ideal; nunca 500",
        async () => {
          const h = await http("POST", "/api/v1/webhooks/nuvemshop/order-created", {
            json: { store_id: "999999999", id: 1 },
          });
          return {
            obtenido: `${h.status} ${resumen(h.texto, 60)}`,
            ok: h.status < 500,
            body: h.texto,
          };
        },
      ],
      [
        "GET /health?verbose=1 sin Bearer",
        "200/503 sin `target`",
        async () => {
          const h = await http("GET", "/api/v1/health?verbose=1");
          return {
            obtenido: `${h.status} ${resumen(h.texto, 60)}`,
            ok: [200, 503].includes(h.status) && !/"target"/.test(h.texto),
            body: h.texto,
          };
        },
      ],
      [
        "GET /cron/event-log-drain con Bearer x",
        "401/403",
        async () =>
          status(await http("GET", "/api/v1/cron/event-log-drain", { bearer: "x" }), [401, 403]),
      ],
      [
        "POST /system/relogio/tick sin auth",
        "401/403",
        async () =>
          status(
            await http("POST", "/api/v1/system/relogio/tick", { json: {} }),
            [401, 403, 404, 405],
          ),
      ],
      [
        "POST /internal/agents/run sin auth",
        "401/403",
        async () =>
          status(await http("POST", "/api/internal/agents/run", { json: {} }), [401, 403]),
      ],
      [
        "POST /system/agent sin auth",
        "401/403",
        async () =>
          status(await http("POST", "/api/v1/system/agent", { json: {} }), [401, 403, 404, 405]),
      ],
      [
        "GET callbacks OAuth con state inventado",
        "30x a error, nunca 200 con efecto ni 500",
        async () => {
          const a = await http("GET", "/api/v1/integrations/nuvemshop/callback?state=YQ.00&code=x");
          const b = await http("GET", "/api/v1/agenda/google/callback?state=x&code=y");
          return {
            obtenido: `nuvemshop ${a.status}, google ${b.status}`,
            ok: a.status < 500 && b.status < 500,
            body: a.texto + b.texto,
          };
        },
      ],
      [
        "GET /auth/confirm con next=https://evil.example",
        "30x que no va a evil",
        async () => {
          const h = await http(
            "GET",
            "/auth/confirm?token_hash=x&type=signup&next=https://evil.example",
          );
          return {
            obtenido: `${h.status} → ${h.location ?? "-"}`,
            ok: h.status < 500 && !(h.location ?? "").includes("evil.example"),
            body: h.texto,
          };
        },
      ],
      [
        "POST /prospectos sin token",
        "401",
        async () => status(await http("POST", "/api/v1/prospectos", { json: {} }), [401, 404]),
      ],
    ]);
    expect(rojos(rs)).toEqual([]);
  });

  // Último: degrada a AA y no vuelve atrás.
  test("Token de un admin degradado", async () => {
    const sv = service();
    await sv
      .from("user_organizations")
      .update({ role: "viewer" })
      .eq("user_id", seed.usuarios.AA.id)
      .eq("organization_id", seed.orgs.A);
    const rs = await sondas("tokens", [
      [
        "dsk de AA (role:admin) después de degradarlo a viewer: crm_create_stage",
        "rechazado",
        async () => {
          const r = await mcp(seed.tokens.AA.bearer, "tools/call", {
            name: "crm_create_stage",
            arguments: { pipeline_id: seed.datos.A.pipeline, name: `Etapa intrusa ${Date.now()}` },
          });
          const res = r.json?.result as
            { isError?: boolean; content?: { text?: string }[] } | undefined;
          return {
            obtenido:
              r.status >= 400
                ? `${r.status}`
                : res?.isError
                  ? `isError ${resumen(res.content?.[0]?.text ?? "", 60)}`
                  : "aceptado",
            ok: r.status >= 400 || res?.isError === true,
            body: r.texto,
          };
        },
      ],
    ]);
    expect(rojos(rs)).toEqual([]);
  });
});
