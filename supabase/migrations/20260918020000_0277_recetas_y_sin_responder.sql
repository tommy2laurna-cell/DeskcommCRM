-- 0277 — recetas de automatización y filtro «sin responder».
-- Idempotente; el mismo bloque va en el apéndice del baseline.

-- ---- recetas de automatización y filtro «sin responder» (migration 0277) ----
-- `recipe_key` marca qué filas de automation_rules vienen del catálogo de recetas
-- (lib/recetas/catalogo.ts): una por receta y organización, para que «prender» sea
-- idempotente. `sin_responder` es la cuenta «escribió y nadie contestó» hecha en la
-- base, porque la API pagina y filtrar después en memoria devolvería páginas cortas.
alter table public.automation_rules
  add column if not exists recipe_key text;

create unique index if not exists uniq_automation_rules_recipe
  on public.automation_rules (organization_id, recipe_key)
  where recipe_key is not null;

alter table public.conversations
  add column if not exists sin_responder boolean
  generated always as (
    last_inbound_at is not null
    and (last_outbound_at is null or last_outbound_at < last_inbound_at)
  ) stored;
