-- 0277 — captar fuera de WhatsApp: formularios y encuestas públicos.
--
-- Una fila = un formulario (o encuesta) que la persona publica como link propio
-- o como snippet en la web del cliente. NO tiene tabla de envíos propia: al
-- enviarse, el formulario entra por la MISMA captación que ya existe
-- (`webhook_sources` → /api/v1/webhooks/in/[token] → `webhook_lead_captures`),
-- así contacto, lead, historial, UTM e IP salen del mismo camino de siempre.
-- Por eso cada formulario guarda `webhook_source_id`: la fuente interna que lo
-- respalda (`on delete set null`: borrar la fuente no borra el formulario).
--
-- `slug` es la identidad pública (no es secreto): corto, único en toda la
-- instalación. `fields` es la definición validada en TypeScript
-- (`lib/captar/formulario.ts`); sin CHECK de vocabulario para que un tipo de
-- campo nuevo no rompa el update.sh de un clon con filas viejas.

create table if not exists public.capture_forms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9]{8,32}$'),
  kind text not null default 'formulario' check (kind in ('formulario', 'encuesta')),
  name text not null check (length(name) between 1 and 120),
  fields jsonb not null default '[]'::jsonb,
  pipeline_id uuid not null references public.crm_pipelines(id) on delete cascade,
  stage_id uuid not null references public.crm_stages(id) on delete cascade,
  tags text[] not null default '{}'::text[],
  thanks_message text not null default '',
  consent_text text not null default '',
  webhook_source_id uuid references public.webhook_sources(id) on delete set null,
  is_active boolean not null default true,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists capture_forms_org_idx
  on public.capture_forms (organization_id, created_at desc);

comment on table public.capture_forms is
  'Formularios y encuestas públicos del CRM Conectado. El envío entra por webhook_sources/webhook_lead_captures (webhook_source_id); acá solo vive la definición.';

alter table public.capture_forms enable row level security;

drop policy if exists "capture_forms_select" on public.capture_forms;
create policy "capture_forms_select" on public.capture_forms
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

drop policy if exists "capture_forms_manager_write" on public.capture_forms;
create policy "capture_forms_manager_write" on public.capture_forms
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
