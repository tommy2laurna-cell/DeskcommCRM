-- ============================================================================
-- 0279 — CAMPAÑAS: mensaje aprobado enviado a una lista, solo por la API de Meta
--
-- `campaigns` guarda el borrador y el estado; `campaign_recipients` es UNA fila
-- por (campaña, contacto), materializada al confirmar. El `unique` es lo que
-- vuelve idempotente el reintento del cron: un contacto no puede tener dos
-- filas, y una fila `enviado` no vuelve a enviarse.
--
-- Estados del destinatario: pendiente | enviado | excluido_optout |
-- excluido_sin_telefono | error. El opt-out se REVALÚA justo antes de cada envío
-- (el contacto pudo pedir la baja entre la confirmación y el envío), por eso un
-- `pendiente` puede terminar en `excluido_optout`.
--
-- `claimed_at` es un arriendo corto: dos ticks del cron que se solapan no toman
-- el mismo destinatario.
--
-- La tarifa de Meta NO se inventa: vive en `organizations.settings.campaigns.tarifa`
-- y la escribe `fn_set_campaign_tarifa` (un solo UPDATE atómico sobre el jsonb,
-- sin read-modify-write: el jsonb `settings` ya tiene escritores que se pisan).
-- ============================================================================

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  list_id uuid references public.smart_lists(id) on delete set null,
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  template_name text not null,
  template_language text not null,
  template_category text not null check (template_category in ('marketing', 'utility', 'authentication')),
  template_values jsonb not null default '{}'::jsonb check (jsonb_typeof(template_values) = 'object'),
  status text not null default 'borrador'
    check (status in ('borrador', 'confirmada', 'enviando', 'completada', 'cancelada')),
  status_reason text,
  scheduled_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by_user_id uuid references auth.users(id) on delete set null,
  total_recipients integer not null default 0,
  total_sent integer not null default 0,
  total_excluded integer not null default 0,
  total_error integer not null default 0,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.campaigns add column if not exists status_reason text;

create index if not exists campaigns_org_status_idx
  on public.campaigns (organization_id, status);

create table if not exists public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  status text not null default 'pendiente'
    check (status in ('pendiente', 'enviado', 'excluido_optout', 'excluido_sin_telefono', 'error')),
  reason text,
  external_id text,
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_recipients_campaign_contact_key unique (campaign_id, contact_id)
);

create index if not exists campaign_recipients_campaign_status_idx
  on public.campaign_recipients (campaign_id, status);
create index if not exists campaign_recipients_org_sent_idx
  on public.campaign_recipients (organization_id, sent_at)
  where status = 'enviado';

alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;

drop policy if exists campaigns_select on public.campaigns;
drop policy if exists campaigns_manager_write on public.campaigns;
drop policy if exists campaign_recipients_select on public.campaign_recipients;

create policy campaigns_select on public.campaigns
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

-- Escritura de `authenticated` SOLO sobre borradores (using Y with check): confirmar,
-- enviar, completar y cancelar son transiciones del servidor (cliente admin), así un
-- manager no puede, vía PostgREST, reabrir una campaña ni saltarse el botón de baja
-- que la confirmación verifica.
create policy campaigns_manager_write on public.campaigns
  using (
    (public.fn_is_platform_admin()
     or ((organization_id in (select public.fn_user_org_ids()))
         and public.fn_role_at_least(organization_id, 'manager')))
    and status = 'borrador'
  )
  with check (
    (public.fn_is_platform_admin()
     or ((organization_id in (select public.fn_user_org_ids()))
         and public.fn_role_at_least(organization_id, 'manager')))
    and status = 'borrador'
  );

-- Los destinatarios los escribe SOLO el servidor (service_role, que ignora RLS).
create policy campaign_recipients_select on public.campaign_recipients
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

revoke all on public.campaigns from anon;
revoke all on public.campaign_recipients from anon;
revoke insert, update, delete on public.campaign_recipients from authenticated;

drop trigger if exists trg_campaigns_set_updated_at on public.campaigns;
create trigger trg_campaigns_set_updated_at
  before update on public.campaigns
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_campaign_recipients_set_updated_at on public.campaign_recipients;
create trigger trg_campaign_recipients_set_updated_at
  before update on public.campaign_recipients
  for each row execute function public.fn_set_updated_at();

-- Tarifa vigente de Meta. `p_tarifa` null = borrarla. Solo la ejecuta el servidor
-- (service_role): la ruta PUT /api/v1/campaigns/tarifa exige admin con
-- `requireRole` antes de llamarla. `authenticated` NO la ejecuta: una definer que
-- escribe, con el org por argumento, sería escritura cross-tenant directa.
create or replace function public.fn_set_campaign_tarifa(p_org uuid, p_tarifa jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update public.organizations
     set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{campaigns}',
           (coalesce(settings -> 'campaigns', '{}'::jsonb) - 'tarifa')
             || case when p_tarifa is null then '{}'::jsonb
                     else jsonb_build_object('tarifa', p_tarifa) end,
           true)
   where id = p_org;
end;
$$;

revoke execute on function public.fn_set_campaign_tarifa(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_set_campaign_tarifa(uuid, jsonb) to service_role;

-- Las travas del modo somente leitura del suporte cubren la tabla nueva (migración 0274).
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';
