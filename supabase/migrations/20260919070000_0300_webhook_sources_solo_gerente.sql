-- 0300_webhook_sources_solo_gerente — aislamiento #7 (gate de 2 orgs, 2026-11-18).
-- Un viewer leía `webhook_sources.path_token` por PostgREST: con él puede inyectar
-- prospectos por /api/v1/webhooks/in/<token>. Toda lectura legítima con sesión ya
-- pasa por requireRole('manager'); el resto usa service role. SELECT pasa a manager.
drop policy if exists "webhook_sources_select" on public.webhook_sources;
create policy "webhook_sources_select" on public.webhook_sources
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );
