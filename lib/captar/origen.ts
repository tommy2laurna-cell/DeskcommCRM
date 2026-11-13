/**
 * Lo que la ficha de un contacto muestra de DÓNDE vino, además de `source`:
 * el formulario, la campaña y la fuente (`utm_*`) que quedaron en
 * `source_metadata` al captarlo. Los rótulos son claves del diccionario.
 */
const CAMPOS: [rotulo: string, clave: string][] = [
  ["Formulário", "formulario_nombre"],
  ["Campanha", "utm_campaign"],
  ["Fonte", "utm_source"],
  ["Meio", "utm_medium"],
];

export function detallesDeOrigen(meta: unknown): [string, string][] {
  if (!meta || typeof meta !== "object") return [];
  const m = meta as Record<string, unknown>;
  const out: [string, string][] = [];
  for (const [rotulo, clave] of CAMPOS) {
    const v = m[clave];
    if (typeof v === "string" && v.trim()) out.push([rotulo, v.trim().slice(0, 200)]);
  }
  return out;
}
