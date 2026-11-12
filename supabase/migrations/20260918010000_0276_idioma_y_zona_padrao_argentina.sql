-- 0276 — idioma e fuso padrão de organização nova: español e Buenos Aires.
--
-- Só muda o DEFAULT de duas colunas; nenhuma linha existente é tocada, então
-- instalação em uso mantém o idioma e o fuso que já tinha.
--
-- `organizations.locale` alimenta a cadeia preferência da pessoa → idioma da
-- organização → padrão (lib/auth/server.ts): é o elo que faz o idioma da
-- instalação chegar a quem entra sem ter aberto o perfil.
--
-- O baseline reaplica o `CREATE TABLE IF NOT EXISTS` sem tocar tabela existente;
-- por isso o mesmo bloco vai no apêndice do baseline, para o update.sh também
-- acertar o default de quem já instalou.

alter table public.organizations
  alter column locale set default 'es';

alter table public.organizations
  alter column timezone set default 'America/Argentina/Buenos_Aires';
