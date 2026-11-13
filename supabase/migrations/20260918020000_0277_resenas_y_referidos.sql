-- ============================================================================
-- 0277 — PEDIDO DE RESEÑA DESPUÉS DE GANAR, Y QUIÉN RECOMENDÓ A QUIÉN
--
-- 1) `review_requests`: una fila por negocio ganado (unique(lead_id) = idempotente).
--    Quien la llena y la consume es el cron `cron/review-requests`; el cliente
--    solo la LEE (RLS org-flat). Sin policy de escritura para `authenticated`:
--    la escritura es del servidor, con `organization_id` resuelto del negocio.
-- 2) `contacts.referred_by_contact_id`: «Lo recomendó». on delete set null —
--    borrar a quien recomendó no puede borrar al recomendado. Que sea de la misma
--    organización lo verifica la ruta (una FK simple no puede).
-- ============================================================================

create table if not exists public.review_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  due_at timestamptz not null,
  sent_at timestamptz,
  status text not null default 'pendiente'
    check (status in ('pendiente', 'enviado', 'sin_configurar', 'omitido', 'fallido')),
  error text,
  created_at timestamptz not null default now(),
  constraint review_requests_lead_id_key unique (lead_id)
);

create index if not exists review_requests_org_status_due_idx
  on public.review_requests (organization_id, status, due_at);

alter table public.review_requests enable row level security;

drop policy if exists review_requests_select on public.review_requests;
create policy review_requests_select on public.review_requests
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

revoke all on public.review_requests from anon;

alter table public.contacts
  add column if not exists referred_by_contact_id uuid
  references public.contacts(id) on delete set null;

create index if not exists contacts_referred_by_idx
  on public.contacts (organization_id, referred_by_contact_id)
  where referred_by_contact_id is not null;

notify pgrst, 'reload schema';
