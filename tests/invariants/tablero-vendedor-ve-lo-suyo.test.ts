import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Seguridad § 2.4 (medium): «el vendedor ve solo lo suyo» valía solo en la ruta. Con su JWT,
 * un agent llamaba a /rest/v1/rpc/fn_tablero_metrics {p_org, p_owner:null} y recibía las
 * ventas y montos de TODOS cuando visibility_mode='all'. Ahora el owner se fuerza en la función.
 * Corre contra el Postgres de scripts/test-db.sh (baseline.sql aplicado).
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db` (scripts/test-db.sh)");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "cccccccc-0000-4000-8000-0000000000a1";
const MANAGER = "cccccccc-1111-4000-8000-0000000000a1";
const AGENT_1 = "cccccccc-1111-4000-8000-0000000000a2";
const AGENT_2 = "cccccccc-1111-4000-8000-0000000000a3";

/** Ventas (ganados, monto ARS) que ve `user` al pedir la org entera (p_owner = null). */
function ventasComo(user: string, owner: string | null = null): { ganados: number; monto: number } {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${user}"}', false);
    select (v->'ventas'->>'ganados') || '|' || (v->'ventas'->>'monto_ars_cents')
      from (select public.fn_tablero_metrics('${ORG}'::uuid, now() - interval '30 days', now() + interval '1 day',
            ${owner ? `'${owner}'::uuid` : "null"}) as v) t;
  `);
  const [g, m] = out.split("\n").pop()!.split("|");
  return { ganados: Number(g), monto: Number(m) };
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER}', 'tab-m@invariant.test'), ('${AGENT_1}', 'tab-1@invariant.test'), ('${AGENT_2}', 'tab-2@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'tab-inv', 'Tablero Invariant', 'Tablero') on conflict (id) do nothing;
    update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"all"}'::jsonb where id = '${ORG}';
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER}', '${ORG}', 'manager', now()), ('${AGENT_1}', '${ORG}', 'agent', now()), ('${AGENT_2}', '${ORG}', 'agent', now())
      on conflict do nothing;
    do $seed$
    declare v_pipe uuid; v_stage uuid;
    begin
      select id into v_pipe from public.crm_pipelines where organization_id = '${ORG}' and slug = 'tab-inv';
      if v_pipe is null then
        insert into public.crm_pipelines (organization_id, name, slug) values ('${ORG}', 'Tab', 'tab-inv') returning id into v_pipe;
      end if;
      select id into v_stage from public.crm_stages where pipeline_id = v_pipe and slug = 'novo';
      if v_stage is null then
        insert into public.crm_stages (organization_id, pipeline_id, name, slug, position) values ('${ORG}', v_pipe, 'Novo', 'novo', 1000) returning id into v_stage;
      end if;
      if not exists (select 1 from public.crm_leads where organization_id = '${ORG}') then
        insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id, status, closed_at, value_cents, currency) values
          ('${ORG}', v_pipe, v_stage, 'venta 1', '${AGENT_1}', 'won', now(), 100000, 'ARS'),
          ('${ORG}', v_pipe, v_stage, 'venta 2', '${AGENT_2}', 'won', now(), 700000, 'ARS');
      end if;
    end $seed$;
  `);
});

describe("fn_tablero_metrics: el owner se fuerza dentro de la función", () => {
  it("control: el manager ve las ventas de los dos", () => {
    expect(ventasComo(MANAGER)).toEqual({ ganados: 2, monto: 800000 });
  });

  it("el agent que llama a la RPC directo con p_owner null ve SOLO lo suyo", () => {
    expect(ventasComo(AGENT_1)).toEqual({ ganados: 1, monto: 100000 });
    expect(ventasComo(AGENT_2)).toEqual({ ganados: 1, monto: 700000 });
  });

  it("el agent no se destraba pidiendo el owner de otro", () => {
    expect(ventasComo(AGENT_1, AGENT_2)).toEqual({ ganados: 1, monto: 100000 });
  });

  it("anon no puede ejecutar la RPC (revoke)", () => {
    expect(() => sql(`set role anon; select public.fn_tablero_metrics('${ORG}'::uuid, now(), now(), null);`)).toThrow();
  });
});
