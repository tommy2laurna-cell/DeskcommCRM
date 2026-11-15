-- 0295 — «Anonimizar» borra de verdad (auditoría 2026-11-14, H7).
--
-- La ruta POST /api/v1/lgpd/anonymize hacía el paso 1 (contacto) con
-- `fn_lgpd_anonymize_contact` y redactaba leads y actividades, pero NUNCA
-- llamaba a esta cascada: mensajes, media, conversaciones, `event_log` y las
-- tablas de IA quedaban legibles. Y la cascada no servía para llamarla después
-- del paso 1, porque cortaba en «ya anonimizado» antes de tocar nada.
--
-- Qué cambia:
--   1. Sin corte en «ya anonimizado». La rama del contacto, leads y actividades
--      sigue corriendo UNA vez (la fecha `anonymized_at` responde al plazo
--      legal y no se reescribe; leads y actividades de un contacto ya
--      anonimizado son de `lib/lgpd/cascata.ts`). Todo lo demás corre siempre
--      y es idempotente: cada UPDATE filtra lo que todavía tiene dato, así que
--      la segunda pasada cuenta 0.
--   2. Alcanza lo que faltaba: lo que el paso 1 deja en el contacto (consent,
--      source_metadata, tags), `conversations.last_handoff_reason`,
--      `messages.error_message`, `event_log` (payload y metadata, sin cortar el
--      bus: los pendientes pasan a `dead`), `ai_agent_runs`, `ai_invocations`,
--      `agent_cases` y `agent_case_events`.
--   3. La fila densa de auditoría se escribe solo si hubo efecto.
--
-- Devuelve lo mismo que antes (`already_anonymized`, `counts`, `media_paths`):
-- el worker de pedidos sigue leyendo `already_anonymized` igual.

create or replace function public.fn_lgpd_cascade_redact_contact(
  p_organization_id uuid, p_contact_id uuid, p_request_id uuid
) returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
  v_convs uuid[];
  v_leads uuid[];
  v_casos uuid[];
  v_efeito int := 0;
