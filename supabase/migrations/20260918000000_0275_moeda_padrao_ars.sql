-- 0275 — a moeda padrão passa a ser o peso argentino (ARS).
--
-- Só muda o DEFAULT de duas colunas; nenhuma linha existente é tocada, então
-- instalação em uso mantém a moeda que já tinha.
--
-- `organizations.currency` é a fonte da moeda do negócio (0208): organização
-- nova nasce sem declarar moeda e herdava BRL. `crm_leads.currency` cobre o
-- lead criado por caminho que não passa pelo app (função SQL, gatilho).
-- O app grava a moeda da organização explícita (`moedaDaOrganizacao`).
--
-- O baseline reaplica o `set default 'BRL'` da 0208 a cada update; por isso o
-- mesmo bloco vai no apêndice do baseline, DEPOIS dela.

alter table public.organizations
  alter column currency set default 'ARS';

alter table public.crm_leads
  alter column currency set default 'ARS';
