import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_CONTACT_1,
  GOV_CONV_UNASSIGNED,
  GOV_ORG,
  GOV_SESSION,
  GOV_VIEWER,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * C2 / M1 (auditoría 2026-11-13 y 2026-11-14), migration 0291.
 *
 * `messages` tiene `GRANT ALL` a `authenticated` y la policy de UPDATE solo mira
 * la organización: con la anon key y el JWT de un viewer se reescribía
 * `media_url` (y la ruta de media la pedía a WAHA con la API key global) o
 * `media_storage_path` (y la ruta firmaba `<orgB>/…` con service role).
 *
 * Contra Postgres real: el navegador no cambia esas dos columnas, no crea un
 * entrante con media ni inserta un path fuera de `<org>/<conversación>/`; el
 * INSERT de salida del composer y la service role siguen.
 */

const CV = GOV_CONV_UNASSIGNED;
const MSG = "cccccccc-9191-4000-8000-000000000001";

beforeAll(() => {
  seedGov();
  sql(`delete from public.messages where id = '${MSG}';
       insert into public.messages
         (id, organization_id, conversation_id, channel_session_id, contact_id,
          type, direction, status, sent_via, body, media_url, sent_at)
       values
         ('${MSG}', '${GOV_ORG}', '${CV}', '${GOV_SESSION}', '${GOV_CONTACT_1}',
          'image', 'inbound', 'received', 'ai', null,
          'http://waha:3000/api/files/default/false_5491100000000@c.us_AAA.jpeg', now());`);
});

/** Corre como `authenticated` y devuelve el stderr del psql si falla. */
function errorAs(userId: string, dml: string): string {
  try {
    writeCountAs(userId, dml);
    return "";
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
}

describe("media de mensaje: solo la escribe el servidor (0291)", () => {
  it.each([
    ["media_url", "'http://x/api/sessions?all=true'"],
    ["media_url", "null"],
    ["media_storage_path", "'bbbbbbbb-0000-4000-8000-000000000001/conv/x.jpg'"],
  ])("⭐ un viewer no cambia %s (= %s) por PostgREST", (col, valor) => {
    const err = errorAs(GOV_VIEWER, `update public.messages set ${col} = ${valor} where id = '${MSG}'`);
    expect(err).toContain("solo los escribe el servidor");
    expect(sql(`select coalesce(media_storage_path, '') || '|' || media_url from public.messages where id = '${MSG}';`)).toBe(
      "|http://waha:3000/api/files/default/false_5491100000000@c.us_AAA.jpeg",
    );
  });

  it("⭐ ni un admin crea un entrante con media_url", () => {
    const err = errorAs(
      GOV_ADMIN,
      `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, sent_via, media_url, sent_at)
       values ('${GOV_ORG}', '${CV}', '${GOV_SESSION}', '${GOV_CONTACT_1}',
         'image', 'inbound', 'received', 'ai', 'http://x/api/sessions', now())`,
    );
    expect(err).toContain("solo lo crea el servidor");
  });

  it.each([
    "bbbbbbbb-0000-4000-8000-000000000001/conv/x.jpg",
    `${GOV_ORG}/cccccccc-4444-4000-8000-000000000002/x.jpg`,
  ])("⭐ ni un admin inserta una salida con media_storage_path ajeno (%s)", (path) => {
    const err = errorAs(
      GOV_ADMIN,
      `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, sent_via, media_storage_path, sent_at)
       values ('${GOV_ORG}', '${CV}', '${GOV_SESSION}', '${GOV_CONTACT_1}',
         'image', 'outbound', 'queued', 'user', '${path}', now())`,
    );
    expect(err).toContain("media_storage_path fuera de la");
  });

  it("par de vacuidad: el mismo usuario sí cambia otra columna de la fila", () => {
    expect(
      writeCountAs(GOV_ADMIN, `update public.messages set metadata = '{"x":1}'::jsonb where id = '${MSG}'`),
    ).toBe(1);
  });

  it("par de vacuidad: el INSERT de salida del composer (media_storage_path propio) sigue", () => {
    expect(
      writeCountAs(
        GOV_ADMIN,
        `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id,
           type, direction, status, sent_via, media_storage_path, sent_at)
         values ('${GOV_ORG}', '${CV}', '${GOV_SESSION}', '${GOV_CONTACT_1}',
           'image', 'outbound', 'queued', 'user', '${GOV_ORG}/${CV}/subida.jpg', now())`,
      ),
    ).toBe(1);
  });

  it("par de vacuidad: la service role (worker de persistencia) sí escribe media_storage_path", () => {
    sql(`set role service_role;
         update public.messages set media_storage_path = '${GOV_ORG}/${CV}/${MSG}.jpeg' where id = '${MSG}';`);
    expect(sql(`select media_storage_path from public.messages where id = '${MSG}';`)).toBe(
      `${GOV_ORG}/${CV}/${MSG}.jpeg`,
    );
  });
});
