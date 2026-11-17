-- 0291 — `media_url` y `media_storage_path` de `messages` solo los escribe el servidor (C2, M1).
--
-- ═══ EL DEFECTO ═══
--
-- `messages` tiene `GRANT ALL ... TO authenticated` y la policy de UPDATE solo
-- mira la organización. Con la anon key y el JWT de cualquier miembro (viewer
-- incluido), un `PATCH /rest/v1/messages` cambiaba `media_url` a una ruta de la
-- API de WAHA y `GET /api/v1/messages/<id>/media` la pedía con la X-Api-Key
-- global (C2); o cambiaba `media_storage_path` a `<orgB>/…` y la ruta la firmaba
-- con service role (M1). Un INSERT `direction = 'inbound'` con media hacía lo
-- mismo sin tocar una fila existente. Y un INSERT de salida directo por PostgREST
-- (sin pasar por el handler, que sí valida) podía apuntar `media_storage_path` a
-- otra conversación.
--
-- ═══ POR QUÉ TRIGGER Y NO `revoke update (media_url, media_storage_path)` ═══
--
-- Con privilegio de TABLA, revocar la misma columna no hace nada: «if a role has
-- been granted privileges on a table, then revoking the same privileges from
-- individual columns will have no effect»
-- (https://www.postgresql.org/docs/15/sql-revoke.html). La otra forma —revocar
-- UPDATE de tabla y re-otorgarlo columna por columna— deja toda columna FUTURA
-- sin UPDATE para el navegador, y eso se rompe callado.
--
-- ═══ QUÉ QUEDA PERMITIDO ═══
--
-- Medido: el único escritor con JWT de usuario es el INSERT de salida de
-- `app/api/v1/messages/_handler.ts` (`direction: 'outbound'`, el composer manda
-- `media_storage_path` de su upload, bajo `<org>/<conversación>/`). Ese sigue, con
-- la misma regla de posesión que el handler (`isMediaPathOwnedBy`). Los ingest (WAHA, Meta, Zernio)
-- y los workers usan service role y no pasan por acá. Ningún UPDATE con JWT de
-- usuario toca estas dos columnas.
--
-- `security invoker` a propósito: con definer, `current_user` sería el dueño de
-- la función y la guarda no vería al rol que escribe.
-- Idempotente: `create or replace` + `drop trigger if exists`.

create or replace function public.fn_messages_media_solo_servidor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and (new.media_url is distinct from old.media_url
          or new.media_storage_path is distinct from old.media_storage_path) then
    raise exception 'media_url y media_storage_path solo los escribe el servidor'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.direction = 'inbound'
     and (new.media_url is not null or new.media_storage_path is not null) then
    raise exception 'un mensaje entrante con media solo lo crea el servidor'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.media_storage_path is not null
     and not starts_with(new.media_storage_path,
                         new.organization_id::text || '/' || new.conversation_id::text || '/') then
    raise exception 'media_storage_path fuera de la conversación'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_messages_media_solo_servidor() from public, anon, authenticated;

drop trigger if exists trg_messages_media_solo_servidor on public.messages;
create trigger trg_messages_media_solo_servidor
  before insert or update on public.messages
  for each row execute function public.fn_messages_media_solo_servidor();
