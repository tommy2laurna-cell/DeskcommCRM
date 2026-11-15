import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { replyFixture } from "../support/autonomia-fixture";
import { seedGov } from "./gov-helpers";

/**
 * «ANONIMIZAR» BORRA DE VERDAD (auditoría 2026-11-14, H7 — migration 0295).
 *
 * La ruta `POST /api/v1/lgpd/anonymize` hacía el paso 1 (contacto) y nunca
 * llamaba a `fn_lgpd_cascade_redact_contact`: el cuerpo de los mensajes, el
 * `event_log` y lo que guardó la IA quedaban legibles. Y la cascada no servía
 * para llamarla después, porque cortaba en «ya anonimizado».
 *
 * Este archivo reproduce lo que hace la ruta, en el orden en que lo hace, sobre
 * Postgres real: paso 1 (el mismo UPDATE de `fn_lgpd_anonymize_contact`; su
 * autoridad y su MFA las vigila `lgpd-agenda-lock-order.test.ts`), un
 * `lgpd_requests` propio y la cascada. Después BUSCA la PII sembrada en TODAS
 * las tablas de `public`, fila por fila como texto. No confía en una lista: una
 * tabla nueva que guarde el nombre aparece acá sola.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const NOMBRE = "Zoe Piiprueba";
const TELEFONO = "5491155550199";
const EMAIL = "zoe.piiprueba@ejemplo.test";
const VECINA = "Ana Vecinaprueba";
const TELEFONO_VECINA = "5491155550288";

type Fixture = Awaited<ReturnType<typeof replyFixture>>;
let f: Fixture;
let vecina: Fixture;
let pedido: string;
let eventoPendiente: string;
let fechaDelDerecho: string;

async function sembrarPii(x: Fixture, nombre: string, telefono: string, email: string): Promise<void> {
  await pool.query(
    `update contacts set name = $3, display_name = $3, email = $4, phone_number = $5,
       consent = jsonb_build_object('texto', $3::text), source_metadata = jsonb_build_object('pushName', $3::text),
       tags = array[$3::text]
     where organization_id = $1 and id = $2`,
    [x.org, x.contact, nombre, email, `+${telefono}`],
  );
  await pool.query(
    `update conversations set last_message_preview = $3, metadata = jsonb_build_object('pushName', $3::text),
       last_handoff_reason = 'pidió humano: ' || $3
     where organization_id = $1 and id = $2`,
    [x.org, x.conversation, nombre],
  );
  const mensaje = randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction,
       status, body, media_url, media_mime, media_storage_path, error_message, metadata)
     values ($1, $2, $3, $4, $5, 'image', 'inbound', 'received', 'Hola, soy ' || $6 || ' y mi teléfono es +' || $7,
       'https://waha.test/api/files/' || $7 || '.jpg', 'image/jpeg', $8,
       'falló con ' || $6, jsonb_build_object('pushName', $6::text))`,
    [mensaje, x.org, x.conversation, x.channel, x.contact, nombre, telefono, `${x.org}/media/${mensaje}.jpg`],
  );
  await pool.query(
    `insert into ai_agent_runs (organization_id, agent_id, agent_version_id, conversation_id, contact_id,
       status, tool_calls, error_message)
     values ($1, $2, $3, $4, $5, 'completed', jsonb_build_array(jsonb_build_object('args', jsonb_build_object('nombre', $6::text))),
       'error leyendo a ' || $6)`,
    [x.org, x.agent, x.version, x.conversation, x.contact, nombre],
  );
  await pool.query(
    `insert into ai_invocations (organization_id, agent_id, conversation_id, invocation_kind, model, latency_ms,
       citations, error_payload)
     values ($1, $2, $3, 'bot_respond', 'test-model', 10, jsonb_build_array(jsonb_build_object('texto', $4::text)),
       jsonb_build_object('raw', $4::text))`,
    [x.org, x.agent, x.conversation, nombre],
  );
  const caso = (
    await pool.query<{ id: string }>(
      `insert into agent_cases (organization_id, conversation_id, agent_id, title, summary, blocker, context_snapshot)
       values ($1, $2, $3, $4 || ' quiere presupuesto', 'Resumen: ' || $4, 'falta el teléfono de ' || $4,
         jsonb_build_object('nombre', $4::text))
       returning id`,
      [x.org, x.conversation, x.agent, nombre],
    )
  ).rows[0]!.id;
  await pool.query(
    `insert into agent_case_events (organization_id, case_id, kind, actor_kind, body, metadata)
     values ($1, $2, 'opened', 'agent', 'Abrí el caso de ' || $3, jsonb_build_object('nombre', $3::text))`,
    [x.org, caso, nombre],
  );
}

/** Tablas de `public` con alguna fila que, como texto, contiene `needle`. */
async function tablasQueContienen(needles: string[]): Promise<string[]> {
  const { rows: tablas } = await pool.query<{ t: string }>(
    `select quote_ident(table_name) as t from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  );
  const patrones = needles.map((n) => `%${n}%`);
  const hallazgos: string[] = [];
  for (const { t } of tablas) {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.${t} x where x::text ilike any($1::text[])`,
      [patrones],
    );
    if (rows[0]?.n !== "0") hallazgos.push(t);
  }
  return hallazgos;
}

/** Lead ligada por `contact_id` y otra ligada SOLO por `crm_lead_links`, con actividad. */
async function sembrarLeads(x: Fixture, nombre: string): Promise<void> {
  const pipeline = randomUUID();
  const stage = randomUUID();
  const directa = randomUUID();
  const ligada = randomUUID();
  await pool.query(`insert into crm_pipelines (id, organization_id, name, slug) values ($1, $2, 'Funil', $3)`, [
    pipeline,
    x.org,
    pipeline,
  ]);
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1, $2, $3, 'Entrada', 'entrada', 1)`,
    [stage, x.org, pipeline],
  );
  // El nombre va DESPUÉS del carácter 20: la regla del título conserva 20.
  for (const [id, contato] of [
    [directa, x.contact],
    [ligada, null],
  ] as const) {
    await pool.query(
      `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, description, custom_fields, tags)
       values ($1, $2, $3, $4, $5, 'Presupuesto techo y canaleta para ' || $6, 'Llamar a ' || $6,
         jsonb_build_object('quien', $6::text), array[$6::text])`,
      [id, x.org, pipeline, stage, contato, nombre],
    );
  }
  await pool.query(
    `insert into crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
     values ($1, $2, 'contact', $3, 'primary')`,
    [x.org, ligada, x.contact],
  );
  await pool.query(
    `insert into crm_lead_activities (organization_id, lead_id, contact_id, source_module, type, payload, metadata, reason)
     values ($1, $2, null, 'crm', 'note', jsonb_build_object('texto', $3::text), jsonb_build_object('quien', $3::text),
       'el agente habló con ' || $3)`,
    [x.org, ligada, nombre],
  );
}

beforeAll(async () => {
  seedGov();
  f = await replyFixture(pool);
  vecina = await replyFixture(pool);
  await sembrarPii(f, NOMBRE, TELEFONO, EMAIL);
  await sembrarPii(vecina, VECINA, TELEFONO_VECINA, "ana.vecinaprueba@ejemplo.test");
  await sembrarLeads(f, NOMBRE);
  await sembrarLeads(vecina, VECINA);

  // El bus: un evento pendiente con nombre y teléfono, como emite un consumidor.
  eventoPendiente = (
    await pool.query<{ id: string }>(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload)
       values ($1, 'contact.updated', 'contact', $2,
         jsonb_build_object('contact_id', $5::text, 'name', $3::text, 'phone', $4::text))
       returning id`,
      [f.org, f.contact, NOMBRE, `+${TELEFONO}`, f.contact],
    )
  ).rows[0]!.id;
  // `contact.updated` es de registro y nace `done` (trg_event_log_marca_registro,
  // solo en el INSERT): lo dejamos pendiente como un evento que un consumidor
  // todavía no tomó.
  await pool.query(`update event_log set status = 'pending' where id = $1`, [eventoPendiente]);

  // Paso 1 de la ruta: el mismo UPDATE de `fn_lgpd_anonymize_contact`.
  await pool.query(
    `update contacts set name = null, display_name = 'Contato Anonimizado #' || $3,
       email = null, phone_number = null, cpf_encrypted = null, cpf_hash = null, birthdate = null,
       is_anonymized = true, anonymized_at = now(), updated_at = now()
     where organization_id = $1 and id = $2`,
    [f.org, f.contact, f.contact.slice(0, 8)],
  );
  fechaDelDerecho = (
    await pool.query<{ t: string }>(`select anonymized_at::text as t from contacts where id = $1`, [f.contact])
  ).rows[0]!.t;

  // El pedido propio de la ruta (FK de la cola de media).
  pedido = (
    await pool.query<{ id: string }>(
      `insert into lgpd_requests (organization_id, request_type, source, contact_id, status, due_at)
       values ($1, 'redact', 'manual', $2, 'processing', now() + interval '7 days') returning id`,
      [f.org, f.contact],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await pool.end();
});

