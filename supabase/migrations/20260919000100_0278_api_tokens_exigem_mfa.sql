-- 0278 — `api_tokens` só se cria com sessão de MFA provada (auditoria 2026-11-14, H1, 2ª metade).
--
-- Um admin com sessão aal1 (só a senha) inseria um `api_tokens` próprio: token
-- persistente que sobrevive à sessão e não passa por MFA. O insert vem do
-- client da sessão (app/api/v1/settings/api-tokens/route.ts), então a barreira
-- tem que estar na RLS. Policy RESTRICTIVE: soma-se (AND) a `api_tokens_admin_only`.
-- `fn_session_mfa_proven()` é stable e só olha a própria sessão: o EXECUTE a
-- `authenticated` é necessário porque a policy roda com o papel de quem consulta.

grant execute on function public.fn_session_mfa_proven() to authenticated;

drop policy if exists api_tokens_insert_exige_mfa on public.api_tokens;
create policy api_tokens_insert_exige_mfa on public.api_tokens
  as restrictive for insert to authenticated
  with check (public.fn_session_mfa_proven());
