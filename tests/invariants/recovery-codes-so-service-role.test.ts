import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * H1 (auditoría 2026-11-13) — `user_recovery_codes` no se toca con la sesión.
 * Antes: GRANT ALL a anon/authenticated + policy `user_id = auth.uid()` sin AAL:
 * una sesión aal1 insertaba el hash de un código propio y `useRecoveryCode`
 * borraba todos los factores TOTP. Prueba bajo role real; service_role sigue
 * con acceso (par de vacuidad).
 */
const UID = "00000000-0000-4000-8000-0000000000a1";

function comoRol(rol: "anon" | "authenticated", consulta: string): string {
  try {
    sql(`
      set role ${rol};
      select set_config('request.jwt.claims', '{"sub":"${UID}","role":"${rol}"}', false);
      ${consulta};
    `);
    return "";
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? "";
  }
}

describe("user_recovery_codes solo con service role (H1)", () => {
  for (const rol of ["authenticated", "anon"] as const) {
    it(`⭐ ${rol} no inserta, lee, actualiza ni borra`, () => {
      expect(
        comoRol(rol, `insert into public.user_recovery_codes(user_id, code_hash) values ('${UID}', '\x00')`),
      ).toMatch(/permission denied/i);
      expect(comoRol(rol, "select 1 from public.user_recovery_codes limit 1")).toMatch(/permission denied/i);
      expect(comoRol(rol, "update public.user_recovery_codes set used_at = now()")).toMatch(/permission denied/i);
      expect(comoRol(rol, "delete from public.user_recovery_codes")).toMatch(/permission denied/i);
    });
  }

  it("par de vacuidad: service_role sí lee la tabla", () => {
    expect(() => sql("set role service_role; select 1 from public.user_recovery_codes limit 1;")).not.toThrow();
  });
});
