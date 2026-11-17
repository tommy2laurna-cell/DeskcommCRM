-- 0280_fusion_de_contactos_hereda_la_baja — seguridad § 2.3 (M18, agravado por las campañas).
--
-- Fusionar dos contactos NO heredaba la baja: un duplicado que pidió «BAJA» (is_blocked y
-- consent.marketing.declined_at), fusionado en uno sin baja, dejaba al sobreviviente apto y
-- recibía marketing masivo. Regla: la baja gana. Se hace con un trigger sobre la lápide
-- (is_merged_into pasa de null a un id) para que valga en TODO camino de fusión, no solo
-- en fn_mesclar_contatos.
--  * is_blocked  = el del principal OR el del absorbido.
--  * declined_at = la más reciente de las dos (si alguna existe).
-- `consent` NO se hereda en lo demás: un granted_at ajeno fabricaría consentimiento.
create or replace function public.fn_fusion_hereda_la_baja()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_baja text;
begin
  if old.is_merged_into is not null or new.is_merged_into is null then
    return new;
  end if;

  v_baja := new.consent #>> '{marketing,declined_at}';

  update public.contacts p
     set is_blocked = p.is_blocked or new.is_blocked,
         consent = case
           when v_baja is null then p.consent
           when (p.consent #>> '{marketing,declined_at}') is not null
                and (p.consent #>> '{marketing,declined_at}')::timestamptz >= v_baja::timestamptz
             then p.consent
           else jsonb_set(
                  coalesce(p.consent, '{}'::jsonb),
                  '{marketing}',
                  coalesce(p.consent -> 'marketing', '{}'::jsonb) || jsonb_build_object('declined_at', v_baja),
                  true)
         end
   where p.id = new.is_merged_into
     and p.organization_id = new.organization_id
     and (
       (new.is_blocked and not p.is_blocked)
       or (v_baja is not null)
     );
  return new;
end;
$$;

drop trigger if exists trg_fusion_hereda_la_baja on public.contacts;
create trigger trg_fusion_hereda_la_baja
  after update of is_merged_into on public.contacts
  for each row execute function public.fn_fusion_hereda_la_baja();

revoke execute on function public.fn_fusion_hereda_la_baja() from public, anon, authenticated;