begin
  perform public.fn_service_lock(p_organization_id, p_contact_id);
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;
  v_already := coalesce(v_already, false);

  v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);

  select coalesce(array_agg(id), '{}') into v_convs
    from conversations
    where contact_id = p_contact_id and organization_id = p_organization_id;

  select coalesce(array_agg(id), '{}') into v_leads
    from crm_leads
    where organization_id = p_organization_id
      and (
        contact_id = p_contact_id
        or id in (
          select lead_id from crm_lead_links
            where target_kind = 'contact'
              and target_id = p_contact_id
              and organization_id = p_organization_id
        )
      );

  select coalesce(array_agg(id), '{}') into v_casos
    from agent_cases
    where organization_id = p_organization_id and conversation_id = any(v_convs);

  -- Media que todavía tiene archivo (solo lo nuestro: media_storage_path).
  select coalesce(array_agg(distinct media_storage_path)
           filter (where media_storage_path is not null and length(media_storage_path) > 0), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id and conversation_id = any(v_convs);

  -- 1. contacts. Primera vez: todo. Ya anonimizado: solo lo que el paso 1 de
  --    la ruta no limpia, sin tocar `anonymized_at` ni el nombre.
  if not v_already then
    update contacts set
      name = v_anon_label,
      display_name = v_anon_label,
      email = null,
      -- email_normalized es GENERATED (lower(trim(email))): se limpia sola.
      phone_number = null,
      cpf_encrypted = null,
      cpf_hash = null,
      birthdate = null,
      is_anonymized = true,
      anonymized_at = now(),
      consent = '{}'::jsonb,
      source_metadata = '{}'::jsonb,
      tags = '{}'::text[],
      updated_at = now()
    where id = p_contact_id and organization_id = p_organization_id;
  else
    update contacts set
      email = null,
      phone_number = null,
      cpf_encrypted = null,
      cpf_hash = null,
      birthdate = null,
      consent = '{}'::jsonb,
      source_metadata = '{}'::jsonb,
      tags = '{}'::text[],
      updated_at = now()
    where id = p_contact_id and organization_id = p_organization_id
      and (email is not null or phone_number is not null or cpf_encrypted is not null
           or cpf_hash is not null or birthdate is not null
           or consent <> '{}'::jsonb or source_metadata <> '{}'::jsonb or tags <> '{}'::text[]);
  end if;
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 2. conversations
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    last_handoff_reason = null,
    updated_at = now()
  where organization_id = p_organization_id and id = any(v_convs)
    and (metadata <> '{}'::jsonb or last_message_preview is not null or last_handoff_reason is not null);
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: cuerpo, media, error y metadata (quedan estado, horas y el hilo).
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    error_message = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id and conversation_id = any(v_convs)
    and (body is distinct from '[mensagem anonimizada]' or media_url is not null
         or media_mime is not null or media_size_bytes is not null
         or media_storage_path is not null or error_message is not null
         or metadata <> '{}'::jsonb);
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4 y 5. Actividades y leads: solo en la primera vez. Con el contacto ya
  --    anonimizado son de `lib/lgpd/cascata.ts` (la ruta y el cron de
  --    retención), que corta el título con otra regla; pisarlo acá daría dos
  --    títulos distintos para la misma lead.
  if not v_already then
    update crm_lead_activities set
      payload = '{}'::jsonb,
      metadata = '{}'::jsonb,
      reason = null
    where organization_id = p_organization_id
      and (contact_id = p_contact_id or lead_id = any(v_leads));
    get diagnostics v_count = row_count;
    v_efeito := v_efeito + v_count;
    v_counts := v_counts || jsonb_build_object('activities', v_count);

    update crm_leads set
      title = v_anon_label,
      description = null,
      custom_fields = '{}'::jsonb,
      source_metadata = '{}'::jsonb,
      tags = '{}'::text[],
      updated_at = now()
    where organization_id = p_organization_id and id = any(v_leads);
    get diagnostics v_count = row_count;
    v_efeito := v_efeito + v_count;
    v_counts := v_counts || jsonb_build_object('leads', v_count);
  end if;

  -- 6. orders: se conservan valores, estado y fechas.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 7. media a la cola de borrado (idempotente por unique (bucket, object_path)).
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 7b. voice_calls: el teléfono de la otra punta (migration 0235).
  update voice_calls set
    peer_phone = v_anon_label,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id
    and (peer_phone is distinct from v_anon_label or owner_user_id is not null or created_by is not null);
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  -- 8. event_log: el bus guarda en `payload` el cuerpo del mensaje, el nombre
  --    y el teléfono. Queda solo lo que es un uuid (ids, que no reidentifican a
  --    nadie solos) y la marca `redacted`. Lo que estaba pendiente pasa a
  --    `dead`: un consumidor no tiene que actuar sobre una persona que pidió la
  --    supresión. Entra también lo que esta transacción emitió en los pasos de
  --    arriba (triggers de leads): por eso la segunda pasada cuenta 0. Los
  --    eventos `lgpd.*` y `contact.anonymized` son el registro del derecho
  --    ejercido y no se tocan.
  update event_log e set
    payload = coalesce((
        select jsonb_object_agg(j.k, j.v)
          from jsonb_each(case when jsonb_typeof(e.payload) = 'object' then e.payload else '{}'::jsonb end) as j(k, v)
          where jsonb_typeof(j.v) = 'string'
            and (j.v #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ), '{}'::jsonb) || '{"redacted": true}'::jsonb,
    metadata = '{"lgpd_redacted": true}'::jsonb,
    status = case when e.status = 'pending' then 'dead' else e.status end,
    last_error = case when e.status = 'pending' then 'lgpd_redacted' else e.last_error end,
    updated_at = now()
  where e.organization_id = p_organization_id
    and e.event_type <> 'contact.anonymized'
    and e.event_type not like 'lgpd.%'
    and (e.payload->>'redacted') is distinct from 'true'
    and (
      (e.entity_kind = 'contact' and e.entity_id = p_contact_id)
      or (e.entity_kind = 'conversation' and e.entity_id = any(v_convs))
      or (e.entity_kind = 'crm_lead' and e.entity_id = any(v_leads))
      or (e.entity_kind = 'message' and e.entity_id in (
            select m.id from messages m
              where m.organization_id = p_organization_id and m.conversation_id = any(v_convs)))
      or e.payload->>'contact_id' = p_contact_id::text
      or e.payload->>'conversation_id' = any(v_convs::text[])
    );
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('event_log', v_count);

  -- 9. IA. Las corridas guardan los argumentos de las herramientas (lo que el
  --    agente leyó o escribió de la persona) y el error crudo; las
  --    invocaciones, citas y el error del proveedor. Quedan tokens, costo y
  --    latencia, que sostienen el presupuesto. `ai_reply_drafts` ya la limpia
  --    `fn_reply_redact` al anonimizar.
  update ai_agent_runs set
    tool_calls = '[]'::jsonb,
    error_message = null
  where organization_id = p_organization_id
    and (contact_id = p_contact_id or conversation_id = any(v_convs))
    and (tool_calls <> '[]'::jsonb or error_message is not null);
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('ai_agent_runs', v_count);

  update ai_invocations set
    citations = '[]'::jsonb,
    error_payload = null
  where organization_id = p_organization_id
    and conversation_id = any(v_convs)
    and (citations <> '[]'::jsonb or error_payload is not null);
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('ai_invocations', v_count);

  -- Casos que el agente escaló: título, resumen y bloqueo los escribe el LLM
  -- sobre la conversación. Son NOT NULL, por eso van con el rótulo.
  update agent_cases set
    title = '[caso anonimizado]',
    summary = '[caso anonimizado]',
    blocker = '[caso anonimizado]',
    context_snapshot = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id and id = any(v_casos)
    and (title is distinct from '[caso anonimizado]' or summary is distinct from '[caso anonimizado]'
         or blocker is distinct from '[caso anonimizado]' or context_snapshot <> '{}'::jsonb);
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('agent_cases', v_count);

  update agent_case_events set
    body = null,
    metadata = '{}'::jsonb
  where organization_id = p_organization_id and case_id = any(v_casos)
    and (body is not null or metadata <> '{}'::jsonb);
  get diagnostics v_count = row_count;
  v_efeito := v_efeito + v_count;
  v_counts := v_counts || jsonb_build_object('agent_case_events', v_count);

  -- 10. Fila densa de auditoría, solo si hubo efecto.
  if v_efeito > 0 or coalesce(array_length(v_media_paths, 1), 0) > 0 then
    insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
    values (
      p_organization_id,
      'lgpd.redact_executed',
      null,
      'contact',
      p_contact_id,
      jsonb_build_object(
        'cascaded_to', v_counts,
        'media_queued', coalesce(array_length(v_media_paths, 1), 0),
        'request_id', p_request_id,
        'already_anonymized', v_already
      ),
      true
    );
  end if;

  return jsonb_build_object(
    'already_anonymized', v_already,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;
revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;

notify pgrst, 'reload schema';
