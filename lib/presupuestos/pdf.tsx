/**
 * El PDF del presupuesto y el del recibo, con la marca DEL CLIENTE.
 *
 * ── Colores en hex, siempre ──────────────────────────────────────────────────
 * `@react-pdf` descarta en silencio `var(--x)` y `oklch()`: el PDF sale válido y
 * sin la marca (mismo hallazgo que documenta `lib/lgpd/pdf-renderer.tsx`).
 * `marcaDaSaida` ya entrega `#hex` + un color de frente con contraste, que es lo
 * único que este archivo usa. Por eso los estilos se arman DENTRO del render, con
 * la marca como parámetro, y no a nivel de módulo.
 *
 * ── El logo ──────────────────────────────────────────────────────────────────
 * Solo PNG o JPG (react-pdf no dibuja webp ni svg) y solo si viene de nuestro
 * propio storage: `logoUrl` puede ser una URL pegada a mano, y pedirla desde el
 * servidor sin filtro sería un SSRF. Si no se puede, se imprime el nombre.
 *
 * ── Qué NO es ────────────────────────────────────────────────────────────────
 * No es una factura. El recibo lleva la leyenda de `RECIBO_LEYENDA` en grande.
 */
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import React from "react";

import { env } from "@/lib/env";
import { formatCents } from "@/lib/money";
import type { MarcaDeSaida } from "@/lib/branding/saida";

import { RECIBO_LEYENDA } from "./calculo";

export interface DatosDelDocumento {
  marca: Pick<MarcaDeSaida, "nome" | "accent" | "accentFg">;
  /** Logo ya resuelto a data URI (o null). Lo arma `logoParaPdf`. */
  logoDataUri: string | null;
  numero: number;
  moneda: string;
  clienteNombre: string | null;
  fechaEmision: string;
  validoHasta: string;
  lineas: Array<{ descripcion: string; cantidad: number; precioUnitCents: number; totalCents: number }>;
  subtotalCents: number;
  descuentoPct: number;
  descuentoCents: number;
  totalCents: number;
  notas: string | null;
}

export interface DatosDelRecibo extends DatosDelDocumento {
  medio: string;
  fechaDePago: string;
}

const pad = (n: number) => String(n).padStart(4, "0");

function estilos(m: DatosDelDocumento["marca"]) {
  return StyleSheet.create({
    page: { padding: 36, fontSize: 10, fontFamily: "Helvetica", color: "#1f2937" },
    banda: {
      backgroundColor: m.accent,
      color: m.accentFg,
      padding: 14,
      marginBottom: 18,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    marcaNombre: { fontSize: 16, fontWeight: 700, color: m.accentFg },
    logo: { height: 34, objectFit: "contain" },
    titulo: { fontSize: 14, marginBottom: 4 },
    meta: { color: "#4b5563", marginBottom: 2 },
    tablaCab: {
      flexDirection: "row",
      borderBottom: `1.5pt solid ${m.accent}`,
      paddingBottom: 4,
      marginTop: 16,
      fontWeight: 700,
    },
    fila: { flexDirection: "row", borderBottom: "0.5pt solid #e5e7eb", paddingVertical: 4 },
    cDesc: { flex: 5 },
    cCant: { flex: 1, textAlign: "right" },
    cPrecio: { flex: 2, textAlign: "right" },
    cTotal: { flex: 2, textAlign: "right" },
    totales: { marginTop: 12, alignSelf: "flex-end", width: 200 },
    filaTotal: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
    total: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: 4,
      paddingTop: 4,
      borderTop: `1.5pt solid ${m.accent}`,
      fontSize: 12,
      fontWeight: 700,
    },
    notas: { marginTop: 18, color: "#374151" },
    leyenda: {
      marginTop: 24,
      padding: 10,
      border: `1.5pt solid ${m.accent}`,
      textAlign: "center",
      fontSize: 13,
      fontWeight: 700,
    },
    pie: { position: "absolute", bottom: 24, left: 36, right: 36, color: "#6b7280", fontSize: 8 },
  });
}

