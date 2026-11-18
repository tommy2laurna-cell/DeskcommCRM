-- 0300_webhook_sources_solo_gerente — aislamiento (gate de 2 orgs, 2026-11-18).
--
-- #7: un viewer leía `webhook_sources.path_token` por PostgREST: con él puede
-- inyectar prospectos por /api/v1/webhooks/in/<token>. Toda lectura legítima con
-- sesión ya pasa por requireRole('manager'); el resto usa service role.
drop policy if exists "webhook_sources_select" on public.webhook_sources;
create policy "webhook_sources_select" on public.webhook_sources
  for select using (
    -- migration 0300: solo manager lee (path_token); antes cualquier miembro
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- #4: una org suspendida (o archivada) no da rol a nadie: requireRole y toda
-- policy que lea el rol cierran solas, sin un chequeo por ruta.
create or replace function public.fn_user_role_in_org(p_org uuid)
returns text language sql stable security definer set search_path = public as $f$
 select case when not exists (select 1 from public.organizations o where o.id=p_org and o.status='active') then null
 when s->>'status'='active' and (s->>'organization_id')::uuid=p_org
 then case when s->>'access_mode'='full' then 'admin' else 'viewer' end
 else (select role from public.user_organizations where user_id=auth.uid() and organization_id=p_org and revoked_at is null limit 1) end
 from (select public.fn_support_context() s) c;
$f$;