describe("anonimizar desde la ruta borra mensajes, media, bus e IA", () => {
  it("antes de la cascada la PII está en mensajes, bus e IA (el defecto H7)", async () => {
    const tablas = await tablasQueContienen([NOMBRE, TELEFONO]);
    for (const t of [
      "messages",
      "conversations",
      "event_log",
      "ai_agent_runs",
      "ai_invocations",
      "agent_cases",
      "crm_leads",
      "crm_lead_activities",
    ]) {
      expect(tablas).toContain(t);
    }
  });

  it("la cascada corre aunque el contacto ya esté anonimizado, y la PII no queda en ninguna tabla", async () => {
    const { rows } = await pool.query<{ r: { already_anonymized: boolean; counts: Record<string, number>; media_paths: string[] } }>(
      `select public.fn_lgpd_cascade_redact_contact($1, $2, $3) as r`,
      [f.org, f.contact, pedido],
    );
    const r = rows[0]!.r;
    expect(r.already_anonymized).toBe(true);
    for (const t of [
      "contacts",
      "conversations",
      "messages",
      "event_log",
      "ai_agent_runs",
      "ai_invocations",
      "agent_cases",
      "agent_case_events",
      "leads",
      "activities",
    ]) {
      expect(r.counts[t], t).toBeGreaterThan(0);
    }
    expect(r.media_paths).toHaveLength(1);

    // La búsqueda: nombre, teléfono y e-mail, en todo `public`.
    expect(await tablasQueContienen([NOMBRE, TELEFONO, EMAIL])).toEqual([]);

    // La media va a la cola de borrado, atada al pedido.
    const cola = await pool.query(
      `select 1 from storage_redaction_queue where organization_id = $1 and object_path = $2 and request_id = $3`,
      [f.org, r.media_paths[0], pedido],
    );
    expect(cola.rowCount).toBe(1);
  });

  it("el evento pendiente no se procesa sobre la persona: pasa a dead y conserva solo ids", async () => {
    const { rows } = await pool.query<{ status: string; last_error: string; payload: Record<string, unknown> }>(
      `select status, last_error, payload from event_log where id = $1`,
      [eventoPendiente],
    );
    expect(rows[0]).toMatchObject({ status: "dead", last_error: "lgpd_redacted" });
    expect(rows[0]!.payload).toEqual({ contact_id: f.contact, redacted: true });
  });

  it("la segunda pasada no toca nada ni escribe otra fila de auditoría", async () => {
    const antes = await pool.query(
      `select count(*)::int as n from api_audit_log
        where organization_id = $1 and action = 'lgpd.redact_executed' and resource_id = $2`,
      [f.org, f.contact],
    );
    const { rows } = await pool.query<{ r: { counts: Record<string, number> } }>(
      `select public.fn_lgpd_cascade_redact_contact($1, $2, $3) as r`,
      [f.org, f.contact, pedido],
    );
    expect(Object.values(rows[0]!.r.counts).every((n) => n === 0)).toBe(true);
    const despues = await pool.query(
      `select count(*)::int as n from api_audit_log
        where organization_id = $1 and action = 'lgpd.redact_executed' and resource_id = $2`,
      [f.org, f.contact],
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it("no reescribe la fecha en que se ejerció el derecho", async () => {
    const { rows } = await pool.query<{ t: string }>(
      `select anonymized_at::text as t from contacts where id = $1`,
      [f.contact],
    );
    expect(rows[0]!.t).toBe(fechaDelDerecho);
  });

  it("la otra organización queda intacta", async () => {
    expect(await tablasQueContienen([VECINA, TELEFONO_VECINA])).toEqual(
      expect.arrayContaining([
        "contacts",
        "conversations",
        "messages",
        "ai_agent_runs",
        "ai_invocations",
        "agent_cases",
        "crm_leads",
        "crm_lead_activities",
      ]),
    );
  });
});
