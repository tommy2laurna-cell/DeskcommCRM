/**
 * Interpola variables de una respuesta rápida con datos del contacto de la conversa.
 *
 * Acepta las dos grafías, `{nombre}` y `{{nombre}}`:
 *   {nombre} / {{nombre}}                  nombre completo
 *   {primeiro_nome} / {primer_nombre}      primer nombre
 *   {turno} / {{turno}}                    el próximo turno confirmado, ya formateado
 * Una variable sin valor o desconocida deja el literal tal cual: nunca sale al
 * cliente un texto roto ni un hueco donde iba el nombre.
 */
export interface TemplateContact {
  name?: string | null;
  /** Próximo turno ya formateado (ver `lib/recetas/turno.ts`). */
  turno?: string | null;
}

/** ¿El texto pide el turno? Sirve para no consultar la agenda si no hace falta. */
export function usaTurno(body: string): boolean {
  return /\{\{\s*turno\s*\}\}|\{turno\}/i.test(body);
}

export function interpolateTemplate(body: string, contact: TemplateContact): string {
  const full = (contact.name ?? "").trim();
  const first = full.split(/\s+/)[0] ?? "";
  const turno = (contact.turno ?? "").trim();
  return body.replace(
    /\{\{\s*([a-zA-Z_]+)\s*\}\}|\{([a-zA-Z_]+)\}/g,
    (literal, doble: string | undefined, simple: string | undefined) => {
      const key = (doble ?? simple ?? "").toLowerCase();
      if (key === "nome" || key === "nombre") return full !== "" ? full : literal;
      if (key === "primeiro_nome" || key === "primer_nombre") return first !== "" ? first : literal;
      if (key === "turno") return turno !== "" ? turno : literal;
      return literal; // desconhecida: mantém
    },
  );
}

/** El primer turno que todavía no pasó, de una lista sin orden garantizado. */
export function proximoTurno(
  filas: Array<{ starts_at: string }>,
  agora: Date,
): Date | null {
  const futuros = filas
    .map((f) => new Date(f.starts_at))
    .filter((d) => !Number.isNaN(d.getTime()) && d.getTime() > agora.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  return futuros[0] ?? null;
}
