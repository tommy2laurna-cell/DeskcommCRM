-- 0277 — `user_recovery_codes` só se toca com service role (auditoria 2026-11-13, H1).
--
-- A tabela tinha GRANT ALL a anon e authenticated com a policy `user_id = auth.uid()`
-- e sem AAL: quem tinha só a senha (aal1) inseria o hash de um código que ele
-- escolhia e depois usava `useRecoveryCode`, que apaga todos os fatores TOTP.
-- Toda escrita legítima (confirmMfaEnroll, regenerateRecoveryCodes,
-- useRecoveryCode) já usa o admin client; a leitura também. Sem acesso direto,
-- o bypass some.

revoke all on table public.user_recovery_codes from anon, authenticated;
