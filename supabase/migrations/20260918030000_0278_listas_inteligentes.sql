-- ============================================================================
-- 0278 — LISTAS INTELIGENTES: filtros guardados, membresía calculada al leer
--
-- Una lista inteligente guarda los FILTROS (etiqueta, etapa, origen, puntaje,
-- último contacto, cumpleaños del mes), nunca la lista de contactos. La
-- membresía se recalcula en cada lectura con `fn_smart_list_contacts`: un
-- contacto que cambia de etapa entra o sale solo, y nadie mantiene una copia
-- que envejece.
--
-- La función es SQL porque dos de los filtros no existen como columna de
-- `contacts`: la etapa y el puntaje viven en `crm_leads` / `crm_lead_scores`, y
-- el mes de cumpleaños sale de `birthday_md`. Hacerlo por PostgREST obligaría a
-- traer ids y devolverlos en un `.in()` de cientos de elementos: una URL que
-- revienta. Con la función el cliente pagina por keyset (`id > cursor`) y la URL
-- no crece con la lista.
--
-- SECURITY INVOKER a propósito: corre con los permisos de quien llama, así la
-- RLS de `contacts` sigue mandando. Todos los parámetros null = sin ese filtro.
-- ============================================================================

create table if not exists public.smart_lists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists smart_lists_org_name_uidx
  on public.smart_lists (organization_id, lower(name));

alter table public.smart_lists enable row level security;

drop policy if exists smart_lists_select on public.smart_lists;
drop policy if exists smart_lists_manager_write on public.smart_lists;

create policy smart_lists_select on public.smart_lists
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy smart_lists_manager_write on public.smart_lists
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.smart_lists from anon;

drop trigger if exists trg_smart_lists_set_updated_at on public.smart_lists;
create trigger trg_smart_lists_set_updated_at
  before update on public.smart_lists
  for each row execute function public.fn_set_updated_at();

create or replace function public.fn_smart_list_contacts(
  p_org uuid,
  p_tags text[] default null,
  p_stage_ids uuid[] default null,
  p_sources text[] default null,
  p_score_min numeric default null,
  p_score_max numeric default null,
  p_inactive_before timestamptz default null,
  p_birthday_month integer default null
) returns setof public.contacts
language sql stable security invoker
set search_path = public
as $$
  select c.*
  from public.contacts c
  where c.organization_id = p_org
    and c.is_anonymized = false
    and c.is_merged_into is null
    and (p_tags is null or c.tags && p_tags)
    and (p_sources is null or c.source = any (p_sources))
    -- "hace más de N días": quien nunca tuvo actividad también cuenta.
    and (p_inactive_before is null
         or c.last_activity_at is null
         or c.last_activity_at < p_inactive_before)
    and (p_birthday_month is null
         or c.birthday_md between p_birthday_month * 100 + 1 and p_birthday_month * 100 + 31)
    -- etapa y puntaje se evalúan sobre el MISMO negocio abierto del contacto.
    and ((p_stage_ids is null and p_score_min is null and p_score_max is null)
         or exists (
           select 1
           from public.crm_leads l
           left join public.crm_lead_scores s on s.lead_id = l.id
           where l.organization_id = p_org
             and l.contact_id = c.id
             and l.status = 'open'
             and (p_stage_ids is null or l.stage_id = any (p_stage_ids))
             and ((p_score_min is null and p_score_max is null)
                  or (s.ai_probability is not null
                      and (p_score_min is null or s.ai_probability >= p_score_min)
                      and (p_score_max is null or s.ai_probability <= p_score_max)))
         ));
$$;

revoke execute on function public.fn_smart_list_contacts(uuid, text[], uuid[], text[], numeric, numeric, timestamptz, integer) from public, anon;
grant execute on function public.fn_smart_list_contacts(uuid, text[], uuid[], text[], numeric, numeric, timestamptz, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
