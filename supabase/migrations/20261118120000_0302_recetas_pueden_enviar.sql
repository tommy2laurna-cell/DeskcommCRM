-- 0302 — Las recetas pueden enviar (PR #23).
--
-- `fn_service_event_origin` solo resolvía 6 tipos de evento; los 4 del reloj de
-- recetas (`appointment.reminder`, `contact.silent`, `lead.idle`,
-- `contact.dormant`) caían en `service_event_origin_unsupported` (40001) y
-- `serviceForEvent` lo tomaba como «fronteira vencida»: ninguna receta enviaba.
-- Se suman los 4 con el mismo control de alcance (contacto de la entidad, no
-- anonimizado ni fusionado). La fronteira sigue viniendo del `service_origin`
-- de tipo command que estampa `app/api/v1/cron/recetas`; sin él, `service_stale`.
-- Cuerpo idéntico a 0224 salvo el bloque marcado «0302». Mismo bloque en el
-- apéndice del baseline.

create or replace function public.fn_service_event_origin(p_org uuid,p_event uuid,p_contact uuid,p_session uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.event_log; origin jsonb; boundary jsonb; current_boundary jsonb; entity_contact uuid; cid uuid; sid uuid; observed jsonb; root_event uuid:=p_event; visited uuid[]:=array[]::uuid[];
begin
 -- O drain faz claim otimista em outra transação; não conserva row lock.
 -- Não travar event_log: advisory contato antecede os locks de conversa/FKs.
 perform public.fn_service_lock(p_org,p_contact);
 loop
 if root_event = any(visited) or cardinality(visited)>=32 then raise exception 'service_origin_cycle' using errcode='40001'; end if;
 visited:=array_append(visited,root_event);
 boundary:=null;
 entity_contact:=null;
 select * into e from public.event_log where organization_id=p_org and id=root_event;
 if not found then raise exception 'service_event_not_found' using errcode='P0002'; end if;
 if e.event_type in ('lead.created','lead.stage_changed','lead.tag_added') and e.entity_kind='crm_lead' then
   select contact_id into entity_contact from public.crm_leads where organization_id=p_org and id=e.entity_id;
 elsif e.event_type='contact.tag_added' and e.entity_kind='contact' then
   select id into entity_contact from public.contacts where organization_id=p_org and id=e.entity_id;
 elsif e.event_type='appointment.outcome_confirmed' and e.entity_kind='appointment' then
   select contact_id into entity_contact from public.calendar_appointments where organization_id=p_org and id=e.entity_id and revision=(e.payload->>'appointment_revision')::bigint and status='no_show' and outcome_recorded_at is not null;
 -- 0302: los eventos del reloj de recetas (cron/recetas). El contacto sale de la
 -- entidad; la fronteira, del `service_origin` de tipo command que el cron estampa.
 elsif e.event_type='appointment.reminder' and e.entity_kind='calendar_appointment' then
   select contact_id into entity_contact from public.calendar_appointments where organization_id=p_org and id=e.entity_id and status='confirmed';
 elsif e.event_type in ('contact.silent','contact.dormant') and e.entity_kind='contact' then
   select id into entity_contact from public.contacts where organization_id=p_org and id=e.entity_id;
 elsif e.event_type='lead.idle' and e.entity_kind='crm_lead' then
   select contact_id into entity_contact from public.crm_leads where organization_id=p_org and id=e.entity_id and status='open';
 elsif e.event_type='message.received' and e.entity_kind='message' then
   select contact_id,jsonb_build_object('organization_id',organization_id,'contact_id',contact_id,
     'conversation_id',conversation_id,'service_revision',service_revision,'demanda_id',demanda_id,'demanda_revision',demanda_revision)
     into entity_contact,boundary from public.messages where organization_id=p_org and id=e.entity_id and direction='inbound';
 else raise exception 'service_event_origin_unsupported' using errcode='40001'; end if;
 if entity_contact is distinct from p_contact or not exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and not is_anonymized and is_merged_into is null) then
   raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 origin:=e.payload->'service_origin';
 if origin->>'kind'='event' then
   if origin->>'organization_id' is distinct from p_org::text or origin->>'contact_id' is distinct from p_contact::text then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   root_event:=(origin->>'event_id')::uuid;
   if root_event is null then raise exception 'service_stale' using errcode='40001'; end if;
   continue;
 end if;
 exit;
 end loop;
 if boundary is not null or origin->>'kind'='continuation' then
   boundary:=coalesce(boundary,origin->'boundary');
   select channel_session_id into sid from public.conversations where organization_id=p_org and contact_id=p_contact and id=(boundary->>'conversation_id')::uuid;
   if p_session is not null and p_session is distinct from sid then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 elsif origin->>'kind'='command' then
   observed:=origin->'observed';
   if observed->>'organization_id' is distinct from p_org::text or observed->>'contact_id' is distinct from p_contact::text then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
   if jsonb_typeof(observed->'destinations')='array' then
     sid:=coalesce(p_session,(observed->>'default_session_id')::uuid);
     select item->'observed' into observed from jsonb_array_elements(observed->'destinations') item where item->>'channel_session_id'=sid::text;
   else
     -- Compatibilidade com snapshot anterior: prova somente sua conversa, nunca ausência de outro canal.
     select channel_session_id into sid from public.conversations where organization_id=p_org and contact_id=p_contact and id=(observed->>'conversation_id')::uuid;
     if p_session is not null and p_session is distinct from sid then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
   end if;
 else raise exception 'service_stale' using errcode='40001'; end if;
 if sid is null then raise exception 'service_stale' using errcode='40001'; end if;
 if not exists(select 1 from public.channel_sessions where id=sid and organization_id=p_org and archived_at is null) then raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 if boundary is null and observed is null then raise exception 'service_stale' using errcode='40001'; end if;
 select service_boundary into current_boundary from public.event_service_origins where organization_id=p_org and event_id=root_event and channel_session_id=sid;
 if found then boundary:=current_boundary;
 elsif boundary is null then
   -- PARA UM EVENTO, `absent` E PROCEDENCIA — NAO REIVINDICACAO DE ESTADO.
   --
   -- O CAS de `fn_service_begin` existe para que dois ATORES com a mesma
   -- observacao "ausente" nao ajam os dois: o segundo tem de perder, e o
   -- invariante de `fn_service_begin` guarda isso. Um evento e outra coisa: o
   -- retrato `absent` diz "quando este evento foi EMITIDO nao havia
   -- atendimento", e a resolucao de cada evento ja e idempotente pelo memo
   -- `event_service_origins` logo acima — nao ha corrida a arbitrar aqui.
   --
   -- Sem esta distincao o caminho ORDINARIO morria: um lead criado e depois
   -- movido de etapa gera DOIS eventos, cada um com seu retrato `absent`;
   -- resolver o primeiro cria a conversa e o segundo levantava 40001 — que
   -- `serviceForEvent` engole como `stale_origin`, entao o follow-up de etapa
   -- simplesmente nao nascia, sem erro em lugar nenhum.
   --
   -- Zerar `observed` so quando a conversa JA existe mantem o CAS de pe para o
   -- retrato que descreve uma fronteira concreta (esse continua sendo conferido
   -- contra a vigente) e para todo chamador direto de `fn_service_begin`.
   if observed->>'absent' = 'true' and exists(
        select 1 from public.conversations
         where organization_id=p_org and contact_id=p_contact
           and channel_session_id=sid and not is_group) then
     observed:=null;
   end if;
   boundary:=public.fn_service_begin(p_org,p_contact,sid,observed) - 'status' - 'demanda_fechada_em' - 'service_started_at';
 end if;
 if boundary->>'organization_id' is distinct from p_org::text or boundary->>'contact_id' is distinct from p_contact::text then
   raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 cid:=(boundary->>'conversation_id')::uuid;
 if p_session is not null and not exists(select 1 from public.conversations where organization_id=p_org and id=cid and contact_id=p_contact and channel_session_id=p_session) then
   raise exception 'service_channel_mismatch' using errcode='23503'; end if;
 current_boundary:=public.fn_service_boundary(p_org,cid);
 if current_boundary is null or current_boundary->>'status' in ('closed','resolved','archived')
   or current_boundary->>'demanda_fechada_em' is not null
   or (current_boundary - 'status' - 'demanda_fechada_em' - 'service_started_at') is distinct from boundary then
   raise exception 'service_stale' using errcode='40001'; end if;
 insert into public.event_service_origins(event_id,channel_session_id,organization_id,service_boundary) values(root_event,sid,p_org,boundary)
 on conflict(event_id,channel_session_id) do nothing;
 return boundary;
end; $$;
revoke all on function public.fn_service_event_origin(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_origin(uuid,uuid,uuid,uuid) to service_role;

notify pgrst, 'reload schema';
