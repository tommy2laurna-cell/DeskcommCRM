-- ============================================================================
-- 0277 — PRESUPUESTOS desde un negocio (GC3)
--
-- Un presupuesto es lo que se le prometió a un cliente: qué, cuántas unidades,
-- a qué precio, con qué descuento y hasta cuándo vale. Por eso cada línea es una
-- FOTO del producto (`descripcion` y `precio_unit_cents` se copian al emitirlo):
-- si el catálogo sube el precio la semana que viene, el presupuesto que ya salió
-- no cambia. `producto_id` queda solo como referencia y se anula si el producto
-- se borra.
--
-- El dinero va en `_cents` + `moneda` (la de la organización, ARS por defecto).
-- `total_cents = subtotal_cents - descuento_cents` lo exige un CHECK: el PDF y la
-- pantalla leen la misma cifra y no pueden discrepar.
--
-- NO es facturación fiscal. El recibo es un comprobante interno y el PDF lo dice
-- («Comprobante no válido como factura»). El CRM tampoco cobra (decisión de
-- cobros del 10/11): `recibo_*` solo registra que el cobro se hizo por fuera.
--
-- RLS: leer es de toda la organización; escribir es `agent` o más. Mismo molde
-- que `catalog_products`, con el piso más bajo porque quien atiende arma el
-- presupuesto.
-- ============================================================================

create table if not exists public.presupuestos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,

  -- Correlativo por organización (1, 2, 3…): es lo que el cliente ve en el PDF.
  numero integer not null,
  estado text not null default 'emitido',

  moneda text not null default 'ARS',
  subtotal_cents bigint not null,
  descuento_pct numeric(5,2) not null default 0,
  descuento_cents bigint not null default 0,
  total_cents bigint not null,

  valido_hasta date not null,
  notas text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,

  -- Cobro registrado a mano (efectivo, transferencia…). El CRM no mueve plata.
  recibo_emitido_at timestamptz,
  recibo_medio text,

  constraint presupuestos_estado_valido check (estado in ('emitido', 'aceptado', 'rechazado')),
  constraint presupuestos_moneda_iso check (moneda ~ '^[A-Z]{3}$'),
  constraint presupuestos_montos_no_negativos
    check (subtotal_cents >= 0 and descuento_cents >= 0 and total_cents >= 0),
  constraint presupuestos_descuento_pct_rango check (descuento_pct >= 0 and descuento_pct <= 100),
  constraint presupuestos_total_cierra check (total_cents = subtotal_cents - descuento_cents),
  constraint presupuestos_recibo_solo_si_aceptado
    check (recibo_emitido_at is null or estado = 'aceptado')
);

create unique index if not exists presupuestos_org_numero_key
  on public.presupuestos (organization_id, numero);
create index if not exists presupuestos_lead_idx
  on public.presupuestos (lead_id, created_at desc);

create table if not exists public.presupuesto_items (
  id uuid primary key default gen_random_uuid(),
  presupuesto_id uuid not null references public.presupuestos(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  producto_id uuid references public.catalog_products(id) on delete set null,
  descripcion text not null,
  cantidad integer not null,
  precio_unit_cents bigint not null,
  total_cents bigint not null,
  position integer not null default 0,

  constraint presupuesto_items_cantidad_positiva check (cantidad > 0),
  constraint presupuesto_items_precio_no_negativo check (precio_unit_cents >= 0),
  constraint presupuesto_items_total_cierra check (total_cents = cantidad * precio_unit_cents)
);

create index if not exists presupuesto_items_presupuesto_idx
  on public.presupuesto_items (presupuesto_id, position);

alter table public.presupuestos enable row level security;
alter table public.presupuesto_items enable row level security;

drop policy if exists presupuestos_select on public.presupuestos;
create policy presupuestos_select on public.presupuestos
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists presupuestos_write on public.presupuestos;
create policy presupuestos_write on public.presupuestos
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists presupuesto_items_select on public.presupuesto_items;
create policy presupuesto_items_select on public.presupuesto_items
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists presupuesto_items_write on public.presupuesto_items;
create policy presupuesto_items_write on public.presupuesto_items
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

-- El default privilege del baseline le da todo a `anon`: se retira (el catálogo
-- y los montos de un cliente no se leen con la anon key del navegador).
revoke all on public.presupuestos from anon;
revoke all on public.presupuesto_items from anon;
grant select, insert, update, delete on public.presupuestos to authenticated;
grant select, insert, update, delete on public.presupuesto_items to authenticated;
grant all on public.presupuestos to service_role;
grant all on public.presupuesto_items to service_role;

-- ── Crear un presupuesto: cabecera + líneas en UNA transacción ─────────────
--
-- El número correlativo se toma bajo un lock por organización: dos agentes que
-- emiten a la vez no pueden llevarse el mismo número ni dejar un hueco por un
-- insert que falló a la mitad. `security invoker`: corre con la RLS de quien
-- llama, así que un agente de otra organización no escribe en ésta.
create or replace function public.fn_crear_presupuesto(
  p_organization_id uuid,
  p_lead_id uuid,
  p_moneda text,
  p_descuento_pct numeric,
  p_valido_hasta date,
  p_notas text,
  p_items jsonb
) returns public.presupuestos
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_numero integer;
  v_subtotal bigint;
  v_descuento bigint;
  v_row public.presupuestos;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 277));

  if not exists (
    select 1 from public.crm_leads
     where id = p_lead_id and organization_id = p_organization_id
  ) then
    raise exception 'lead_no_encontrado' using errcode = 'P0002';
  end if;

  select coalesce(max(numero), 0) + 1 into v_numero
    from public.presupuestos where organization_id = p_organization_id;

  select coalesce(sum((i->>'cantidad')::int * (i->>'precio_unit_cents')::bigint), 0)
    into v_subtotal
    from jsonb_array_elements(p_items) i;

  v_descuento := round(v_subtotal * round(p_descuento_pct * 100) / 10000.0);

  insert into public.presupuestos (
    organization_id, lead_id, numero, moneda, subtotal_cents, descuento_pct,
    descuento_cents, total_cents, valido_hasta, notas, created_by
  ) values (
    p_organization_id, p_lead_id, v_numero, p_moneda, v_subtotal, p_descuento_pct,
    v_descuento, v_subtotal - v_descuento, p_valido_hasta, p_notas, auth.uid()
  ) returning * into v_row;

  insert into public.presupuesto_items (
    presupuesto_id, organization_id, producto_id, descripcion, cantidad,
    precio_unit_cents, total_cents, position
  )
  select v_row.id, p_organization_id,
         nullif(i.item->>'producto_id', '')::uuid,
         i.item->>'descripcion',
         (i.item->>'cantidad')::int,
         (i.item->>'precio_unit_cents')::bigint,
         (i.item->>'cantidad')::int * (i.item->>'precio_unit_cents')::bigint,
         (i.ord - 1)::int
    from jsonb_array_elements(p_items) with ordinality as i(item, ord);

  return v_row;
end;
$$;

revoke all on function public.fn_crear_presupuesto(uuid, uuid, text, numeric, date, text, jsonb) from public, anon;
grant execute on function public.fn_crear_presupuesto(uuid, uuid, text, numeric, date, text, jsonb)
  to authenticated, service_role;

notify pgrst, 'reload schema';