function Encabezado({ d, s }: { d: DatosDelDocumento; s: ReturnType<typeof estilos> }) {
  return (
    <View style={s.banda}>
      {d.logoDataUri ? (
        <Image src={d.logoDataUri} style={s.logo} />
      ) : (
        <Text style={s.marcaNombre}>{d.marca.nome}</Text>
      )}
    </View>
  );
}

function Lineas({ d, s }: { d: DatosDelDocumento; s: ReturnType<typeof estilos> }) {
  const money = (c: number) => formatCents(c, d.moneda);
  return (
    <View>
      <View style={s.tablaCab}>
        <Text style={s.cDesc}>Descripción</Text>
        <Text style={s.cCant}>Cant.</Text>
        <Text style={s.cPrecio}>Precio</Text>
        <Text style={s.cTotal}>Importe</Text>
      </View>
      {d.lineas.map((l, i) => (
        <View key={i} style={s.fila} wrap={false}>
          <Text style={s.cDesc}>{l.descripcion}</Text>
          <Text style={s.cCant}>{l.cantidad}</Text>
          <Text style={s.cPrecio}>{money(l.precioUnitCents)}</Text>
          <Text style={s.cTotal}>{money(l.totalCents)}</Text>
        </View>
      ))}
      <View style={s.totales}>
        <View style={s.filaTotal}>
          <Text>Subtotal</Text>
          <Text>{money(d.subtotalCents)}</Text>
        </View>
        {d.descuentoCents > 0 ? (
          <View style={s.filaTotal}>
            <Text>Descuento ({d.descuentoPct}%)</Text>
            <Text>- {money(d.descuentoCents)}</Text>
          </View>
        ) : null}
        <View style={s.total}>
          <Text>Total</Text>
          <Text>{money(d.totalCents)}</Text>
        </View>
      </View>
    </View>
  );
}

export function PresupuestoDocument({ d }: { d: DatosDelDocumento }) {
  const s = estilos(d.marca);
  return (
    <Document title={`Presupuesto N° ${pad(d.numero)}`} author={d.marca.nome}>
      <Page size="A4" style={s.page}>
        <Encabezado d={d} s={s} />
        <Text style={s.titulo}>Presupuesto N° {pad(d.numero)}</Text>
        {d.clienteNombre ? <Text style={s.meta}>Para: {d.clienteNombre}</Text> : null}
        <Text style={s.meta}>Fecha: {d.fechaEmision}</Text>
        <Text style={s.meta}>Válido hasta: {d.validoHasta}</Text>
        <Lineas d={d} s={s} />
        {d.notas ? <Text style={s.notas}>{d.notas}</Text> : null}
        <Text style={s.pie} fixed>
          {d.marca.nome}
        </Text>
      </Page>
    </Document>
  );
}

export function ReciboDocument({ d }: { d: DatosDelRecibo }) {
  const s = estilos(d.marca);
  return (
    <Document title={`Recibo - Presupuesto N° ${pad(d.numero)}`} author={d.marca.nome}>
      <Page size="A4" style={s.page}>
        <Encabezado d={d} s={s} />
        <Text style={s.titulo}>Recibo - Presupuesto N° {pad(d.numero)}</Text>
        {d.clienteNombre ? <Text style={s.meta}>Recibimos de: {d.clienteNombre}</Text> : null}
        <Text style={s.meta}>Fecha de pago: {d.fechaDePago}</Text>
        <Text style={s.meta}>Medio de pago: {d.medio}</Text>
        <Lineas d={d} s={s} />
        <Text style={s.leyenda}>{RECIBO_LEYENDA}</Text>
        <Text style={s.pie} fixed>
          {d.marca.nome}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderPresupuestoPdf(d: DatosDelDocumento): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(<PresupuestoDocument d={d} />));
}

export async function renderReciboPdf(d: DatosDelRecibo): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(<ReciboDocument d={d} />));
}

/**
 * El logo como data URI, o `null`. Nunca lanza: sin logo el PDF sigue saliendo,
 * con el nombre de la marca en la banda.
 */
export async function logoParaPdf(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null;
  try {
    const u = new URL(logoUrl);
    if (u.origin !== new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    const tipo = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (tipo !== "image/png" && tipo !== "image/jpeg") return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 1_000_000) return null;
    return `data:${tipo};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
