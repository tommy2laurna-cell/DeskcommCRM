import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Seguridad § 2.3 (M18, agravado por las campañas): fusionar contactos no heredaba la baja.
 * A pidió «BAJA» (is_blocked + consent.marketing.declined_at), se fusiona en B (sin baja) y B
 * quedaba apto para marketing masivo. La baja gana en la fusión.
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

const ORG = "dddddddd-0000-4000-8000-0000000000b1";
const ID = (n: number) => `dddddddd-3333-4000-8000-00000000000${n}`;

/** Siembra dos contactos; `baja` marca al absorbido con la baja de marketing. */
function sembrar(par: number, opts: { absorbidoConBaja: boolean; principalBloqueado?: boolean }): { principal: string; absorbido: string } {
  const principal = ID(par * 2);
  const absorbido = ID(par * 2 + 1);
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'fus-inv', 'Fusion Invariant', 'Fusion') on conflict (id) do nothing;
    delete from public.contacts where id in ('${principal}', '${absorbido}');
    insert into public.contacts (id, organization_id, display_name, phone_number, is_blocked, consent) values
      ('${principal}', '${ORG}', 'Principal ${par}', '+54911000000${par}1', ${opts.principalBloqueado ? "true" : "false"}, '{}'::jsonb),
      ('${absorbido}', '${ORG}', 'Absorbido ${par}', '+54911000000${par}2', ${opts.absorbidoConBaja ? "true" : "false"},
        ${opts.absorbidoConBaja ? `'{"marketing":{"declined_at":"2026-11-10T12:00:00.000Z"}}'::jsonb` : "'{}'::jsonb"});
    select public.fn_mesclar_contatos('${ORG}'::uuid, '${principal}'::uuid, array['${absorbido}']::uuid[]);
  `);
  return { principal, absorbido };
}

const leer = (id: string) =>
  sql(`select is_blocked::text || '|' || coalesce(consent #>> '{marketing,declined_at}', '-') from public.contacts where id = '${id}';`);

beforeAll(() => {
  sql(`select 1`);
});

describe("fusión de contactos: la baja del absorbido la hereda el sobreviviente", () => {
  it("A con BAJA se fusiona en B limpio: B queda bloqueado y con declined_at", () => {
    const { principal } = sembrar(1, { absorbidoConBaja: true });
    const [bloqueado, declined] = leer(principal).split("|");
    expect(bloqueado).toBe("true");
    expect(declined).toMatch(/^2026-11-10T12:00:00/);
  });

  it("control: si ninguno pidió la baja, el sobreviviente sigue apto", () => {
    const { principal } = sembrar(2, { absorbidoConBaja: false });
    expect(leer(principal)).toBe("false|-");
  });

  it("control: un sobreviviente que ya estaba bloqueado no se desbloquea", () => {
    const { principal } = sembrar(3, { absorbidoConBaja: false, principalBloqueado: true });
    expect(leer(principal).split("|")[0]).toBe("true");
  });
});
