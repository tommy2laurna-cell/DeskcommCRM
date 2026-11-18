import { describe, expect, it } from "vitest";

import { NAV_DESTINATIONS, sidebarGroups } from "@/lib/navigation/registry";
import { destinosDaInterface } from "@/lib/navigation/interface";

/**
 * Decisão de 2026-11-12: Meta Ads não aparece no Conectado. A configuração
 * existente (`interface.destinos`) é opt-in por vínculo e o padrão é "completa",
 * então não esconde nada por padrão — a porta sai do registro.
 */
const OCULTAS = ["/app/ads/meta", "/app/settings/meta-ads"];

describe("Meta Ads fora da navegação", () => {
  it("nenhuma das duas telas está no registro", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    for (const h of OCULTAS) expect(hrefs).not.toContain(h);
  });

  it("nem o sidebar nem a interface completa as mostram, para nenhum papel", () => {
    for (const role of ["viewer", "manager", "admin"] as const) {
      const sidebar = sidebarGroups(false, role).flatMap((g) => g.items.map((i) => i.href));
      const completa = destinosDaInterface(undefined, false, role).map((d) => d.href);
      for (const h of OCULTAS) {
        expect(sidebar).not.toContain(h);
        expect(completa).not.toContain(h);
      }
    }
  });
});
