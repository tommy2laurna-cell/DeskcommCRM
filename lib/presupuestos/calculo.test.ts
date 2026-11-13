import { describe, expect, it } from "vitest";

import {
  calcularTotales,
  estaVencido,
  hoyEnZona,
  presupuestoCreateSchema,
  RECIBO_LEYENDA,
} from "./calculo";

describe("calcularTotales", () => {
  it("suma líneas y descuenta sobre el subtotal, en centavos enteros", () => {
    const r = calcularTotales(
      [
        { cantidad: 2, precioUnitCents: 150_050 },
        { cantidad: 1, precioUnitCents: 99_999 },
      ],
      10,
    );
    expect(r.subtotalCents).toBe(400_099);
    expect(r.descuentoCents).toBe(40_010); // 40 009,9 → redondea una sola vez
    expect(r.totalCents).toBe(r.subtotalCents - r.descuentoCents);
    expect(Number.isInteger(r.totalCents)).toBe(true);
  });

  it("sin descuento el total es el subtotal", () => {
    const r = calcularTotales([{ cantidad: 3, precioUnitCents: 1_000 }], 0);
    expect(r).toMatchObject({ subtotalCents: 3_000, descuentoCents: 0, totalCents: 3_000 });
  });

  it("100 % deja el total en cero y no negativo", () => {
    const r = calcularTotales([{ cantidad: 1, precioUnitCents: 5_000 }], 100);
    expect(r.totalCents).toBe(0);
  });

  it("acepta porcentajes con dos decimales sin deriva de flotantes", () => {
    const r = calcularTotales([{ cantidad: 1, precioUnitCents: 10_000 }], 12.5);
    expect(r.descuentoCents).toBe(1_250);
  });
});

describe("vencimiento", () => {
  it("el último día de validez todavía vale; el siguiente no", () => {
    expect(estaVencido("2026-11-13", "2026-11-13")).toBe(false);
    expect(estaVencido("2026-11-13", "2026-11-14")).toBe(true);
  });

  it("hoyEnZona usa la zona de la organización, no la del servidor", () => {
    // 02:00 UTC del 14 sigue siendo 13 en Buenos Aires (UTC−3).
    const ahora = new Date("2026-11-14T02:00:00Z");
    expect(hoyEnZona("America/Argentina/Buenos_Aires", ahora)).toBe("2026-11-13");
    expect(hoyEnZona("UTC", ahora)).toBe("2026-11-14");
  });
});

describe("presupuestoCreateSchema", () => {
  const ok = {
    items: [{ producto_id: "5f1c1f0e-4c1a-4b1e-9c53-0f4f3d0f2a11", cantidad: 2 }],
    valido_hasta: "2026-12-01",
  };

  it("completa el descuento en 0 y rechaza cantidades inválidas", () => {
    expect(presupuestoCreateSchema.parse(ok).descuento_pct).toBe(0);
    expect(
      presupuestoCreateSchema.safeParse({ ...ok, items: [{ ...ok.items[0], cantidad: 0 }] }).success,
    ).toBe(false);
    expect(presupuestoCreateSchema.safeParse({ ...ok, items: [] }).success).toBe(false);
  });

  it("rechaza descuentos fuera de 0–100 y fechas mal formadas", () => {
    expect(presupuestoCreateSchema.safeParse({ ...ok, descuento_pct: 101 }).success).toBe(false);
    expect(presupuestoCreateSchema.safeParse({ ...ok, valido_hasta: "1/12/2026" }).success).toBe(false);
  });
});

describe("recibo", () => {
  it("la leyenda es la exacta que pidió el negocio", () => {
    expect(RECIBO_LEYENDA).toBe("Comprobante no válido como factura");
  });
});
