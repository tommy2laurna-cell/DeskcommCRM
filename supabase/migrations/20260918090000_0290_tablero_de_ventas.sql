-- 0290_tablero_de_ventas — GC5: tablero del dueño (prospectos por origen,
-- alcance por etapa, ventas en ARS, primera respuesta, y lo mismo por usuario).
--
-- SECURITY INVOKER: la RLS de crm_leads y conversations define el alcance
-- (vendedor = lo suyo, dueño/gerente = todo). Nunca cross-tenant: p_org sale de
-- la org activa en la ruta. Ventana semiabierta [from,to). Solo lectura.
--
-- Definiciones (las mismas que usa la lista al tocar el número):
--  * prospectos nuevos  = crm_leads.created_at en la ventana, agrupado por source.
--  * alcanzó la etapa   = lead creado en la ventana que está HOY en esa etapa o
--                         más adelante (position >=) o ya fue ganado.
--  * ventas             = leads status='won' con closed_at en la ventana;
--                         monto = suma de value_cents solo de currency='ARS'.
--  * 1ª respuesta       = promedio de la primera respuesta humana (igual que 0037).
create or replace function public.fn_tablero_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  nuevos as (
    select l.id, l.source, l.owner_user_id, l.status, l.stage_id, l.pipeline_id, s.position
    from public.crm_leads l
    join public.crm_stages s on s.id = l.stage_id
    where l.organization_id = p_org
      and l.created_at >= p_from and l.created_at < p_to
      and (p_owner is null or l.owner_user_id = p_owner)
  ),
  ganados as (
    select owner_user_id, value_cents, currency
    from public.crm_leads
    where organization_id = p_org and status = 'won'
      and closed_at >= p_from and closed_at < p_to
      and (p_owner is null or owner_user_id = p_owner)
  ),
  perdidos as (
    select owner_user_id from public.crm_leads
    where organization_id = p_org and status = 'lost'
      and closed_at >= p_from and closed_at < p_to
      and (p_owner is null or owner_user_id = p_owner)
  ),
  resp as (
    select c.assigned_to_user_id as user_id,
           extract(epoch from (fr.first_human_out - fr.first_in)) as secs
    from public.conversations c
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (where m.direction = 'outbound' and m.sent_by_user_id is not null) as first_human_out
      from public.messages m where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and fr.first_in is not null and fr.first_human_out is not null
      and fr.first_human_out > fr.first_in
      and fr.first_human_out >= p_from and fr.first_human_out < p_to
  ),
  usuarios as (
    select owner_user_id as user_id from nuevos where owner_user_id is not null
    union select owner_user_id from ganados where owner_user_id is not null
    union select owner_user_id from perdidos where owner_user_id is not null
    union select user_id from resp
  )
  select jsonb_build_object(
    'por_origen', coalesce((
      select jsonb_agg(jsonb_build_object('source', source, 'count', n) order by n desc, source)
      from (select source, count(*) n from nuevos group by source) x), '[]'::jsonb),
    'etapas', coalesce((
      select jsonb_agg(jsonb_build_object(
          'stage_id', s.id, 'stage_name', s.name, 'pipeline_id', s.pipeline_id,
          'position', s.position,
          'alcanzaron', (select count(*) from nuevos n
                         where n.pipeline_id = s.pipeline_id
                           and (n.status = 'won' or n.position >= s.position))
        ) order by s.pipeline_id, s.position)
      from public.crm_stages s
      where s.organization_id = p_org and s.is_archived = false), '[]'::jsonb),
    'ventas', jsonb_build_object(
      'ganados', (select count(*) from ganados),
      'monto_ars_cents', coalesce((select sum(value_cents) from ganados where currency = 'ARS'), 0),
      'ganados_otra_moneda', (select count(*) from ganados where currency is distinct from 'ARS')),
    'primera_respuesta_segundos', (select avg(secs) from resp),
    'por_usuario', coalesce((
      select jsonb_agg(jsonb_build_object(
          'user_id', u.user_id,
          'nuevos', (select count(*) from nuevos n where n.owner_user_id = u.user_id),
          'ganados', (select count(*) from ganados g where g.owner_user_id = u.user_id),
          'monto_ars_cents', coalesce((select sum(value_cents) from ganados g
                                       where g.owner_user_id = u.user_id and g.currency = 'ARS'), 0),
          'perdidos', (select count(*) from perdidos p where p.owner_user_id = u.user_id),
          'primera_respuesta_segundos', (select avg(secs) from resp r where r.user_id = u.user_id)
        ) order by u.user_id)
      from usuarios u), '[]'::jsonb)
  );
$$;
