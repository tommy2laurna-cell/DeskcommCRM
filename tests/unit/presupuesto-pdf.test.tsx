// @vitest-environment node
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import {
  renderPresupuestoPdf,
  renderReciboPdf,
  type DatosDelDocumento,
  type DatosDelRecibo,
} from "@/lib/presupuestos/pdf";

/**
 * EL PDF DEL PRESUPUESTO LLEVA LA MARCA DEL CLIENTE, LOS NÚMEROS CORRECTOS Y,
 * EL RECIBO, LA LEYENDA.
 *
 * «El PDF salió y abre» no prueba nada: `@react-pdf` genera un PDF válido aunque
 * descarte el color (pasa con `var(--x)` y `oklch()`). Por eso acá se lee el
 * contenido: el texto con pdfjs y los colores del flujo de dibujo, inflando los
 * streams.
 */

const base: DatosDelDocumento = {
  marca: { nome: "Muebles Pampa", accent: "#112233", accentFg: "#ffffff" },
  logoDataUri: null,
  numero: 7,
  moneda: "ARS",
  clienteNombre: "Lucía Fernández",
  fechaEmision: "13/11/2026",
  validoHasta: "27/11/2026",
  lineas: [
    { descripcion: "Mesa ratona de pino", cantidad: 2, precioUnitCents: 15_000_000, totalCents: 30_000_000 },
    { descripcion: "Silla apilable", cantidad: 4, precioUnitCents: 2_500_000, totalCents: 10_000_000 },
  ],
  subtotalCents: 40_000_000,
  descuentoPct: 10,
  descuentoCents: 4_000_000,
  totalCents: 36_000_000,
  notas: "Entrega en 15 días hábiles.",
};

function coloresDeRelleno(pdf: Buffer): Array<[number, number, number]> {
  const crudo = pdf.toString("latin1");
  const out: Array<[number, number, number]> = [];
  for (const m of crudo.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let texto: string;
    try {
      texto = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const c of texto.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG|scn|SCN)/g)) {
      out.push([Number(c[1]), Number(c[2]), Number(c[3])]);
    }
  }
  return out;
}

const cerca = (a: number, b: number) => Math.abs(a - b) < 0.01;

describe("PDF del presupuesto", () => {
  it("es un PDF con el número, las líneas y los totales correctos", async () => {
    const pdf = await renderPresupuestoPdf(base);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    const texto = await extractPdfText(pdf);
    expect(texto).toContain("Presupuesto N° 0007");
    expect(texto).toContain("Lucía Fernández");
    expect(texto).toContain("Mesa ratona de pino");
    expect(texto).toContain("Descuento (10%)");
    // 360.000,00 en formato argentino: el total es subtotal menos descuento.
    expect(texto.replace(/\s/g, "")).toMatch(/360\.000,00/);
    expect(texto).toContain("Entrega en 15 días hábiles.");
    expect(texto).not.toContain("Comprobante no válido como factura");
  });

  it("pinta con el color de la marca del cliente (no con uno fijo)", async () => {
    const conMarca = coloresDeRelleno(await renderPresupuestoPdf(base));
    const otra = coloresDeRelleno(
      await renderPresupuestoPdf({ ...base, marca: { ...base.marca, accent: "#aa5500" } }),
    );
    const [r, g, b] = [0x11 / 255, 0x22 / 255, 0x33 / 255];
    expect(conMarca.some(([x, y, z]) => cerca(x, r) && cerca(y, g) && cerca(z, b))).toBe(true);
    expect(otra.some(([x, y, z]) => cerca(x, r) && cerca(y, g) && cerca(z, b))).toBe(false);
    expect(otra.some(([x, y, z]) => cerca(x, 0xaa / 255) && cerca(y, 0x55 / 255) && cerca(z, 0))).toBe(
      true,
    );
  });

  it("sin logo imprime el nombre de la marca", async () => {
    const texto = await extractPdfText(await renderPresupuestoPdf(base));
    expect(texto).toContain("Muebles Pampa");
  });
});

describe("PDF del recibo", () => {
  const recibo: DatosDelRecibo = { ...base, medio: "Transferencia", fechaDePago: "14/11/2026" };

  it("lleva la leyenda «Comprobante no válido como factura»", async () => {
    const texto = await extractPdfText(await renderReciboPdf(recibo));
    expect(texto).toContain("Comprobante no válido como factura");
    expect(texto).toContain("Recibo - Presupuesto N° 0007");
    expect(texto).toContain("Transferencia");
  });
});
